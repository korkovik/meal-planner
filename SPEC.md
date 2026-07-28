# Meal Planner — Specification (v0.1)

Czech-language web app that plans a family's weekly dinners for a balanced diet (supporting children's body and mind development) while respecting family favorites, then hands the shopping off to rohlík.cz.

UI language: **Czech only** (English/others possibly later). This spec is the developer-facing doc; UI strings are Czech.

---

## 1. Scope

- **Dinners only** — one meal per day.
- **5 meals per week**: 3 weekday + 2 weekend. (A meal may in reality cover more than one day; the system does not track that.)
- No lunch/breakfast planning (kids eat *oběd* at škola/školka).

## 2. Family model

- Configurable family definition: number of adults, number of kids, ages.
- **Portions via age→adult-equivalent lookup table.** Starting values (tune later):

  | Age band | Adult-equiv factor |
  |----------|--------------------|
  | 0–3      | 0.4                |
  | 4–8      | 0.6                |
  | 9–13     | 0.8                |
  | 14–18    | 1.1                |
  | 19–60    | 1.0                |
  | 60+      | 0.9                |

  Total household factor drives both recipe scaling and cart quantities.
- **Dietary constraints** (allergies, intolerances, hard exclusions e.g. no pork): configurable, **one configuration for the whole family**. Treated as hard filters, not soft preferences.

## 3. Nutrition rubric (soft goals)

Goals the generator aims for across the 5 weekly dinners — not hard constraints. Levers chosen for kids' development (omega-3, iron, vitamin D, B12):

- Fish ≥ 1× (aim 1–2), prefer oily fish
- Legumes ≥ 1×
- Red meat ≤ 2×
- Vegetables present in every meal
- Whole grain as default carb ≥ 2×
- No single main protein > 2×
- ≥ 3 distinct cuisines across the week
- Fried / ultra-processed ≤ 1×

**Coverage summary:** after generating a week, show which goals were met (checklist / simple visual). This is the "why this week is balanced" view.

## 4. Favorites & dislikes

- **Favorites**: specific recipes. Weighting = "preferred when relevant" — surfaced as recommendations the user accepts or ignores per meal. Not guaranteed N×/week.
- **Dislikes**: a separate, family-wide never-list. Hard filter.

## 5. Difficulty

- Single dimension: **cooking time only.**
- No weekday/weekend split. No hard cap. User sets a preferred time level; generator treats it as a soft preference.

## 6. Generation & refresh

- Generate a 5-meal week from the recipe pool, respecting constraints (hard) and rubric + favorites + time (soft).
- **Refresh** = user locks any meals they like and rerolls only the rest.
- User can **manually pick** one or more specific meals (into the plan and/or into the rohlík order).
- **Comments — two tiers** (resolves the open question):
  - *Standing preferences* — persist across weeks and compound (editable list). e.g. "děti nejedí ryby".
  - *One-off nudges* — apply to the current refresh only. e.g. "tento týden míň těstovin".
  - User can promote a one-off to standing.
  - Both are fed into the generation prompt as context.

## 7. Recipes

- **Decision (2026-07-28): primary source is the Rohlík MCP recipe DB** (`search_recipes_by_vector_similarity` + `get_recipe_detail`) — it arrives pre-structured with ingredient→product mapping, which removes the free-text parsing problem for those recipes. AI still generates/adapts recipes the Rohlík DB can't cover; recepty.cz seed-import is deferred (kept below as the original plan, revisit if Rohlík coverage proves too thin).
- **Original plan — source: recepty.cz + AI-generated.** DB-first rule: prefer favorites and rubric-satisfying DB recipes; AI fills remaining slots and adapts.
- AI also (a) parses recepty.cz free-text into structured ingredient lists, (b) writes brief steps where missing.
- Each recipe needs: **shopping list (primary)** + **brief steps**.
- **Persisted once generated** — the DB grows over time, AI usage drops.
- Note: recepty.cz content should be **seed-imported once** into your DB (simpler, avoids a runtime scraping dependency and ToS/robots risk at request time) rather than scraped live. The hard part is parsing free-text ingredients into `{name, qty, unit}` — this is the bridge to rohlík matching.

## 8. Rohlík & cart

- **Rohlík MCP path exists (per Tom) → build a PoC first. This gates the whole architecture.**
- Flow: user confirms which meals to shop → app maps ingredients to rohlík SKUs → adds to cart → **prompts user to pay/purchase manually (no auto-checkout).**
- **Pantry**: a common "already have" list (salt, potatoes, rice, oil, spices, …), subtracted before building the cart.
- **Ingredient → SKU matching**: respect package sizes (buy whole packages). **Surface low-confidence matches for user review**; auto-accept high-confidence ones.
- **Leftovers** (bought 500 g, used 200 g): ignored — up to the user to reuse.
- **No budget cap.**

## 9. Data model (sketch)

- `Family(id, adults, kids[])` · `Kid(age)`
- `DietConfig(family_id, exclusions[], dislikes[])`
- `Preference(family_id, kind: standing|oneoff, text)`
- `Recipe(id, name, source, time_min, cuisine, protein, steps[], origin: recepty|ai)`
- `Ingredient(recipe_id, name, qty, unit)`
- `Pantry(family_id, items[])`
- `WeekPlan(id, family_id, slots[5])` · `PlanSlot(recipe_id, locked: bool)`
- `CartLine(week_id, ingredient, sku, packages, est_price, confidence)`

## 10. Architecture & build order

**Hosting reality:** github.io is **static frontend hosting only**. It cannot run a database, make server-side rohlík/MCP calls, or scrape. So:

- **Frontend** → github.io (fine).
- **Backend needed** for: database, rohlík MCP calls, recipe import, accounts (later). Recommended: a single serverless + DB provider (e.g. Supabase — Postgres + auth + edge functions, good path to multi-family later).

**Build order (riskiest first):**

1. **Rohlík MCP PoC** — confirm you can search products, map an ingredient to a SKU, and add to cart. Gates everything.
2. **Generation loop as a Claude artifact** — prove meal quality: config → 5-meal week → rubric coverage → lock/reroll → comments. Zero backend; validates the core experience.
3. **Recipe DB** — seed-import + parse recepty.cz into structured ingredients; persist AI recipes.
4. **Ingredient → SKU mapping + pantry** — the real engineering; low-confidence review UI.
5. **Wire cart hand-off**; then port frontend to github.io + Supabase backend.
6. **Accounts / multi-family** (later).

## 11. Open decisions

- Comment persistence: two-tier model above — confirm or adjust.
- ~~recepty.cz: seed-import (recommended) vs live scrape.~~ **Resolved 2026-07-28: Rohlík MCP recipe DB is the primary source for now; recepty.cz deferred (see §7).**
- Backend provider (Supabase recommended).
- Whether the artifact prototype (step 2) is the throwaway PoC or the seed of the real frontend.
