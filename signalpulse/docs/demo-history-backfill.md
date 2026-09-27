# Steam demo historical recovery

This extends, rather than replaces, PR149's observed-snapshot history and
PR152's continued tracking after publisher retirement.

## Independent series

- `dailyDownloads`: for Saber, a directly verified single-day Downloads by
  Region report for the exact demo App ID. For non-Saber, a provisional 130×
  estimate from a daily review activity count; the source identifies whether
  it is a Valve histogram bucket or reconciled surviving-review creation dates.
- `reportedDownloadsToDate`: a directly retrieved Steamworks report with
  `dateStart=2000-01-01` and the historical `dateEnd`. This is a date-bounded
  report fetched now, not an observation made on that historical day. No
  lifetime-scope label is assumed. It is never computed by adding daily totals.
- `lifetimeDownloads`: original retained lifetime snapshot or model output,
  on its original observation date. Existing figures and model IDs are unchanged.
- `netLifetimeChange`: the old consecutive-comparable-LTD difference, retained
  separately. It is not a single-day report and can include negative corrections.

Source report calendar dates are distinct from UTC review-creation / CCU dates.
Retrieval timestamps are retained separately and exported in CSV. Reports can
be revised. The default recent collector conservatively excludes the current
Pacific calendar day, and rereads three prior dates for late revisions.

## Ongoing daily behavior

The same 03:00 America/New_York pipeline now retrieves direct single-day and
date-bounded cumulative reports for the last three completed dates for all six
approved Saber demo App IDs, including retired demos. Each run is capped at
48 requests / 120 seconds, serial and paced. Failures preserve last-good data;
401/403/429 stop the request budget rather than provoking rapid retries.

The existing daily own-demo review histogram, review-total observations,
estimate snapshots and CCU sampling continue for the eligible tracked catalog.
No parent metrics, complimentary units, full-game preloads, extra schedule,
or reconstructed historical CCU are introduced.

## One-time backfill

`scripts/backfill-demo-history.ts` is read-only planning by default. It requires
explicit `--since` and `--until` dates, and a scope of `all`, `saber`, or `reviews`.
No date bound implies exhaustive Steam history; report the requested interval
and unresolved dates/title jobs explicitly. `--apply` requires the maintenance
lock environment flag. Production execution must hold the real host flock and
follow an approved, consistent SQLite backup.

Each apply invocation is limited by `--max-requests` (default 200, maximum 5000)
and `--max-ms` (default 240000, maximum 3600000). It resumes existing checkpoints
without resetting them, processes no more than ten dates/pages per title per
invocation, and refuses a different date scope for an enrolled job.

Saber backfill proceeds newest first. A date advances only after both explicit
reports are verified. Review recovery pages the demo's own public reviews:
all languages, purchase types and review types, without the off-topic filter.
It retains only a hash of review identity, UTC creation date and recommendation
polarity. No review text or author account data is retained.

An exhausted cursor must reconcile with the current endpoint summary and any
fresh completed-day histogram overlap before recovered daily estimates are
published. Count disagreements become `mismatch`, not a successful empty or
full historical series. Failed/partial jobs retain cursors and do not publish
partial estimates. A zeroed retired endpoint cannot erase prior positive history.
Original histogram days always take priority. Missing days are not zero-filled.
Recovered surviving reviews do not recreate deleted reviews, past sentiment,
or historical observed cumulative review totals.

Mismatch jobs deliberately do not auto-reset or repeatedly retry. Inspect the
coverage report and provider differences before authorizing a fresh pass.

## Storage and operations

All new tables are additive: dated reports, bounded job checkpoints, hashed
review staging, reconciled daily aggregates and per-source health checks.
Existing lifetime actuals, estimate history, review buckets and paid-sales
tables are not rewritten by backfill. No new ingestion HTTP endpoint is added.
Only authenticated PDP responses expose title-specific coverage status.

Operational results include every enrolled tracked title, actual/report day
counts, histogram/recovered day counts, retrieved review counts, per-job
status, errors and remaining date checkpoints. Budget-limited is partial,
not complete. Historical backfill runs only by explicit operator invocation,
not on application startup, PDP reload or a new automation.

## Verified upstream evidence

The [September 26 report-contract audit](https://github.com/sallisonhome/sentimentpulse/actions/runs/36286359952)
verified reports for all six Saber demos. Hellraiser's September17 single-day
report returned 16,699. Its baseline-through-September18 report returned 35,290
with the exact requested date inputs but without the current-lifetime label.
The original strict lifetime parser remains unchanged for dashboard actuals.

The [earlier feasibility probe](https://github.com/sallisonhome/sentimentpulse/actions/runs/36243864110)
confirmed that sums of single-day values need not equal the combined-period
report and found public-review/histogram differences. Neither discrepancy is
silently explained away or used to fabricate reconciled history.
