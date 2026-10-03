# SignalPulse scoped regression lessons

## 2026-10-03: a reviewed Xbox SKU also needs an xbox_title_cache row, or the boards hide it

**Report:** Minecraft Dungeons II had no Xbox SKU on the multiplatform charts.

**Causes, in order found:** (1) No Xbox row existed: discovery reads only the top-100 paid browse list, and Microsoft shows this Game Pass day-one listing at $0 with no Purchase action, which the paid-only gate drops. (2) After the reviewed seed (PR 195: base 9P5786PJB9RP at 2999 and Deluxe 9NFDXGJ16M47 at 4999, the PS5 prices) and a full refresh, the estimator wrote d7 225,563 native units for title 11293, but the Xbox board and PDP still showed no estimate. The Xbox board query takes name and art only from xbox_title_cache and filters out any Xbox row without one. Seeded rows skip discovery, so they are never landed there.

**Fix:** the seed script now lands each reviewed bigId through landXboxBigIds (idempotent) after writing the rows.

**Rules:**
1. For any Xbox row added outside discovery, land it in xbox_title_cache. A row in platform_sku_map plus an estimate in window_estimates_daily is not visible until it is.
2. When the API shows "no estimate", read window_estimates_daily before blaming the estimator; here the estimate existed and a read-side filter hid it.
3. The full refresh is the only manual refresh path and shares a deploy-droplet queue; check for running jobs before dispatching and expect read-only queries to queue behind long runs.
4. Xbox ratio for this title is held at PS5 parity (ratings Steam 6,437, PS5 1,452, Xbox 1,405 plus 51 Deluxe; catalog median Xbox/PS5 ratings ratio 0.21 against a 0.33 unit ratio). That is a judgment, not a measurement; revisit with real Xbox sales evidence.

## 2026-10-03: owner-driven review surges are not sales; cross-check against Steam's own list before and after

**Report:** The Witcher 3 Remastered was #1 on the Steam d7 board (336K units, $11.1M; PS5 #3, Xbox #4 derived from it). The user said it was not on Steam's top sellers.

**Cause:** Steam d7 and d30 units are new reviews times a sales multiplier (about 40.8 for this title). The free upgrade made owners review: about 120 reviews/day became 2,442 up and 1,133 down on 9/29, a negative share of 28% vs 4% normal, about 9.8x the weekly baseline. Reviews from owners are not purchases, and nothing guarded against it.

**Fix (PR 192, deployed 2026-10-03 UTC), read-time only:** `steam-review-surge.ts` flags a Steam d7 or d30 row (no anchor, override, milestone or Saber product) when the trailing 7 days are at least 3x the title's 21-day baseline, at least 1,500 reviews, and the negative share is at least 15% and 3x baseline. It replaces only surge days (over 2x the daily baseline, inside the trailing 14) with the baseline. Missing or stale daily history is never flagged. dataSource `estimated_review_surge_guard`. Console rows derived from Steam inherit it. Not included: a re-release name heuristic (never audited).

**Audit before building:** 181 Steam titles on the top-100 d7, d30, m12 and ltd boards, 166 analyzable. Only the Witcher 3 met the rule. Ori (14.9x, normal negative share) is a sale-style bump and was left alone. The smaller 1.8x to 3.8x bumps were likely sales and were not verified. Titles outside the top-100 boards were not audited.

**Live result:** Steam d7 336K units, $11.1M, #1 to 42K units, $1.4M, #17; PS5 d7 $8.5M to $1.1M; Xbox d7 $2.8M to $0.4M; Steam d30 458K to 205K units ($6.7M, #17). Ori unchanged.

