# Units-only sales presentation

## Scope and acceptance

- [x] Read governing CLAUDE, PRINCIPLES and lessons in both repositories.
- [x] Trace estimator: rating signal × multiplier → owners; owners / digital share → units; raw revenue = units × ASP. Anchors and platform overlays can override revenue independently.
- [x] Remove owners from all console sales PDP cards, combined totals and signal-chart choices. Keep units and revenue unchanged.
- [x] Mirror in hmap Buying, including CSV; retain Genre Stats owners because that separate feature uses it to calculate gross.
- [x] Run regression tests, typecheck and both production builds.
- [x] Exercise actual builds with captured live API responses at desktop/mobile across all five windows; test chart controls and CSV download.
- [x] Inspect screenshots, null/zero states and API failure handling.
- [ ] Open reviewed PRs, request approval before main merges, then verify production after approved deploys.

## Boundaries and rollback

No estimator, DB, API response, calibration, auth or ingestion changes. Internal owners fields and legacy timeseries API remain compatible. Revert the presentation commit to restore the prior display. Historical changelog entries remain historical.

## Pre-merge review, 2026-09-21

- SignalPulse: 78/78 tests, TypeScript, production build passed.
- hmap: 2/2 presentation/CSV tests and production build passed. Existing bundle-size warnings remain.
- Actual built UIs tested with 32 captured production API responses, not fabricated sales values. No Man's Sky family plus Steam 10005, PS5 10350 and Xbox 10438; 1440px and 390px; d7/d30/d90/m12/ltd and return-to-d7: 96 state checks.
- Every checked units/revenue value matches the existing API value after the app's existing formatting. No owners labels or owner-chart calls remain.
- Rating count/average rating controls exercised; real CSV downloads passed on all three platforms. CSV source regression also checks zeroes, quote escaping and header/value alignment.
- Synthetic zero/anchor and null-unit cases verified separately: no fallback to owners. hmap HTTP 503 visibly errors. No uncaught page errors or horizontal document overflow.
- Desktop/mobile screenshots inspected for combined two-card layout, platform subtitles and individual PDP/chart controls.
- API/DB migration QA not applicable: no runtime server or schema changes. Production UI verification remains a post-approval deployment gate.
- Existing scope caveat: combined anchor/overlay revenue can differ from raw individual-PDP revenue; combined units remain the API's original window estimates. This change does not reconcile those pre-existing estimator semantics.
