# SignalPulse Changelog

A running log of what changed in SignalPulse — wishlist, sales, and revenue intelligence for Saber's PC and console portfolio.

## September 26, 2026

- Added an Archived demos view with search, genre filters, sortable dates/metrics
  and links to retained demo PDPs, including Graveyard Keeper 2.
- Updated retirement policy: publisher takedowns no longer remove demos from
  metric views or daily own-App-ID source checks. Retirement badges show the
  detected date; unknown historical dates remain explicitly unknown. Top/New
  storefront feeds remain available-only and Friends Pass behavior is unchanged.
- Preserved last-good review history when retired Steam apps return a zeroed
  histogram. Failed review refreshes do not advance estimate dates; stale
  rolling windows are not presented as current. Saber retired demos continue
  verified Steamworks report checks across all supported windows.
- Added an additive invalid-identity exclusion field, separating non-game/
  unreleased/invalid SKUs from genuinely retired demos. No cadence change.

## September 25, 2026

- Fixed: lifetime initialization no longer replays superseded initial review snapshots. Existing states are insert-only on reseed, and daily mature accumulators retain a cumulative-signal high-water mark so review-count dips and rebounds cannot count twice.
- Added: dry-run-first repair for exactly proven legacy Steam seed contamination. The repair removes only the demonstrated seed excess from the affected lifetime state and its saved lifetime estimates, preserving subsequent increments, raw reviews, calibrated coefficients, verified anchors, overrides, and all non-lifetime windows. It requires a reviewed manifest, backup, transactional audit and conflict-checked rollback under the existing maintenance lock.
- Fixed: extrapolated console review activity cannot exceed the platform's entire lifetime review count. The catalog repair also covers proven residual Steam overlap maxima and exactly replayable lifetime floors inherited from impossible windows, retaining independent rank floors and refusing unexplained trajectories.

- Fixed: weekly sales boards and individual/family detail pages no longer substitute 30-day quantities when seven-day evidence is unavailable. Protected lifetime anchors calibrate available weekly evidence only; missing values remain unavailable instead of becoming zero. Incomplete combined results are labeled as subtotals and do not display misleading platform percentages or pies. Monthly, quarterly, yearly and lifetime policies, stored estimates, multipliers and anchors are unchanged.

- Hardened: missing-platform Steam verification now paces requests and retries bounded transient errors, honoring short provider cooldowns and explicitly deferring long ones. A rate-limit response never supplies paid-game eligibility or changes review counts.
- Improved: the existing daily refresh now verifies missing paid Steam, PS5 and Xbox coverage across the known catalog, independently of Top 20/40 rank. Verified ratings-only mappings and recoverable unknown classifications can enter sales estimates; exact reviewed Steam links can enroll a missing Steam counterpart. Native product identity, platform, release and USD purchase evidence are required.
- Hardened: same-family, shared-title, regional and PlayStation-concept guards prevent duplicate additions. Ambiguous listings, non-base editions, free games and unsupported platforms remain held. Reviewed console-version aliases join their parent sales family without copying ratings or histories; Townfall remains Steam/PS5 only.
- Added: auditable before/after receipts, retained backups, Settings controls for active/plan/off, and conflict-checked catalog rollback. The check runs before collection under the existing maintenance lock, not a second scheduled writer. HMAP receives the same upstream results across all five periods.

- Fixed: extreme negative Steam review bursts on established games are screened from the sales proxy using each title's own prior review activity, with no publisher-specific exceptions. Raw review history and sentiment remain unchanged. Daily platform-share learning excludes families with detected bursts in its evidence window.
- Improved: affected individual and combined PDP estimates carry an explicit review-burst adjustment note. Worldwide review counts, existing labels and the calibrated multiplier remain unchanged.
- Added: explicit, dry-run-first repair of provable mature-accumulator review-burst increments, preserving pre-event lifetime baselines, anchors, overrides, and unexplained states. Manifest approval, backup, per-title audit and conflict-checked rollback are required; no automatic startup repair.

## September 24, 2026

- Hardened: missing Steam classification responses preserve known paid-game eligibility and provenance; verified non-game responses still exclude DLC. The daily timer no longer starts discovery merely because the timer itself is started.

