# Qualified Friend’s Pass scenarios

User approved integration September 26, 2026. A separate panel in DemoPulse's
Friends Pass tab consumes read-only `GET /api/demos/pass-scenarios`. No database
migration, scheduler change, automatic downstream application, measured-player
registry change, downloads change or paid-sales estimator change.

## Scope and provenance

The snapshot contains 43 complete title-months: It Takes Two June 2024–August
2026 and Lords May 2025–August 2026. Data cutoff is August 2026, not “today.”
Generation preserves a SHA-256 over the three reviewed research inputs.
The importer uses existing files, never requests a fresh external feed.
The exact input CSVs and assumption JSON are retained in
`docs/pass-scenario-inputs/`. Running `python scripts/import-pass-scenario-snapshot.py`
reproduces the typed snapshot without a network connection.

- It Takes Two uses combined monthly main + legacy-client average CCU, multiplied
  by the last-12-pre-transition weighted pass share, 26.0689755191204%.
  Sensitivity is historical mix variation, not a confidence interval.
  https://steamcharts.com/app/1426210
  https://steamcharts.com/app/1504980
  https://www.ea.com/games/it-takes-two/it-takes-two/news/steam-friends-and-deck-verified
- Lords uses positive excess above the last pre-event monthly observation, times
  an explicitly assumed attribution fraction, divided by one plus assumed
  incremental owner activity per guest. Reference 50% / 0.5 is illustrative,
  NOT a fitted or preferred central estimate. User can select 100% pass-led
  attribution. Broad sensitivity retains zero and maximum positive excess
  across the tested baseline models, independent of selected coefficients.
  https://steamcharts.com/app/1501750
  https://news.xbox.com/en-us/2025/04/17/why-lords-of-the-fallen-version-2-0-is-worth-your-time/
- The sparse Lords weekday sample does not establish a robust new weekend
  pattern and does not increase the attribution confidence.
  https://steamspy.com/app/1501750

## Contract

Parameters: `title=lords|it-takes-two`, `from=YYYY-MM`, `through=YYYY-MM`,
`attribution=0|0.25|0.5|0.75|1`, `hosts=0|0.5|1`, `format=json|csv`.
Defaults June–August 2026, Lords, attribution 0.5, hosts 0.5.
Invalid, reversed or out-of-coverage months return 400; no extrapolation or
zero filling. Attributions do not modify It Takes Two's historical transfer.
API inherits application auth; it is not added to the public-read allowlist.

Monthly CCU is averaged using calendar-hour weights. Player-hours are summed.
JSON and CSV preserve confidence, metric scope, source URLs, assumptions,
method version, snapshot date and source hash. CSV matches the selected period
and coefficients, with unrounded machine-readable values.

Consumers must preserve `observed=false`, `excludedFromActualsAndTotals=true`,
and `automaticDownstreamApplication=false`. Only opt-in scenario calculations
may consume these results. Never add them to parent activity totals, treat them
as unique people/downloads/invitations, or combine Lords incremental guest
activity with It Takes Two total estimated pass-client activity as one metric.

## QA inventory

- Reproduce June–August local outputs (Lords 342.126884; It Takes Two 1908.253513).
- Check every month, hour-weighting, all coefficient combinations and bounds.
- Reject unknown titles, partial/out-of-range/reversed dates and invalid inputs.
- Exercise real HTTP JSON/CSV/error paths and prove no mutation endpoint.
- Browser: switch titles, both month selectors, attribution, host coefficient,
  details and CSV; change/return states; check error/retry and zero scenario.
- Desktop/mobile and light/dark visual checks, chart and table readability.
- Existing demo/pass player/activity regressions; TypeScript and full build.
- No schema migration needed; isolated DB integrity and unchanged actuals.
- Production verification only after explicit push/merge/deploy approval.

## Local verification receipt, September 26

- TypeScript check and production build passed. Existing warnings remain for
  bundle size, Browserslist age and CSS import ordering; none introduced here.
- Final `npm test` after integrating PR #149's demo PDPs: 296 tests passed
  across the main and pretest suites
  (43 + 44 + 17 + 12 + 27 + 5 + 148), with zero failures.
  New scenario tests are included in `test:pass-players`.
- Scenario tests exercise authenticated-access denial as well as read-only
  HTTP, coefficients, all 43 source months, bounds and export metadata.
- Browser: both titles, full monthly coverage, changed/returned selectors,
  pass-led/zero cases, details, exact-window CSV download, injected error/retry,
  demo/pass tabs and independent leaderboard filters passed.
- Exported July 2026 It Takes Two CSV reconciles with original research.
- Desktop 1440px and mobile 375px inspected. No page-level horizontal overflow
  at 375px; the detailed table intentionally scrolls horizontally.
- Light/dark inspected; no JavaScript page errors. Isolated SQLite integrity
  `ok`; actual-download rows and measured CCU snapshot rows both remain zero.
- Existing production DemoPulse GET returns 401 without a user session.
  No production credentials were exported and no new production route is live.
- No migration is needed. Production authenticated smoke tests remain pending
  approved merge/deployment; local success is not a live-deployment claim.
