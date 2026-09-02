# Saber Intelligence Suite — What's New

A running suite-wide log of what shipped across every app. Each entry is tagged with the owning app. For per-app detail, see:

- [SentimentPulse](CHANGELOG.md)
- [SignalPulse](signalpulse/CHANGELOG.md)
- [Trip Tracker](triptracker/CHANGELOG.md)
- [GTM Studio](gtm/CHANGELOG.md)
- [Genre Pulse](genrepulse/CHANGELOG.md)
- [Publishing Partnerships](partnerships/CHANGELOG.md)
- [Launcher](launcher/CHANGELOG.md)

---

## September 1, 2026

- New

  ### SentimentPulse: Chart-drop fix — Competitive Set graphs now hardened into every parent-child digest

  Root-caused the missing charts on today's weekly digest send. A UNIQUE-constraint race in the editorial-articles cache was poisoning the SQLAlchemy Session, cascading into `_build_competitor_bullets` silently returning None, which dropped the entire Competitive Set section (chart + volume bullets + topic bullets) for every parent title with configured competitors. Fix has three layers: dedup within the editorial fetch batch, cross-batch DB existence check before add, and rollback+retry in the competitor-bullets loader. Locked in with 3 regression tests. Charts are back and now robust against future session-poisoning from any other source.

- New

  ### SentimentPulse: Reddit-comment tier-aware admission gate + social-nicety pre-classifier

  Comments on noise-tier parent threads no longer skip the keyword gate. Short comments consisting mostly of "thanks / cool / lol / got it" now short-circuit to neutral before the model runs. Fixes false-positive labels like "Thanks for this explanation" scoring Positive for a game the commenter had never mentioned. Also deleted 133,886 stale positive/negative labels attached to noise-tier posts across 26 games (worst offenders: Turok 38,939, Jurassic Park: Survival 37,544, John Wick 19,200).

- New

  ### SentimentPulse: Resume-on-restart + deploy-wait for interrupted ingests

  If a deploy or crash kills the daily ingest mid-run, the next scheduled trigger picks up where it left off (6-hour resume window). Deploys now poll `/api/ingest/status` and wait up to 20 minutes for an in-flight ingest to finish before restarting the service.

- New

  ### SentimentPulse: Posts view hides noise-tier posts by default

  `/api/games/{id}/posts` now excludes broad-sub keyword-miss posts unless you pass `?relevance=noise` or `?relevance=all`. Cleans up the operator UI so mistagged posts don't surface with stale positive/negative labels.

- New

  ### SentimentPulse: Reclassify by authored-date window

  New `post_days_ago_start` + `post_days_ago_end` params on the reclassify endpoint filter by `COALESCE(post_date, collected_at)` instead of `processed_at`. Lets ops backfill a specific historical range without redoing already-reclassified rows.

- Improved

  ### Suite-wide: Publishing Partnerships added to launcher + all sub-app sidebars

  New sixth app now reachable from the launcher home page and from every sub-app's sidebar.

## August 31, 2026

- New

  ### Publishing Partnerships launched

  Sixth app in the suite. Tracks non-cash publishing opportunities per title — first-party feature slots, storefront placements, discovery quests, cross-promo trades — with per-title timelines. Express + Vite + React + Drizzle. Full deploy wiring (nginx + systemd + workflow) shipping the same day.

- New

  ### SentimentPulse: Daily-volume chart + topic-quality floors + per-competitor bullets

  Digest chart shows actual daily post counts (no smoothing) so beats and spikes show. One line per title. Chart series filters to dedicated-community volume only so broad-keyword Bluesky/general-sub matches don't inflate calendar-word / franchise-name titles. Parent metrics strip filters to `dedicated_sub` too so numbers agree across chart, caption, and strip.

## August 30, 2026

- New

  ### SentimentPulse: Competitive Set sub-section in the weekly digest

  For parent titles with tracked competitors, the digest now shows a Competitive Set sub-section comparing this title's pos/neg mix against each competitor's for the same 7-day window.

- New

  ### SignalPulse: LTD Units column on the Steam revenue leaderboard

  Lifetime-to-date units-sold column now shows alongside running revenue totals.

## August 28, 2026

- New

  ### SignalPulse: Multi-title compare charts on Wishlist + Revenue leaderboards

  Select multiple titles from either leaderboard and see them overlaid. Plots daily values (not cumulative) so launch beats, promo spikes, and press-cycle bumps are visually obvious.

