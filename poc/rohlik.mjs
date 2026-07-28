#!/usr/bin/env node
// Rohlík MCP PoC — standalone OAuth client + minimal MCP-over-HTTP client.
// This mirrors what the future backend will do: dynamic client registration,
// authorization-code + PKCE login, token refresh, then MCP tool calls.
//
// Usage:
//   node rohlik.mjs login              # opens browser, user logs in at rohlik.cz
//   node rohlik.mjs tools              # list MCP tools with schemas
//   node rohlik.mjs call <tool> '<json-args>'
//
// Tokens/client are cached next to this file (gitignored).

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const MCP_URL = 'https://mcp.rohlik.cz/mcp';
const ISSUER = 'https://identity.rohlik.cz';
const REDIRECT_PORT = 8976;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const CLIENT_FILE = join(DIR, '.client.json');
const TOKEN_FILE = join(DIR, '.tokens.json');

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const writeJson = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2));

async function oidcConfig() {
  const r = await fetch(`${ISSUER}/.well-known/openid-configuration`);
  if (!r.ok) throw new Error(`OIDC discovery failed: ${r.status}`);
  return r.json();
}

async function getClient(cfg) {
  const cached = readJson(CLIENT_FILE);
  if (cached) return cached;
  const r = await fetch(cfg.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'meal-planner-poc',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'openid email roles',
    }),
  });
  if (!r.ok) throw new Error(`Client registration failed: ${r.status} ${await r.text()}`);
  const client = await r.json();
  writeJson(CLIENT_FILE, client);
  console.log(`Registered OAuth client: ${client.client_id}`);
  return client;
}

async function login() {
  const cfg = await oidcConfig();
  const client = await getClient(cfg);
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));

  const authUrl = new URL(cfg.authorization_endpoint);
  authUrl.search = new URLSearchParams({
    client_id: client.client_id,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: 'openid email roles',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: MCP_URL,
  }).toString();

  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url, REDIRECT_URI);
      if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const err = u.searchParams.get('error');
      const gotState = u.searchParams.get('state');
      const gotCode = u.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (err || gotState !== state || !gotCode) {
        res.end('<h2>Login failed — check the terminal.</h2>');
        server.close();
        reject(new Error(err || 'state mismatch / missing code'));
      } else {
        res.end('<h2>Přihlášení proběhlo. Můžete zavřít okno.</h2>');
        server.close();
        resolve(gotCode);
      }
    });
    server.listen(REDIRECT_PORT, () => {
      console.log('Opening browser for Rohlík login…');
      console.log(`If it does not open, visit:\n${authUrl}`);
      execFile('open', [authUrl.toString()]);
    });
    setTimeout(() => { server.close(); reject(new Error('Login timed out (5 min)')); }, 5 * 60 * 1000);
  });

  const r = await fetch(cfg.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
      code_verifier: verifier,
      resource: MCP_URL,
    }),
  });
  if (!r.ok) throw new Error(`Token exchange failed: ${r.status} ${await r.text()}`);
  const tokens = await r.json();
  tokens.obtained_at = Date.now();
  writeJson(TOKEN_FILE, tokens);
  console.log(`Login OK. Access token expires in ${tokens.expires_in}s; refresh token: ${tokens.refresh_token ? 'yes' : 'no'}.`);
}

async function accessToken() {
  const t = readJson(TOKEN_FILE);
  if (!t) throw new Error('No tokens — run: node rohlik.mjs login');
  const age = (Date.now() - t.obtained_at) / 1000;
  if (age < (t.expires_in ?? 0) - 60) return t.access_token;
  if (!t.refresh_token) throw new Error('Token expired and no refresh token — run login again');
  const cfg = await oidcConfig();
  const client = readJson(CLIENT_FILE);
  const r = await fetch(cfg.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token,
      client_id: client.client_id,
      resource: MCP_URL,
    }),
  });
  if (!r.ok) throw new Error(`Refresh failed: ${r.status} ${await r.text()} — run login again`);
  const nt = await r.json();
  nt.obtained_at = Date.now();
  nt.refresh_token ??= t.refresh_token;
  writeJson(TOKEN_FILE, nt);
  return nt.access_token;
}

// --- minimal MCP streamable-HTTP client ---

let sessionId = null;

async function mcpRequest(body, token) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
    'MCP-Protocol-Version': '2025-06-18',
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const r = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  const sid = r.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await r.text();
  if (!r.ok) throw new Error(`MCP HTTP ${r.status}: ${text.slice(0, 500)}`);
  if (!text) return null; // notifications get 202/empty
  const ct = r.headers.get('content-type') ?? '';
  if (ct.includes('text/event-stream')) {
    // take the last data: line that parses as our response
    let result = null;
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) {
        try { const j = JSON.parse(line.slice(5)); if (j.id === body.id || j.result || j.error) result = j; } catch {}
      }
    }
    return result;
  }
  return JSON.parse(text);
}

async function mcpConnect(token) {
  const init = await mcpRequest({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'meal-planner-poc', version: '0.1.0' },
    },
  }, token);
  if (init?.error) throw new Error(`initialize error: ${JSON.stringify(init.error)}`);
  await mcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, token);
  return init.result;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'login') return login();

  const token = await accessToken();
  const info = await mcpConnect(token);

  if (cmd === 'tools') {
    const res = await mcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, token);
    if (res?.error) throw new Error(JSON.stringify(res.error));
    console.log(`Server: ${info.serverInfo?.name} ${info.serverInfo?.version}`);
    console.log(JSON.stringify(res.result.tools, null, 2));
  } else if (cmd === 'call') {
    const [name, json] = args;
    if (!name) throw new Error('usage: node rohlik.mjs call <tool> \'<json-args>\'');
    const res = await mcpRequest({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name, arguments: json ? JSON.parse(json) : {} },
    }, token);
    if (res?.error) throw new Error(JSON.stringify(res.error));
    console.log(JSON.stringify(res.result, null, 2));
  } else {
    console.log('usage: node rohlik.mjs login | tools | call <tool> <json-args>');
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
