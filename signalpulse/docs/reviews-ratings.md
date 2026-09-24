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

- Steam: current all-language, Steam-purchase review summary, positive reviews divided by total reviews. Native percentage and Valve description, not a converted star rating. Exact requested App ID.
- PlayStation and Xbox: latest existing lifetime store-rating observation for one verified family SKU, on the native five-star scale. Regional counts and averages are never summed or averaged. The source link identifies the selected storefront listing.
- OpenCritic: `percent_recommended`, `top_critic_score`, `tier`, `review_count`; never use percentile rank as a review score. These are title-level critic aggregates, not separate platform ratings.
- Captured dates describe when SignalPulse fetched the response, or the console observation date. They are not a guarantee that a scraper refreshed its underlying record that day. Scores are the latest available response, not a promised real-time feed.
- Genuine zero is preserved; missing scores remain null. A zero review count is not treated as a zero score.

## Coverage and identity

SignalPulse: portfolio product, standalone CCU, individual Steam/console sales, combined family and Amazon product detail pages. HMAP: Steam game detail, individual Buying title and combined Buying family pages. Sections follow existing media/product information where present. Roblox and Fortnite experiences have no equivalent mapped PC/console title identity and are not assigned unrelated store/critic scores.

OpenCritic matches require a unique exact normalized title, plus a matching Steam ID when available or corroborating release dates within 370 days. Words, numbers, editions, remasters and subtitles remain meaningful. Unverified matches fail closed. Demo/pass/playtest products never inherit the parent game's critic score.

Buying reuse is publisher-independent: mapped Saber and non-Saber titles read the same `platform_sku_map` identities and `store_rating_signal_daily` console observations. Family routes recognize both storefront and identity-checked IGDB spellings so existing Buying URLs resolve without changing critic search names. No additional PlayStation/Xbox fetches or sales calculations occur. Missing catalog SKUs still mean missing console coverage, not zero ratings.

Steam's Buying collector stores lifetime histogram up/down totals and a five-star conversion for estimation. Those histogram totals are not substituted for the separately filtered Steam-purchase review summary displayed here. All PDPs instead share the cached summary for the exact App ID. Metadata fallback requires exactly one successful record whose embedded App ID matches; conflicting/duplicate identities are rejected even if the outer response key differs.

Amazon uses the exact mapped product or the competitor's own Steam identity. A competitor pin's `parent_product_id` belongs to the tracked Saber parent and is deliberately not used as the competitor identity. Unmapped physical bundles/accessories show unavailable rather than guessing.

## Public API and cache behavior

`GET /api/reviews-ratings/{steam|title|family}/:id` is public-read. `{product|amazon}` remains behind existing SignalPulse authentication. HMAP exposes only the first three kinds.

All routes validate identities, rate-limit requests and return safe errors. The API key stays server-side. Public responses have a 30-second cache lifetime; private identities use private caching. Responses still refreshing use `no-store`.

- Steam and OpenCritic scores: 24-hour on-demand stale-while-revalidate cache.
- Negative matches and Steam identity: seven days.
- Failures: 30-minute backoff; retain last successful values with a stale label.
- Provider 401/403/429: shared 30-minute circuit breaker.
- Local provider guard: 900 attempted requests in a rolling 31-day window, including failed calls and title searches. This is conservative but is not an account-wide meter; other applications sharing the key can exhaust the provider quota sooner.
- First-time matches normally cost two requests; later refreshes use the saved OpenCritic ID and cost one. A 1,000-call plan cannot provide daily refreshes for a large catalog. The UI explicitly reports allowance exhaustion and keeps cached values.
- At most eight background refreshes run concurrently. Duplicate requests for the same identity share the in-flight refresh. Browser polling is bounded.
- HMAP uses the existing SignalPulse proxy with a 30-second ratings cache and does not cache refreshing responses.

Four additive, idempotently created tables: `review_rating_cache`, `opencritic_title_matches`, `opencritic_request_usage`, `review_rating_provider_state`. No existing tables are rewritten.

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
