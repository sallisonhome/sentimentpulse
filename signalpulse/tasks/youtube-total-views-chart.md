# YouTube PDP total-views chart

## Scope

- [x] Make the total-views time series visible by default on every YouTube title-detail page, including competitor titles.
- [x] Reuse the 7/30/90/365-day presets, custom dates, daily/weekly/monthly grouping, and archived-record control.
- [x] Display the latest observed total within the applied range with its actual observation date.
- [x] Add total views to the exact-data table; preserve CSV snapshot values.
- [x] Preserve null gaps and distinguish lifetime totals from views gained during a period.
- [x] Explicitly handle one-point history and absent history.
- [x] Leave ingestion, schedules, API quota, schema, and authentication unchanged.

## Verification

- TypeScript check and production build passed.
- Full test command passed: 11 player-model tests, 12 pass-activity tests, and 143 main tests.
- New regression covers observed zero, missing dates, title isolation, old-video lifetime views, weekly/monthly ending snapshots rather than sums, and no carry-forward.
- [Read-only production probe](https://github.com/sallisonhome/sentimentpulse/actions/runs/36075759509) returned HTTP 200 for all 42 stored title-history endpoints.
- Reconstructed only public metric records in an isolated in-memory QA database. All 42 locally computed series exactly matched the production API rows.
- Browser-tested all 42 title pages against verified totals, all presets, custom dates, all grouping options, archive toggles, all existing chart tabs, exact-data table, CSV values, reversed-date validation, empty ranges, refresh, and simulated API failure/recovery.
- Verified weekly tooltip uses the observation/end date, not the bucket-start date.
- Desktop and 375px mobile screenshots reviewed in light and dark mode; no horizontal page overflow or uncaught browser errors.
- Return link reaches the populated YouTube overview.
- No schema migration required; no collection or write operation was run against production.

## Data limitation

At the September 24 ET verification, 17 of 42 titles had snapshots, each with a single observed day, September 24 UTC. Those charts show a visible point and an explicit history-accumulation notice. Titles without observations show “Not observed,” not zero. This UI change does not backfill unavailable historical view counts or repair collector coverage.

## Release

- [ ] User approves squash merge and deployment.
- [ ] Verify deployed bundle and production page after approval.