- New

  ### SignalPulse: Pre-Release Wishlist → Units Sold Conversion metrics on the PDP

  PDP shows the pre-release wishlist-to-units conversion for every launched title with a locked forecast snapshot. Powers the Bull (0.45) / Bear (0.18) conversion scenario toggle.

## August 27, 2026

- Fixed

  ### SentimentPulse: Press-headline ingest + comment-parent selection (v0027)

  Strict distinctive-keyword gate was over-dropping press headlines during Gamescom (e.g. "Halo 3 anniversary edition coming to PC — Gamescom reveal" got dropped because it lacked a distinctive-keyword variant). Fix: the game's own name is now an implicit companion keyword when it's multi-token or ≥8 chars. Step 4a comment window widened 3d → 7d and keyed on `COALESCE(post_date, collected_at)` so backfilled rows don't get mis-sorted.

## August 24, 2026

- Improved

  ### SignalPulse: Chart column moved next to game title on both leaderboards

  Compact per-title sparkline now sits directly beside the game name for faster scan-and-compare.

## August 20-21, 2026

- New

  ### SignalPulse: Dynamic Actuals Driven Forecast + Bull/Bear scenario toggle

  Renamed dashboard forecast card. Locks the pre-launch snapshot as an immutable baseline, then reports live delta against it. Bull(.45) / Bear(.18) Month-1 conversion scenario toggles across dashboard + PDP. Steam pre-purchase totals surface on the PDP Steam Sales card. Wishlist top-200 rank scan consolidated into a single shared scan (was per-title). First-month wishlist conversion raised 0.27 → 0.45 based on Saber's own history.

## August 18-19, 2026

- New

  ### SignalPulse: Launch forecast snapshot + Steam long-lived cookie auto-refresh

  Launch snapshot freezes on first post-release PDP view — locks the pre-launch prediction as the immutable baseline for post-launch scoring. Steamworks cookie now refreshes proactively via pure-HTTP (no browser) with provenance tracking. All shared charts default to 90-day view.

- New

  ### SentimentPulse: SignalPulse PLS milestones overlay on the sentiment chart

  Sentiment chart now shows dotted vertical lines at every PLS (Product Life Stage) milestone recorded in SignalPulse. Promotions get a distinct olive color. Also new: Posts by Source card + period-over-period % deltas.

## August 15, 2026

- New

  ### SignalPulse: Inbound email via Resend webhook + admin Inbox UI

  Signal alerts can now be received via email. Webhook + inbox for triaging pre-orders / promo emails / publisher outreach without leaving the app.

## August 14, 2026

- New

  ### SignalPulse: Weekly digest redesign — prior-week KPIs + Sonar-grounded narratives

  Weekly digest leads with prior-week KPIs (wishlists, followers, ranks, sales), then per-title Sonar-grounded research narratives citing the actual press, promo, and event beats behind each number.

- New

  ### SentimentPulse: Dominant-topic gate on competitor subreddits (v0028)

  Broad genre subreddits primarily discussing a competitor game (e.g. r/Spacemarine dominated by SM2 talk) now require a distinctive keyword match before admitting posts as "signal" for a different title.

## August 13, 2026

- New

  ### SignalPulse: Weekly digest cron + Settings recipients UI

  Automated weekly send. Recipient list managed through Settings. Positive-only Revenue Lift KPI card added alongside the existing bidirectional Revenue Movers card. Daily ingestion cron @ 03:00 ET with per-source manual triggers for backfills.

- New

  ### Launcher: Saber-auth cutover

  Launcher now authenticates via the shared saber-auth service. Grace-week overlap with the legacy flow through Aug 20. SignalPulse cutover shipped in parallel.

## August 12, 2026

- New

  ### SignalPulse: Steam Revenue Leaderboard — ingestion + UI

  Full revenue leaderboard shipping with Steamworks portal-daily ingestion, dashboard cards, and cross-title comparisons. Powers the daily / weekly / monthly revenue movers surfaces. Wishlist rank extended beyond top 200.

## August 6, 2026

- Fixed

  ### SentimentPulse: Topics no longer blank on every dashboard

  `_CM_MIN_DAYS=2` was mathematically unsatisfiable against Step 6's single-day input window. Gate rewired to look back across the actual analysis window.

## July 27, 2026

- Fixed

  ### Launcher: Stale-browser-cache after deploys

  Touched `index.html` on every deploy and installed an nginx no-cache header.

