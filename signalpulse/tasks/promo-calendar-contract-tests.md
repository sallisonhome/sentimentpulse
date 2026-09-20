# Promo Calendar contract regression repair

## Scope and plan

- [x] Reproduce the reported test failure before editing.
- [x] Verify the richer promo fields are intentionally consumed by the weekly digest.
- [x] Update the stale assertion without removing production fields.
- [x] Exercise absent, true and false active flags, platform deduplication, date precedence, discount tie-breaking, full winning metadata and sort order.
- [x] Run the full configured test suite, TypeScript check and production build.

## Verification

`npm test`: 71 passed, zero failures, zero skipped. `npm run check`: passed. `npm run build`: passed with the existing bundle-size warning. The original failure was reproduced first (five passed, one failed in the promo client suite). After repair, all eight promo client tests pass as part of the full suite.

## Diagnosis

The legacy test expected only platform and end date. Since v3.34 the client intentionally also returns start date, program, discount and game label. The old fixture also contained `is_active: true` despite claiming to test that the flag was not required.

This repair changes tests only. It does not alter live promo behavior, health-history semantics, data or hmap. Rollback is a revert of the test/documentation commit; no data migration is involved.
