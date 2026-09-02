# SentimentPulse Changelog

A running log of what changed in SentimentPulse — the community sentiment intelligence surface for Saber's game portfolio.

## September 1, 2026

- Fixed

  ### Reddit-comment posts no longer classified when their parent thread is off-topic

  When a subreddit was accidentally tagged as a game's dedicated community (e.g. r/Truckers for Road Kings, r/LogitechG for a peripheral thread), every comment on every parent thread inherited the tag and got a positive/negative sentiment label. Comments now defer to the tagger's tier verdict: signal/dedicated_sub parents still admit their comments; noise parents run the comment through the same keyword gate as any other broad-sub post.

- New

  ### Social-nicety pre-classifier gate

  Short comments consisting mostly of "thanks", "cool", "lol", "got it", "np", etc. now short-circuit to neutral BEFORE the RoBERTa model runs, regardless of admission tier. Fixes false-positive labels like "Thanks for this explanation" scoring Positive 0.68 for a game the commenter had never mentioned.

- Improved

  ### Posts view hides noise-tier posts by default

  The `/api/games/{id}/posts` endpoint no longer returns broad-sub keyword-miss posts unless you explicitly pass `?relevance=noise` (to see only noise) or `?relevance=all` (to include everything). This is a behavior change from the old "return everything" default, driven by the discovery that portfolio-wide noise-tier records were surfacing on the UI with stale positive/negative labels.

- New

  ### Admin cleanup endpoint for stale SentimentRecords

  New `POST /api/ingest/sentiment/cleanup_noise` deletes SentimentRecord rows attached to noise-tier RawPosts, portfolio-wide or per game. Idempotent, chunked, dry-run by default. Ran portfolio-wide on ship day and removed 133,886 phantom sentiment labels across 26 games (Turok 38,939, Jurassic Park: Survival 37,544, John Wick 19,200 were the worst offenders).

- Improved

  ### Resume-on-restart for interrupted ingests

  If a deploy or crash kills `run_ingestion()` mid-run, the next scheduled trigger now picks up where Phase A left off instead of restarting from game #1. Uses an `AppSetting['ingest_run_state']` marker with a 6-hour resume window so tomorrow's daily cron never accidentally inherits yesterday's marker.

- Improved

  ### Deploy waits for in-flight ingest before restarting the service

  `.github/workflows/deploy.yml` now polls `/api/ingest/status` every 15s for up to 20 minutes before restarting sentimentpulse.service. If ingest is running it waits; if not it proceeds immediately. Together with the resume marker above, this eliminates the class of bug where a mid-day deploy clobbered a live ingest.

- Fixed

  ### Truck-sim, peripheral, and industry subreddits now keyword-gated for all games

  Added `trucksim`, `EuroTruck2`, `snowrunner`, `Mudrunner`, `RoadCraft`, `Truckers`, `LogitechG`, `Fanatec`, and 5 more to `GENERAL_SUBS` so competitor-game and real-industry subs never auto-tag as any game's dedicated community. Discovered during the Road Kings contamination investigation.

## August 30, 2026

- New

  ### Competitive Set sub-section in the weekly digest

  For parent titles with tracked competitors, the digest now shows a Competitive Set sub-section comparing this title's pos/neg mix against each competitor's for the same 7-day window.

- Fixed

  ### Digest metrics strip agrees with the chart

  Weekly digest chart, volume commentary, and the parent metrics strip now all count the same posts: those in the game's dedicated Reddit sub + Steam Forum + Steam Reviews. Broad-keyword Bluesky and general-sub matches (which were inflating the strip) no longer reach either.

## August 27–28, 2026

- Fixed

  ### Press-headline and comment-parent ingestion unblocked

  A silent shadow-import regression in `_run_health_drop_check` was killing the press-headline ingest for all titles. Fixed. Comment-parent selection also had a mismatched fallback that skipped legit thread parents; fixed as part of the same push.

## August 17–19, 2026

- New

  ### SignalPulse PLS milestones overlay on the sentiment chart

  The main sentiment chart on each game's dashboard now shows dotted vertical lines at every PLS (Product Life Stage) milestone recorded in SignalPulse. Promotions get a distinct olive color. Hover for milestone name + date.