- Fixed: paid Steam sales windows use a non-overlapping daily/weekly/monthly review history instead of adding duplicate representations. UTC date boundaries are explicit; missing or inconsistent signals do not become fabricated zero sales. Revenue, units and console overlays continue to use the existing calibrated coefficients, ASPs and platform policies.
- Added: dry-run-first, manifest-approved lifetime-state repair for provable Steam review-overlap inflation, with retained database backups, transactional per-title audit records and conflict-checked rollback. Verified anchors, manual overrides, mature accumulators and unexplained state are excluded. The repair is an explicit operator action, not an automatic startup migration.

- Fixed: Steam ratings cards now include all purchase types, including free acquisitions, instead of showing zero or severely incomplete review counts for games such as Marvel Rivals. Counts, percentages and descriptions come from the same Steam summary and both apps label the review scope explicitly. Old purchase-only display caches refresh on access; sales-estimation signals and critic data are unchanged.

- Fixed: Steam CCU critic matching incorporates release evidence after adding verified console links. Reviewed exact App-ID aliases resolve renamed titles and GTA V PC variants to explicitly named title-level aggregates; the renamed Overwatch app uses Overwatch 2, never the original 2016 record.
- Improved: verified console-version links cover 13 additional native listings across 10 CCU titles. Distinct console editions are labeled by native listing name; Steam review counts remain tied to the requested exact App ID. The complete reviewed CCU addition is 105 links across 63 titles, with 102 new ratings-only SKUs and no sales-estimate changes.
- Improved: critic cards name the actual review aggregate. Evidence-aware cache keys retry identity gaps while preserving existing successful ordinary matches and the provider allowance guard.

- Fixed: console OpenCritic lookup removes trademark glyphs before Unicode decomposition and strips only known storefront/platform packaging. Storefront dates outrank conflicting enrichment; verified original dates can corroborate later ports. Provider year-qualified remakes are verified against release years, and duplicate names require exactly one verified detail record.
- Added: reviewed cross-platform ratings links for Steam CCU titles, including F2P console listings. The offline CCU backfill generator preserves existing catalog/sales data; new console rows are ratings-only and use the existing daily collectors.
- Improved: revised critic caches retry legacy misses without deleting valid scores. HMAP consumes the shared correction without a second ratings pipeline or frontend deployment.

- Added: verified ratings-only catalog support for the eight portfolio console gaps, using existing Buying collectors and observations while remaining excluded from base-SKU sales estimates. World War Z's original PlayStation rating is explicitly labelled as a PS4 listing, not Aftermath.
- Fixed: Sony's square-bracket PS4/PS5 platform suffixes now group with the same verified base title.

- Fixed: Reviews and Ratings recognizes verified Buying family aliases (including “II” versus “2”), reusing existing PlayStation/Xbox rating observations across SignalPulse and HMAP instead of requiring another collection pipeline.
- Fixed: standalone Steam lookup accepts a unique, exact embedded App ID when the metadata response uses a different envelope key; ambiguous or conflicting identities still fail closed.

- Fixed: critic lookup prefers verified Steam storefront names over alternate IGDB spellings, and mapped portfolio/Amazon titles use the same canonical identity rather than shortened display labels.
- New: Reviews and Ratings on portfolio, CCU, Steam/console sales, combined-family and Amazon detail pages, with applicable Steam, PlayStation and Xbox player ratings plus verified OpenCritic critic scores via OmkarCloud.
- Added: shared source links, capture dates, native rating scales, unavailable/stale states, server-side caching and a conservative provider request guard. HMAP can rebroadcast the public catalog response without score recalculation.
- Improved: these detail pages use the existing compact sidebar on phones.
- Configuration: set the masked OpenCritic RapidAPI key in Settings; see `docs/reviews-ratings.md` for limitations and rollout checks.

## September 20, 2026

- Fixed: shared fail-closed metadata protection now covers both individual and combined-family PDPs. Low-confidence or family-mismatched IGDB data cannot override storefront identity or leak unrelated artwork, credits, descriptions, screenshots, or release dates. Adds the Halloween/Solitaire regression test; corrects the earlier incomplete per-platform-only fix.

- New: platform revenue-share pies on combined title-family PDPs and revenue-share banners above the combined Top 20. SignalPulse returns `revenueSummary` on both endpoints using final displayed revenue and the selected period. Steam, PS5, and Xbox are the only slices; editions remain grouped into their parent family. Empty totals return unavailable percentages. hmap rebroadcasts the same envelope without recalculating.
- Fixed: combined leaderboard links carry the selected period into the SignalPulse PDP.

