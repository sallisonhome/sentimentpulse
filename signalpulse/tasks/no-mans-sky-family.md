# No Man's Sky title-family repair

## Plan
- [x] Reproduce the split family from live API and SKU records.
- [x] Verify Steam 275850, PS5 US/EU SKUs and Xbox BQVQTL3PCH05 are base-game mappings.
- [x] Guard old and new enrichment against child-update identities.
- [x] Prefer exact storefront identity over unverified historical Xbox seeds.
- [x] Deduplicate regional title/platform estimates on the family PDP and per-platform board.
- [x] Verify all five windows through real routes, including platform breakdowns and sum reconciliation.
- [x] Run full tests, typecheck, build, and update hmap's public changelog.
- [ ] Obtain main/deploy approval and verify both public surfaces after deployment.

## Evidence
Read-only production audit: https://github.com/sallisonhome/sentimentpulse/actions/runs/35647861382 and https://github.com/sallisonhome/sentimentpulse/actions/runs/35647963170.

The database contains three distinct title/platform estimate identities, not a separately estimated paid Worlds Part II product. Steam 10005 and Xbox 10438 had stale IGDB update metadata; Xbox's immutable cache copied that mistake with source `seeded_from_cti`. PS5 10350 has two regional SKU rows, one without MSRP. All three identities have direct estimates for d7, d30, d90, m12 and ltd on 2026-09-21.

The observed two-platform row excludes PS5. The repair must preserve base-game estimates, join all three platforms, and count PS5's shared estimate only once. This verifies tracked model coverage, not audited worldwide sales: untracked stores, physical and Switch are outside this board.

## Rollback
Read-time correction only; no production estimates or raw observations are rewritten. Revert the release commit to undo the behavior.

## Pre-deploy verification

- Full configured suite: 76 passed, zero failed or skipped.
- TypeScript check and SignalPulse production build passed.
- hmap frontend build passed; its only application change is the public changelog. Both builds retain existing bundle-size warnings.
- Real Express + freshly migrated SQLite integration test reproduces the production SKU rows, null-confidence update metadata, Xbox seeded cache, PS5 regional duplication and current window quantities.
- 28 successful HTTP probes: five windows times combined PDP, combined board and three platform boards, plus three individual PDPs. Combined revenue equals both the platform sum and leaderboard row; PS5 units are not doubled; each window uses its direct estimate; every PDP finds the same Steam-family portrait. Estimate rows are unchanged.
- Mocked external enrichment verifies storefront search input, stale-cache bypass, parent selection when the update ranks first, and low-confidence rejection if only the update is returned.
- Production metadata audit examined 799 distinct records. Forty-five previously accepted mappings fail the stricter identity comparison; harmless Roman-numeral, leading-article, Greek-delta, punctuation and edition differences are covered by regression tests. This is a fail-closed metadata guard, not a claim that every catalog identity has been independently verified.
- No production write, main merge, deploy or post-deploy browser verification has occurred yet. The latter awaits approval; no frontend rendering code is changed.
