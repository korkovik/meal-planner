# Meal Planner — working notes for Claude

Czech-language weekly dinner planner for one family, which hands the shopping off to
**rohlik.cz**. Read [SPEC.md](SPEC.md) for the product spec and
[docs/rohlik-mcp-poc.md](docs/rohlik-mcp-poc.md) for everything verified about Rohlík's API.
This file is the operational guide: how the pieces fit, how to ship, and what will bite you.

Owner: Tomáš (korkat@gmail.com). GitHub: `korkovik/meal-planner`. UI language is **Czech only** —
all user-visible strings, buttons, and messages are Czech. Code comments and docs are English.

## The one file that matters

`prototype/planovac.html` **is the app** — a single self-contained HTML file (no build system,
no framework, no dependencies). Everything else supports it. Edit it directly.

It is written in *artifact format*: no `<!doctype>`, `<html>`, `<head>`, or `<body>` tags — it
starts with `<title>` and is wrapped at publish time. `scripts/build-pages.mjs` wraps it into
`docs/index.html` for GitHub Pages.

## Layout

| Path | What |
|---|---|
| `prototype/planovac.html` | The app. Single file: recipe pool, generator, UI, Rohlík cart. |
| `docs/index.html` | **Generated** — never edit. Output of `scripts/build-pages.mjs`, served by Pages. |
| `scripts/build-pages.mjs` | Wraps the prototype into a standalone page. |
| `backend/rohlik-cart-proxy.worker.js` | Cloudflare Worker holding the family Rohlík session. |
| `backend/wrangler.toml` | Worker config (KV namespace id lives here). |
| `poc/rohlik.mjs` | Standalone CLI for poking Rohlík's MCP (`login`, `tools`, `call`). |
| `SPEC.md` · `docs/rohlik-mcp-poc.md` | Product spec · API findings and decisions. |

## Shipping a change

Always all three steps, in order:

```bash
cd ~/claudecode-workspace/meal-planner
node scripts/build-pages.mjs          # regenerate docs/index.html
git add -A && git commit -m "..." && git push
```

Pages redeploys automatically (~1 min). Verify with a cache-busting URL —
**GitHub Pages caches HTML for ~10 minutes**, which repeatedly looked like "my fix didn't
deploy" during development:

```bash
until curl -s https://korkovik.github.io/meal-planner/ | grep -q "<some new string>"; do sleep 5; done
```

Then open `https://korkovik.github.io/meal-planner/?v=<short-sha>` in a browser.

The app has no test suite. Before committing, at minimum syntax-check the page script:

```bash
python3 -c "
import re,subprocess,tempfile
s=open('prototype/planovac.html').read()
m=re.search(r'<script>(.*)</script>',s,re.S)
f=tempfile.NamedTemporaryFile('w',suffix='.js',delete=False); f.write(m.group(1)); f.close()
print(subprocess.run(['node','--check',f.name],capture_output=True,text=True).stderr or 'syntax OK')"
```

Better: drive the real page in a browser and exercise the changed path. Most bugs here were
silent runtime failures (a missing function, a swallowed promise rejection), not syntax errors.

### The claude.ai artifact

The same file is also published as a private artifact at
`https://claude.ai/code/artifact/27f4bad4-bdfb-4f51-8c5c-89527564d643`. Only a session with the
Artifact tool can republish it (pass that URL as `url`). If you can't, just push to git and tell
Tomáš the artifact is one version behind — the Pages version is fully functional on its own.

## How the Rohlík cart works (two bridges, one code path)

`mcpCall(tool, input, isRead)` picks a bridge at call time via `bridgeMode()`:

1. **`connector`** — inside the claude.ai artifact, calls the viewer's "Rohlik" claude.ai
   connector through `window.claude.mcp`.
2. **`direct`** — everywhere else (Pages, localhost): POSTs MCP JSON-RPC to the Cloudflare
   Worker, authenticated with the *family code* stored in `localStorage["rohlik-app-key"]`.
3. **none** — the UI falls back to "copy the order for Claude" and says so.

