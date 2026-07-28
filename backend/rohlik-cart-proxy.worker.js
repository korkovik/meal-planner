// Cloudflare Worker: family Rohlík cart proxy for the GitHub Pages planner.
//
// Why it exists: Rohlík's MCP endpoint allows browser calls (CORS), but its
// OAuth cannot be completed from a static site (token endpoints lack CORS and
// dynamic client registration allowlists redirect URIs to localhost-style
// clients only — verified 2026-07-28). So this worker holds ONE family Rohlík
// session: refresh-token chain in KV (tokens rotate on every refresh), and
// proxies MCP calls with the Bearer token injected server-side.
//
// Security model (personal/family deployment):
// - callers must present the family code in X-App-Key (secret APP_KEY)
// - browser callers restricted by CORS to ALLOWED_ORIGINS
// - only the tool ALLOWLIST below is forwarded — no checkout, no order
//   mutations, nothing outside search/cart
// - Rohlík password never touches this worker; the session comes from a
//   one-time localhost OAuth login (poc/rohlik.mjs) seeded into KV
//
// Setup (one time):
//   npx wrangler kv namespace create ROHLIK_KV       # id -> wrangler.toml
//   npx wrangler deploy -c backend/wrangler.toml
//   npx wrangler kv key put tokens "$(cat poc/.tokens.json)" --binding KV -c backend/wrangler.toml --remote
//   npx wrangler kv key put client "$(cat poc/.client.json)" --binding KV -c backend/wrangler.toml --remote
//   echo -n "<family-code>" | npx wrangler secret put APP_KEY -c backend/wrangler.toml
// NOTE: after seeding, the poc CLI must not refresh the same chain (rotation
// would invalidate the worker's copy) — re-login there if you need it.

const ALLOWED_ORIGINS = [
  "https://korkovik.github.io",
  "http://localhost:8000",
];
const MCP = "https://mcp.rohlik.cz/mcp";
const TOKEN_URL = "https://identity.rohlik.cz/oauth2/token";
const TOOL_ALLOW = new Set([
  "batch_search_products",
  "add_items_to_cart",
  "get_cart",
  "update_cart_item",
  "remove_cart_item",
]);
const METHOD_ALLOW = new Set([
  "initialize", "notifications/initialized", "tools/list", "tools/call", "ping",
]);

async function getAccessToken(env) {
  const raw = await env.KV.get("tokens");
  if (!raw) throw new Error("KV not seeded with tokens");
  const t = JSON.parse(raw);
  if (Date.now() - t.obtained_at < ((t.expires_in || 0) - 60) * 1000) return t.access_token;
  const client = JSON.parse((await env.KV.get("client")) || "{}");
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
      client_id: client.client_id,
      resource: MCP,
    }),
  });
  if (!r.ok) throw new Error("token refresh failed: " + r.status);
  const nt = await r.json();
  nt.obtained_at = Date.now();
  if (!nt.refresh_token) nt.refresh_token = t.refresh_token;
  await env.KV.put("tokens", JSON.stringify(nt));
  return nt.access_token;
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": allowed ? origin : "null",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type,x-app-key,mcp-protocol-version,mcp-session-id",
      "Access-Control-Expose-Headers": "mcp-session-id",
      "Vary": "Origin",
    };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (new URL(req.url).pathname !== "/mcp" || req.method !== "POST" || !allowed)
      return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: cors });
    if (req.headers.get("X-App-Key") !== env.APP_KEY)
      return new Response(JSON.stringify({ error: "bad app key" }), { status: 401, headers: cors });

    let body;
    try { body = await req.json(); } catch {
      return new Response(JSON.stringify({ error: "bad json" }), { status: 400, headers: cors });
    }
    if (!METHOD_ALLOW.has(body.method) ||
        (body.method === "tools/call" && !TOOL_ALLOW.has(body.params && body.params.name)))
      return new Response(JSON.stringify({ error: "tool not allowed" }), { status: 403, headers: cors });

    let token;
    try { token = await getAccessToken(env); } catch (e) {
      return new Response(JSON.stringify({ error: "session expired: " + e.message }), { status: 502, headers: cors });
    }
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "Authorization": "Bearer " + token,
      "MCP-Protocol-Version": req.headers.get("MCP-Protocol-Version") || "2025-06-18",
    };
    const sid = req.headers.get("Mcp-Session-Id");
    if (sid) headers["Mcp-Session-Id"] = sid;

    const r = await fetch(MCP, { method: "POST", headers, body: JSON.stringify(body) });
    const respHeaders = { ...cors, "Content-Type": r.headers.get("content-type") || "application/json" };
    const rsid = r.headers.get("mcp-session-id");
    if (rsid) respHeaders["Mcp-Session-Id"] = rsid;
    return new Response(await r.text(), { status: r.status, headers: respHeaders });
  },
};
