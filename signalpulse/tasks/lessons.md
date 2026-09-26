# SignalPulse scoped regression lessons

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
