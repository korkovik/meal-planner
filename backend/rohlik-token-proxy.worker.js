// Cloudflare Worker: tiny CORS proxy for the two Rohlík identity endpoints
// that don't send CORS headers (token exchange + dynamic client registration).
// This is the ONLY server-side piece the GitHub Pages version needs — all MCP
// calls go directly browser → mcp.rohlik.cz (which has proper CORS).
//
// Deploy (needs a free Cloudflare account):
//   npx wrangler deploy backend/rohlik-token-proxy.worker.js \
//     --name rohlik-token-proxy --compatibility-date 2026-01-01
//
// Then put the worker URL into TOKEN_PROXY in prototype/planovac.html.
//
// Security notes: forwards only POST bodies to the two fixed upstream URLs,
// never sees Rohlík passwords (login happens on identity.rohlik.cz in the
// user's browser), and only serves the allowed origins below.

const ALLOWED_ORIGINS = [
  "https://korkovik.github.io",
  "http://localhost:8000",
];

const UPSTREAM = {
  "/token": "https://identity.rohlik.cz/oauth2/token",
  "/register": "https://identity.rohlik.cz/connect/register",
};

export default {
  async fetch(req) {
    const origin = req.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": allowed ? origin : "null",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Vary": "Origin",
    };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const upstream = UPSTREAM[new URL(req.url).pathname];
    if (!upstream || req.method !== "POST" || !allowed)
      return new Response("not found", { status: 404, headers: cors });

    const res = await fetch(upstream, {
      method: "POST",
      headers: {
        "Content-Type": req.headers.get("Content-Type") || "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: await req.text(),
    });
    return new Response(await res.text(), {
      status: res.status,
      headers: { ...cors, "Content-Type": res.headers.get("Content-Type") || "application/json" },
    });
  },
};