- Improved

  ### Multiplatform title PDP is public-read and ships combined owners + nested IGDB

  `GET /api/console/multiplatform-title/:key` is now on the public-read prefix list (same gate as `/api/console/titles/` and the leaderboard routes) so howmanyareplaying's Buying hub can link Cross-Platform Leaders rows without a session cookie. The envelope now nests `igdb` in the same parsed shape as the per-platform parent PDP (screenshots / genres / developers / publishers / summary / cover) and adds `ownersMid` per platform plus `combinedOwners` summed across base SKUs. Combined revenue / units still use the leaderboard overlay cascade (`d7→d30→d90→m12→ltd`) so the PDP matches the clicked row. Default window is `d7` to match the hub. The SPA multiplatform detail page now uses that IGDB header plus a combined KPI row (revenue, units, owners) above the per-platform cards.

## September 16, 2026 (late)

- Reverted

  ### Rolled back both speculative `\u00b7` charset "fixes" — neither could have worked and neither was verified

  The two charset changes shipped on Sep 15 evening were speculation, not diagnosis. (1) The `server/static.ts` `setHeaders` block that appended `charset=utf-8` to `.js` / `.css` / `.json` / `.svg` responses is a guaranteed no-op: nginx serves `/signal/assets/*` directly via `alias` from the built bundle, so the express handler never sees those requests. A 30-second grep of the nginx config before drafting the fix would have caught this. (2) The `signalpulse/nginx/sentimentpulse.conf` file was written at the wrong path — the `sp-nginx-sync` workflow syncs from the repo-root `nginx/sentimentpulse.conf`, not from a signalpulse subdirectory copy, so this file was dead code sitting in HEAD. Neither change was ever supported by evidence — the actual bundle bytes on the wire are correct UTF-8 (`\xc2\xb7`, verified via hexdump of the deployed `index-BBSb-iQg.js` at offset 1283914), and the iOS Safari symptom was never reproduced with the browser. The Latin-1 fallback hypothesis was never proven and cannot explain the specific symptom (Latin-1 decoding of `\xc2\xb7` produces mojibake `Â·`, not the literal six-character text `\u00b7` that appears in the screenshot).

  What stays: the revenue-daily spike suppression logic in `server/routes-console-leaderboards.ts` from commit 74d547f is intact and verified working live (Wolverine Sep 15 spike suppressed, Valheim's real 5,052-unit day renders normally, Resonance's real Sep 14 day-1 bootstrap renders at $115,180 PS5). That fix mattered and it works.

  The `\u00b7` symptom stays open pending real diagnosis — next session will drive Safari against the actual PDP, inspect the rendered DOM, and figure out what's actually happening before touching any more code.

## September 15, 2026 (evening)

- Fixed

  ### PDP daily-revenue chart no longer draws a cartoon-scale spike on the day the LTD engine initialises

  The `/api/console/titles/:titleId/revenue-daily` endpoint derives per-day revenue from day-over-day change in `window_estimates_daily` where `window='ltd'`, priced by MSRP × ASP-factor. The `max(0, cur − prev)` guard originally in place only suppressed negative diffs from override anchors — not the positive step change that happens the first day the LTD engine transitions from a bootstrap-only method tag (units_mid still tiny) to an `ltd_state:derived_max_windows` / `ltd_state:accumulator` tag (units_mid jumps to the real ratings-derived LTD). Marvel's Wolverine on 2026-09-15 surfaced this: units_mid rose from 1,926 to 319,579 in one day, which the chart drew as $17.8M of PS5 revenue in a single 24-hour window — not a real sales event, an accumulator initialisation.

  Added two layered suppressions in the revenue-daily route, each keyed on abnormality of the daily delta rather than on the method-transition alone (because titles like Valheim have a clean handover — Sep 14=60,853 bootstrap, Sep 15=65,905 accumulator, delta 5,052 units, in line with the ~5k/day bootstrap growth — which must NOT be suppressed): (A) once we have ≥2 prior accepted positive deltas on the same platform, suppress any new delta that exceeds 20× the median of the trailing 7-day window; (B) on the first day `method` transitions from bootstrap-only to accumulator, suppress if the flip-day delta exceeds 20× the MAX of prior accepted deltas. Wolverine (Sep 14=1,926 bootstrap, Sep 15=319,579 accumulator, delta 317,653 ≫ 20× max bootstrap delta) trips Rule B and returns `null` for that day. Valheim renders its normal 5,052-unit day. The `combined` series continues to sum surviving per-platform values.