- New

  ### Posts by Source card + period-over-period deltas

  New card on each game's dashboard shows post volume ranked by source (Reddit, Steam Reviews, Steam Forum, Bluesky, DTF). Period-over-period % deltas indicate week/month/quarter trends.

- New

  ### Saber PLS annotations on the Post Volume by Title chart

  The portfolio-wide Post Volume chart now shows PLS annotations for Saber-published titles so you can visually correlate community activity with launches, patches, and promos.

- Fixed

  ### `?game=<id>` URL wins over localStorage on first mount

  Deep-linking to a game via URL now overrides the last-visited-game persisted in localStorage. Previously the deep link was silently ignored on first render.

- Fixed

  ### Steam Forum age gate no longer blocks mature-rated titles

  Some mature-rated forums (Warhammer 40,000: Space Marine 2, Hellraiser) were returning empty ingest passes because Steam intercepted with an age-verification page. Ingest now bypasses the age gate.

- Fixed

  ### Steam Reviews backfill runs alongside Forums on new-title onboarding

  Adding a game via `POST /api/games` now backfills both Steam Reviews and Steam Forum posts (previously only Forums). Onboarding backfill guard hardened so races don't cause double backfills.

## August 12–14, 2026

- New

  ### Dominant-topic gate on competitor subreddits

  Broad genre subreddits that primarily discuss a competitor game (e.g. r/Spacemarine dominated by SM2 talk) now require a distinctive keyword match before admitting posts as "signal" for a different title.

- Fixed

  ### Step 5 trusts the v3 relevance tagger's tier verdict

  Fixed the bug where Step 5 was throwing out ~97% of Space Marine 2's Reddit submissions from r/Spacemarine because the body text didn't restate the title — defeating the tier system. Signal and dedicated_sub rows now admit without a second keyword check.

- New

  ### `/api/games/{id}/classifier-audit` and `/api/games/{id}/audit` diagnostic endpoints

  New per-game endpoints report the distribution of `has_sentiment` vs `is_relevant` states, and the top noise-tier subreddits by count. Used by the morning scan and operator UI to detect keyword-list drift.

- Fixed

  ### British/US spelling variants for gaming-leaks-and-rumours

  The relevance tagger's dictionary had `gamingleaksandrumours` but not `gamingleaksandrumors`. Both variants now match.

- Fixed

  ### `UnboundLocalError` in `run_ingestion` + startup smoke test

  A function-local `from X import Y` inside `run_ingestion` was shadowing a module-level import, wedging every daily cron with an UnboundLocalError. Fixed, and added a startup smoke test that catches the class of bug on service start.

## August 6, 2026

- Fixed

  ### Topics no longer blank on every dashboard

  `_CM_MIN_DAYS=2` was mathematically unsatisfiable against Step 6's single-day input window, so every dashboard rendered empty top-topics lists. Gate rewired to look back across the actual analysis window.

## August 1, 2026

- Fixed

  ### Bluesky silent-source bug

  OR-joined keyword queries were returning 0 results because Bluesky's search API doesn't parse `OR`. Bluesky ingestion now runs one query per keyword and merges results client-side.

## July 27–30, 2026