**Steam cross-check:** [SteamDB weekly](https://steamdb.info/topsellers/) (22 to 29 Sep) ranks the remaster #49, and [Steam's chart](https://store.steampowered.com/charts/topselling/global) also had it #49 at 50% off. Our corrected $1.38M sits within the range of neighbors ranked #44 to #58 (median $1.03M, range $0.5M to $2.1M), so the multiplier was not changed. Our rank reads #17 because the board is paid titles only. The surge week itself (9/29 to 10/6) was not yet published, and revenue ranks are not dollars.

**My error:** I first repeated the user's statement that the title was "absent" from Steam's list without checking. It was on the list at #49. State what a source shows only after reading it.

**Rules:**
1. A review count is evidence of sales only for paying buyers. For a free upgrade, re-release or review-bomb, the negative share rises with the volume; require both before capping.
2. Before building a rule from one title, run the detector read-only over the catalog and list every title it would move.
3. Check any "this title is not on Steam's list" claim against Steam's chart or SteamDB first, then compare our dollars to rank neighbors, not to a rank alone.
4. A fix is done when the originally reported number on the deployed board matches the prediction. Here, rank and revenue both moved as predicted.
5. Not checked: client display, d90 and longer windows (no guard by design), and the multiplier on other old high-review titles.

## 2026-10-02: validate lifetime units against public totals before trusting a derived console figure

A Witcher 3 report ("looks high") was a family-wide defect, not a double count. Stored rows were clean: one Steam
app, one Xbox SKU, and the two regional PS5 SKUs share one rating pool that the board already counts once. The
inflation came from the Path B overlay in `routes-console-leaderboards.ts`, which shows PS5/Xbox lifetime units as
Steam revenue times a fixed console ratio instead of the database's own console estimate (Witcher 3 PS5 22.7M
shown vs 9.4M stored; Xbox 7.6M vs 3.9M). Combined tracked units (66.3M) exceeded CD Projekt's all-platform
65M+ total while omitting PS4, Xbox One, Switch, GOG and Epic.

Audit of the 30 flagged multiplatform families against public lifetime figures (full table with sources:
`public-sales-audit-30-families.md`, shared asset "Audit of 30 flagged families against public lifetime sales"):
- 11 over a recent public total or probably over: Witcher 3, Phasmophobia, Valheim, Black Myth: Wukong, ARC Raiders,
  Ready or Not, Crusader Kings III, Crimson Desert, Don't Starve Together, Bannerlord, Satisfactory. Starfield's PS5
  overlay (3.1M) vs about 140K one week after launch is also inflated.
- 5 within the public total (Palworld, Stardew Valley, Red Dead Redemption 2, Monster Hunter: World, Hogwarts Legacy);
  11 with no usable public figure; Space Marine 2 is a Saber title and is never changed.
- Where a recent first-party figure exists (ARC Raiders 16.3M, Ready or Not 13M, Phasmophobia 25M+), the native
  estimate sits near it and the overlay is far above it. But native is not reliable everywhere: Forza Horizon 5 PS5
  native 2.2M vs public 5M to 6M, where the overlay (7.05M) is closer. Do not blanket-switch to native.
- Steam's own estimate exceeds the all-platform public total for Phasmophobia, Valheim and Black Myth. That is a
  Steam-side error; no overlay rule fixes it.

Outcome (PRs 184 and 185, deployed 2026-10-02): `console-public-ceilings.ts` skips the lifetime PS5/Xbox overlay
for 8 families when Steam plus overlay exceeds the dated public total, keeping the native console estimate. Live
lifetime boards after deploy: Witcher 3 PS5 22.74M to 9.37M, Xbox 7.56M to 3.93M (tracked 49.3M vs the 65M+
all-platform total); ARC Raiders, Ready or Not, Crusader Kings III, Crimson Desert and Valheim Xbox also switched to
native; Stardew, Hogwarts, RDR2, Monster Hunter: World and Palworld unchanged. Not yet verified: Phasmophobia console
rows and Valheim PS5 (not in the top 300 returned), client display, shorter windows (unaffected by design).
Still open: Steam alone exceeds the public total for Phasmophobia, Valheim and Black Myth.

Lesson from the miss: PR 184 passed its tests and CI, but Witcher 3, the reported title, was not fixed on the live
board, because the live rows are named "The Witcher 3: Wild Hunt — Remastered" and the table key was the plain
name. Match a name-keyed table against the live display names (add aliases), put the live name in the test, and
check the originally reported title on the deployed board before calling the fix done.

Steam-side follow-up (PR 187, deployed 2026-10-03 UTC): a read-only production query found no anchors, overrides
or unit milestones for Phasmophobia (title 10088), Valheim (10006) or Black Myth (10463), so nothing protected them.
`steamPublicCapRatio` scales a Steam lifetime estimate above the public all-platform total down to that total
(revenue scaled, units revenue-derived, dataSource `estimated_public_ceiling`, caveat on the row). Live lifetime
board after deploy: Phasmophobia 29.69M to 27.00M, Valheim 19.85M to 17.00M, Black Myth 36.15M to 30.00M; all other
Steam rows unchanged. The cap is an upper bound, so Steam alone may still be overstated by the console share.
Open: Black Myth's PS5 listing "Black Myth: Wukong (Simplified Chinese)" (6.92M, estimated_console_exclusive) has no
Steam name match, so the console guard never sees it; Steam 30M plus 6.9M PS5 exceeds the 30M total. The 30M is
third-party (Communist Youth League of China), so do not tighten it without a developer figure. Phasmophobia console
rows and Valheim PS5 were not in the top-100 board and were not checked. Client display not checked.
Lesson: a name-keyed guard misses regional or edition listings whose names differ across platforms; when a family
trips a ceiling, check every listing in it, not only the name-matched ones.

