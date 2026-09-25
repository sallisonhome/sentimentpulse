# Lifetime catalog integrity repair

Scope: Sniper Elite: Resistance and catalog-wide proof of the same class of
retained model-state inflation. No arbitrary revenue ceilings or multiplier refit.

## Implementation and acceptance

- Insert-only seeder uses current canonical evidence, not positive-only history replay.
- Mature accumulators retain a cumulative signal high-water mark across dips.
- Console observed-pace rating projections cannot exceed their lifetime signal.
- Explicit catalog planner combines isolated initial-snapshot proof, existing
  Steam overlap proof, and exact original/corrected window-floor replay.
- A complete reviewed SHA binds the repair set, before images, history and evidence.
- Apply backs up SQLite, replans within an immediate transaction, and retains
  before/after audit rows. Rollback refuses intervening state or estimate writes.
- Run under the existing maintenance lock and non-cancelling deployment queue.
  No new schedule, no timer stop/start, no startup data repair.
- Preserve source observations, coefficients, anchors, manual overrides, independent
  rank floors and unexplained histories. Unknown paid-game identity stays held.

## QA gates

- Unit and real-writer tests; TypeScript; both production builds.
- Fresh production-shaped full-catalog dry run; exact rollback round trip.
- Unrelated states and all protected input tables unchanged by repair.
- Actual API routes for five windows; hmap proxy parity; no duplicate family platforms.
- Repeated real estimator, seeder, anchor and daily-mix writers preserve corrections.
- Daily revenue chart has no repair-created negative or positive spike.
- Desktop/mobile built-client checks, then explicit deployment approval.

Production repair remains pending approval. A pre-apply fresh audit must reproduce
the reviewed scope; changed input or repair membership requires renewed review.

## Production-shaped QA, September 25

- 1,014 title/platform states audited; 46 proven repairs:
  24 Steam, 18 PS5, 4 Xbox. These are platform records, not unique game families.
- 307 saved lifetime estimates corrected with their state; raw observations,
  multipliers, overrides, anchors and unrelated repair-time estimates unchanged.
- 255 real route responses across five periods, 46 daily charts and 602 actual
  hmap proxy/cache reads passed. No duplicate board-family keys.
- Exact rollback round trip passed before daily writers. Seeder, estimator,
  anchor writer and daily mix evaluator each ran twice with all repaired
  lifetime states stable. No impossible observed-pace signals remained.
- Sniper Elite: Resistance: 35,415,886 to 201,122 model units;
  USD 1,168,490,493.1524 to USD 6,635,698.5948 at unchanged ASP and coefficient.
  These are estimates, not verified actual sales.
- 285 regression tests passed; TypeScript and both production builds passed.
- Exclusions are deliberate, not a clean bill of commercial accuracy: unknown
  identity (including held Touhou), anchors, overrides, rank floors, mixed Game Pass
  and Steam-anchored provenance (including Forza Horizon 6) and unexplained histories
  must not be repaired by a generic ratio threshold.
- Built SignalPulse and hmap clients show the repaired Sniper lifetime value on
  desktop and 390px mobile with no horizontal overflow; five period controls and
  the hmap changelog were exercised. Ancillary third-party ratings were deliberately
  unavailable in the read-only fixture, and their existing error state was checked.
- Workflow YAML and embedded Bash passed syntax checks. Production deploy/live
  refresh checks remain pending approval.

## Operator execution and rollback

1. Deploy the SignalPulse code first. Do not apply on the old writer.
2. Dispatch the lifetime catalog workflow in `audit` mode. Compare scope and
   fresh SHA to the reviewed manifest; changed scope requires another review.
3. Dispatch `apply` with that SHA and `CONFIRM`. Retain its run ID and backup.
4. Dispatch the separately confirmed `refresh` action under the same maintenance
   lock to recompute current windows, anchor propagation and daily mix. It does
   not collect external data, reset timers or create a new schedule.
5. Deploy hmap's changelog after upstream repair and verify both live APIs,
   board/detail parity, raw-input preservation and all five periods.

Before another writer runs, `rollback` restores only the exact audited before
images, after an additional backup. It refuses intervening state/history writes.
After a refresh, do not restore an entire old database over new observations;
review a new scoped rollback manifest against current rows. Code rollback is a
revert of this PR; preserve the data backup and audit even if code is reverted.