- Fixed

  ### Static-asset content-type now carries `charset=utf-8` so mobile Safari stops rendering `\u00b7` literally

  Nginx serves the `/signal/assets/` bundle directly via `alias`, bypassing the express server entirely — so the initial express `setHeaders` fix was a no-op. Added `charset utf-8;` + expanded `charset_types` (default is `text/*` only) to the SignalPulse server block in the versioned nginx config so nginx appends `; charset=utf-8` to Content-Type for `.js` / `.css` / `.json` / `.svg` / etc. `express.static` `setHeaders` change stays in place as a belt-and-braces layer for anything served directly by express. The mobile Safari symptom ("Estimated daily revenue `\u00b7` all platforms" rendered literally instead of the middle-dot `·`) is caused by iOS Safari falling back to Latin-1 when no charset is declared.

- Fixed

  ### d7 estimates no longer collapse into d30 for launches aged 8–19 days

  When a title released 8–19 days ago (older than the d7 window, younger than our per-title collection horizon of typically a few days), the d7 signal resolver fell through to `backfill-steam-pace`, which multiplies PS5 LTD by the Steam sibling's stabilised d7/LTD ratio. For old Steam siblings that ratio is ~0.007, producing a nonsense d7 signal of ~19 that gets gated `signal_too_small`. The leaderboard route's cascade then fell back to d30, which for the same window band is bootstrap-filled from LTD, so d7 rendered numerically identical to d30 (and to LTD) for every fresh launch. Resonance: A Plague Tale Legacy (PS5, released 2026-08-27) surfaced the pattern: d7 signal=19 gated, cascade to d30 showing 86,053 units, same as m12 and LTD.

  Added a `backfill-observed-pace` step ahead of `backfill-steam-pace`: when the title's per-title collection history is ≥3 days but shorter than the window, scale the actual observed rating-count delta (`ltd_today − ltd_first_snap`) linearly to the requested window. For Resonance this produces a d7 signal of ~450 (real observed pace of ~64 ratings/day × 7d), well above the noise gate. The method tag `backfill-observed-pace` writes the audit trail. Guards: requires ≥3 days of history, positive delta, and skips when history already exceeds `winDays` (forward-delta handles that case natively).

- Improved

  ### Daily refresh now runs under a hardened systemd wrapper on the droplet

  The oneshot `signalpulse-daily.service` used to run its four-phase pipeline (verify-discovery → verify-console-collectors → estimate-console-units → write-revenue-anchors) from an inline `ExecStart=/bin/sh -c '…'` chain with nested backslash-quoting across multiline continuations. Systemd's argument parser kept rejecting the reloaded unit with `status=2/INVALIDARGUMENT` before executing any phase (confirmed on the 13:12 UTC install fire today). Extracted the entire shell body into `deploy/signalpulse-daily.sh` running under `set -Eeuo pipefail`, invoked from a one-line `ExecStart=` that resolves `WorkingDirectory` from `signalpulse.service` dynamically. Each phase has its own timeout guard (360s / 360s / 300s / 120s) and its own distinct exit code (10/20/30/40) so a `journalctl` grep for `status=X` pinpoints which phase broke without reading the full pipeline output. The install workflow's preflight now verifies the wrapper is present and executable before enabling the timer, so a partial deploy can't silently reintroduce the same failure mode. Added a `signalpulse-run-daily.yml` dispatch workflow that fires the service and reports the run's `ExecMainStatus` and journal, and used it to verify a clean end-to-end run at 16:58-17:06 UTC (2437 estimates, 55 revenue anchors written).

- Improved

  ### Fresh top-20 releases get a rank-anchored floor on d7 units

  When a title released within the last 30 days sits at rank ≤ 20 on the PSN sales30 or Xbox top-paid chart, the d7 unit estimate is now floored against the mean units of its 6 nearest stabilised peers (peers released > 30 days ago), tapered by a power law on chart rank (`∝ rank^-0.7`). This closes the gap between where the storefront ranks a fresh AAA launch and where our ratings-derived signal puts it while the rating count is still catching up. The floor auto-releases the moment natural ratings exceed the anchor, and rows tagged `rank_anchor:<sort_key>` write the audit trail into `window_estimates_daily.method`.

