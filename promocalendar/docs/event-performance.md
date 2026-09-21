# Historical promotion-event performance

## Scope

Events Past, Events Table, event detail, and Analytics share a platform-neutral actual-sales contract in `shared/event-performance.ts`. Steam figures come from the existing SignalPulse read-only `POST /api/promo-support/steam-revenue-batch`. The scope is participating titles' base-game plus DLC revenue in inclusive calendar-day windows. This is not SKU-specific sales attribution, causal lift, or net publisher receipts beyond the source's own net-revenue definition.

## Persistence and refresh

- `event_archive` retains started event metadata and title membership independently of replaceable workbook campaigns. Capture runs at startup, during background refresh, and transactionally before upload replacement or rollback. The active workbook wins if the same event key is still present.
- `event_performance` retains the last successful snapshot, source/mapping fingerprint, check time, retry deadline, and failure flag. No existing tables are altered or cleared by the additive migration.
- A single-flight in-process worker checks every 15 seconds, refreshing at most 24 due events per pass. Queries are deduplicated by source ID and date range, chunked at 200 items, and awaited sequentially. Page requests only read local snapshots.
- Live windows end at today; past windows end at the recorded event end date. Live snapshots refresh every minute; completed snapshots every six hours to capture late corrections. Retry after an error is one minute, with saved totals retained and marked stale. Coverage regression also retains the last snapshot; equal-coverage monetary corrections can increase or decrease totals.
- Upcoming events are not fetched. Reversed date windows are flagged, never silently corrected. Missing rows are not converted to zero. A genuine reported zero is displayed as zero.
- Cold-start history drains across bounded passes, newest first. Pending views poll local snapshots every 15 seconds. Retry state persists across restarts; there is no external scheduled task.

## Coverage and comparisons

Coverage uses reported title-days / expected title-days, not the maximum covered days of any one title. Missing mappings and partial-day histories remain explicit. Fetch time is consumer freshness, not a claimed source ingestion timestamp. Overlapping events may include the same title-day sales, so Analytics intentionally has no sum across event rows. Revenue order includes partial snapshots and labels them.

## Adding PS5

Register an `ActualSalesAdapter` for calendar platform `Sony`, canonical platform `ps5`, after SignalPulse has a verified PS5 partner actual-sales endpoint and title-ID mappings. The adapter resolves calendar game codes, fetches bounded date-window revenue, and returns the same currency/scope/coverage contract. Do not use SignalPulse's public console estimates here. Adding a partner key alone does not implement a sales ingestion endpoint; that integration remains necessary. The archive, worker, Analytics filters, cards, and detail contract need no Steam-specific branching for the new adapter.

## QA inventory

- API: completed windows, live-to-past transition, no request-time upstream fanout, local list/detail parity.
- Data: partial/unmapped coverage, true zero vs missing data, duplicate identifiers, late corrections, failures, coverage regressions, future/invalid windows, unsupported PS5, mock PS5 actuals adapter.
- Persistence: additive idempotent migration, workbook replacement/rollback retention, archive dedup/filtering, calendar isolation, fingerprint invalidation.
- Load: 24-event bound, 200-item batch bound, query dedup, single-flight, persisted retry times.
- UI: Events Past list/table, older-event access, detail drilldown, Analytics platform/status/date/search/order/more controls; desktop/mobile, dark/light; pending, empty, error, partial and unsupported states.
- Production after approval: migration table inspection, read-only API reconciliation against SignalPulse and browser verification of the deployed UI. No leadership digest send; no SignalPulse auth/config changes.

## Branch verification, September 21, 2026

- `npm test`: 27 passed, 0 failed, 0 skipped (21 performance/transport/UI cases plus 6 existing workbook-parser cases).
- `npm run check` and `npm run build`: passed. Build retains the existing four Vite configuration `import.meta`/CJS warnings.
- Real-data preview uses a disposable copy of the workbook database and read-only calls to live SignalPulse. Historical Steam event keys, names, platforms, windows, and title counts match production's event API.
- A recent completed sale reconciles exactly to the sum of its live source rows, including title-day coverage. A missing source product is excluded and marked as a coverage gap, not converted to zero. Commercial figures are intentionally omitted from this public repository.
- Valid historical Steam windows captured; reversed-date windows explicitly flagged. Archive/snapshot schema verified using SQLite metadata, migration rerun idempotently, and the saved sale figure read from a separate process.
- Local historical-events HTTP response: 200, approximately 12 ms in one measured run. This is a local observation, not a production latency guarantee.
- Browser checks: Events Past list/table, Show more, event details and per-title figures, Analytics platform/status/date/search/order/refresh/more controls, empty search, reversed date filter, simulated HTTP 503, and PS5 unsupported state. Desktop 1440px and mobile 390px inspected in light/dark; no browser runtime errors observed. Mobile Analytics switches to stacked event records with revenue visible, rather than forcing horizontal reading.
- Not yet performed: deployed-production UI validation and production SQLite table inspection. These are post-approval deployment gates, not implied by the preview results.