Name-matching follow-ups (PRs 189 and 190, deployed 2026-10-03 UTC):
- PR 189 made the Steam cap "public total minus native console units for the family" (floor 50% of the total) and
  added a short alias for Black Myth's PS5 listing. Live check: Black Myth Steam fell only to 29.55M, not the
  predicted 23.1M, because the live PS5 name is "Black Myth: Wukong (Simplified Chinese, English, Korean, Thai,
  Japanese, Traditional Chinese)" and my unit test used a short invented name. Its 6.92M was still not counted.
- PR 190 matches the exact key first, then the key with one trailing parenthetical removed, and tests the exact live
  name. Live result: Black Myth Steam 22.63M + PS5 6.92M (+ Xbox 0.45M native, not in the top-100 board) = the 30M
  third-party total. Phasmophobia Steam 25.19M, Valheim 15.64M, ARC Raiders 11.59M, Crimson Desert 4.61M; other rows
  unchanged. Client display, shorter windows, and console rows outside the top 100 were not checked.
- I also wrote in PR 189 that other Steam rows would be unchanged. They were not: any family whose Steam plus native
  console units exceeds its public total is lowered (ARC Raiders 12.45M to 11.59M, Crimson Desert 4.79M to 4.61M).
  That is the designed behavior, but the PR text was wrong. Predict the effect from the rule, not from the three
  titles that motivated it, and list every family that can move.
Lessons: (1) This is the second name-keyed miss in this feature (Witcher 3 "Remastered", then Black Myth's language
list). Before writing the test, read the exact live names for every platform from the API and use them verbatim;
console storefronts append edition and language lists in parentheses. (2) Report a deployed fix only after reading
the specific number it was meant to change, and compare it with the prediction. (3) A third-party public total is
still a weak ceiling; get a developer figure for Black Myth when one appears.

Rules for the fix and for future sales-estimate reports:
- Check stored SKU rows and the shared-pool grouping first, then compare the displayed figure with the stored
  estimate for the same row. A gap between them points at the read-time overlay, not at double counting.
- A public all-platform total is a ceiling for the tracked platforms, not a platform split. Build a small table of
  recent first-party totals with sources and dates, and apply it only to families that have one.
- The rule runs at read time, so stored data is untouched and daily writers cannot overwrite it. Anchored and Saber
  titles are excluded. A test must fail if a tracked total exceeds its ceiling.
- Audit the whole flagged population before building, and say which figures are weak (undated, unattributed,
  third-party, or years old) instead of treating them as ceilings.

## 2026-10-01: match rating pools with tolerance, not exact equality

Sibling SKUs are captured at different moments, so identical pools differ by a few ratings, and a family
key built from names misses siblings with different names. Exact-equality dedupe silently stopped working
for Witcher 3, Ark, Skyrim, Minecraft and GTA Online. Match on count within a small tolerance plus a
second sign of the same concept, prefer verified anchors, never merge a verified zero anchor, and check
the candidate rule against unrelated titles that match by chance before shipping.

## 2026-10-01: sibling SKUs that share a rating pool must not be summed

The family rollup treated sibling SKUs as additive sales. On PS5/Xbox, regional and edition SKUs of one
concept share one rating pool and get the same estimate, so the sum doubled or tripled units (Stellar
Blade, Gran Turismo 7, Mafia, Undisputed and others) and a new Definitive Edition's bootstrap lifetime
value was shown as a 30-day figure. A user report on one title (Mafia PS5 30 days) was a family-wide
defect: audit every board row with a shared pool before fixing.

## 2026-09-30: name-pattern rules must normalize store names

The console-first sports IP rules were anchored regexes on the display name. Store names carry a trademark
glyph and publisher prefix ("EA SPORTS(TM) Madden NFL 27"), so Madden 27 silently fell to the generic
console ratios and dropped off the boards. Normalize names (strip TM/R/C glyphs, collapse whitespace)
before matching, and when a franchise rule exists audit every catalog name against it, not one title.

## 2026-09-30: claiming a global fix requires auditing every title, not the reported one

