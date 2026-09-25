# Steam review overlap and LTD-state repair

## Scope approved September 24, 2026
- [x] Replace the paid-sales estimator's overlapping daily/weekly/monthly sum with a deterministic non-overlapping histogram.
- [x] Retain observed bucket counts; do not invent daily precision for coarse historical boundaries.
- [x] Audit the paid Steam catalog using production measurements exported read-only.
- [x] Provide dry-run-first, transactional, per-row audited LTD repair with conflict-checked rollback.
- [x] Protect anchors, manual/title overrides, mature accumulators, unknown provenance, and genuine historical review maxima.
- [x] Test actual estimator, all five periods, real API parity, second-run stability and rollback on an isolated production-data copy.
- [x] Full regression suite, typecheck and build before PR and approval request.
- [ ] Merge/deploy and apply the fresh production repair manifest after approval.

## QA outcome
See `docs/steam-review-overlap-repair.md` for the release/rollback procedure and
test evidence. 127 eligible state repairs on the captured database; 765 other
state records untouched by repair. 213 SP tests, two hmap tests, typecheck, both
builds, 1,470 API arithmetic assertions, 96 browser states and three exports
passed. The corrected estimator is numerically idempotent. Production unchanged.

No Alinea calibration, ASP changes, mix changes, edition-eligibility changes, new schedules, or production writes are part of pre-deploy implementation.

## Proposed histogram policy
Use daily data when it completely replaces a rollup's covered days. Otherwise retain one latest weekly/monthly representation and discard all daily buckets covered by it. Whole coarse buckets are assigned by bucket start at historical edges, explicitly tagged `steam_histogram_nonoverlap_v1`; no fractional review counts or uniform daily allocation. Use UTC calendar windows including the as-of day; reject future buckets and absent history.

## Repair contract
Separate dry-run-first operator script, never an automatic startup migration.
Repair only Steam `derived_max_windows` states whose excessive maximum can be traced to an impossible window signal greater than the same-date LTD signal and whose present histogram demonstrably overlaps. Rebase at the unchanged active coefficient, preserving the highest observed lifetime review signal (including review-count resets). An obsolete coefficient's unanchored prediction is not an actual-sales floor. Skip any ambiguous state, manual override or anchor.
Snapshot before apply; audit old/new values and evidence. Raw review buckets, ratings, calibration coefficients, anchors and historical estimate rows remain immutable. Run the corrected estimator after the repair to publish fresh rows. Rollback must reject intervening state changes rather than overwrite new observations.
