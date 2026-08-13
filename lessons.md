# Lessons Learned — Agent Working Notes

A running list of mistakes the agent has made on this project and corrective
rules to prevent them from happening again. Every entry references the
session date so future agents can reconstruct context.

---

## 2026-08-12 (signalpulse) — portal-daily-backfill's delete-then-recreate wasn't idempotent; re-running it over dates that already had real data silently deleted Space Marine 2's Steam sales history (1,342 → 11 rows)

**RESOLUTION (same day, ~4:57pm ET).** Fix committed (`fd3980a`→`0674ce3` after rebase) and deployed via the normal `main`→GitHub Actions→droplet pipeline. Verified idempotency on a 2-day test window (`2024-05-23`→`2024-05-24`) run twice before touching the full range — both runs returned `2/2 succeeded, 0 failed` with identical row values. Then re-ran the full backfill: Toxic Commando (product 10) completed **358/358 succeeded, 0 failed**, restoring 244 real rows (better than the ~203 documented pre-incident baseline). SM2 (product 3) completed **1,342/1,342 succeeded, 0 failed**, restoring `steam_sales_daily` to LTD 5,419,330 units / $250,617,437 base revenue. Confirmed on the live dashboard (`http://104.236.239.46/signal/#/products/3`) that `dynamicFullForecasts` is actuals-driven again: PC (Steam) Dynamic First Month = 1,161,915, Dynamic LT = 5,419,330 — matching pre-incident figures.

**New wrinkle found during the restore: an unrelated concurrent deploy interrupted the SM2 job mid-run.** About 90 seconds after starting the SM2/Toxic Commando restore jobs, a *different, unrelated* push to `main` (`sentimentpulse: Step 5 trusts relevance_tier...` — a SentimentPulse Python-side fix, not a SignalPulse change) triggered the shared "Deploy to Droplet" workflow, which restarts services on the droplet as part of its deploy step. That restart wiped the in-memory `backfillJobs` Map mid-run (per the existing rule below on in-memory job registries), silently killing the SM2 backfill at ~13/1342 days and knocking Toxic Commando back to 0 rows. Neither job's own status endpoint reported this as a failure — the job ID just started returning `404 Job not found` after the restart, which is a *different* failure signature than `daysFailed` and easy to miss if you only check for the latter. Caught it by cross-referencing `gh run list` timestamps against when the restore jobs were started, then re-ran (safe because idempotency was already fixed and verified).

> **Addendum to the in-memory-job-registry rule below: ANY deploy to the shared droplet can kill a running SignalPulse backfill job, not just a SignalPulse deploy.** `sentimentpulse` and `signalpulse` share one "Deploy to Droplet" restart step. A push to the unrelated Python/SentimentPulse codebase, from a different session or teammate, restarts the same droplet processes. Before starting a long-running backfill, there is no way to block other sessions from deploying — so treat every long backfill as interruptible by surprise, poll for `404 Job not found` (not just `daysFailed`) as a distinct interruption signal, and re-check `gh run list` timestamps against job start times whenever a job's progress looks stalled or the job ID stops resolving.

**What happened.** While re-running Steam sales-actuals backfills for all 9 products with corrected announce-date windows, I noticed SM2's `dynamicFullForecasts` had regressed and spot-checked its `steam/prepurchases` endpoint: `2024-05-23` (previously present with `cumulativeCount=333,451`) was `MISSING`. The backfill job for SM2 (`portal-daily-1786556537480-mjn5gc`, 2022-12-09→2026-08-11) eventually finished at **541/1,342 succeeded, 801 failed** — and because of how the failure happened (see root cause), the 801 "failed" days weren't skipped, they were **actively deleted**. By the time I checked again an hour later, SM2's `steam/prepurchases` endpoint had fallen from 1,342 rows to just **11** (only the last few days, which had never been touched by an earlier run and so never collided). Toxic Commando (product 10) hit the same bug from an earlier superseded job with an overlapping date range, and I made it *worse*: I re-triggered its backfill as a "retry" **before deploying the fix**, so the retry hit the identical bug again and dropped it from 203/358 succeeded to 114/358 succeeded.

**Root cause.** `runPortalDailyJob` in `server/routes.ts` does, per day: `storage.deleteSteamSalesByBatch(batchId)` → `storage.createSteamSalesUploadBatch({id: batchId, ...})` → `storage.upsertSteamSalesRows(rows)`, where `batchId = portal-daily-{productId}-{date}` is **deterministic** (same value every time that product+date is backfilled). `deleteSteamSalesByBatch` only ran `DELETE FROM steam_sales_daily WHERE batch_id = ?` — it never deleted the matching row in `steam_sales_upload_batches` (the audit/metadata table, primary-keyed on that same `id`). So on any re-run of a date that had been successfully backfilled before (by an earlier session, or an earlier overlapping job), the sequence was: (1) delete the real sales rows for that date — **succeeds**; (2) insert a new batch metadata row with the same id — **throws `UNIQUE constraint failed`** because the stale metadata row from the first run was never cleaned up; (3) the `if (rows.length > 0) { createBatch(); upsertRows(); }` block throws on step (2), so `upsertSteamSalesRows(rows)` — the line that would have put the real data back — **never runs**. The `catch` block marks the day `daysFailed++` and moves on. Net effect per affected day: real production data deleted, never replaced, silently, one HTTP-response-truncated-to-20-errors away from being noticed (the job response caps `errors` to the first 20 for payload size, so the true 801-day scope was invisible until row counts were checked directly).

**Compounding mistake.** When Toxic Commando showed a wall of `UNIQUE constraint failed` errors, I treated it as "the old superseded job is still running, race condition, retry once it's done" and re-triggered the exact same buggy code path — instead of first asking *why* a UNIQUE constraint would fire on a delete-then-insert sequence at all. That question would have found the root cause immediately (deleteSteamSalesByBatch doesn't touch the metadata table) without a second destructive run.

**Fix.**
- `storage.ts`: `deleteSteamSalesByBatch(batchId)` now also runs `DELETE FROM steam_sales_upload_batches WHERE id = ?`, so the delete-then-recreate sequence is actually idempotent — re-running a backfill for a date that already has data no longer collides.
- Restored SM2 and Toxic Commando's wiped sales-daily history by re-running the (fixed) portal-daily-backfill over their full announce-to-today windows, sourcing fresh from the Steamworks Partner API (the authoritative source — nothing was lost permanently since the real data lives on Valve's servers, not just in our DB).

**Generalizable rules.**

> **A "delete rows tied to this ID, then recreate" pattern must delete from EVERY table keyed by that ID, not just the primary data table.** Audit table-by-table: if an id/batchId/jobId is a foreign key or primary key in more than one table, the delete step must clear all of them, or use `INSERT OR REPLACE` / upsert semantics on the metadata table too. A delete-then-insert that isn't atomic across all affected tables will look idempotent on a fresh id and silently corrupt data on any id reuse.
>
> **A `UNIQUE constraint failed` error inside a delete-then-recreate code path is never "expected" — it means the delete didn't actually clear what the insert assumes is clear.** Treat it as a correctness bug to root-cause immediately, not a transient collision to retry past. Retrying the same buggy write path on production data multiplies the damage instead of fixing it.
>
> **Before re-running any backfill/import job over a date range that already holds production data, verify on 1–2 days first that a re-run is truly a no-op (same row count, same values) before unleashing it across the full historical range.** Blind full-range re-runs on "probably idempotent" jobs are how 1,342 days of real revenue data becomes 11.
>
> **When a background job everyone assumes is safely re-runnable starts showing unexpected failures, stop and diff row counts before deciding it's fine to keep running or to retry.** I only caught this because I happened to spot-check a specific date against a value I remembered from earlier in the session — the job's own status endpoint (`541 succeeded / 801 failed`) undersold the severity because "failed" here meant "deleted and not restored," not "left untouched."


---

## 2026-08-11 (signalpulse) — Wishlist card assumed products had a "Release" milestone; forecast multiplier scattered across files

**What happened.** User asked to redesign the Steam Wishlist Count card in signalpulse's product-detail page to show pre-release + current counts side-by-side, with dynamic forecasts locked to the pre-release snapshot once a title has released. First deploy (v2.1) computed everything correctly on paper but the API returned `preLaunchNet=2,503,004, postLaunchNet=0` for Space Marine 2 (a title released 2024-09-09). Every wishlist row was being classified as pre-launch. Independent of that, the user then asked to raise the global first-month multiplier 0.20 → 0.27; grep found the number scattered in `forecast.ts` docstring, `forecast.ts` inline, `routes.ts` docstring, and `routes.ts` inline — 4 places, easy to skew.

**Root cause of the classification bug.** `storage.getProductReleaseDate(id)` searched `plsMilestones` for a milestone named literally `"Release"` and returned `actualDate ?? null`. But the default PLS-milestone template ships only Announce / Product Page Live / Prepurchase Start / First Teaser / Official Trailer / Launch Trailer / Game Demo — no `"Release"` row. SM2's `products.release_date` column was set to `2024-09-09`, but the helper never looked there. Result: `releaseDate = null` → the summary computation's `if (releaseDate == null) { preLaunchNet = postLaunchNet; postLaunchNet = 0; }` fallback ran and misclassified every row.

**Root cause of the multiplier sprawl.** `calculateDynamicForecastsFull` and `computeSteamFirstMonthForecast` each hard-coded `0.20` independently. Neither imported from the other. When the multiplier changed, two places had to be found and edited in sync — trivially skewable.

**Additional issue found the same day.** SignalPulse's in-memory `backfillJobs = new Map<string, BackfillJob>()` registry does not survive process restarts. Every deploy today killed the SM2 backfill mid-run. The user's requests kept generating deploys, and the backfill never got a clean 22-minute window.

**Fix.**
- `storage.getProductReleaseDate` now: (1) check `plsMilestones.find(m => m.name === "Release")?.actualDate`; (2) fallback to `products.release_date` column. Documented precedence explicitly in the JSDoc.
- `forecast.ts` now exports `const STEAM_WISHLIST_FIRST_MONTH_MULTIPLIER = 0.27` at module scope. Both `calculateDynamicForecastsFull` (Steam first-month branch) and `routes.ts`'s `computeSteamFirstMonthForecast` import and use it. Single source of truth. Docstrings reference the constant name, not a hard-coded number.
- New `getForecastingWishlistCount(summary, releaseDate)` helper in `routes.ts` returns `preLaunchNet` post-release (locked) or `lifetimeNet` pre-release (identical to pre-release by construction). Replaced ALL 5 call sites into `calculateDynamicForecasts` / `calculateDynamicForecastsFull` in `routes.ts` (list, detail, PATCH, GET /forecasts/dynamic, and the `steamWishlistCountUsed` stored-forecast field).
- Card: pre-release + current counts always shown side-by-side; pre-release is the primary/larger metric because it drives forecasts; current has the day-over-day delta.
- Dashboard card `Dyn.` columns broken into `Steam` + `All Platforms` sub-rows so viewers can see the WL → Steam Dyn (× 0.27) → All Platforms (via platform-mix expansion) chain.

**Generalizable rules.**