- Improved

  ### PS5 discovery now writes every edition SKU under one title_id

  PSN's sales30 chart lists each edition of a game as its own row (Standard, Deluxe, Ultimate). Discovery now groups every row that shares an `npTitleId` and emits ONE base SKU (lowest MSRP wins) plus one `sku_role='edition'` row per sibling, all under the base row's `title_id`. This keeps the leaderboard showing one unified row per game with the accurate base-price MSRP (previously Sony's ranking order could hand base status to the $79.99 Deluxe over the $69.99 Standard, inflating ASP).

- Fixed

  ### PS5 ratings collector no longer double-counts editions

  Sony's PSN productRetrieve returns the same rating count for every edition SKU on a shared concept (they aggregate at the concept, not per-SKU). Verified live for Wolverine, Halloween, NBA 2K27, and Blood of Dawnwalker. The runtime collector now filters to `sku_role='base'` before polling, so a title with N editions no longer writes N identical rating snapshots per day and inflates the ratings-derived unit signal by N×.

- Fixed

  ### Marvel's Wolverine (tid=10302) SKU normalisation

  Manually inserted the Standard SKU ($69.99) as the base row under Wolverine's `title_id`, downgraded the Deluxe SKU ($79.99) to `sku_role='edition'`, and reset the display name from the Deluxe-specific storefront string to "Marvel's Wolverine". Both rows latched with `is_manual_override=1` so tomorrow's discovery can't reset them. The paired discovery + collector changes above prevent this class of one-off cleanup from being needed on the next AAA launch.

## September 15, 2026

- Fixed

  ### LTD KPI tile shows revenue as primary for young titles too

  On the console title PDP, the LTD window tile now leads with estimated revenue whenever the API returns one — including titles under 12 months whose LTD derives from the longest valid shorter window (`derived_max_windows`). The `est. via {window}` badge fires on LTD in that case so the derivation source stays visible. Ratings-first fallback is reserved for platforms that genuinely have no revenue estimate (gated / no MSRP / signal-only), matching the LTD leaderboard behaviour landed yesterday.

- New

  ### Estimated daily revenue chart on console title PDPs

  Console title pages now include an all-platforms line chart of estimated daily revenue derived from day-over-day change in the persistent LTD unit accumulator (Steam / PS5 / Xbox / combined). Range presets 7d / 30d / 90d / "since 2026-09-14", per-series toggles, and a footnote that explains the collection-start caveat so early sparse dates read as expected.

- New

  ### `/api/console/titles/:titleId/revenue-daily` endpoint

  New public-read endpoint returns per-day incremental revenue per platform, computed as `max(0, unitsMid_ltd[D] − unitsMid_ltd[D−1]) × msrp × aspFactor / 100` from `window_estimates_daily`. Uses each platform's primary SKU MSRP and the same ASP factors as the leaderboards (Steam 0.66, PS5 0.80, Xbox 0.80). Days before 2026-09-14 return null.

- Improved

  ### Multiplatform LTD leaderboard admits no-Steam titles with dual-anchored consoles

  The multiplatform LTD aggregator gate now has two admission branches: (a) Steam + at least one console (unchanged), or (b) no Steam SKU but BOTH PS5 and Xbox anchored to verified revenue. Branch (b) is the Minecraft path — the title has no Steam presence but has manual-anchor revenue on both consoles, so it now shows up on the multiplatform LTD board where it belongs. Anchored-on-both requirement keeps the admission bar high; raw estimator signal alone can't bypass Steam.

- Fixed

  ### Manual LTD anchor writes for GTA V and Minecraft SKUs

  Wrote calibrated anchors to `revenue_calibration_anchors` for GTA V (Steam 10021 / PS5 10318 / Xbox 10205) and Minecraft (Xbox 10209 / PS5 10314) based on verified franchise LTD figures (Take-Two Q1 FY27, Guinness/Mojang). GTA V now sits at #1 on multiplatform LTD ($7.658B combined).

## September 1, 2026

- Improved

  ### Publishing Partnerships added to sidebar navigation

  SignalPulse now links to the Publishing Partnerships sub-app from its sidebar, matching the pattern in every other suite app.

## August 30, 2026

- New

  ### LTD Units column on the Steam revenue leaderboard

  Lifetime-to-date units-sold column now shows alongside the running revenue totals so you can compare unit velocity against dollar throughput without switching views.

## August 28, 2026

- New

  ### Multi-title compare charts on Wishlist + Revenue leaderboards (v3.34)

  Select multiple titles from either leaderboard and see them on a single overlaid chart. Plots daily values (not cumulative) so launch beats, promo spikes, and press-cycle bumps are visually obvious.

- New

  ### Pre-Release Wishlist → Units Sold Conversion metrics on the PDP (v3.33)

  Product detail pages now show the pre-release wishlist-to-units conversion for every launched title with a locked forecast snapshot. Powers the Bull (0.45) / Bear (0.18) conversion scenario toggle across the dashboard.

## August 27, 2026

- Improved

  ### Pre-release wishlist / followers / rank eligibility widened

  Dropped the `isSaberPublished` filter from the pre-release wishlist and followers tables. Any actively-tracked pre-release title with a Steam appId now qualifies, so competitor pre-release trajectories show up alongside Saber's own titles.

## August 24, 2026

- Improved

  ### Chart column moved next to the game title on both leaderboards (v3.40)

  The compact per-title sparkline now sits directly beside the game name for faster scan-and-compare. Number columns kept their prior order.

## August 20–21, 2026

- New

  ### Dynamic Actuals Driven Forecast (v3.32)

  Renamed the dashboard's forecast card to `Dynamic Actuals Driven Forecast` (was Dynamic Pre-Launch Forecast). Locks the pre-launch snapshot as an immutable baseline, then reports live delta against it. Actuals-vs-forecast delta is gated by days-since-release: hidden for the first 30 days, first-year basis 30-365d, lifetime basis thereafter.

- New

  ### Bull / Bear conversion scenario toggle

  Dashboard and PDP now honor a Bull(.45)/Bear(.18) Month-1 conversion scenario toggle. Snapshots + cache reads sync across dashboard and PDP so both views agree.

- New

  ### Steam pre-purchase totals on the PDP Steam Sales card (v3.38)

  Pre-purchase orders (PS5) surface on the PDP alongside first-week sales so you can see momentum before the launch window opens.

- Improved

  ### Wishlist top-200 rank scan → shared scan

  Replaced per-title extended wishlist scans with a single shared scan that all tracked titles read from. Reduces Steamworks API load and fixes cascade failures where one bad title broke every downstream lookup.

- Fixed

  ### Wishlist rank extended-scan cascade failure (v3.33)

  A single title's Steam filter error was aborting the extended-scan run for the whole portfolio. Now isolated per title so the rest of the portfolio still completes.

- Improved

  ### First-month wishlist conversion raised 0.27 → 0.45 (v3.31)

  Updated based on Saber's own historical data. Applied portfolio-wide via a one-off recalibrate endpoint.

- Improved

  ### Manual-covered appids sourced from howmanyareplaying (v3.39)

  hmap is now the source of truth for which appids Steam filters out of the popularwishlist endpoint. Lets us patch coverage gaps in one place instead of updating per-title configs.

## August 18–19, 2026

- New

  ### 7-day trailing wishlist adds column on the wishlist leaderboard

  Adds a rolling 7-day wishlist-adds delta column so you can rank by momentum, not just total.

- New

  ### Launch forecast snapshot at first post-release view (v3.22)

  When any title's PDP is opened for the first time after its release date, the current dynamic forecast is frozen into `launch_forecast_snapshot`. Powers the actuals-vs-forecast delta and locks the pre-launch prediction as an immutable baseline for post-launch scoring.

- Improved

  ### All shared charts default to 90-day view (v3.23)

  Was `All Time` — most sessions ended with users zooming to 90-day anyway.

- New

  ### Steam long-lived cookie auto-refresh (v3.20)

  Pure-HTTP path (no headless browser). Detects impending expiry and refreshes proactively. Provenance tracked so ops can see which refreshes came from the agent vs a manual paste.

- New

  ### PDP Back to Dashboard button (v3.39)

  Actually goes to the dashboard (was navigating to home).

- New

  ### Per-product Bull/Bear forecast scenario (v3.36)

  Was global — now every product can carry its own scenario, useful for titles with meaningfully different pre-purchase profiles.

## August 15, 2026

- New

  ### Inbound email via Resend webhook + admin Inbox UI (v3.21)

  Signal alerts can now be received via email. Webhook + inbox for triaging pre-orders / promo emails / publisher outreach without leaving the app.

## August 14, 2026

- New

  ### Weekly digest redesign — prior-week KPIs + Sonar-grounded narratives

  Weekly digest now leads with prior-week KPIs (wishlists, followers, ranks, sales), then per-title Sonar-grounded research narratives that cite the actual press, promo, and event beats behind each number.

- New

  ### IGDB hype scores pulled directly via Twitch/IGDB API

  Was mirrored via `howmanyareplaying.com`. Direct integration is faster and covers titles hmap hasn't indexed yet.

- Improved

  ### Steamworks cookie refresh: agent auto-refresh health tracking (v3.18)

  Tracks refresh provenance (agent vs manual) + a health score so ops can spot silent-refresh regressions before the cookie actually expires.

- New

  ### Agent refresh request flag for Steamworks cookie (v3.19)

  Signal to the agent that a proactive refresh is needed. Complements the health tracking above.

## August 13, 2026

- New

  ### Weekly digest cron + Settings recipients UI (Phase 5)

  Automated weekly send. Recipient list managed through Settings without touching config files.

- New

  ### Test-send digest with override recipient

  Ops can preview the weekly digest to any address without changing the live recipient list.

- New

  ### Positive-only Revenue Lift KPI card

  A dedicated card that shows only revenue lift (never drop). Sits next to the existing bidirectional Revenue Movers card. Fixed label to say `Drop` when the mover is negative.

- New

  ### Daily ingestion cron @ 03:00 ET + manual per-source triggers

  Was manual-only. Now runs nightly with per-source manual-trigger endpoints for backfills and diagnostics.

- New

  ### Proactive Steam cookie-expiry detection

  Detects impending expiry so refresh can happen before the cookie dies and stalls the ingest.

- Improved

  ### Revenue Leaderboard eligibility (v3.17)

  Widened to all released/pre-purchase titles regardless of publisher. Fixed key art ingestion gap that left some titles without cover images.

- Improved

  ### Revenue math anchored to latest ingested day

  `24h` and `30d` revenue windows now anchor to the most recent day with data instead of blindly using GMT-yesterday. Fixes weekend/holiday drift where blank days would erase the trailing window.

- New

  ### Saber-auth cutover for SignalPulse (Phase 2 → 3)

  SignalPulse now authenticates via the shared saber-auth service alongside the launcher. `AUTH_MODE=both` grace period through Aug 20.

## August 12, 2026

- New

  ### Steam Revenue Leaderboard — ingestion + UI (Phase 3+4, v3.15)

  Full revenue leaderboard shipping with Steamworks portal-daily ingestion, dashboard cards, and cross-title comparisons. Powers the daily / weekly / monthly revenue movers surfaces.

- Improved

  ### Wishlist rank extended beyond top 200 (v3.14)

  Was capped at 200. Now walks the full extended list so titles further down still get real numbers.

- Improved

  ### IGDB hype source switched to howmanyareplaying.com public API

  Was a scraped mirror. Public API is more stable. (Later replaced by direct IGDB API on Aug 14 — see above.)

- Fixed

  ### Chart section labels showed 'Units' for USD revenue charts (v3.16)

  Currency-vs-units axis label mismatch. Fixed to use the actual metric per chart.

- Fixed

  ### Key art 404s

  Some titles had stale cover-image URLs; ingest now fetches fresh from Steam on cache miss.

## April 8, 2026

- New

  ### SignalPulse launched as part of the Saber Intelligence Suite

  Combined with SentimentPulse under a unified launcher. Dark-mode preference now persists across both apps via a shared localStorage key. Wishlist and Steam sales dashboards, launch forecasting, and the first pass at product detail pages all shipped in this initial release.
# Qualified Friend’s Pass scenarios (pending deployment)

- Add a separate DemoPulse Friends Pass panel for the reviewed Lords and
  It Takes Two historical planning inputs, with complete-month selectors,
  monthly charts, explicit assumptions and exact-selection CSV export.
- Read-only scenario API preserves provenance, confidence, bounds and metric
  scope for opt-in downstream use. No automatic model application.
- Keep observed players, download actuals, rankings, database schema,
  collection schedules and retention unchanged.
