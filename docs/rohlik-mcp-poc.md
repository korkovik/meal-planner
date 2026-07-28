# Rohlík MCP PoC — Findings (2026-07-28)

**Verdict: PoC PASSED end-to-end. The official Rohlík MCP covers search → SKU → cart, plus a recipe DB with built-in ingredient→product mapping. Architecture is un-gated.**

## Option A — Official Rohlík MCP server (recommended)

- Docs: https://www.rohlik.cz/mcp-docs (also https://www.rohlik.cz/stranka/rohlik-mcp-server)
- Endpoint: `https://mcp.rohlik.cz/mcp` — remote **streamable HTTP** MCP (verified live: unauthenticated `initialize` returns proper 401 + `WWW-Authenticate` with resource metadata).
- Auth: **OAuth 2.1**, verified via discovery:
  - Protected-resource metadata: `https://mcp.rohlik.cz/.well-known/oauth-protected-resource/mcp`
  - Authorization server: `https://identity.rohlik.cz` (authorization_code + **refresh_token** grants, PKCE S256, **dynamic client registration** at `/connect/register`)
- Capabilities per docs: product search, cart management (add items, quantities), recipe search, order history / reorder, shopping lists, support.
- Checkout: **orders finalize only on rohlik.cz** — exactly matches our "no auto-checkout, user pays manually" requirement.
- Caveat: Rohlík labels the service *experimental* and reserves the right to change/discontinue it.

## Option B — Community server (fallback only)

- `tomaspavlin/rohlik-mcp` (`npx @tomaspavlin/rohlik-mcp`), also mirrored as `kolarova-ops/rohlik-mcp`.
- Reverse-engineered Rohlík API, username/password in env vars, "study purposes / personal use only".
- Broader tools (delivery slots, discounts, frequent items) but ToS-risky and fragile. Use only if the official server lacks something we need.

## Static-site (github.io) findings — 2026-07-28 evening

- `mcp.rohlik.cz/mcp` has **full CORS** (origin echo + credentials + auth headers) — browsers can call the MCP directly.
- `identity.rohlik.cz` has **no CORS** on token/register endpoints, and DCR **allowlists redirect URIs** (github.io and workers.dev rejected; localhost allowed). Device grant is advertised in discovery but **silently stripped** from DCR-registered clients. ⇒ a static site can never obtain tokens itself.
- Refresh tokens **rotate on every refresh** — any server-side holder needs persistent storage.
- Solution shipped: `backend/rohlik-cart-proxy.worker.js` (Cloudflare Worker + KV) holds the family refresh-token chain, injects the Bearer, and forwards **only** search/cart tools (no checkout/order mutations) to callers presenting the family code (X-App-Key) from allowed origins. Verified end-to-end from the live github.io page (search → review → add → remove).
- ⚠️ The worker owns the poc client's token chain now — running `poc/rohlik.mjs` against the same stored login would rotate the chain and break the worker; re-login there if the CLI is needed.

## Architectural implications

1. **The Supabase-backend plan works.** Because identity.rohlik.cz supports dynamic client registration + authorization-code + refresh tokens, our backend can register as an OAuth client, run the login redirect flow per user, store refresh tokens, and call `mcp.rohlik.cz/mcp` server-side as an MCP client. No scraping, no password handling.
2. **Recipe tools exist on the Rohlík side too** — their MCP exposes recipe search with ingredient lists. Potentially a second recipe source alongside recepty.cz, already SKU-adjacent.
3. **Cart hand-off flow confirmed**: MCP fills the cart, user opens rohlik.cz to pay. No auto-checkout is even possible.

## PoC status — all passed (2026-07-28)

- [x] Server exists, endpoint live, transport + OAuth verified
- [x] Registered in workspace `.mcp.json` (project scope)
- [x] **Own OAuth client works**: dynamic client registration + PKCE login + refresh token via `poc/rohlik.mjs` (this is the exact flow the backend will use; tokens cached in gitignored `poc/.tokens.json`, access token ~8 h + refresh)
- [x] `tools/list`: ~60 tools (server `rohlik_mcp 2.14.7`)
- [x] `batch_search_products` (up to 4 queries/call, optional nutrition/allergen/ingredient data): returns `productId`, `price`, `pricePerUnit`, `textualAmount` (package size), `inStock`, `brand`, badges — everything the SKU matcher needs
- [x] Cart round-trip: `add_items_to_cart` → `get_cart` shows item + total → `remove_cart_item` (cart left as found)
- [x] **Recipe tools**: `search_recipes_by_vector_similarity` (semantic, Czech) + `get_recipe_detail(include_product_mapping=true)` returns steps, structured ingredients ("500 g čočky", with `ingredient_id`) **and ranked candidate products per ingredient** with package size, price, sale price, stock

## Key tools for the app

| Need | Tool |
|---|---|
| Ingredient → SKU candidates | `batch_search_products`, or free via `get_recipe_detail` product mapping |
| Nutrition/allergens per SKU | `get_products_composition_batch`, `include_nutritions`/`include_allergens` on search |
| Cart hand-off | `add_items_to_cart`, `get_cart`, `update_cart_item`, `remove_cart_item` |
| Recipe source #2 (pre-mapped to SKUs) | `search_recipes_by_vector_similarity`, `get_recipe_detail` |
| Favorites/history signals | `get_all_user_favorites`, `fetch_orders`, `get_typical_order` |

Never call: `submit_checkout` / checkout mutation tools (user pays manually on rohlik.cz — spec rule), `clear_cart`, order-mutation tools (`cancel_order`, `remove_order_items`).

Gotcha: some "boolean-looking" params are strings (`get_recipe_detail.include_prices`) — validate against `inputSchema`, not the description.

## Spec impact

1. **Step 4 shrinks.** Rohlík's recipe DB already maps ingredients→products. For our own/AI recipes, per-ingredient `batch_search_products` + a ranking heuristic (package size vs needed qty, price-per-unit, best-buy badge) likely suffices; the low-confidence review UI remains.
2. **Rohlík becomes recipe source #2** alongside recepty.cz — pre-structured, pre-mapped, Czech. Consider making it source #1 and demoting recepty.cz seed-import.
3. Backend plan validated: DCR + refresh tokens mean Supabase edge functions can hold per-user Rohlík sessions.