- Fixed

  ### Dashboard "All" (lifetime) view no longer 500s on NULL-post_date rows

  Some RawPost rows have `post_date=NULL` (older ingests didn't capture it). The lifetime aggregation query now handles NULL post_dates cleanly instead of returning a 500.

- Improved

  ### Dashboard skips NULL-post_date RawPosts instead of falling back to collected_at

  Falling back to `collected_at` was distorting historical charts for backfilled titles. NULL post_dates now cleanly exclude a row from date-based aggregation.

## July 26, 2026

- New

  ### DTF.ru added as an ingestion source

  DTF is a large Russian-language gaming forum. Toggleable via `AppSetting['dtf_enabled']` runtime flag.

- Improved

  ### Post Volume by Title chart gets period-over-period % delta chip in legend

  Each title in the legend now shows a small green/red % chip indicating volume change vs. the prior equal-length window.

## July 25, 2026

- New

  ### Every new title auto-runs a 90-day Steam Forum backfill on add

  When you add a Saber title via `POST /api/games` or a competitor via the parent's settings card, the server now schedules a background job that walks up to 15 pages of Steam Forum listings for that game and pulls every post from the last 90 days. Reruns Steps 5–7 immediately so KPIs populate right away rather than waiting for the overnight cron.

- New

  ### Portfolio scan endpoint — discover new titles + detect forum-thread spikes

  New `POST /api/portfolio/scan` walks the configured publisher list looking for newly-added Saber games and hot 24-hour forum threads across the portfolio. Powers the weekday-morning portfolio scan cron.

- Improved

  ### Steam Forum daily ingest now paginates

  Daily ingestion walks up to 10 forum listing pages per game (~150 threads visible instead of the previous 15) so busy titles don't lose posts when new active threads push older ones off page 1 within a day. Dedup by external_id keeps re-scraping storage-free.

- Improved

  ### Steam Reviews and Steam Forum posts bypass the keyword relevance gate

  Posts on a game's own Steam store page are definitionally about that game — no franchise or dictionary noise is possible the way it is on cross-cutting Reddit/Bluesky feeds. Step 5 now auto-admits Steam Review + Steam Forum posts and skips the distinctive-keyword check for them.

- Fixed

  ### ILL false-positive fix — block fuzzy match on short-collision keywords

  "ILL" was picking up every occurrence of the word "ill" across Reddit ("I feel ill", "ill-advised", etc.). Fuzzy matcher now blocks 3-letter tokens from fuzzy-matching to game keywords.

- Fixed

  ### Competitor child pages resolve titles correctly and show back-to-parent breadcrumb

  Competitor child dashboards were rendering an empty line chart because the picker used `useGames` (Saber-published only) instead of `useGameDetail` (accepts any game_id). Fixed, and added a back-to-parent breadcrumb.

## July 24, 2026

- New

  ### Standalone Changelog page + footer link

  This changelog now renders at `/changelog` via a plain markdown file (`CHANGELOG.md` at repo root). No CMS, no DB — edit like any other doc. Footer link added to every dashboard.

- Fixed

  ### Off-by-one in dashboard period window

  Weekly / monthly / quarterly windows were including an extra hour at the tail, causing edge posts to appear in the wrong bucket. Windows now cleanly close at 00:00 UTC of the boundary date.

## July 23, 2026

- Improved

  ### Historical backfill endpoint (Reddit paged + Steam Reviews cursor)

  New admin endpoint walks Reddit's paginated search and Steam Reviews' cursor-based fetch to backfill posts from before the daily-ingest cron start date. Runs in the background, safe to trigger multiple times (idempotent by external_id).

## July 20, 2026

- Improved

  ### Trust-chain sentiment gate (§18) — 5 layers

  Sentiment classification now runs through language detection → signal-quality gate → title/body separation with combined score → confidence floor → gaming-domain lexicon overlay. Audit fields (`original_label`, `sentiment_conflict`, `applied_rules`) recorded on every SentimentRecord.

## June 29, 2026

- New

  ### Editorial summary layer — bold ideas, exec summary, recommended actions

  Weekly and monthly summaries now generate an executive summary paragraph, 5 recommended actions, and 3 bold ideas per title. Grounded by citation + self-criticism (§20 layers 3+4) so fabricated proper nouns get filtered out.

- Improved

  ### Commercial strategic context (CLAUDE.md §21)

  Summaries now amplify positive comparisons against tracked competitors instead of counter-positioning away. Preserves negative-topic coverage while highlighting relative strengths.

- Improved

  ### Recommendation-class critical mass (§21b)

  Only surfaces a recommendation when at least N distinct posts support the theme, preventing single-user complaints from becoming dashboard-level "recommended actions".

## June 24, 2026

- Improved

  ### Citation grounding + self-criticism on exec summaries

  Every claim in the executive summary now has to trace back to a specific post or thread; the LLM re-reads its own draft and drops sentences it can't cite. Reduces hallucinated numbers and fabricated player names.

## March 20, 2026

- New

  ### SentimentPulse launched

  First shipped version of SentimentPulse. Password gate (SABER), dark mode toggle, lightweight NLP mode, deploy script. Auto-refresh UI when ingestion completes, poll faster during runs. Multi-source ingest (Steam Reviews, Steam Forum, Reddit) + daily cron + per-game dashboards.
