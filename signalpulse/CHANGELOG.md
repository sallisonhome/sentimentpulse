# SignalPulse Changelog

A running log of what changed in SignalPulse — wishlist, sales, and revenue intelligence for Saber's PC and console portfolio.

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