## July 26, 2026

- New

  ### SentimentPulse: DTF.ru added as an ingestion source

  DTF is a large Russian-language gaming forum. Toggleable via runtime flag.

## July 25, 2026

- New

  ### SentimentPulse: Auto-onboarding — every new title gets a 90-day Steam Forum backfill

  Adding a Saber title via `POST /api/games` (or a competitor via the parent's settings) now triggers a background 90-day Steam Forum backfill and re-runs Steps 5-7 so KPIs populate right away.

- New

  ### SentimentPulse: Portfolio scan endpoint

  `POST /api/portfolio/scan` walks the configured publisher list looking for newly-added Saber games and hot 24-hour forum threads across the portfolio. Powers the weekday-morning portfolio scan cron.

## July 24, 2026

- New

  ### SentimentPulse: Standalone Changelog page + footer link

  A plain markdown file at repo root (`CHANGELOG.md`) rendered as `/changelog` in the app. No CMS, no DB. Now generalized to a suite-wide roll-up.

## July 20, 2026

- New

  ### Trip Tracker: Download Trip Report PDF

  One-click export of any trip report as a formatted PDF suitable for forwarding to partners, executives, or archive.

- New

  ### SentimentPulse: Trust-chain sentiment gate (§18) — 5 layers

  Sentiment classification runs through language detection → signal-quality gate → title/body separation → confidence floor → gaming-domain lexicon overlay. Audit fields recorded on every SentimentRecord.

## July 18, 2026

- New

  ### GTM Studio: v7.3 polish pass

  Wizard: TypeScript strict build gate, Step 4 crash fix, Step 1 ReferenceError fix, genre dropdown with custom fallback. Slides: Slide 1 subtitle refresh, Slide 4 no-truncate, Slide 6 wide KPIs, USP + Challenges slides go full-width. Preview: real PNG filenames from backend, 500 fix on empty platforms.

## July 15, 2026

- New

  ### GTM Studio: v6.0 — 6-slide pack + design pass

  Reordered slide sequence. Design pass across every slide 2-6 for typography, spacing, and visual language.

## June 24-29, 2026

- New

  ### SentimentPulse: Editorial summary layer + citation grounding

  Weekly + monthly summaries generate an exec summary, 5 recommended actions, and 3 bold ideas per title. Grounded by citation + self-criticism (§20 layers 3+4) so fabricated proper nouns get filtered out.

- New

  ### Trip Tracker: Confirm-or-Omit citation grounding on exec summaries

  Every claim in the exec summary paragraph traces back to a specific note or citation; the LLM drops sentences it can't cite.

## May 27, 2026

- New

  ### GTM Studio: in-app deck viewer

  Preview and share decks inside GTM Studio without downloading.

## May 19, 2026

- New

  ### Genre Pulse: Platform Mix widget

  Port of the Platform Mix widget from howmanyareplaying.com.

## May 15, 2026

- New

  ### GTM Studio launched

  Fifth app in the suite. Renderer package + FastAPI backend + React/Vite/Tailwind frontend. Admin auth, delete/restore/purge/audit/password, and rate limiting all shipping in the initial pass.

- Improved

  ### Genre Pulse: Median Units Sold + Median Est. Gross Sales

  Mirrored the hmap change from average to median. Median is far more robust for genre analysis where a handful of megahits skew averages.

## May 4, 2026

- New

  ### Genre Pulse launched

  Fourth app in the suite. Mirrors howmanyareplaying.com via nginx proxy so genre-level PC market intelligence lives right alongside SentimentPulse, SignalPulse, and Trip Tracker.

## April 9, 2026

- New

  ### Trip Tracker launched

  Third app in the suite. PostgreSQL backend, cross-navigation with SentimentPulse and SignalPulse, shared theme, launcher card. Renamed to "Saber Trip/Show & Partner Meeting Report Tracker" everywhere shortly after launch.

## April 8, 2026

- New

  ### Saber Intelligence Suite launched

  First shipped version of the unified launcher, combining SentimentPulse + SignalPulse under one Saber-branded home page. Dark-mode preference persists across apps via a shared localStorage key.

## March 20, 2026

- New

  ### SentimentPulse launched

  First shipped version of SentimentPulse. Password gate (SABER), dark-mode toggle, lightweight NLP mode, deploy script. Multi-source ingest (Steam Reviews, Steam Forum, Reddit) + daily cron + per-game dashboards.