> **When adding a new value to a domain schema (e.g. a milestone template), any downstream helper that reads it MUST have a fallback for products created before the schema included that value.** The `"Release"` milestone isn't in the default PLS template; helpers that need a release date must fall back to `products.release_date`. Same rule applies to any new milestone name or column added later — check `getProduct*` helpers and audit them for null-fallbacks.
>
> **Any magic number that affects money or forecasts must live in ONE named constant.** If more than one file references the same multiplier / ratio / threshold, extract a `const` and import it. Tests should assert the constant is used, not the value. When a business rule changes (like 0.20 → 0.27), a single-file grep should surface the ONE line to change, not five.
>
> **In-memory job registries (`Map<jobId, Job>`) do not survive deploys.** For any backfill / long-running background job on this droplet, either (a) persist the job state to SQLite so it can resume after a restart, or (b) accept that any deploy during the run will lose the job and require a re-trigger, and never fire more than one deploy while a critical long-running job is active. The current signalpulse backfill route is category (b) — treat it that way and coordinate deploys accordingly.
>
> **Before assuming a per-product piece of data is missing, check ALL sources.** Products have both a `release_date` column AND a milestones table; audio/data ingestion tables have both `products.release_date` and per-day rows; product platform mix lives in both `products.platforms` and derived mix helpers. Grep the schema first, not just the primary source.

---

## 2026-07-24 (evening) — Weak auto-generated keywords let franchise/word-collision noise corrupt ILL and Silent Hill: Townfall

