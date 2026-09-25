# PDP reviews and ratings

SignalPulse owns rating identity, fetching, normalization and caching. HMAP rebroadcasts the public response without recalculating any scores. This feature does not change sales estimates, revenue mix, ingestion jobs or existing store-rating rows.

## Configuration

- Set `opencritic_rapidapi_key` in SignalPulse Settings. It is a masked `app_settings` secret, not a frontend setting. Production does not read the development environment fallback.
- Provider: [OmkarCloud OpenCritic scraper on RapidAPI](https://rapidapi.com/OmkarCloud/api/best-opencritic-scraper-free-1000-calls). The observed Basic plan has 1,000 requests/month; it still requires a valid key and access to the API. No paid plan is automatically activated.
- Host: `best-opencritic-scraper-free-1000-calls.p.rapidapi.com`; header names: `X-RapidAPI-Key` and `X-RapidAPI-Host`.
- Search: `GET /games/search?query=...`; details: `GET /games/details?game=...`.
- This is a third-party scraper, not an official OpenCritic license. API access alone does not establish redistribution rights. Confirm provider and OpenCritic terms for the intended public display before production rollout.
- A Computer-vault credential is not automatically installed in the production app. Configure the production Settings field separately; never copy a raw key into Git, an issue, a screenshot or a deployment log.

## Score definitions

- Steam: current all-language, all-purchase-types review summary (`purchase_type=all`), including free acquisitions and key activations. Positive reviews divided by total reviews from the SAME summary. Native percentage and Valve description, not a converted star rating. Exact requested App ID. The API supplies `reviewScope: "all"` and both clients label this cohort explicitly.
- PlayStation and Xbox: latest existing lifetime store-rating observation for one verified family SKU, on the native five-star scale. Regional counts and averages are never summed or averaged. The source link identifies the selected storefront listing.
- OpenCritic: `percent_recommended`, `top_critic_score`, `tier`, `review_count`; never use percentile rank as a review score. These are title-level critic aggregates, not separate platform ratings.
- Captured dates describe when SignalPulse fetched the response, or the console observation date. They are not a guarantee that a scraper refreshed its underlying record that day. Scores are the latest available response, not a promised real-time feed.
- Genuine zero is preserved; missing scores remain null. A zero review count is not treated as a zero score.

## Coverage and identity

SignalPulse: portfolio product, standalone CCU, individual Steam/console sales, combined family and Amazon product detail pages. HMAP: Steam game detail, individual Buying title and combined Buying family pages. Sections follow existing media/product information where present. Roblox and Fortnite experiences have no equivalent mapped PC/console title identity and are not assigned unrelated store/critic scores.

OpenCritic matches require a unique exact normalized title, plus a matching Steam ID when available or corroborating release dates within 370 days. Words, numbers, editions, remasters and subtitles remain meaningful. Unverified matches fail closed. Demo/pass/playtest products never inherit the parent game's critic score.

Buying reuse is publisher-independent: mapped Saber and non-Saber titles read the same `platform_sku_map` identities and `store_rating_signal_daily` console observations. Family routes recognize both storefront and identity-checked IGDB spellings so existing Buying URLs resolve without changing critic search names. No additional PlayStation/Xbox fetches or sales calculations occur. Missing catalog SKUs still mean missing console coverage, not zero ratings.

Steam's Buying collector stores lifetime histogram up/down totals and a five-star conversion for estimation. Those histogram totals are not substituted for the Steam review summary displayed here. All PDPs instead share the cached all-purchase-types summary for the exact App ID. Metadata fallback requires exactly one successful record whose embedded App ID matches; conflicting/duplicate identities are rejected even if the outer response key differs.

Amazon uses the exact mapped product or the competitor's own Steam identity. A competitor pin's `parent_product_id` belongs to the tracked Saber parent and is deliberately not used as the competitor identity. Unmapped physical bundles/accessories show unavailable rather than guessing.

## Public API and cache behavior

`GET /api/reviews-ratings/{steam|title|family}/:id` is public-read. `{product|amazon}` remains behind existing SignalPulse authentication. HMAP exposes only the first three kinds.

All routes validate identities, rate-limit requests and return safe errors. The API key stays server-side. Public responses have a 30-second cache lifetime; private identities use private caching. Responses still refreshing use `no-store`.

- Steam and OpenCritic scores: 24-hour on-demand stale-while-revalidate cache.
- Steam summaries use `steam_reviews:all:v2:` so both zero and misleadingly small legacy purchase-only summaries are refreshed on first access. Legacy cache rows remain intact for rollback; critic caches and provider-usage accounting are unchanged.
- Negative matches and Steam identity: seven days.
- Failures: 30-minute backoff; retain last successful values with a stale label.
- Provider 401/403/429: shared 30-minute circuit breaker.
- Local provider guard: 900 attempted requests in a rolling 31-day window, including failed calls and title searches. This is conservative but is not an account-wide meter; other applications sharing the key can exhaust the provider quota sooner.
- First-time matches normally cost two requests; later refreshes use the saved OpenCritic ID and cost one. A 1,000-call plan cannot provide daily refreshes for a large catalog. The UI explicitly reports allowance exhaustion and keeps cached values.
- At most eight background refreshes run concurrently. Duplicate requests for the same identity share the in-flight refresh. Browser polling is bounded.
- HMAP uses the existing SignalPulse proxy with a 30-second ratings cache and does not cache refreshing responses.

Five additive, idempotently created tables: `review_rating_cache`, `opencritic_title_matches`, `opencritic_request_usage`, `review_rating_provider_state`, `verified_rating_links`. No existing tables are rewritten.

### Console critic matching

Remove trademark glyphs before Unicode decomposition, so `™` does not become
literal `tm`. Normalize the Delta glyph and explicit trailing storefront
platform/standard/deluxe/ultimate/gold packaging, but retain remaster, definitive,
complete-edition and semantic subtitle distinctions. Console `UFC N` searches
use OpenCritic's `EA Sports UFC N` branding.

Native storefront name/date takes precedence over enrichment. Additional
verified family storefront dates and name-consistent IGDB dates can corroborate
later ports. A provider `(YYYY)` suffix is eligible only when the year occurs
in this verified date set. At most three exact/year-qualified candidates are
fetched; require exactly one detail record passing name plus Steam-ID/date
verification. Do not resolve ambiguity by search rank.

The `opencritic:v2:` cache namespace retries old misses. Existing successful
same-identity caches are copied forward without spending another provider call;
the 900-attempt guard and failure/stale behavior remain unchanged.

### CCU ratings-only backfill

`scripts/ccu-ratings-backfill.ts <evidence-json> <output-directory>` produces five
single-statement files: maps, metadata, Xbox names, verified links, observations.
It never opens a database. Evidence must contain an exact embedded Steam App ID,
native console name/SKU, current nonempty native rating, official storefront
URL, full-game PlayStation classification and actual Xbox console compatibility.
Microsoft PC-only listings, unrelated games, DLC and unverified console editions
are excluded. Empty search results are not proof that a port does not exist.

After explicit release/write approval, deploy first to create the additive
links table, then apply those five files sequentially through DB Admin. Existing
SKU roles, business models, IDs and nonempty metadata are preserved. New rows
use `sku_role='ratings_only'`, `business_model='unknown'`, a manual-override flag
and the exact `verified_ratings_only:ccu_2026-09-24` marker. Do not classify a
PlayStation product as paid merely because its Steam version is paid.

The existing PS/Xbox daily collectors admit only explicitly verified/manual
ratings-only rows regardless of paid/F2P status. Ordinary F2P/unknown rows retain
their original gates. Sales estimates and Buying membership still require base
SKUs. An explicit link makes console observations available to the exact Steam
PDP and shares that Steam App ID with the verified console PDP. This does not
alter Buying edition groups, estimate inputs, or platform sales.

The initial reviewed set has 53 CCU titles and 92 console links (90 new SKUs
against the 2026-09-24 catalog export). This is not a claim of exhaustive console
coverage. Console-specific editions, unresolved listings and missing native
ratings remain unfilled pending verification. HMAP's existing ratings proxy
receives the same response; no HMAP code change is required.

## QA and rollout

### Eight-title console coverage backfill

`scripts/portfolio-ratings-backfill.ts <output-directory>` reads live Steam,
PlayStation and Xbox collectors and writes an evidence file plus four
single-statement SQL files. It does not connect to a database. The fixed
allowlist covers Bus Bound, World War Z, Toxic Commando, Insurgency: Sandstorm,
Docked, SnowRunner, RoadCraft and Expeditions. It verifies exact candidate IDs,
store names, current nonempty observations and paid Xbox identity. Bus Bound
uses Xbox `9PGTSPHXQ1DQ`, not its separate preorder/package listing.

After review and explicit production-write approval, apply maps, metadata,
Xbox identity cache and snapshots in that order using the existing DB Admin
workflow. Re-running is idempotent: existing SKU IDs, pricing, overrides,
metadata and same-day ratings are preserved. Each workflow run takes its
normal pre-write database backup. Do not run the broad daily estimation job
just to populate these cards.

All new mappings are manually protected `ratings_only` SKUs. Existing base
Steam mappings are untouched. The existing daily collectors refresh their
observations in `store_rating_signal_daily`; the estimator and sales
leaderboards remain restricted to `sku_role='base'`. PlayStation only admits
the exact verified/manual ratings-only source marker, not generic editions.
The original World War Z PS4 store listing is permitted for the PS Store
rating card with an explicit PS4 label, but never counted as a PS5 sales SKU.
No Aftermath rating is copied onto base World War Z.

Run SignalPulse `npm run check`, `npm run build`, and the `tsx --test` ratings, title-metadata, sales-presentation and family-route tests. Run HMAP's build and ratings/Buying presentation tests. Browser-check all eight page types at desktop and phone widths, loading/error/retry, null/zero/stale values, outbound source links and section placement. UI QA fixtures are local test inputs, not production data.

After explicit approval: deploy SignalPulse first through its existing GitHub workflow, configure the masked Settings key, verify a real cold fetch and a cache hit, then deploy HMAP through its workflow and compare response values verbatim. Verify app health and existing sales pages after both deploys.

Rollback through reviewed Git reverts and the existing deployment workflows. The additive cache tables can remain; do not drop user data. Clearing the OpenCritic key stops provider calls while Steam and console ratings remain independent.
# CCU identity follow-up (September 24, 2026)

Steam CCU context does not restrict Reviews and Ratings to Steam. Reviewed exact console links are appended before deriving critic release evidence, while Steam ratings always use the requested App ID. The original 92 links/53 titles were applied and live-checked; the reviewed follow-up adds 13 console-version links/10 titles, for 105 links/63 titles and 102 newly created ratings-only SKUs. Existing native rows are reused and sales estimates are untouched.

`reviews-ratings-aliases.ts` contains explicit App-ID-scoped critic aliases, not a global "strip Enhanced/Legacy" rule. The rendered card names the actual title-level aggregate; console-specific player ratings retain their native listing labels. Key evidence:

- GTA V PC variants: https://store.steampowered.com/app/3240220/ and https://store.steampowered.com/app/271590/; title aggregate https://opencritic.com/game/163/grand-theft-auto-v
- Crimson Desert: https://store.steampowered.com/app/3321460/; https://opencritic.com/game/19373/crimson-desert
- PUBG rename: https://www.gamespot.com/articles/playerunknowns-battlegrounds-just-got-a-new-name/1100-6494880/; https://store.steampowered.com/app/578080/
- Black Desert's own Steam description identifies Black Desert Online: https://store.steampowered.com/app/582660/
- FFXIV Steam identifies A Realm Reborn as the base game: https://store.steampowered.com/app/39210/
- Overwatch 2 was renamed, not reverted to the separate 2016 game's critic record: https://www.gematsu.com/2026/02/overwatch-2-drops-2-as-year-long-narrative-arc-begins-with-10-new-heroes-coming-to-switch-2-this-spring and https://store.steampowered.com/app/2357570/
- The Sims 4's original release is listed on Steam: https://store.steampowered.com/app/1222670/

Do not substitute expansion reviews for Path of Exile's missing base record, Switch-only Witcher Complete Edition reviews for the PC listing, the older 7 Days to Die console reviews for the current console version, or reviews with no verified release identity/score. Missing or unsafe matches stay unavailable. World of Warships: Legends and The Orange Box are not interchangeable rating sources for World of Warships and Team Fortress 2.
