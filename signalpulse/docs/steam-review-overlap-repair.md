# Paid Steam review overlap repair

## Implementation and scope

`server/steam-review-windows.ts` is the paid-sales estimator's canonical histogram reader.
It selects one current weekly/monthly representation, replaces a whole rollup with daily
observations only when those observations fully cover it, and never adds both. Recent
window boundaries are UTC calendar dates including the current as-of date. Older
partial coarse buckets remain bucket-start based; no daily prorating is invented.
Null evidence remains unavailable, not a fabricated zero; a window exceeding its
latest lifetime rating snapshot is rejected.

The estimator tags corrected Steam window methods with `steam_histogram_nonoverlap_v1`.
It does not change multipliers, ASPs, platform shares, title/edition identity, review
display caches, demo estimates, actual-sales anchors, or scheduling.

## Explicit lifetime repair

`scripts/repair-steam-review-overlap.ts` defaults to read-only and prints a JSON
manifest, proposed per-title changes, skip reasons and SHA-256. It imports
`better-sqlite3` directly rather than `storage.ts`, so a dry run does not execute
application schema migrations or seed settings.

Candidate requirements:

- Steam, exactly one paid base App ID, valid release age below 366 days.
- State source is `derived_max_windows`; mature accumulators and override states
  are excluded.
- No revenue anchor, title multiplier override or manually controlled SKU.
- Fresh lifetime review snapshot reconciles exactly to the non-overlapping histogram.
- Stored state maximum matches the historical `derived_max_windows` regime.
- Every inflated historical state is explained by a same-date window whose review
  signal exceeds lifetime, or a held maximum already explained earlier.
- A candidate must have at least one explicit impossible-window witness. Unknown
  provenance fails closed.

The target applies the unchanged active coefficient to the largest observed
lifetime review signal. This preserves review-count resets without treating a
superseded coefficient's unanchored prediction as verified actual sales. Historical
estimate rows and raw observations are not rewritten.

Apply requires `--apply --confirm CONFIRM --expected-sha` with the exact reviewed
manifest hash. The operator must read the fresh manifest and use its returned
hash, not reuse the test-snapshot hash. The CLI creates a retained online SQLite
backup first, then replans inside an immediate transaction. Any intervening
evidence/state change invalidates the approval. `steam_overlap_repair_audit`
stores before/after state, evidence, manifest hash, run ID and apply time.

`--rollback --confirm CONFIRM --run-id` reverses the matching audit rows only if
every affected state still equals its audited post-repair value. It rejects a
rollback after later observations or estimator writes. After a refresh, recovery
requires a reviewed scoped restoration from the retained backup, not overwriting
the whole production database or blindly restoring stale state.

## Release procedure

1. Obtain merge/deploy and production-repair approval. SignalPulse first.
2. Verify no active ingestion, discovery, collector, estimator or unrelated maintenance.
   Use the existing GitHub Actions `deploy-droplet` serialization; do not cancel
   another task or queue multiple competing maintenance operations.
3. Deploy the corrected estimator. The application deployment alone does not
   execute this one-off repair.
4. Through an approved maintenance workflow, generate a new read-only production
   manifest. Compare eligible counts, skip reasons, Zero Company and largest
   reductions with the QA evidence. Unexpected changes require review.
5. Apply the reviewed manifest with its exact hash and retain the backup. Never
   dispatch a generic old seed workflow, because it would change unrelated coefficients.
6. Run the corrected estimator with the deployed service's
   `LTD_ACCUMULATOR_ENABLED` value, then evaluate daily revenue mix. Stop on failure.
   Repair changes LTD state only; the estimator refresh is necessary to publish
   fresh period and lifetime KPI rows.
7. Verify all five period APIs, unit/revenue arithmetic, protected anchors, family
   totals and no artificial negative correction-day sales. Repeat the estimator
   and confirm numerical idempotence.
8. Verify hmap after its existing upstream cache expires, then deploy its matching
   changelog entry. No hmap formula or proxy change is needed.

No permanent maintenance workflow, extra schedule, global refit, Alinea anchor,
platform-mix recalibration or edition-eligibility relaxation is included.

## QA on the September 24 production export

Read-only export: 36,371 histogram buckets, 10,420 rating snapshots, 49,040 saved
estimates and 892 lifetime state records, plus required catalog and calibration
evidence. Only non-secret relevant app settings were exported.

- 430 paid Steam title/App-ID mappings audited; 1,664 nonempty window computations.
- 127 proven lifetime repairs; 765 other state records unchanged by the repair.
- Repair apply, exact rollback, stale-plan rejection, intervening-write rollback
  rejection, retained backup and repeat-run behavior exercised.
- Raw reviews, rating snapshots, multiplier tables, title overrides and revenue
  anchors remained byte-for-byte equivalent as SQL result sets.
- Corrected real estimator ran twice with identical numeric window outputs.
- Real Express API: 1,470 revenue/unit arithmetic assertions; all five periods
  across platform boards, individual PDPs, combined PDP and combined boards.
- Zero Company on the newer captured data: Steam 838,342 units; combined
  $55,878,288.77 and 1,424,799 units. This is model output, not actual sales.
- 213 SignalPulse regression tests; TypeScript and production build passed.
- hmap: production build and two Buying presentation/export tests passed.
- Both actual frontend builds: 96 desktop/mobile PDP period states, three real
  CSV downloads and changelog rendering passed, with no JavaScript page errors.
  The isolated preview did not mount the unrelated ratings/critic API; its
  unavailable state and external artwork loading were not treated as regressions.

Production execution and live post-deploy verification remain pending approval.