**What happened.** I added ILL (#138) and SILENT HILL: Townfall (#139) as competitors under Hellraiser, batch-added 22 and 25 subreddits, and ran an April→today backfill (14,805 raw Reddit posts). Post-backfill: ILL showed 15 posts monthly, Townfall showed 587. When the user asked "Are you sure ILL and game and ILL and Steam, Trailer and other game adjacent words didn’t get cut out by our rules," I audited via a new `/api/ingest/diag/game_records` endpoint and found the OPPOSITE problem: massive false-positive contamination.
- ILL: 42 SentimentRecords, ~1/15 sampled were actually about the game. The bare `"ILL"` keyword matched every English "ill" / "I'll" / "illness" occurrence: "Should I trophy hunt Both the RE Revelation Games?" ("ill only have requiem left"), "ill leave this for women audiences", "Horror Movie Mental Illness Scapegoating", etc.
- Townfall: 819 SentimentRecords, **0/20 sampled** were about Townfall. The bare `"SILENT HILL"` keyword matched every Silent Hill franchise post: SH2, SH3, SH4, Silent Hill F reviews, wallpapers, drawings, remakes, movie, "How do Silent Hill fans feel about Hellraiser Revival", etc.

This directly violates the user's non-negotiable: **"Zero comments that are about things other than the game specifically make it into the daily updated post counts even as neutral we have to be crisp on that of the data is corrupted".** ~93% of ILL's post counts and ~100% of Townfall's were corrupted.

**Root cause.** `services/keyword_generator.generate_default_keywords()` produced:
- `ILL` → `['ILL', 'ILL game']`. The bare 3-char `ILL` matched `\bill\b` in Reddit posts.
- `SILENT HILL: Townfall` → `['SILENT HILL: Townfall', 'SILENT HILL: Townfall game', 'SILENT HILL', 'SILENT HILL Townfall']`. The bare `SILENT HILL` (via the multi-word main-title branch — `main_part.split() >= 2`) matched every franchise post across the 25 SH-adjacent subs.

The generator's design assumption was "multi-word main title fragments are distinctive enough not to collide." That's false for franchise names — SILENT HILL is 2 words but is a franchise name that appears in tens of thousands of unrelated posts.

Compounding the failure: `GameResponse` schema doesn't expose `distinctive_keywords`, so my earlier `curl /api/games/138 | .distinctive_keywords` returned `None`, making me think the keywords weren't set at all. They were set, they were just poison.

**Fix.**
- `services/keyword_generator.py` v2:
  - Short-title guard: for titles ≤3 chars OR in a curated `_UNSAFE_SHORT_TITLES` collision list (`ill, go, fez, hi, in, up, ...`) OR ≤5-char single-word-lowercase, the generator NEVER emits the bare title. Only emits `"<title> game"` and `"<title> the game"`.
  - Franchise-spinoff guard: bare main-title fragments are only emitted when main title is ≥3 words. `"SILENT HILL: Townfall"` (2-word main) no longer emits `"SILENT HILL"`; `"A Quiet Place: The Road Ahead"` (3-word main) still emits `"A Quiet Place"` (distinctive enough).
  - Combined main+subtitle disambiguated forms added: `"SILENT HILL Townfall"`, `"Townfall SILENT HILL"`.
- `tests/test_keyword_generator.py` — 11 regression tests covering: 3-char titles, common-word titles, franchise-spinoff 2-word/3-word main titles, possessive main titles, and generic behavior (empty, dedup, trademark strip, remaster year). All pass.
- `scripts/purge_and_rebuild_ill_townfall.py` — one-time idempotent purge (all SentimentRecord + DailySummary + WindowSummary for both games), rewrite keywords to stricter values, re-run Steps 5–7 against existing RawPost rows.
- `/api/ingest/diag/keyword_dryrun?game_id=X&sample_size=50` — NEW endpoint to preview relevance-gate admission rate + admitted samples + rejected samples against a random slice of existing RawPost. Use before any bulk backfill to catch bad keywords.

**Generalizable rules for future new-title onboarding.**

> **BEFORE batch-adding subreddits and running any backfill for a newly-added title, this checklist MUST be completed:**
>
> 1. **Load lessons.md 2026-07-24 (evening) first — this one.** Re-read the ILL/Townfall failure so the failure pattern is fresh in context.
> 2. **Inspect the auto-generated `distinctive_keywords`.** Query the DB directly (`GameResponse` schema hides them). Look at every keyword and ask: "Would this keyword match posts that aren't about this specific game?" If yes, it must go.
> 3. **Reject bare-word keywords under any of these conditions:**
>    - Keyword is a common English word (ill, go, in, up, we, if, do, or, ok, no, my, ...) — will match contractions and adjectives.
>    - Keyword is a short (≤5 char) single-word non-proper-noun — high homograph risk.
>    - Keyword is a franchise name for a game that is a spin-off (Silent Hill, Resident Evil, Halo, Call of Duty) — will match every franchise-adjacent post, not just the new title.
>    - Keyword is a common short IP handle (RE, MGS, GTA, CoD, FF) UNLESS combined with a distinguishing token.
> 4. **Every keyword for a spin-off title MUST contain the unique-to-this-title token** (Townfall for SILENT HILL: Townfall, Revival for Hellraiser: Revival, Origins for Turok Origins).
> 5. **Run the pre-backfill dry-run.** After the FIRST small natural-ingestion pass (a few hundred RawPost per game), call `GET /api/ingest/diag/keyword_dryrun?game_id=X&sample_size=50`. Read the admitted_samples list. Every single admitted post title should visibly be about the specific game. If any admitted sample is about the franchise generally, a movie, an adjective, or a different game, tighten keywords BEFORE running the full backfill.
>    - **Threshold rule of thumb:** admission rate >25% for a low-signal pre-launch title is a red flag. Rechecke every admitted sample.
> 6. **Only after the dry-run is clean** run the full backfill via `POST /api/ingest/backfill?game_ids=X,Y&start_date=YYYY-MM-DD`.
> 7. **Post-backfill audit.** Call `/api/ingest/diag/game_records?game_id=X&limit=20` and manually verify every SentimentRecord in the sample_sentiment_records list is actually about the game. If contamination is present, purge and retighten keywords before any dashboard, digest, or report goes out.

**Also:** `GameResponse` schema needs `distinctive_keywords` field added so future `curl /api/games/{id}` audits show the actual keyword set instead of `None` by default. Deferred for now (won't affect ingestion; is a diagnostic-only ergonomics issue), but noted.

**Updated locations.** `services/keyword_generator.py`, `tests/test_keyword_generator.py`, `scripts/purge_and_rebuild_ill_townfall.py`, `routers/ingest.py` (endpoints: `/remediate/ill_townfall`, `/remediate/ill_townfall/status`, `/diag/keyword_dryrun`, `/diag/game_records`), this lessons.md entry.

---

## 2026-07-24 — Dashboard rendered same visual scope from three different tables

**What happened.** Hellraiser today showed 258 posts in the Post Volume by Source chart but 1 post in the KPI cards on the same page. User: "these numbers MUST MATCH... if we're capturing 250 posts and only 1 was actually about the game then it's one post".

**Root cause.** `routers/dashboard.py` had four independent aggregations reading from three different tables:
- KPI cards → DailySummary (post-relevance-gate, but stale after purges)
- Net Sentiment Trend chart → DailySummary (same stale cache)
- Post Volume by Source chart → RawPost (PRE-relevance-gate, so counted ~260 off-topic Reddit posts that correctly never got a SentimentRecord)
- Sentiment Velocity gauge → DailySummary (same stale cache)

Every one of them was individually "correct" against its own data source, but together they showed the user four different pictures of what "posts about this game today" means.

**Fix.** Every section now aggregates from `SentimentRecord JOIN RawPost` scoped by `COALESCE(post_date, collected_at)`. One data source, one answer. By construction a RawPost has a SentimentRecord iff it passed the relevance gate at Step 5 — so this joined query is the canonical answer for "how many posts about this game in this period".

**Downstream effects.** Every data-quality operation (relevance purge, low-substance purge, keyword tightening) now reflects on the dashboard immediately; no more DailySummary rebuild scripts needed for dashboards to be correct. Volume/KPI/trend/velocity/topics are all internally consistent because they read the same rows.

**Generalizable rule.** When a UI shows multiple numbers/charts scoped to the same (entity, time window), they MUST come from the same data source query. If they don't, they'll silently disagree the first time anything mutates the underlying tables. This is not a caching problem — it's a design problem. The fix is not "invalidate the cache faster", it's "read the same table for every number on the same page".

**Codified invariant.** `test_dashboard_kpi_matches_volume_chart_total` in `backend/tests/test_api.py` asserts `KPI Total Posts == sum(Post Volume bars)` on the dashboard response. Regression protection for the whole class of "two aggregations disagree" bugs.

**Live QA gate followed (CLAUDE.md §9).** After deploy, ran a 137-active-game × 3-period (today/weekly/monthly) invariant scan against the live droplet: 411/411 checks passed. Confirmed Hellraiser specifically dropped from KPI=1 vs volume=258 to KPI=1 vs volume=1.

**Updated locations.** `backend/routers/dashboard.py` (all four sections). `backend/tests/test_api.py` (invariant test). This lessons.md entry.

---

## 2026-07-01 — Monthly digest cron fired before the monthly summaries were generated

**What happened.** On 2026-07-01 at 07:00 ET the monthly digest job fired and delivered an email whose Portfolio Brief read "No qualifying monthly summaries available for June 2026. Verify the monthly summary job ran and source health was OK across the period."  All 8 title blocks rendered "0 posts, no signal."

**Root cause.** Scheduler cron ordering:
- Daily ingestion cron runs at **10:45 local time** (America/New_York).
- Its Step 9 (`_step9_generate_monthly_summaries` in `services/ingestor.py`) is the ONLY code path that creates `MonthlySummary` rows for the just-ended month.
- Monthly digest cron was scheduled for **07:00 ET on the 1st**.
- 07:00 < 10:45 — so when the digest fired, no `MonthlySummary` rows existed yet for June 2026.  `build_monthly_block` correctly returned `has_data=False` for every title and the digest correctly said "no qualifying summaries."
- At 10:45 the ingestion ran, Step 9 created all the June summaries with full content, but the email had already gone out.

**Fix (Option B, per user direction).** Move the monthly digest cron from `hour=7` to `hour=12` on the 1st in `backend/scheduler.py`.  12:00 ET gives Step 9 a ~1h 15m buffer after the 10:45 ingestion completes.

**Manual recovery.** After the fact I re-triggered `POST /api/digest/send/monthly` with the summaries now populated — the corrected June 2026 digest went out at 08:21 ET with real content.

**Generalizable rule for future cron scheduling in this project.** When adding a scheduled job that consumes derived data (weekly summaries, monthly summaries, editorial cache, etc.), verify the upstream generation cron completes BEFORE the consumer cron fires.  Don't rely on "they'll usually be done by then."  If ingestion moves earlier (05:00 for faster morning digests), the monthly digest can move earlier too — but the ORDERING invariant is the load-bearing one.

**Pre-ship check for future scheduler changes.** For every scheduled digest / email / report job:
1. Identify the derived-data prerequisite (which upstream cron populates the tables the job reads).
2. Confirm the prerequisite cron's max expected runtime + its trigger time is strictly BEFORE the consumer cron trigger.
3. Add a comment in `scheduler.py` at the consumer cron declaration stating the prerequisite and the safety margin.
4. If the buffer is under 15 minutes, either widen it or add a defensive check inside the consumer that regenerates the missing derived data before rendering the output.

**Updated locations.** `backend/scheduler.py` (cron trigger + explanatory comment). This lessons.md entry. No CLAUDE.md rule needed — this is operational deployment configuration, not a principle.

---

## 2026-06-29 — When a class of LLM outputs requires layered post-LLM filters, the model is wrong for the job

**What happened.** Across 3+ hours of iteration (§25 → §25d → §25e → §25f → §25g → §25h) I stacked six post-LLM filter passes on top of the exec/recs/bold-ideas output because Claude Haiku kept producing confabulations (invented competing titles, invented partnerships, single-poster topics promoted to leads).  Each filter was individually correct.  The cumulative architecture was hostile to good output: the verifier deleted whole legitimate sentences for over-claim, the monitor-only-lead-strip ran both before AND after the verifier, and the min-length fallback replaced partially-verified analyst prose with a sterile placeholder.  The user's exact frustration: "we keep repeating the same errors in different ways" and later "this insanely myopic grind you're on regarding putting together an executive summary that is robust and accurate free of hallucinations… it's not getting better it's getting worse."

**Root cause.** Haiku is the wrong model class for grounded summarization with strict citation discipline.  Under sparse-context inputs it confabulates because that's what small-parameter models do when asked to sound authoritative.  No amount of downstream filtering can turn a confabulation-prone model into a citation-strict model — you can only delete its bad output, and if too much output is bad, deletion leaves you with nothing.

**Fix.** Swap the model.  A side-by-side test on Hellraiser (the torture case: sparse posts, dominant single-locale cluster, real editorial context, historical confabulation pattern) showed Perplexity Sonar Pro producing atomic, cited, post-anchored sentences on the first try.  Zero filter stack needed.  Wired Sonar as the primary LLM for all three user-facing blocks (exec, recs, bold-ideas) with Haiku as fallback; disabled the §25-series post-LLM filters on the recs + bold-ideas paths (§26.8).

**Generalizable rule.** When you find yourself writing the 4th or 5th post-LLM filter pass to compensate for a model's habitual failure mode on a specific class of output, stop.  A filter can enforce structural rules (schema, citation existence, coverage counts).  A filter CANNOT change what class of content the model is willing to produce.  If the model produces confabulations, you can delete them, but you can't turn deletion into good content.  Test a different model class before shipping the fourth filter.

**Practical decision rule.** After the second post-LLM filter for the same failure mode, run a head-to-head test between the current model and one from a different model family.  Cost of a head-to-head is trivial (one prompt, three API calls) vs the cost of shipping a fragile filter stack that gets more layers every week.

**Updated locations.** CLAUDE.md §26 (structured-output contract that assumes a competent LLM instead of layered filters).  This lessons.md entry.

---

## 2026-06-24 — Confirm-or-Omit Directive (permanent, project-wide)

**User directive, recorded verbatim:**

> *"on sentiment pulse summaries NEVER invent context, only confirm context explicitly. IF you can't confirm do not create an issue positive or negative from the posts we are accumulating. Commit this to lessons.md and the project requirements overall."*

**Status:** Promoted to CLAUDE.md §20 (Confirm-or-Omit) — a CRITICAL always-on requirement on the same tier as §13/§14/§15/§19. Every claim in every summary, recommended action, and big idea must be confirmable against a specific post in the source data fed into that LLM call. If a claim cannot be pointed to a specific post, the claim does not get made. No issue, positive or negative, is surfaced from posts that do not specifically and unambiguously confirm it. Saying nothing is preferred over saying something invented.

This is not a heuristic. It applies to every prompt currently in the project and every prompt added in the future. Mechanically enforced by `_anti_fabrication_clause()` in `backend/services/period_summary_service.py`, which is invoked from `_call_exec`, `_call_actions`, and `_call_bold_ideas`. Regression test: `backend/tests/test_anti_fabrication.py` asserts the clause is in each prompt — not just that current outputs happen to be clean.

The full operational rule lives in CLAUDE.md §20. This entry exists in lessons.md so the directive's exact wording and date are preserved in the agent's working notes alongside the failure that prompted it (see the Hellraiser/Jamie Clayton entry below).

---

## 2026-06-24 — LLM fabricated a celebrity name in the digest (anti-fabrication rule)

**What happened.** The live weekly digest for Clive Barker's Hellraiser: Revival surfaced "Jamie Clayton voice casting" as a Recommended Action and proposed partnering with Jamie Clayton in a Big Idea. The user caught it: Doug Bradley is the cast Pinhead voice actor in the game, not Clayton (Clayton played Pinhead in the 2022 Hulu film).

Ground truth from `raw_posts` for game_id=21 in the 7d window:

  - posts mentioning "Clayton": **0**
  - posts mentioning "Bradley": **1** ("Doug Bradley returns to voice Pinhead in Hellraiser Revival")
  - posts mentioning "Pinhead": 2 (both confirming Bradley)

The LLM autocompleted Clayton from background knowledge of the franchise's film history. The community didn't mention her. The model invented a celebrity name and used it as if it came from the data.

**Why this happened.** Three prompt functions feed Claude: `_call_exec`, `_call_actions`, `_call_bold_ideas`. The exec-summary prompt already had an explicit anti-fabrication clause ("Do NOT invent specifics that aren't in the samples or entities list") — and the resulting executive summary correctly stayed generic ("Minor friction surfaces around voice casting preferences"). But the actions + bold-ideas prompts had no such constraint. They told the LLM to "reference a SPECIFIC entity" but did not restrict the source of that entity to the input data. The model treated franchise background knowledge as fair game.

This is also a CLAUDE.md §19-shaped failure: an intermediate signal (the prompt asked for "specific entities") was treated as sufficient to guarantee fidelity, but the actual ground truth (the post corpus we fed in) was not enforced as the only valid source.

**Rule (permanent, no exceptions):**

Every prompt that asks Claude to surface named entities (people, characters, DLC, patches, modes, levels, weapons, voice actors, etc.) MUST include a clause that:

1. Limits valid entities to those appearing **verbatim** in the input data (sample posts or distinctive-entities list).
2. Explicitly forbids using **background knowledge** about the franchise, its prior games, its movies, its actors, or its lore.
3. Provides a fallback: if no proper-noun entity is in the data, fall back to a topic label or respond NONE.

This is implemented as a shared helper `_anti_fabrication_clause()` in `period_summary_service.py` and is now invoked from all three `_call_*` prompts. Regression test: `backend/tests/test_anti_fabrication.py` asserts (a) the clause is present in each prompt when data is supplied, (b) the prompt's data section contains only real entities from the input (no Clayton), and (c) the empty-data fallback "NO SPECIFICS AVAILABLE — do not invent" form is used when both samples and entities are empty.

**How to apply this rule going forward.** Whenever a new prompt function is added that synthesizes from community data into an analyst-facing output, the FIRST thing to add — before specificity preferences, before formatting rules, before the data section — is the anti-fabrication clause. The order is: identity → output style → anti-fabrication → task → data → format.

Written 2026-06-24 after the Hellraiser/Jamie Clayton fabrication was caught by the user. Commit: <hash>.

---

## 2026-06-24 — Verify domain ownership before suggesting DNS work (§19 violation)

**What happened.** During the Resend email-sender setup, the agent suggested using `mail.sentimentpulse.com` as the verified sending domain for the digest. Reasoning was: "the domain name matches the product name, so the user must own it." The agent then registered `mail.sentimentpulse.com` in the user's Resend account and prepared DKIM / SPF / MX records, all before checking whether the user actually owned `sentimentpulse.com`.

The user pushed back: "i thought we didn't reserve a domain like sentimentpulse.com for this site and are just relying on the IP address." Ground-truth check (`curl https://sentimentpulse.com/`, `dig +short A sentimentpulse.com`) revealed:

- The domain resolves to `15.197.225.128` / `3.33.251.168` (AWS Global Accelerator) — NOT the SentimentPulse droplet IP `104.236.239.46`.
- The domain serves an unrelated commercial product called "Sentiment Pulse | AI-Powered Stock Analysis."
- The user's actual SentimentPulse app lives only at `http://104.236.239.46/sentiment/` — a droplet IP path, no domain attached.

The agent had been about to walk the user through a 20-minute Cloudflare nameserver-switch + 3 DNS-record exercise on a domain they don't own.

**Why this happened.** The agent treated a *name match* as ownership evidence. It also conflated memory notes from `lifetime-class-booker` (which has its own domain setup) with SentimentPulse. The agent's mental model assumed every product has a matching domain, which is not how this user works — SentimentPulse is currently a droplet-IP-only deployment.

**Rule (permanent, no exceptions):**

Before suggesting ANY DNS work, domain configuration, registrar changes, or claiming a domain on behalf of the user, the agent MUST:

1. **Run `dig +short A <domain>` and `curl <domain>`** to see where the domain points and what it serves.
2. **Confirm with the user explicitly** that they own/control the domain. A name match ("sentimentpulse.com matches SentimentPulse") is NOT evidence of ownership.
3. **Check the actual production URL** the user uses to access the app, not the domain the agent assumed.

This is a specific instance of CLAUDE.md §19: ground truth must be verified before action, never assumed from naming coincidences. "Domain X exists with a related name" is an intermediate signal; "the user owns and controls Domain X" is the ground truth that authorizes DNS work.

The cost of guessing wrong here was bounded only because the user caught it. If the user had said "sure, sounds good" the agent would have walked them through a 20-min DNS-on-a-domain-they-don't-own exercise that would have failed at the very first step.

**What to do for transactional email when the user has no domain:**

- Either ask the user to pick + register a domain, OR
- Restrict the recipient list to only the Resend account owner's verified address (the no-domain-needed path), OR
- Use a domain the user has already verified ownership of (confirmed by an actual question and an actual whois / DNS check, not by name resemblance).

Written 2026-06-24 after the agent registered `mail.sentimentpulse.com` in Resend and had to delete it via `DELETE /domains/{id}` to clean up the mistake.

---

## 2026-05-30 — Never declare success on intermediate signals; verify ground truth

**Mistake (two confirmed instances, one detected by the user):**

1. **2026-05-29 Bluesky rollout.** Claimed "2,167 posts saved across 26/28 games" based on the dashboard endpoint and `bluesky_metric posts=100 status=ok` log lines. Did not run a direct DB count of rows where `collected_at >= run_started_at`. Reality happened to be correct, but the verification was unsafe — the same proxy would have missed an analogous Reddit failure.

2. **2026-05-30 Reddit cron diagnosis.** Earlier today's cron pulled 0 Reddit posts. While investigating, claimed "Reddit is working perfectly right now" after a manual ingest, citing `arctic_shift_metric ... status=ok posts=25-49` lines in the live ring buffer. The user pushed back and asked me to actually verify the claim. A direct DB count showed **zero** Reddit rows saved across all 28 active games today — despite Arctic Shift returning 25-49 posts per subreddit. The buffer's `status=ok` was a fetch-side signal; persistence was the actual question, and persistence was 0.

The second case is the harmful one. If the user had not pushed back, I would have built retry/notification infrastructure on top of a still-broken save path. The retry would never "recover" anything because the bug was never about fetch volume — it was about persistence dropping every post silently.

**Rule (now permanent, formalized as CLAUDE.md §19):**

Before declaring success on anything that produces persistent state, identify the **ground truth** of the claim and run the direct query/check that measures it. Specifically:

- **Ingest success** = `SELECT COUNT(*) FROM raw_posts WHERE source=? AND collected_at >= run_started_at`. Not log lines. Not status field. Not buffer counters.
- **Bug fix success** = the original failing user action now produces the expected outcome. Not "tests pass". Not "function returned non-empty".
- **Deploy success** = a fresh request to the live endpoint returns the new behavior. Not the green CI checkmark.

When the bug being fixed was "X ran but didn't persist", the post-fix verification MUST measure persistence — not that the buggy step now reports success. The signals that lied during the bug cannot be the proof of the fix.

Differentiate "fetched" from "saved" in every observability statement: those are two different facts and they are not interchangeable.

When the user reports the symptom is still present after a claimed fix, STOP and re-verify ground truth before proposing any new fix. Don't assume "transient". Don't change scope. The user observed reality.

See `CLAUDE.md` §19 for the full canonical rule.

---

## 2026-05-29 — Never ask the user to run a command without including the command

**Mistake (twice in one session, in the same debugging thread):**

While diagnosing the Reddit fetcher 403 errors, the agent asked the user to run a
PowerShell line and paste the output back — but did NOT include the actual command
in the message. The user had to ask for it before they could proceed.

**Rule (permanent, no exceptions):**

When the agent asks the user to run any command — in PowerShell, bash, cmd, a SSH
session, a browser console, anywhere — the agent MUST include the exact
copy-paste-ready command in the same message as a fenced code block.

Specifically:

- ✅ "Run this in PowerShell and paste the output:" followed by a `powershell`
  code block with the literal command.
- ❌ "Run this single line and paste back what you see." (no command provided)
- ❌ "Open PowerShell and run a curl test." (vague, not paste-and-run)

This is true regardless of which UI tool the agent is using (ask_user_question
with free_text_only, plain prose, confirm_action, etc.). If the prompt text
contains "run this" or "execute this" or any equivalent phrasing, a code block
with the command MUST be included beside it. Re-read the message before sending
to confirm the command is there.

This rule reinforces the broader user preference (already in memory) that all
commands given to the user must be complete, paste-and-run executable verbatim,
with no edits, no placeholders, and no copy-this-paste-that steps.

---

## 2026-06-24 — Citation grounding + self-criticism (CLAUDE.md §20 layers 3 + 4)

Two further defenses behind §20's prompt rule (layer 1) and post-LLM proper-noun fact-check gate (layer 2):

**Layer 3 — Citation Grounding.** Every sample post pulled into a summary prompt is tagged with a stable token `[P-001]`, `[P-002]`, ... The prompt requires every sentence (or numbered item, or bold idea) to end with at least one such citation drawn from the allowed list. Sentences without a valid `[P-NNN]` are dropped before the user sees them. The renderer turns each token into a small superscript anchor link to the source post URL, so every claim is auditable in the email itself.

**Layer 4 — Self-Criticism.** After each LLM call, a second Claude call ingests `(text, source posts cited)` and emits one SUPPORTED/UNSUPPORTED verdict per sentence. Unsupported sentences are stripped. Failure modes are degrade-safe: a critic-call exception or a malformed (length-mismatched) verdict list both keep the first-pass output rather than wipe everything.

**Why both, not one.** Layer 2 catches *fabricated proper nouns* (the Jamie Clayton case) but is blind to *semantic hallucination* — a claim that uses only real names but invents the relationship, direction, or quantity between them ("Doug Bradley criticized for the casting choice" when no post says that). Layer 3 forces the LLM to point at a specific post for every claim. Layer 4 verifies the cited post actually supports it. Together they close the semantic gap that proper-noun matching alone leaves open.

**Data model change.** `WindowSummary.citation_map` and `MonthlySummary.citation_map` are new nullable JSON columns (migration `0007_summary_citation_map.py`). The map persists `{ "P-001": { "id": post_id, "url": post_url, "sentiment": "positive" }, ... }` alongside the summary text so the email renderer can resolve tokens to clickable links at render time without re-querying. Rows pre-dating layers 3+4 have `citation_map = NULL`; the renderer treats null as legacy and silently strips any leftover `[P-NNN]` tokens.

**Tests** (`backend/tests/test_anti_fabrication.py` + `backend/tests/test_digest_service.py`):
  - Citation infrastructure: ID assignment, prompt-block formatting, requirement-clause shape, multi-cite extraction `[P-001, P-003]`, sentence drop, item drop with renumbering, bold-idea drop, no-op when citation_map empty.
  - Self-criticism: drops UNSUPPORTED, keeps SUPPORTED, no-op when citation_map empty, keeps first-pass on critic API error, keeps first-pass on malformed (length-mismatched) verdict output, item-level criticism, bold-idea-level criticism.
  - Renderer: single-cite → sup-link, multi-cite → multiple links, missing URL → plain superscript number, legacy null citation_map → tokens stripped, URL is HTML-escaped (& and ").

**Cost.** Layer 4 adds one additional Claude call per LLM output block (~3 extra calls per summary, one per `_call_exec/_call_actions/_call_bold_ideas`). This is the price of every sentence in a digest being verifiably grounded to a specific post the user can click through to.

---

## 2026-06-24 — Clayton "community demand signal" is grounded, not fabricated (don't over-correct)

**Context.** After deploying CLAUDE.md §20 layers 3+4 (citation grounding + self-criticism), the freshly-regenerated Hellraiser bold idea read:

> "Lean into **Jamie Clayton** voice casting as a community demand signal; early build praise for honoring source material creates opening to announce voice talent that deepens franchise authenticity and captures untapped fan enthusiasm. [P-002, P-004]"

The agent's first instinct was that Clayton had slipped through layer 2 again. Investigation showed otherwise:

- A 4-page (`page_size=200`) sweep of `/api/games/21/posts` returned 750 total posts, not the 50 originally inspected (the API has no `?days=N` parameter — the earlier filter was silently ignored).
- Among those 750 posts, **multiple Bluesky and Steam-forum posts explicitly discuss Jamie Clayton** as a community wish — e.g. post id 69772 ("I'd be way more interested in Hellraiser: Revival if Jamie Clayton was voicing Pinhead"), id 63346, id 42998, id 41061, id 21030, etc.
- The bold idea's citation `[P-002]` resolves to one of those real posts (`https://bsky.app/profile/foxenlock.bsky.social/post/3mok5xsykrc2i`), which a human can click and verify.
- The bold idea does NOT claim Clayton is cast. It frames her name as "community demand signal" and proposes the publisher acknowledge that demand. That is exactly the §20-compliant shape: confirm what posts actually say, do not invent that she is cast.

**Rule.** When §20-protected output mentions a name that the agent previously caught as fabricated, do NOT auto-revert. Re-check the actual posts in the full window against the cited [P-NNN] token. If the citation points to a real post that genuinely supports the framing (community wish, criticism, demand signal, controversy, etc.), the claim is grounded — leave it alone. The §20 violation is *inventing context*, not *naming a real entity that real posts discuss*.

**Concretely, this means:**

- Do not strengthen the proper-noun whitelist to exclude Clayton (or any other previously-flagged name). The whitelist is derived from the actual input data; if a name appears in the data, it is by definition a valid reference.
- Do not tighten the self-criticism prompt to demand "is the bold idea a marketing recommendation the company would actually take" — that conflates editorial judgment with grounding. Grounding is about whether the post supports the claim; whether the claim is wise is a separate dimension.
- The earlier Clayton failure (2026-06-24 morning) was a different shape: the LLM stated Clayton as if cast, with no post saying that. Layers 1+2 fixed that exact failure. Layers 3+4 fixed the broader semantic gap. The remaining Clayton mentions in today's digest are a feature, not a bug.

**Operational note for future agents.** When the user asks "does the data really say X?", run a full-window post sweep with `page_size=200` across all pages — do not trust a single-page response. The `/api/games/{id}/posts` endpoint paginates by `page_size` (default 50, max 200) and has filters for `sentiment`/`source`/`date_from`/`date_to` but NOT a `days` parameter. Earlier in this session the agent reported "0 posts mention Clayton in the 7d window" based on the default first page only — which was wrong by an order of magnitude.

---

## 2026-06-28 — Pre-release "Patch Difficulty Settings" violation (CLAUDE.md §20 hardening)

**Violation.** A 7-day recommendation for Hellraiser: Revival (id=21) read:

> "Patch **Game Difficulty Settings** — negative sentiment concentrated here; balance pass required before October release window [P-021]"

Three independent §20 violations stacked:
1. **Wrong release context.** Hellraiser is unreleased; an unreleased game cannot be patched, balanced, or hotfixed.
2. **Wrong specific entity.** The cited post P-021 says only *"I'm disappointed in Hellraiser Revival after seeing actual gameplay. It's Hellraiser in window dressing only and what looks to be a very generic Resi-like."* — zero mention of difficulty settings.
3. **Fabricated date.** "Before October release window" is not in any cited post.

**Why all four layers missed it:**
- Layer 1 prompt rule (anti-fabrication) — restricted proper nouns, not verbs/dates.
- Layer 2 proper-noun fact-check gate — "difficulty", "settings", "October" are all common words, not proper nouns; gate didn't fire.
- Layer 3 citation grounding — the recommendation HAD a citation (`[P-021]`); the citation existed in the map; nothing to drop.
- Layer 4 self-criticism — the critic prompt's "topical proximity is not support" rule was apparently too soft. It accepted the recommendation because P-021 is a negative post about the game (topical proximity), without checking whether the specific mechanic (difficulty settings), date (October), or verb context (patch on an unshipped game) matched the post.

**Fix architecture (this commit):**

1. **Release-status heuristic.** `_infer_release_status(samples_block)` returns `"pre-release" | "released" | "unclear"` based on counts of pre-release signal words (trailer, reveal, wishlist, "after seeing gameplay", SGF, gamescom, etc.) vs. post-release signal words (patch, hotfix, server, matchmaking, prestige, season pass, etc.) in the sample posts. Directionally correct on every priority title; no DB schema change required.

2. **Layer 1 prompt augmentation.** A new `_release_status_clause(status)` is injected into all three prompts (exec, actions, bold). For pre-release: forbids Patch/Hotfix/Rebalance/Nerf/Buff/Revert; allows only Clarify/Communicate/Reframe/Address/Document/Publish/Reveal/Showcase/Reassure/Counter-position. For released: explicitly allows live-game verbs. For unclear: instructs caution.

3. **Layer 2b post-LLM sanitizer.** `_sanitize_recommendations_for_release_status(text, status)` drops any numbered recommendation whose item-line matches one of `_POST_LAUNCH_VERB_PATTERNS` when status is pre-release. Patterns cover leading verbs (patch/hotfix/rebalance/nerf/buff/revert/roll back/ship update), the phrase "balance pass", and "before <month> release". This is belt-and-suspenders — even if the LLM ignores the prompt and the critic accepts it, the regex drops it before persistence.

4. **Layer 4 critic prompt hardened.** Added three new explicit rules:
   - Specific mechanic/feature names (difficulty settings, matchmaking, weapon balance, etc.) must be literally named in the cited post; generic complaints don't count.
   - Dates, deadlines, release windows, and version numbers must be literally in the cited post; current date and industry knowledge are inadmissible.
   - Post-launch action verbs against pre-release context are auto-UNSUPPORTED.

**Tests** (test_anti_fabrication.py +14 tests): release-status detection (pre/post/unclear/empty), the sanitizer (patch/hotfix/rebalance, "balance pass", "before October release", noop for released/unclear, all-dropped-returns-empty), and the prompt clause shape. 537 passing total.

**What this does NOT fix:** the release-status heuristic is text-driven; it can be wrong on edge cases (live game with a heavily-marketed expansion announcement, beta with mostly trailer chatter, etc.). The proper long-term fix is a `Game.release_status` field administered per title. Until then, the layered defense ensures the failure mode is "be conservative on verb choice" rather than "fabricate a patch for an unreleased game."

---

## 2026-06-29 — Commercial strategic context (CLAUDE.md §21)

**Violation.** The Hellraiser weekly digest sent on 2026-06-29 contained:

> "Counter-position **Clive Barker's Horror Vision** — reframe Revival as distinct single-player experience, not competing with asymmetrical multiplayer alternatives, to resolve IP licensing perception concerns. [P-004, P-009]"

> Bold idea: *"...rather than letting 'Modern Resident Evil wrapper' comparisons dominate discourse."*

Both recommendations advised the team to distance the game from comparisons to Resident Evil. Resident Evil Requiem (Feb 27 2026) is the year's #1 commercial horror release — 7M+ units in 2 months, fastest-selling RE ever, Metacritic 89-92. **A community comparison to that property is a commercial GIFT**, not a problem to deflect. The system advised the strategic opposite of what a competent commercial PM would say.

**Why §20 didn't catch it.** §20 enforces factual grounding (every claim traceable to a post). The recommendation WAS factually grounded — there really are community posts comparing Hellraiser to RE. §20 has no opinion on whether the *strategic interpretation* of that grounded claim is commercially sensible.

**The missing layer.** The system had no concept of **strategic grounding** — whether a recommendation is aligned with commercial reality. It treated every community signal as a thing to "react to" (address, counter-position, deflect, distinguish from) without ever asking: **is this signal a commercial ASSET or LIABILITY?**

**Fix architecture (CLAUDE.md §21):**

1. **Per-title `commercial_context` field on `Game`.** Free-form 4-6 sentence brief naming: positioning, commercial tailwinds to amplify, threats to differentiate from, and a "DO NOT" clause to make verb selection explicit. Read by the summary LLM via `_commercial_context_clause()`. Editable in the Settings UI on the per-title card.

2. **`_SIGNAL_CLASSIFICATION_CLAUSE` injected into every prompt** (exec, actions, bold). Forces the LLM to classify each community signal as ASSET / LIABILITY / NEUTRAL before recommending an action, and explicitly maps verb classes: ASSET → amplify verbs (Lean into, Double down on, Anchor on, Spotlight, Embrace). LIABILITY → address verbs (Patch [released only], Clarify, Address). NEUTRAL → no recommendation.

3. **Default verb list rewritten.** Removed `Counter-position` from the recommended verbs in `_call_actions`. Amplify-class verbs moved to the front of the list. `Counter-position` is now reserved for explicitly-named threats in the commercial-context brief, not as a default deflection move.

4. **Default briefs seeded for all 8 priority titles.** `seed_commercial_context.py` ships defensible defaults grounded in real 2026 commercial context (RE Requiem as horror benchmark, Halloween Sept 8 as asymmetrical threat for survival-horror titles, Space Marine 2 as live-co-op proof point, etc.). Idempotent — won't overwrite user-edited briefs.

5. **Tests** (`test_anti_fabrication.py` +10 tests, 556 passing total): brief-set vs. unset behavior, signal classification clause shape, seed coverage of all 8 priority titles, Hellraiser default specifically names RE as tailwind and Halloween as threat, all default briefs include a DO NOT clause.

**Operational principle (commit to memory).** When a community signal references a current commercial success in the same genre, the default interpretation is **the market is validating the comparison; amplify it**. Counter-positioning is reserved for explicitly-named threats in the brief (e.g. asymmetrical horror vs. single-player survival). When the brief is silent, the LLM falls back to a generic "do not advise distancing from a comparison to a market-leading title in the same genre" reminder. This is a strategic decision rule, not just a prompt heuristic — adopt it for every future PM-style output the project generates.

---

## 2026-06-29 — Pre-flight QA checks before asking the user to approve / send

User pattern noticed across the §20 / §21 / §21b iterations: the agent kept producing summary outputs with surface-level oddities (orphan "However,", empty citation-only recommendations, single-poster-driven recommendations, recommendation counts below the 3-minimum target, etc.) and asking the user to approve them — instead of catching them mechanically before declaring the work done.

**Rule going forward.** Before sending any user-facing summary content (real-time UI render OR digest email), run the pre-flight checklist below. If any check fails, FIX it and re-verify; do not surface the output, do not ask the user to approve, do not declare the task complete.

### Pre-flight QA checklist for SentimentPulse summary outputs

Run this against every generated row (window summary, monthly summary) before persisting or shipping. Implement as a Python validator (`_validate_summary_output`) the user can re-use; the LLM call site invokes it and triggers a regen-once-with-stricter-prompt if any check fails. Hard failures (after one regen attempt) drop the offending field rather than ship broken text.

**Executive summary checks:**
1. **No orphan discourse marker as opener.** Must not start with "However,", "Moreover,", "Additionally,", "Furthermore,", "On the other hand,", "Nevertheless,", "Conversely,", "Meanwhile,", "In contrast,", "That said,", "Yet,", "But," — these only make sense following a preceding sentence. If layer-3 sentence stripping leaves one of these as the new opener, scrub the marker (and re-capitalize), OR drop the whole exec and regenerate.
2. **Non-empty when total_posts ≥ _MIN_SUBSTANTIVE_POSTS.** Below the §15 threshold the placeholder is correct; above it, an empty exec is a bug.
3. **At least one citation token survived** when citation_map is non-empty (otherwise every sentence got stripped — regen with a stricter "must cite" reminder).

**Recommendations checks:**
4. **No empty-stub items.** A numbered item that is just `1. [P-NNN]` or `2. [P-001, P-007]` with no prose between number and citations is a layer-3 artifact (LLM produced prose + cite, critic stripped the prose, citation survived alone). Drop these items; renumber survivors.
5. **Minimum 3 recommendations** when total_posts ≥ _MIN_SUBSTANTIVE_POSTS AND there is at least one theme-tier topic available. Below that, fewer is fine. If below minimum after all filters, regenerate ONCE with a stricter "produce N recommendations covering the breadth of the data" instruction; if still below, ship what we have.
6. **Maximum 5 recommendations.** If the LLM returns more, truncate to the top 5 by order.
7. **Every item starts with an imperative verb in the allowed verb list.** Items that start with "Note that..." / "It appears..." / "The community..." are not recommendations, they're observations. Drop or rewrite.
8. **Every item has a bolded entity or topic label.** Items without `**...**` formatting fail the format contract.

**Bold ideas checks:**
9. **No orphan pronouns** — already enforced by `_strip_orphan_reference_ideas`, but keep the check in the validator.
10. **Each idea has at least one citation token AND substantive prose.** Same empty-stub check as recommendations.

**Cross-field checks:**
11. **Exec text consistent with the counts.** If the exec says "overwhelmingly positive" but neg_pct > 30%, the exec is wrong. (Already partially enforced by the breakdown-numeric-reference rule in `_call_exec`.)
12. **No recommendations referencing topics in the monitor-only tier of the critical-mass table.** §21b enforcement — recommendations must only cite topics that cleared the recurrence threshold.

**Implementation expectation.** Add `_validate_summary_output(window_or_monthly_row, critical_mass_table) -> list[ValidationFailure]`. Call it from `generate_window_summary` and `generate_monthly_summary` after the LLM returns and before commit. On failure: log the specific check that fired, attempt ONE regen pass with the failures injected into the prompt as a corrections list, then re-validate. If still failing, drop the offending field (set to None) rather than ship broken text. Regression tests must cover each of the 12 checks with a synthetic failure example.

**The deeper principle.** Output quality bugs that are mechanically detectable should never reach the user. Asking the user "does this look right?" with an output that contains an obvious surface defect ("1. [P-007]" with no prose, or "However, X" with no preceding sentence) is wasteful of their attention and erodes confidence. The user explicitly asked for these checks to be encoded into the system; honor that by making them table-stakes for shipping any summary.

---

## 2026-06-29 — Stop shipping work and asking for review before it's verifiably correct (CRITICAL behavior rule)

**The pattern, called out by the user 2026-06-29 11:23 EDT:**
> *"Be more self critical on the fixes taken against the requirements and don't push live or for review until the work is correct."*

Today's session has three documented examples of the failure mode:

1. **§21 RE counter-positioning fix** — I deployed, ran a regen, audited my own output, claimed "the fix worked exactly as intended" — then the user reported new defects (regional-localization recommendation from a single Turkish post). I had not tested whether the §21 amplify bias was preserving liability handling.
2. **§22 pre-flight QA fix** — I deployed, ran a 1-game regen, audited, claimed "all clean ✓" — the user opened the email and found Toxic Commando still had a non-imperative paragraph dump, Turok had an empty stub, no bold ideas anywhere. My audit had been checking the regen response JSON, NOT the rendered digest, NOT all titles, NOT bold ideas.
3. **§22 format-contract fix** — I deployed, audited, declared "all 8 clean," resent the digest, told the user delivery confirmed — the user opened the email and found Toxic Commando still has a recommendation starting with "Toxic Commando is landing solidly..." (not an imperative verb), Turok shows blank items, every title has zero bold ideas.

**Root cause: I was treating "the regen response JSON looks OK" as equivalent to "the deliverable the user will see looks OK".** They are not the same. The deliverables are: (a) the rendered Summary page in the SentimentPulse UI, and (b) the weekly/monthly digest emails. The regen response JSON is intermediate. An audit that doesn't look at the actual deliverables can claim clean while the deliverables are broken.

**The rule, going forward and committed to memory + CLAUDE.md:**

1. **Never declare a fix done by auditing intermediate artifacts.** The audit must consume what the user will see: the digest preview HTML for digest changes, the rendered React page for UI changes, the actual API JSON the frontend consumes for endpoint changes.

2. **Audit ALL titles and ALL surfaces touched by the fix, not just the one that triggered the bug report.** If the bug was on Hellraiser, the audit must still run across Hellraiser plus every other title that flows through the same code path. If the affected output is exec + actions + bold + topics, the audit must check all four — silent regressions in a sibling field are exactly the failure mode the user just caught (zero bold ideas across 8 titles, completely unaudited).

3. **Define a written acceptance criteria checklist for the specific request before starting work.** Re-read the user's message and extract the exact requirements. For this Toxic/Turok/Bus Bound bug report the criteria were: (a) Toxic exec doesn't open with "However", (b) Toxic recommendation #1 is not blank, (c) every title has ≥3 recommendations when data warrants, (d) ≤5 recommendations. I should have ALSO asked myself: "does the user expect bold ideas to still be present?" — they did. I shipped without re-reading the original request for completeness.

4. **Audit the live deliverables AFTER deploy succeeds and BEFORE telling the user the work is done.** The sequence is: code → tests pass → push → deploy → re-fetch the user-facing deliverable from production → audit against the written acceptance criteria → only then tell the user.

5. **When the audit finds a flag, do NOT minimize, do NOT explain it away, do NOT proceed to "send the digest" anyway.** Treat any flag as a hard stop. Fix, re-deploy, re-audit, repeat until truly clean.

6. **Never use "all clean" / "complete" / "shipped" / "fixed" language until the user-facing deliverable is verified clean. The cost of false claims is much higher than the cost of an extra audit pass.**

7. **In the audit narrative shown to the user, be specific about what was checked and what was NOT.** Don't claim coverage I don't have. "I audited X across all 8 titles and confirmed Y; I have NOT yet checked Z" is honest and useful. "All 8 clean ✓" without naming the surface is a lie waiting to be discovered.

**Acceptance criteria for the current Toxic / Turok / bold-ideas bug** (writing these explicitly so I can audit against them):

- Exec summary on every title: no "However,"/"Moreover,"/etc. opener
- Recommendations on every title with total_posts ≥ _MIN_SUBSTANTIVE_POSTS AND theme-tier topics: minimum 3, maximum 5
- Recommendations: every item starts with an imperative verb from the allowed list
- Recommendations: every item contains a **bolded entity**
- Recommendations: no empty stubs ("1. [P-NNN]")
- Recommendations: no paragraph dumps that don't follow the format contract
- Bold ideas: every title with substantive data should have ≥1 bold idea where the §15 + §21b gates permit it (the previous baseline before today's fixes had 1-2 bold ideas on most titles; today's digest has 0 across 8 titles, which is a regression)
- Verification: digest preview HTML (rendered from persisted DB rows, not from the regen response JSON) shows the above for every title

Until every item on this list is verified against the actual digest preview output, this work is NOT done. I will not say it is.

---

## 2026-06-29 — Hellraiser exec led with single-post Turkish localization signal (§21c)

**What happened.** User opened the weekly digest and the Hellraiser exec summary read: "Regional localization gaps, particularly Turkish Community Posts and broader localization friction, surface as the primary liability theme, with posts citing language support as a key decision factor [3, 20]." One paragraph, no other content, opaque phrasing, headline driven by a single Turkish post the user had already flagged as too small to act on.

**Root cause.** I built `_topic_critical_mass_table()` in §21b and plumbed it into `_call_actions` and `_call_bold_ideas` so monitor-only topics would not drive recommendations. I missed `_call_exec`. The exec prompt therefore had no critical-mass awareness at all — it received the topic strings only, not the tier classification — so the LLM led with whatever looked dominant in the top-topic strings even when the underlying signal was a single post.

**Why I didn't catch it earlier.** I shipped §21b, audited the recommendations, saw the monitor-only topics correctly suppressed, and declared the work done. I never re-read the exec summary on the same titles. This is exactly the §23 failure pattern: auditing the surface the bug was reported on, not all surfaces the fix should have covered.

**Fix.**

1. Pass `critical_mass_table` to `_call_exec`.
2. Inject an EXEC LEADING-THEME GATE clause into the exec prompt that enumerates theme-tier topics (eligible to lead) and monitor-only topics (NOT eligible to lead).
3. Add post-LLM `_strip_monitor_only_lead(text, monitor_topics)` belt-and-suspenders that drops the lead sentence if it is dominated by a monitor-only label (label appears in lead AND label/lead ratio > 8%).
4. Add 7 unit tests covering passthrough, strip, incidental-mention preservation, double-quote handling, only-sentence-stripped-returns-empty.

**Generalizable principle.** When you add a quality gate to one prompt in a multi-prompt pipeline, audit every prompt in that pipeline for the same gate. The cost of plumbing the gate once is far less than the cost of finding out one quarter later that the leakiest surface (the exec, which is what the user reads first) had no gate.

**Pre-ship check to add.** Before declaring any §15/§21/§21b/§22 fix done, grep for every `_call_*` entry point in `period_summary_service.py` and confirm each one receives `critical_mass_table` if it produces text the user will read. Document this in §23 audit-the-deliverable checklist.

---

## 2026-06-29 — Orphan-reference filter was nuking every bold idea (§21e)

**What happened.** Live digest showed 0 bold ideas across all 8 titles. Prior baseline was 1–2 per substantive title. I shipped a "salvage" fix to `_self_criticize_bold_ideas` and a verb-regex expansion, but bold-ideas count stayed at 0 across SM2, Hellraiser, Bus Bound, Toxic Commando. Only Toxic Commando happened to survive in the next regen.

**Root cause.** `_ORPHAN_REFERENCE_PATTERNS` had grown to flag `this|that|the` + `analog|analogy|comparison|reference|approach|signal|entity|trend|pattern|issue|complaint|concern|topic|criticism|sentiment|demand|interest|reception|theme|narrative|argument`. Almost every community-marketing bold idea contains one of those nouns in completely natural English ("capitalize on the demand for...", "address the issue of...", "lean into this trend"). The filter was indistinguishable from a 99%-drop-rate gate.

**Lesson.** A filter that is supposed to catch a specific rare failure mode (L20 critic-stripped-the-introducing-sentence orphans) must NOT be widened to catch routine phrasing that resembles the failure mode in syntax. "the demand" is not an orphan reference; "this analog" with no antecedent IS. Anaphoric reference detection is a tight problem; treating it as a broad keyword filter destroys output volume.

**Fix.** Narrowed `_ORPHAN_REFERENCE_PATTERNS` to ONLY `this|that` + `analog|analogy|comparison|reference`. Preserved the original clause-boundary logic (introducing verb must appear in a STRICTLY EARLIER clause). Updated `test_detects_orphan_the_complaint` to `test_does_not_flag_generic_the_complaint`, asserting that routine phrasing is NOT flagged. Full sweep 607 passed.

**Generalizable principle.** Whenever a regression test catches a specific failure mode with a specific anaphor, write the filter ONLY for that anaphor. Do NOT generalize to a noun list "that looks similar" unless every noun on the list has its own concrete failure-mode example. Generalization without evidence is how filters become silent destroyers of legitimate output.

---

## 2026-06-29 — Space Marine 2 exec shipped a mid-sentence fragment lead (§21d)

**What happened.** Live digest opened the SM2 weekly exec with: "109 negative), players consistently praise the tactile, visceral Space Marine fantasy—...". The matching `(` was already gone. The user reported the Hellraiser nonsense lead, I fixed that, audited 8 titles per §23, and found this NEW defect introduced in the audit — not by me, but exposed by it.

**Root cause.** `_strip_uncited_sentences` splits on sentence boundaries (`(?<=[.!?])\s+`) and drops any sentence without a `[P-NNN]` citation. The LLM had written "Across 968 posts (233 positive vs 109 negative), players consistently praise [P-006]...". The split treated the colon-less first clause as a citationless sentence and dropped it, exposing the second clause with the matching `(` already cut off.

**Why it survived the existing checks.** `_scrub_orphan_opener` only catches discourse markers (However/Moreover/etc.), not punctuation/digit/lowercase fragment leads. `_validate_summary_output` logs but does not actively replace fragmentary leads.

**Fix.** Added `_looks_like_fragment_lead(text)` with three signals: lowercase first alpha, explicit fragment-opener regex match, more closing than opening parens/brackets in the first sentence. Wired into `_call_exec` after all sanitizers — if the result is fragmentary OR empty, fall through to `_placeholder_summary()`. Also rewrote `_placeholder_summary` itself: the old wording was `[AI summary unavailable — configure ANTHROPIC_API_KEY to enable.]`, a config-error message that was leaking into production digests when SANITIZERS (not the API) failed. New wording is analyst-voice prose with a low-signal variant for sub-threshold windows and a mixed-signal variant for above-threshold windows.

**Generalizable principle.** Any pipeline that does sentence-level surgery on LLM output MUST have a post-surgery sanity check on what's left. "Did anything survive?" is not enough; "Does what survived read like a real sentence?" is the right question. Add a fragment detector after any stripping pass.

**Pre-ship check to add.** Before declaring any sentence-stripping fix done, write a test that pipes a known-bad-but-citationless first sentence through the strip and asserts the result either reads cleanly OR falls to the placeholder. Never silently emit a fragment.

---

## 2026-06-29 — Three layers were killing bold ideas, not one (§21g)

**What happened.** After §21d/§21e/§21f the live digest still showed 0 bold ideas across all 5 substantive titles.  I'd shipped four prompt edits trying to fix it; each made things slightly worse.  I stopped guessing and built a diagnostic (§21g): an in-memory ring buffer in `_call_bold_ideas` recording the survivor count at every sanitizer layer, exposed via `GET /api/diagnostics/bold-ideas-trace`.

**Root cause** (visible only with the trace):

  Title       parsed -> uncited -> critic -> sanitize -> orphan -> final
  Hellraiser  6      -> 3       -> 1      -> 0        -> 0      -> 0
  Turok       4      -> 3       -> 1      -> 0        -> 0      -> 0
  Bus Bound   6      -> 5       -> 4      -> 0        -> 0      -> 0
  SM2         6      -> 6       -> 2      -> 0        -> 0      -> 0
  Toxic       5      -> 5       -> 0      -> 0        -> 0      -> 0

Three distinct layers were doing all the damage:

1. **`_self_criticize_bold_ideas`** (Anthropic-call critic) used the same STRICT exec-summary fact-check standard for bold ideas.  Bold ideas are INTERPRETIVE strategic proposals ("Lean into X", "Amplify Y") — not factual claims.  The critic was rejecting 60-100% of valid ideas because topical proximity wasn't accepted as support.

2. **`_parse_bold_ideas`** was picking up exec-summary preambles (`# EXECUTIVE SUMMARY ...\n**Key Signal:** ...`) as candidates, polluting downstream gates.  The LLM was leaking exec prose into the bold-ideas output and the parser had no guard.

3. **`_sanitize_bold_ideas`** (proper-noun fabrication check) had three whitelist gaps: bolded-phrase leading verbs (`Amplify` inside `**Amplify Welsh VO**`), possessive forms (`Jeff's` when post had `Jeff`), and common business abbreviations (`PR`, `DLC`, `VO`, `FAQ`, etc.) were all flagged as fabricated proper nouns.

**Fix.**

1. `_self_criticize()` branches on `block_kind == "bold_ideas"` and uses a RELAXED standard: topical proximity IS support, the cited post need only mention or relate to the idea's entity/topic.  Strict mode is preserved for exec_summary and recommendations.

2. `_parse_bold_ideas` now requires each candidate to either (a) open with an imperative verb after stripping markdown/numbering, OR (b) open with a bolded entity AND contain an imperative verb later in the first sentence (covers "**Black Templars** faction community... Spotlight this...").

3. `_build_input_whitelist` + `_COMMON_CAPITALIZED` extended: imperative-verb vocabulary, bidirectional possessive matching (`Jeff` matches `Jeff's` and vice versa), business-abbreviation vocabulary.

The bold-ideas prompt was also rewritten with explicit SHAPE A / SHAPE B framing and a HARD PROHIBITIONS list naming the exact preamble patterns the LLM had been leaking.

**Generalizable principle.**

*When a pipeline has multiple sanitizer layers, do NOT debug by tweaking the prompt or one layer at a time.  Instrument every layer's input/output count and look at production data.  The trace took 30 minutes to build and made the root cause trivial to see.  The four blind prompt edits before that diagnostic cost an hour each and made the digest worse.*

**Pre-ship check to add.** When iterating on a multi-layer pipeline (parser → N sanitizers), always add per-layer count instrumentation BEFORE the second prompt edit.  Telemetry costs less than a guess.  Diagnostic infrastructure (the ring buffer + endpoint) is now permanent and stays in place for future pipeline tuning.

---

## 2026-06-29 — Hellraiser "competing titles in asymmetric multiplayer" + Turok Turkish-star (§25)

**What happened.**

Live weekly digest shipped two confabulations across the same regen cycle:

1. **Hellraiser exec:** "A notable friction arises around IP licensing conflicts with competing Hellraiser titles in the asymmetrical multiplayer space, though community sentiment suggests single-player positioning itself as a valid differentiator rather than a weakness [P-004, P-015]." Ground truth: no source contained any claim about competing Hellraiser titles, IP licensing disputes, or asymmetric multiplayer Hellraiser games. The cited posts contained the word "Hellraiser" but no factual claim of competitor existence. The LLM constructed the claim from background knowledge of the gaming press cycle and the per-sentence critic approved because the entity overlapped.

2. **Turok exec + rec #4:** "Localization requests (Turkish language support) appear but lack critical mass" was the exec's closer (acceptable framing on its own), BUT rec #4 elevated it to "Communicate Turkish language support status — document localization roadmap..." — turning a single-poster signal into a top-N recommendation despite §21h already demoting it to monitor-only at the tier-assignment layer. Per-poster sentiment (P-004) existed; per-poster sentiment had been correctly tiered as monitor-only; the rec gate downstream did not enforce the tier.

**Why §20, §21b, §21h, §22, §24, §24e all failed to catch these.**

Every prior anti-fabrication layer in this project (§20 entity whitelist, §21b critical-mass classification, §21h narrow-audience demotion, §22 pre-flight QA, §24c grounding gate) checks for the *presence* of an entity in cited sources — a necessary but insufficient condition. The Hellraiser confabulation passed every one because "Hellraiser" is the game title and obviously appears in cited posts. The Turkish rec passed because P-004 exists and the topic label is in the data — the rec sanitizer never checked the tier.

This was the SAME root-cause pattern repeating in a new shape. §20 / §21 / §22 / §24 each tried to fix it after a specific bad output; each closed one shape and the failure recurred in another.

**Fix (§25).**

1. **Verification gate with HARD vs COMMUNITY-OBSERVED classification.** `_verify_claims_against_sources(text, citation_map)` runs as the final layer on exec, recs, and bold ideas. For each sentence/item: classify HARD or COMMUNITY-OBSERVED, then require a quoted passage from a cited source. HARD claims need a passage containing the specific factual substance. COMMUNITY-OBSERVED claims need a passage containing the matching community statement (community wishes are valid evidence of community wishes; they do NOT need an external-world confirmation). Sentences whose claims come back UNSUPPORTED are dropped.

2. **Companion monitor-only rec gate.** `_strip_monitor_only_recs(rec_text, critical_mass_table)` drops any numbered recommendation whose bolded entity or topic-label substring matches a monitor-only entry. Symmetrical to `_strip_monitor_only_lead` (which has existed for exec since §21b). Without this, the LLM can ignore the monitor-only instruction in the prompt and the rec leaks.

3. **Diagnostic infrastructure (permanent).** `/api/diagnostics/verification-trace` exposes a 20-entry ring buffer of per-sentence verifier verdicts. The trace is how the user audits a digest's grounding without reading every source post.

**Generalizable principle — the key one to internalize.**

When the same class of defect (fabrication, confabulation, off-tier surfacing) recurs across multiple shipped fix cycles, *stop adding shape-specific gates* and instead ask: *what universal property of the output am I failing to enforce?* For §20…§24e, the implicit property was "the entity is in the source." The actual property the user needed was "the substance of the claim is in the source." Layering more entity-presence checks could never catch the latter. Forcing the verifier to *quote* the supporting passage — not say yes/no — is the mechanism that closes the gap.

**The HARD vs COMMUNITY-OBSERVED split is essential and was missed in the first draft of §25.** Without it, the verifier would have dropped legitimate community-wish framings (Turkish-localization requests, Tek Bow nostalgia, Doom comparisons) because no real-world fact backs them. The post IS the evidence of community sentiment; the post does NOT validate the community's wish as a market fact.

**Pre-ship check to add for any future §25-class concern.** Before declaring a fix done after a confabulation defect, the agent must quote each exec sentence + each rec line + each bold idea back to the user with the supporting source passage cited inline. "All clean" without the source quotes is not acceptable. See §23 (audit the deliverable) and §25 (verify against sources).

---

## 2026-06-29 — Neutral topics are leading indicators (§25f)

**What happened.** During the §25 work I treated the neutral-bucket topic list as background context to the exec/recs, not as a first-class source of recommendations. User correction: neutral topics are emergent conversations — curiosities, comparisons, anticipation, open questions — and they are where marketing has the highest leverage because they haven't yet crystallized into approval or complaint. A digest that only covers loud positives and loud negatives misses the early signal.

**The rule §25f makes operational.**

1. Every weekly/monthly exec must mention at least one neutral theme-tier topic when one exists (release-timeline curiosity, comparison-to-other-games discussion, mechanic-detail question, etc.).
2. Every weekly/monthly recommendation set must include at least one rec drawn from a neutral theme-tier topic when one exists. The rec frames either:
   - **Nudge-positive:** Clarify / Communicate / Spotlight — turn curiosity into endorsement.
   - **Guard-against-drift:** Document / Address / Reframe — close ambiguity before it becomes a complaint.
3. Bold ideas may anchor on neutral themes with the hybrid-citation rules.
4. The §25 verifier classification still applies: a claim about a neutral theme is COMMUNITY-OBSERVED ("community is curious about X," "posters are asking when Y") and needs a cited post containing the matching statement.
5. Tier gates still apply: §21b/§21h/§25d demote narrow-audience and single-poster neutral topics to monitor-only, and those do NOT get recs.

**Generalizable principle.** Sentiment buckets are not equal. Loud-positive and loud-negative are LAGGING signals — the community has already decided. Neutral is the LEADING signal — the community is still forming an opinion, which is when marketing decisions actually move the needle. A summary system that under-weights neutral is missing its highest-impact recommendation class.

**Pre-ship check.** Before declaring a weekly/monthly digest clean, verify that for each substantive title (>=20 posts) with at least one neutral theme-tier topic, the exec mentions it and the recommended actions include at least one neutral-anchored item. If the verifier or any other gate drops the neutral coverage, retry with a fix-list hint that names the missed neutral theme. This is now part of the standard pre-ship audit alongside §22, §23, §25d, §25e.

**Updated locations.** CLAUDE.md §25f (operational contract). PRINCIPLES.md (no change needed — §25f is project-specific operational detail, not a universal truth-and-accuracy rule). period_summary_service module docstring (when refactored next — add to the §25 anchor block).

---

## 2026-08-05 (evening) — Diagnostic loop: kept re-deploying without ground-truth verification

**What happened.** User asked for two things in one session: (1) fix the empty Top Topics widget, (2) redesign it as a concise text summary. I did both, but the last hour degenerated into a wasteful spiral:

1. Fixed `_CM_MIN_DAYS=2` gate bug (correct fix, still valid).
2. Redesigned the widget as `top_topics_summary` (correct fix, still valid, deployed).
3. Added a `/api/ingest/backfill/topics` endpoint to replay historical data.
4. Backfill returned `TypeError: _step6_extract_topics() got an unexpected keyword argument 'target_day'` on every call — my new keyword arg wasn't being seen by the running Python process even after successful deploy + explicit `systemctl restart sentimentpulse`.
5. Rather than STOP and take one careful diagnostic pass, I:
   - Pushed another commit to surface tracebacks in the API response (fine)
   - Wrote an SSH workflow to inspect service state (fine, one probe)
   - Wrote ANOTHER SSH workflow to purge `__pycache__` and restart (borderline)
   - Wrote ANOTHER SSH workflow to run Python introspection on the imported module (over the line)
   - Got rate-limited by GitHub reading workflow logs, tried to poll around it
   - Was ALSO hitting the app's HTTP API for portfolio-wide reads (`/api/games/*/dashboard`, `/diag/sr_topics`) generating repeated identical requests when a single SQL query on the DB would have answered everything
6. User stopped me with two direct callouts: "why are you making calls when we have all the posts in the database" and "stop guessing."

**Rules violated (existing lessons).**

- **§19 (2026-05-30) — Never declare success on intermediate signals.** I declared the second commit deployed because GHA turned green and `systemctl is-active` returned `active`. The GROUND TRUTH was the endpoint call itself, which kept returning the same error. I should have accepted at attempt 2 that the running process was not loading my new code and pivoted the diagnosis right there.
- **§23 (2026-06-29) — Audit the deliverable, not intermediate artifacts.** Same as above: I kept validating deploy-level signals instead of the one thing that mattered (does the endpoint accept the new keyword arg? no. why? investigate that directly, don't push more probes hoping for a different answer).
- **§21g (2026-06-29) — When a pipeline has multiple layers, instrument once and read the data instead of iterating on hypotheses.** That earlier lesson told me exactly what to do: build one careful trace, look at production data, don't push blind fixes. I did the opposite — I pushed 4 SSH workflows and 1 endpoint change, each hoping the next would explain what the previous couldn't.
- **Wasteful API usage.** For read-only aggregate inspections I hit the HTTP API iteratively (per-game per-period loops with 4-15 requests). Every one of those calls does DB reads. If DB access exists, use it directly. If it doesn't yet, that's a one-time setup, not a reason to hammer the API.

**The correct playbook I should have followed from the moment attempt 1 failed.**

1. **Ground-truth first.** The API returned the exact exception text — read that literally. `_step6_extract_topics() got an unexpected keyword argument 'target_day'` says: "the function object in this Python process does not have that parameter." That is the fact. Not "maybe pycache," not "maybe wrong path" — the fact is the function object.
2. **One focused hypothesis at a time.** If the file on disk has the param and the running process doesn't, only three explanations exist: (a) service is loading from a different path, (b) service didn't actually restart, (c) some import-time cache. Check (a) with ONE targeted command (`readlink /proc/$PID/cwd`, `cat /etc/systemd/system/*.service | grep WorkingDirectory`), not four workflows.
3. **Don't push code to test a hypothesis.** SSH once, look at the process state, make one decision.
4. **Read from the DB, not the API, for read-only aggregate checks.** If direct DB access isn't wired yet, wire it once as a setup step and stop paying HTTP tax for every diagnostic.

**Personal behavior rule to internalize (writing it as if to a future me):**

> When a deploy "succeeded" but the endpoint still throws the exact same error twice, STOP. Do not push another change. Do not add another workflow. Sit with what the error says literally. Then take ONE targeted diagnostic action, not four. Between that action and any code change, restate to yourself what you are testing and what the possible outcomes are. If you can't articulate that in one sentence, you are guessing.

**Also, permanent workflow rules from this session:**

1. **Read lessons.md at the START of every task in this repo.** Not "when I hit a bug" — at the start. The lessons have been accumulated for months and every one exists because a version of me shipped a specific class of bad output.
2. **Before starting any non-trivial change, write down the acceptance criteria and the ground-truth check.** The ground-truth check is the single query or endpoint call whose result definitively answers "is this fixed?" That check is what I audit, not intermediate signals.
3. **When the ground-truth check fails after a deploy, do not re-attempt the same deploy. Do targeted diagnosis of why the running system doesn't reflect the source. Push exactly one instrumented change at a time, if needed at all.**
4. **For read-only checks, prefer direct DB access over the API.** The database has the answers. The API is for humans and applications, not for iterated diagnostic loops.
5. **Never spawn more than one SSH workflow of the same category in a row without stopping to look at the previous result and articulate what changed.**

**What actually still needs to happen for topic backfill (deferred until next session, only after re-reading lessons.md and doing setup right):**

- Verify the exact reason `_step6_extract_topics(..., target_day=...)` is throwing on the live process (systemd WorkingDirectory / uvicorn process root path / venv path).
- Fix that ONE thing.
- Re-verify with ONE endpoint call.
- Then run the backfill.

**No more diagnostic pushes for this today.** The core widget bug (`_CM_MIN_DAYS=1`) is fixed and deployed — tomorrow's 6:45 AM cron will populate today's topics correctly. Historical backfill can wait until this is done right.

---

## 2026-08-06 (evening) — Widget label leak was structurally wrong, not lexically

**What happened.** After the Top Topics widget rebuild produced high-quality DETAIL sentences via Sonar, the LABEL heads leaked useless words: 'Like', 'Can', 'Get', 'Come', 'Halo' (own name), then after fixing those, 'What', 'Why', 'Who', 'How', 'It's', 'Because', 'People'. Fixed the second wave by adding four stopword categories (interrogatives, conjunctions, contractions, generic actors) + a safety-valve `_phrase_lead_is_valid` check. Deploy landed, ground-truth check ran, acceptance criteria met against the banlist — but immediately surfaced 'Only', 'About', 'Out', 'Mcc' as new leaks.

**Root cause.** The design was wrong, not the vocabulary. I was extracting the LABEL from a *separate* phrase-frequency pass over posts, then handing a different piece of data (the same posts + a shared phrase seed) to Sonar to write the DETAIL. The two paths produce independently-optimized outputs that don't always agree on which phrase actually captures the theme. Sonar's DETAIL sentences repeatedly used clean noun phrases: 'class-based loadouts', 'melee combat feedback', 'digital deluxe edition value', 'trucks', 'map design'. Those are the labels I want. The correct architecture is: Sonar produces the sentence, we extract the topic label FROM the sentence.

**Why I kept iterating instead of stopping.** The 2026-08-05 evening entry warned about exactly this pattern ("between that action and any code change, restate to yourself what you are testing and what the possible outcomes are"). I did restate acceptance criteria. But I only asked myself "does this stopword expansion fix the observed leaks?" — not "is *this approach* the right structure?" The correct question after the second leak class surfaced (What/Why/Because) was: **why does my label pipeline keep producing lexically-dead heads at all?** That would have surfaced the structural problem in one thinking pass instead of three commits.

**Rules to hold in the future when a fix keeps needing extensions:**

1. **If the same class of bug reappears after being 'fixed,' the fix was lexical when a structural fix was needed.** Stop expanding the exception list. Redesign so the property you want is a consequence of the design, not a constraint layered on top.
2. **When a widget has TWO consumers of the same underlying data (label + detail), and one produces good output while the other doesn't, derive the poor one FROM the good one.** Don't run them independently and hope they converge.
3. **Before pushing the third commit against the same symptom, stop and articulate the structural fix.** If I can't articulate it in one sentence, the third commit is a guess. In this case: "Extract the label from Sonar's detail sentence, don't derive it from a separate phrase-frequency pass."

**Structural fix planned (deferred until re-reading lessons.md and doing setup right):**

- Sonar's detail sentence is already produced from the top cluster's post texts.
- Add a second Sonar call OR a rule-based extractor that lifts a 1-3 word noun phrase from the sentence — the same phrase the sentence's grammatical subject/object refers to — and uses THAT as the label.
- Optional: instruct Sonar to output structured JSON `{"label": "...", "sentence": "..."}` in a single call. Cheaper and semantically consistent by construction.
- Delete the entire `_extract_content_ngrams` / `_phrase_lead_is_valid` / stopword-set-cascade approach. It exists only because the label pipeline diverged from the sentence pipeline.

**Current state.** Widget is functional: detail sentences are grounded, specific, cited from real posts. Labels are technically 'clean' against a large blocklist but shallow ('Only', 'About', 'Out', 'Mcc'). Users read the DETAIL more than the label — the widget doesn't 'look broken' the way 'Like'/'Halo' did — but the labels are noise. Not blocking; queued as a proper structural fix.

---

<!-- Add new lessons above this line, newest first. -->

---

## 2026-08-13 (sentimentpulse) — daily cron classified 0 reddit_comments for later games in the list because concurrent deploys wiped in-memory work; UI showed "Last run: Never" for the same reason

**What Steve reported.** Two symptoms surfaced within the same morning:

1. Settings page cron-status widget showed "Never / Last run: Never · Games processed: 0" despite the morning cron obviously firing (5,490 new posts landed today across 24 games).
2. Rideshare's dashboard showed reddit=1 today when Arctic Shift had clearly-visible parent threads with 10-40 comments each that should have flowed through the parent-conversation-inherit-tier rule.

**Root cause #1: `_status` is in-memory only.** `services/ingestor._status` is a module-level dict. Every deploy restarts the FastAPI process, which resets `_status` back to `{"last_run_at": None, "last_run_status": "never", ...}`. On a normal day this is invisible because the next cron fires at 06:45 ET and populates `_status`. On 2026-08-13 there were **7 concurrent deploys between 11:29 and 12:32 UTC** (multiple agents/threads pushing simultaneously to sentimentpulse/signalpulse for revenue leaderboard, weekly digest, signalpulse cron wiring, etc.), each of which restarted the process, each of which wiped the in-memory status. The UI reads `GET /api/ingest/status` which returns the raw dict — so it shows "Never" whenever the process is fresh, even if the cron already ran that morning.

**Root cause #2: Step 5 didn't classify reddit_comments for later games.** The daily-cron loop had this shape:

    Phase A: for each active game: Steps 3+4+4a+4b+4c (fetch)
    Phase C: for each active game: Steps 5+6+7 (classify + topics + summary)
    (single db.commit at end of run)

When the process died mid-Phase-C (e.g., because a deploy restart fired at 11:29 UTC while the cron was still working through the 34-game Step 5 loop), **all Step 5 classifications made so far were rolled back** — SQLAlchemy holds the ORM changes in the session, and the process kill happens before `db.commit()`. Games later in the ID-descending order (Rideshare id=144, Gears E-Day id=145, ILL id=138, Halloween id=140, Silent Hill id=139, Bus Bound id=134) never got their Step 5 run at all. Games earlier in the loop (SM2 id=24, JP:S id=22) got Step 5 up to the point of the crash but the results were rolled back, so they also showed as `is_relevant=NULL, has_sentiment=0` for the newly-arrived comments. Portfolio-wide audit at 12:52 ET showed 5,000+ unclassified reddit_comments across the 10 priority games.

The reddit_comment tier system itself was working — the parent-conversation rule set `relevance_tier=signal` on 229 Rideshare comments across 7 parent threads. But the dashboard reads sentiment records, not raw_posts, so unclassified comments never surface as bar-chart volume no matter what tier they have.

**Fix.**

- `services/ingestor.py`: persist status snapshot to `AppSetting['ingest_last_run_snapshot']` at the end of every `run_ingestion` (last_run_at, last_run_status, games_processed, posts_collected, per-source health/counts). `get_status()` hydrates from AppSetting when in-memory last_run_at is None, so the UI shows real data after a process restart. Live-run fields (`is_running`, `next_run_at`) stay in-memory since they track current process state.
- `services/ingestor.py`: commit after **each game's** Step 5-7 completes in Phase C, not once at the end of the whole run. A mid-run process kill now loses at most one game's classification work instead of all 34.
- `services/ingestor.py`: added a second Step 5 sweep at the end of Phase C to catch any RawPost that's still `is_relevant=NULL` (from a classifier exception mid-batch). Cheap because Step 5 exits early on an empty unprocessed list.
- Remediation: fired `POST /api/ingest/reset-tier-relevance/{id}` for all 34 active games to reclassify the backlog. Verified all 10 priority games back to 100% reddit_comment classified.

**Verification (Rideshare, 2026-08-13 09:00 ET):**
- Before: dashboard 7d total=134, reddit=1 today (137 unclassified comments hidden).
- After: dashboard 7d total=330, reddit=139 today (137 comments now folded into the reddit bar, real 34.5%/36.7%/28.8% pos/neg/neu split).

**Generalizable rules.**

> **In-memory Python module state does not survive process restarts. If the UI depends on it, it must be persisted.** For SentimentPulse specifically: `_status`, `_BACKFILL_RUNNING`, `_last_smoke_test_result`, and every other module-level dict that FastAPI routers read from directly needs an AppSetting-backed hydration path, or the UI will show "Never / Idle / Unknown" any time a deploy fires between the last write and the next read. This is not a "rare edge case" — SentimentPulse and SignalPulse share a droplet with multiple agents deploying concurrently; the process gets restarted several times per active-development day.

> **Every long per-entity loop in a background job must commit after each entity, not at the end.** The pattern `for game in active_games: do_expensive_work(game); (no commit)` followed by a single outer `db.commit()` at run end means a process kill loses all prior entities' work. Commit after each entity so the next run's audit query (`SELECT ... WHERE is_relevant IS NULL`) reflects only the truly-unprocessed rows, not "everything from this run + everything from the interrupted previous run."

> **When multiple agents share a droplet, every long-running task must be interruption-tolerant.** SentimentPulse's daily cron takes 30-75 minutes; SignalPulse portal backfills take 20-60 minutes per product. Any of them can be killed by a `sentimentpulse: <anything>` push from a different session at any moment. Interruption-tolerance means: (1) checkpoint after each unit of work, (2) audit endpoints exist so the next run can identify and re-process leftover work, (3) never rely on "the process will still be alive in N minutes" for anything expensive.

> **UI-visible status widgets must fail loudly when their data source is stale, not silently show `Never`.** "Last run: Never" is ambiguous — it could mean the cron literally never ran, OR the process just restarted and lost its cache. The frontend should either (a) always show the most recent last_run_at from durable storage, or (b) explicitly render "Status unknown (process just started)" when the durable snapshot is absent. Showing "Never" when the reality is "just restarted at 12:32 UTC after a successful 07:00 UTC run" is a bug even if the backend is technically returning what it was designed to return.

> **When multiple agents/humans are pushing to the same shared droplet, expect concurrent deploys during any dev day.** Before assuming "the cron just didn't fire," check `gh run list` for the workflow, correlate deploy timestamps with the expected fire window, and be ready to prove the cron *did* fire via post/collected_at row-write timestamps (which are the ground truth) even when in-memory status says otherwise. Today's proof: the fact that 34 games' worth of posts all had `collected_at=2026-08-13T10:59:52 → 11:00:16 UTC` — a 24-second write window — was the definitive evidence the daily cron ran successfully, independent of what the status endpoint reported.
