# YouTube PDP daily views

## Scope

- Replace the featured cumulative lifetime-view chart with `netViews`: same-video changes between consecutive UTC daily snapshots.
- Keep initial observations and missing comparisons blank; preserve genuine zero and negative corrections.
- Weekly/monthly views sum daily changes only for complete selected buckets.
- Table labels distinguish daily/period views from lifetime snapshot diagnostics. CSV `netViews` remains the chart's exact series.
- No collector, schedule, schema, quota, authentication or retention changes.

## QA inventory

- Regression: no discovery spikes, title isolation, prior baseline outside custom range, zero, correction, missing dates, grouped completeness, CSV equality.
- Browser: featured chart and headline use net views; custom range, presets, day/week/month grouping, CSV, refresh, exact table.
- Off-happy-path: first-observation-only range; range with missing daily comparison.
- Visual: desktop/mobile in existing dark/light theme, labels and tooltip date range, no horizontal page overflow.
- Production deployment requires separate user approval after QA. Local test fixtures are not live-data verification.

## Verification results

- TypeScript check and production build passed.
- All 23 YouTube tests passed, including two new daily-view regressions. Full `npm test` passed its prerequisite suites and all 146 main tests.
- Browser: daily headline/chart uses 80 views rather than the fixture's 9,001,180 lifetime views; custom two-day range shows 100 and 80; weekly/monthly totals show 180; downloaded CSV `netViews` matches.
- Browser: all presets, archive checkbox, three secondary tabs, refresh, exact table, first-observation empty state and incomplete grouped period checked without uncaught page errors.
- Desktop dark and mobile light screenshots inspected. Mobile page verified after reload at 375px; no page overflow and chart card is legible.
- Local read-only copy of Space Marine 2 has only September 24 snapshots and correctly shows no daily comparison, rather than using its lifetime total.
- Live unauthenticated API probe returned HTTP 401. Current live authenticated data and deployed UI have NOT been verified for this change. No production data was written and no collection was triggered.
- No schema migration required. Collector, quota, retention and scheduling code unchanged.