The gap fix (#161) was called fixed after checking Control Resonant, a replay sample and the protected
titles. A live scan of all 1,126 paid-base series found 639 still blank on Sep 24/25 (44 protected).
Halloween: The Game's Steam series was blank because the Steam multiplier reset halved LTD units
across the gap and the rule skips negative changes. Audit the whole population live, classify every
blank by cause, and only then claim. A negative LTD change can be a re-scale, not a data artifact:
value it from signal growth at the current ratio when the next adjacent pair confirms the ratio.

## 2026-09-30: anchored and Saber titles are never reallocated; re-read the rules on resume

The user corrected two things during the global missing-day repair. (1) Anything
anchored to actual or publicly reported data, and every Saber title, must never
change. Saber's Steamworks actuals inform the algorithm instead. Protection is
fail-closed at the sibling-group level (calibration anchors, multiplier overrides,
active milestones, Saber products); a failed check also protects. Wardogs and
Marvel's Wolverine are covered by those tables. (2) A resumed compacted session
must re-read CLAUDE.md and lessons.md before touching code; that was skipped and
the first replays showed it: a $953M "increase" was rebasing artifacts, not sales.

- A gap fix must only fill null days for titles that have one and must leave every
  existing point byte-identical. Diff before/after on real data and count changed
  existing points (must be 0) and protected titles touched (must be 0).
- Never split evenly and never zero-fill: no dated evidence means the day stays empty.
- Reviews trail purchases. Saber's Twisted Tower actuals (launch 2026-08-18): same-day
  review shares misallocated 21-34% of units across launch days, next-day shares 3-9%.
  One launch is validation of a starting point, not a universal constant.

## 2026-09-29: preserve evidence, not an arbitrary existing revenue total

The user clarified: increase totals when evidence establishes omitted sales.
Do not turn anti-double-counting into a fixed-total policy. Distinguish missing
activity evidence from a missing estimate date: Townfall's September 24 review
bucket was already in all five current totals, but no estimate row existed for
that date. Reconstruct from activity dates, not differences across missing
observation dates. Label console timing as modeled and reconcile every window.
New admitted evidence must raise totals normally; never insert fabricated
console rating observations or another copy of revenue already in the total.
Keep recovery reversible and prove repeat daily writers do not erase or compound it.

## 2026-09-27: calibrate volume without inventing a sales-date spike

The user wants public Steam milestones to preserve the existing modeled sales
pattern at a revised volume. Use a frozen, nonoverlapping activity-day basis,
not an intraday lifetime snapshot or an old inflated accumulator as denominator.
Public units do not establish actual revenue or actual per-day sales. Retain
old inputs separately, explicitly supersede only the audited assumption, and
prove immediate rollback without erasing new raw observations.

Sustained CCU can corroborate a per-product hypothesis but cannot distinguish
new buyers from retention, patches or free events. Shadow proposals stay
unapplied, require comparable UTC samples and paired review coverage, and
must not compound or propagate into consoles. Missing top-chart coverage is
unknown, never zero activity. No new schedule is required.

## 2026-09-26: FC26 correction now explicitly includes annual and lifetime

The user superseded the earlier short-window-only scope: "12 month estimate
formed 26 is still way off apply change to 12 month and lifetime estimates".
Use each long window's own eligible native platform models, never today's
weekly attenuation factor or a newly invented sales actual. Retain the sports
mix, verified anchors/overrides, raw observations and accumulator state.
Reject Steam-derived peers as independent constraints. Keep the long-window
extension separately reversible and prove all-surface parity, monotonic
window values on the audited inputs and unchanged repeated writer behavior.
Copy and changelogs must no longer promise annual/LTD remain unchanged.

## 2026-09-26: fix rolling inference without inventing a lifetime restatement

FC 26's rolling Steam model amplified PS5 revenue 6.5x even when native
same-period console models were much lower. The owner's clarification narrowed
the repair to d7/d30/d90, not annual/LTD. Keep that scope explicit. A conservative
family-consistency ceiling is a model policy, not an actual-sales anchor or a
measured subscriber fraction. Exclude Steam-derived peers from independent
constraints, preserve manual/verified protections and retain the sports split.
Do not force worldwide estimates to match a current US storefront rank or use
today's rank to rewrite 90 days of history.

Test annual franchise identities explicitly. FC 26/27 native App IDs and stored
histograms were distinct; inflating FC27 100x must not move FC26. Do not attribute
inflation to cross-title leakage without evidence.

Xbox's FC26 child has a sentinel release date and no retail offer. Its exact
Standard Edition parent has the real paid offer and native child membership.
Validate both IDs, family, primary fulfillment membership, release and current
USD full-game offer. Retain the child rating identity; never sum the retail
bundle as an additional sale. Record catalog/metadata/GP before-images and test
field-level rollback plus repeated real writers, not just parser fixtures.

## 2026-09-26: publisher retirement is not tracking retirement

The user superseded the earlier lifetime-only archive policy: keep retired
demos in daily own-App-ID source checks, the main metric views and PDPs.
Record the first detected unavailable date, preserve it on repeat checks,
and leave unknown older dates unknown. Keep the archive as a retired filter.
Top/New source feeds remain available-only. Friends Pass retirement policy
does not change. Separate verified invalid identities from retired demos.

Graveyard Keeper 2's retired App ID returned success=1 with zeroed historical
review buckets, while 695 reviews remained in the database. Reject an empty
replacement of positive saved review history on a retired demo. Only successful
review refreshes may advance its estimate date. Show stale evidence dates and
do not present a previous rolling period as a current one. Valid CCU zero is
different from unavailable/404. Never substitute parent-game metrics.

## 2026-09-26: demo PDP history must distinguish activity from observations

The latest-only Steamworks demo cache is not a historical time series. Retain
one successful observation per UTC date/window alongside it; seed only the
original fetched date of an existing verified report. Failed refreshes create
no observations. Daily net changes require adjacent observation dates and
adjacent report-end dates with identical report starts; preserve corrections
and never allocate a multi-day gap into individual days. Label these as changes
in observed lifetime totals, not audited calendar-day downloads.

Steam daily review histogram buckets are activity dates; estimator inputs and
new review snapshots are observation dates. Their daily changes need not match.
Use retained estimator review-count inputs where available, but never infer
historical positive percentages or replace Saber's actuals with old modeled
downloads. Historical model outputs keep their original multiplier ID.
Weekly/monthly review buckets are never divided into invented daily reviews.

IGDB may use the verified parent game's App ID for metadata and media only.
Label that scope explicitly; parent reviews, downloads and CCU never enter a
demo PDP. Deactivated demos remain excluded except approved Saber lifetime
totals. Hook retention into existing collectors; do not add a competing cron.

## 2026-09-26: qualified pass scenarios are not measured pass users

The user explicitly authorized qualified modeled inputs for Lords and It Takes
Two. This does not relax the standalone measured-player evidence gates.
Keep modeled average CCU/player-hours in a separate dated scenario contract,
not downloads, unique-user columns, ranks, or actuals. Persist the original
inputs and coefficients, distinguish incremental guests from total client
activity, hour-weight monthly means, and preserve broad sensitivity bounds.
The sparse weekday sample does not establish new pass-specific weekend spikes.
Never request that the user re-upload research files already in the workspace.

## 2026-09-26: provider cooldowns must survive phase and process boundaries

A discovery-local 429 flag does not stop the next process from spending a fresh
retry budget against the same Steam appdetails throttle. Discovery and paid-sales
reconciliation must share durable Retry-After state. Defer metadata explicitly,
preserve existing paid evidence, and leave review/histogram collection independent.
Use transactional operational state that releases its lock after process death;
corrupt, unwritable or busy cooldown state must fail closed before HTTP. Never
shorten a provider deadline, including a long header on the final retry.

Missing stored names are not proof that an App ID is ineligible. Unnamed,
non-manual unknown Steam bases can recover only from native metadata whose
embedded App ID matches exactly, followed by the unchanged paid/released/base
gates. Recheck the recovered family name against existing and same-plan paid
coverage inside the apply transaction. Preserve IDs, raw observations, anchors,
overrides and LTD state; do not copy history to fabricate coverage. Record full
metadata before/after images and refuse rollback over a later metadata writer.
QA must include the real production schema, separate processes, writer crash,
exact rollback and a same-day control when replaying clock-sensitive estimators.

## 2026-09-25: monotonic state can preserve an invalid initial snapshot forever

Sniper Elite: Resistance inherited a first snapshot of 880,801 reviews followed
by a correction to 4,824. Option-B positive-only replay retained the wrong
initial count and seeded 35.4M units despite a current signal near 5,000.
Do not treat every old snapshot as compatible with today's canonical identity.
Seed only missing states from current estimator evidence; never rewrite an
existing repaired state during reseeding. Carry a cumulative high-water mark
across daily count declines, so rebounds do not add the same reviews again.
Repair only mathematically proven seed excess, not arbitrary implausible revenue:
audit the entire saved LTD trajectory, protect anchors/overrides, preserve raw
evidence, correct contaminated LTD history with state, and test rollback plus
repeated real estimator/anchor/mix writers. Do not add a competing schedule.

Full-catalog follow-up found residual Steam overlap maxima and console
observed-pace windows extrapolated above all lifetime ratings. A past-window
rating signal is a subset, not an unconstrained forward forecast. Bound that
specific extrapolation before it reaches monotonic state. Prove both original
and corrected trajectories before removing a retained floor; preserve separate
rank floors, raw evidence, prior legitimate peaks and protected actuals.

## 2026-09-25: a period fallback is not that period's sales

Dispatch's gated seven-day signal silently substituted its 30-day estimate.
Weekly totals must select only d7 rows or existing explicitly same-period
models/anchors. Test through all four actual HTTP surfaces, not only SQL.
Never multiply null by an anchor ratio: JavaScript coerces it to false zero.
Missing-platform revenue is not an absent platform or zero sales; preserve null,
label available totals as partial and withhold complete-share charts.

## 2026-09-25: timer success requires fresh evidence and cross-scheduler locking

Discovery's freshly-classified count is not the eligible paid catalog: unavailable
metadata may correctly preserve prior paid evidence. Count retained evidence only
for the current candidates, never unknown new SKUs or verified non-games. Stop
appdetails requests on rate limiting rather than hammering the remaining list.
Keep synthetic seed/invariant tests out of the production daily path.

GitHub cancel-in-progress:false does not protect pending jobs under its default
single queue. Use queue:max consistently across the shared group. GitHub queues
do not lock systemd timers; use a shared host lock before refreshes and shared
checkout deployments. Retire duplicate schedules rather than relying on timing.
Do not stop another run to make room. Budget collection against the full catalog,
and verify a new invocation, fresh per-platform observations, all phases and the
completion marker before claiming success.

## 2026-09-25: real reviews are not necessarily new sales

The deduplicated histogram still treated an extreme negative review campaign as
purchases and accumulated that error into lifetime sales. Distinguish histogram
activity from filtered storefront summaries and compare identical language,
purchase and off-topic scopes before alleging duplicate counts. Preserve raw
sentiment; screen only the sales proxy with title-independent, historical gates.
Exclude the same campaign from platform-share learning. Repair only a proven
increment above a recent pre-event mature baseline, with unchanged coefficients,
reviewed manifest, backup, audit, rollback and repeat-estimator QA.

## 2026-09-24: timer restoration and unknown metadata are not harmless

Restoring `signalpulse-daily.timer` after a bounded repair launched discovery
because the timer declared `Requires=signalpulse-daily.service`. Discovery then
replaced 144 known paid Steam classifications with unknown after empty metadata
responses. Remove that activation dependency; `Unit=` already names the scheduled
service. Before pausing any timer, inspect its dependencies and persistent behavior.
Verify the service stayed idle after restoring scheduling, not just timer status.

Missing upstream evidence must preserve known paid classification and provenance,
but a verified DLC/non-game response must still remove paid-game eligibility.
Test both paths and new unknown SKUs. Recovery must restore only audited fields
from the retained snapshot, never the entire database or fresh review observations.

## 2026-09-24: review resolutions are alternatives, not additive sales evidence

The paid-sales estimator summed both daily and weekly histograms. Zero Company's
September 23 d30 signal became 41,416 against 20,708 lifetime reviews, and
`derived_max_windows` preserved the inflation. Check grain, coverage and temporal
boundaries before multiplying. Test real stored inputs, every window, lifetime
state, console overlays, and repeat runs; a plausible revenue total is not QA.

A query fix cannot lower an already contaminated monotonic accumulator. Repair
only provable unanchored derived states, with reviewed manifest, backup and audit.
Preserve the highest observed review signal across resets using the unchanged
active coefficient; obsolete modeled unit predictions are not verified actuals.
Never rebase verified anchors, manual overrides or mature accumulators by inference.
Do not tune to a competitor's estimate to hide a measurement defect.

## 2026-09-22: Friend's Pass identity and runtime are separate from demo identity

Pass clients may be type=demo or type=game, may omit `is_free`, and may be
named FriendsPass, Friends' Pass, or Buddy Pass. Verify an exact currently
offered free install/run or a free-license offer for an appdetails-owned
package. Package availability is not a license-count download metric.
Never substitute the paid game's reviews or CCU when a pass storefront
SKU shares its runtime. HTTP 404 on that SKU's player API means unavailable,
not zero. Hybrid demo/pass activity cannot be separated.

Keep pass clients in their own `sku_kind`, revalidate daily, retain last
status on transport errors, and do not retain deactivated pass estimates.
Named searches must paginate to exhaustion or expose an incomplete run.
An evidence-backed alias seeds discovery but never bypasses daily checks.
Keep discovery/backfill within the existing 03:00 Eastern schedule.

Recent daily review buckets overlap lifetime weekly/monthly rollups.
Select one current rollup representation and add only nonoverlapping days.
Lifetime review totals and 130× trial estimates must reconcile exactly;
older window edges remain bucket-based, never fabricated daily precision.

## 2026-09-22: discovery depth, current availability and release dates are separate

The first 100 source slots omitted hundreds of verified demos. Top/Trending
now sample 500; New Releases reads at least 500 and catches up to the prior
successful source-head watermark, with a full-page overlap and 2,000-slot
safety cap. A capped/failed catch-up must retain the old ranking, success
time and anchors, and report an error. This remains daily at 03:00 Eastern;
do not add a competing schedule.

A future/missing demo release date does not prove the demo is unavailable.
Allow the fallback only after demo identity and game-parent checks AND a
current Steam parent-page download action referencing the exact demo App ID.
Store the verification source/time; leave the release date null rather than
copying a parent date or inventing one. Network failures are not permanent
deactivations. Software parents and Friend's Pass clients pending review stay
excluded. Expanded catalogs require server-side search and pagination after
all window/source/genre filters and numeric sorting, with stable tie-breaking.

## 2026-09-22: deactivated demos retain only Saber lifetime actuals

Publisher-deactivated demos are not tracked in rolling-period leaderboards,
review estimation, public review polling, or CCU polling. The sole exception is
the explicitly approved Saber roster's lifetime Steamworks download actuals:
retain and refresh those totals on dashboard cards and the Lifetime leaderboard.
Do not restore retired competitors or refresh retired Saber rolling windows.
Label retired Saber rows "Deactivated · lifetime only" and suppress old public
metrics. Show sampled discovery limits; never imply complete Steam coverage.

## 2026-09-22: own-demo downloads must use the actual demo report

The user requires Saber actuals on both leaderboard and dashboard cards;
only non-Saber demos use review-delta estimates (130x trial). Use each
approved demo App ID, never a paid parent game's downloads or preloads.
The verified Steamworks nav_regions.php?downloads=1 report labels its
metric Total Downloads. Free licenses explicitly do not imply downloads;
app/details lifetime unique users measures launches, not this report.
Read the actual date-scoped total for every leaderboard window; use all
history for cards. Verify title, scope, dates and metric before accepting
data. Missing Saber reports stay unavailable; failed refreshes preserve and
flag cached actuals, never fall back to reviews, CCU or license categories.
Retired demos retain lifetime card totals. Toxic Commando is Saber-developed
but Focus-published: approved demo mapping, not base publisher flag, controls
its card. The existing 03:00 America/New_York ingestion updates both sources;
do not create a second competing schedule.

## 2026-09-22: demo review scores must be demo-owned and non-overlapping

Use the demo App ID, never the parent game's reviews. A lifetime histogram
rollup and its recent daily buckets overlap; do not sum both for the score.
When weekly/monthly representations coexist, use one, not both. Recent-only
daily history cannot establish an old demo's lifetime score. Preserve genuine
0% positive separately from no reviews/unavailable and sort by the numeric
percentage before limiting rows. Label daily-cached scores as such.

## 2026-09-22: trial demo multipliers must preserve cohort boundaries

The user selected a 130x non-Saber live trial while preserving Saber's
65.5x baseline. Label a user-selected trial as such, never as an empirical
refit. Share rate selection between API and scheduled writer, recompute
from review deltas rather than scaling already-derived units, retain actual
protection, and apply the resolved values before sorting and limiting.

## 2026-09-22: demo review ratios need concurrency consistency checks

A single title's downloads/review anchor is provisional, not a universal
validated fit. Match downloads and all-language reviews to the same cutoff
before refitting. Never invent a higher global ratio from a CCU outlier.
Check the lifetime model against observed concurrency before ranking/display.
Where it fails, label the observed minimum explicitly, retain the raw review
estimate, and do not reuse that lifetime floor for a partial-lifespan window.
Keep activation categories out of demo-download calibration and ingestion.

## 2026-09-22: demo leaderboard coverage must match its named views

Parsing only the first embedded New & Trending block does not discover the
latest releases or most-played demos. Verify the actual browser feed for
each named view and its pagination. Persist independent source ranks and
timestamps; review/CCU sorts are not substitutes for Steam's Top Demos
(recent daily active users) or New Releases order. Test known missing
examples and no-review new releases, not just arithmetic on the old pool.

Per-title appdetails checks hit HTTP 429 when expanding the universe and
misclassify some software parents as games. Use batched Store Browse
metadata, verify demo + parent types, and share a cache only within one
pipeline run. Missing/failed metadata is not permission to include an app.
Retain the last complete feed snapshot on upstream/verification failure
and expose that failure rather than quietly relabeling old data as fresh.
Do not deactivate a freshly metadata-verified demo just because its review
histogram is absent. Software demos and license-category counts remain
outside the playable-game-demo pipeline.

Release dates must be the demo's, never the parent's. Label broad
Steam genre tags honestly, and apply genre filters and numeric/date sorts
before limiting API rows. Null values stay last in either sort direction.

## 2026-09-21: revenue authority and automatic application are separate contracts

Final anchored/model revenue must be resolved before displayed units. Recompute estimated units from that revenue and unrounded family ASP; preserve verified revenue/unit pairs through their realized ASP. Never pair raw pre-overlay units with final revenue or silently change stored training observations. Reuse one resolver across every Buying surface and sort after reconciliation.

Shadow mode never graduates itself. If the user wants automatic daily application, implement an explicit scheduled application stage, per-day audit ledger, eligibility gates, bounded adjustments, truthful visible status, and a kill switch. Do not apply today's mix to an entire historical period. Normal days return to the baseline; past applied dollar deltas remain scoped to their actual dates. Ratings are a proxy, not proof of a platform sale.

## 2026-09-21: an intermediate estimator field is not a second sales KPI

The owners count is the ratings-derived intermediate before the digital-share conversion to units. Raw revenue uses units × ASP; anchor/overlay revenue can override that independently. Present units and revenue, not both owners and units. Remove obsolete metric selectors and exports along with the card, while preserving internal fields and legacy APIs. Check unrelated surfaces before global deletion: hmap Genre Stats has a separate estimator that uses owners directly.

## 2026-09-21: update metadata can split a base game's platform family

No Man's Sky's paid base Steam/Xbox SKUs were enriched as Worlds Part II. A null legacy confidence flag bypassed the header guard, and Xbox's historical CTI seed froze the same enrichment error as if it were a verified store identity. PS5's actual base SKU then fell into a different family. Validate cached enrichment against the captured storefront name at read time, search from the storefront rather than a previous enrichment result, and never elevate an enrichment-seeded cache above exact-SKU store evidence. Test all five windows and regional SKU duplicates: units/owners/anchors are keyed by title and platform, not by regional listing.

## 2026-09-20: identity correctness does not establish artwork correctness

The Halloween metadata repair correctly rejected the unrelated IGDB title but reused a landscape storefront header as `coverUrl`. Checking title text and image presence was not sufficient QA. Keep landscape and portrait roles distinct, resolve official exact-SKU asset metadata rather than guessing CDN paths, measure native dimensions, and inspect the rendered portrait at desktop and mobile sizes on individual and combined PDPs. Browser fallbacks must reject wide/square assets rather than crop them to pass a visual shape check.

Shadow calibration must never be described as an already-trained revenue model. Persist raw evidence, peer coverage, rejection reasons and bounded proposals, while leaving live estimates unchanged until ground-truth validation supports activation.
## 2026-09-25 — Views over time must use the requested flow metric

The user corrected the YouTube PDP's featured lifetime-snapshot chart: they want daily views, not cumulative views. Use same-video changes between consecutive daily observations (`netViews`), never differences between portfolio snapshot sums that can jump as videos are discovered. Keep first observations and missing comparisons blank; label weekly/monthly grouping as summed period views. Verify the actual chart series, headline, table and CSV rather than only changing the chart title.
## 2026-09-26: Download report dates are not observation dates

The demo PDP showed one Saber lifetime snapshot and blank older download cells
because the prior cache retained only its latest fetch. Historical single-day
reports are available, but summing them does not necessarily reproduce a wider
Steamworks report. Retain direct day reports, baseline-through-date reports,
observed lifetime snapshots and net snapshot changes as independent series.
Keep the legacy lifetime parser's explicit scope guard; a historical
date-bounded report is not a past observed lifetime snapshot.

Public review pagination can disagree with both its summary and histogram.
Exhausting a cursor alone is not proof of completeness. Reconcile counts before
publishing recovered daily estimates, preserve histogram precedence, record
current retrieval timestamps, and surface disagreement rather than overwrite.
No historical CCU, zero-filled missing days, or backdated cumulative observations.

A missed daily run is a global data hole, not a per-title one. When the daily
series is derived from consecutive published lifetime values, allocate the
published change across missing days from dated evidence in one generic path
(gap and first-observation), conserving the total. Do not hard-code titles, do
not synthesize lifetime rows, and label modeled days on each point.