**Why a worker exists at all** (verified, don't re-litigate): `mcp.rohlik.cz` allows browser
calls (CORS is open), but `identity.rohlik.cz` sends no CORS headers on its token endpoints and
its dynamic client registration rejects non-localhost redirect URIs (`github.io` and
`workers.dev` both refused), and strips the device-code grant from registered clients. A static
page therefore **cannot** obtain Rohlík tokens. The worker holds the family's refresh-token
chain in KV instead and injects the Bearer server-side.

The worker forwards **only** an allowlist: `batch_search_products`, `add_items_to_cart`,
`get_cart`, `update_cart_item`, `remove_cart_item`, `search_recipes_by_vector_similarity`,
`get_recipe_detail`. Never add checkout or order-mutation tools — the spec requires the user to
pay manually on rohlik.cz, and `submit_checkout` would place a real order.

Deploy the worker after editing it (from the repo root, `-c` path matters):

```bash
npx wrangler deploy -c backend/wrangler.toml
```

## Secrets — not in the repo, ask Tomáš

Everything sensitive is gitignored. If you need one, ask; do not reconstruct or commit them.

- `poc/.app-key.txt` — the **family code** users type into the page ("rodinný kód").
- `poc/.tokens.json`, `poc/.client.json` — the Rohlík OAuth session for `poc/rohlik.mjs`.
- Worker-side: `APP_KEY` secret + `tokens`/`client` in KV (`wrangler secret put`, `wrangler kv key put`).

⚠️ **Rohlík refresh tokens rotate on every use.** The worker owns the live chain. Running
`node poc/rohlik.mjs` against the same stored session will rotate the token and **break the
deployed worker** until it is re-seeded. If you need the CLI, run `node poc/rohlik.mjs login`
for a fresh session first.

## The generator (inside `planovac.html`)

- `R` — built-in recipe pool. `S.userRecipes` — user's own. `S.extRecipes` — fetched from
  Rohlík's recipe DB. `RALL()` returns all three; **always use `RALL()`, never `R`**, when
  looking recipes up.
- **Cuisine shares are sampled, not scored**: each slot draws a group from `TARGETS`
  (CZ+SK 60 %, Indian 20 %, Italian 10 %, ES+MX 10 %). Changing the mix means changing
  `TARGETS`/`GROUPS`, not the score weights. Cuisines outside the groups never generate —
  they're reachable only via manual pick.
- **The nutrition rubric is deliberately loose** (Tomáš asked for this): small score nudges
  only. The coverage chips are informational and *should* show unmet goals sometimes.
- **Rerolling must never repeat**: `S.seen[slot]` records every rejected recipe. After 12
  rejections (or when the pool is exhausted) `fetchRohlikRecipe()` pulls a genuinely new recipe
  from Rohlík's DB and converts it (`convertRohlikRecipe`: unit parsing, protein/allergen/veg
  heuristics). `S.seen` resets on a full weekly generate.
- **Portions** scale off `factor()` (adults + age-banded child factors). Recipes are written per
  4 adult portions; the shopping list and cart multiply by `factor()/4`.
- All state lives in one `localStorage` key (`planovac-vecere-v1`) — **per origin**, so recipes
  added on Pages don't appear in the artifact and vice versa. Syncing needs the backend.

### Ingredient → SKU matching

`chooseMatches()` scores candidate products by name-token overlap, package-size fit, and price,
then the review UI lets the user switch product, change package count, or drop the line.
Low-confidence rows are badged **zkontrolovat**. `PIECE_G` maps produce to typical piece weights
so "2 ks cibule" buys the right amount when the product is sold by weight — extend that table
when a count-vs-weight mismatch shows up.

## Conventions and traps

- Czech UI strings; English code comments. Keep both.
- **Never do a large block-replace of the `<script>`.** One rewrite silently deleted six helper
  functions (`checkedItems`, `setMsg`, `unwrap`, …) and shipped a dead button. Prefer targeted
  edits, and grep for each function you touched afterwards.
- Failures must be *visible*: use `setMsg(text, isError)`, never a silent `console.log`. An
  earlier version's only feedback was a grey hint nobody saw — the bug report was "nothing
  happens".
- Reads (searches) may carry a 30 s `AbortSignal`; **never abort `add_items_to_cart`** — an
  aborted write leaves the cart in an unknown state.
- When testing against the live Rohlík account, clean up after yourself (`remove_cart_item`) and
  keep test items to one cheap product.
- `git push` and worker deploys are fine to do when asked; the deploy affects the family's live
  shopping, so say what you deployed.

## Next steps (from SPEC.md §10)

Steps 1–2 are done and the frontend is already on Pages. Remaining: the real backend
(Supabase — accounts, shared recipe DB, cross-device sync, and the per-user Rohlík OAuth that
would retire the family-code worker), then AI-generated recipes, which slot in exactly where
`fetchRohlikRecipe()` sits today.
