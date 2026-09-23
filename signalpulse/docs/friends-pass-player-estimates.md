# Standalone Friends Pass player estimates

This read-only leaderboard feature is separate from downloads, review-derived
estimates, Saber actuals, and sampled-CCU columns. It does not change discovery,
ingestion, authentication, the database schema, or the daily schedule.

## Current readiness

The evidence registry is intentionally empty. The September 23, 2026 production
audit found only two snapshots for each of 31 pass clients and no snapshots for
three shared-runtime storefronts, with no pass-specific download actuals in the
actuals table. No current pass is asserted to have a validated player estimate.

Audit: https://github.com/sallisonhome/sentimentpulse/actions/runs/35883283213

Daily single-point sampling will not automatically qualify after seven days.
Dense own-runtime history must come from an authorized historical source or a
separately approved collection-frequency change. Neither is implemented here.

## Eligibility and calculation

- Known shared-runtime passes always abstain, even if a calibration is supplied.
- Each SKU uses only `demo_ccu_snapshots.demo_title_id` for that own catalog row.
- Windows end at midnight UTC today (exclusive), avoiding partial-day output.
  This differs from the existing Downloads report's explicit reporting dates.
- Lifetime requires a valid release date; no extrapolation before tracking.
- At least seven completed days, 95% total time coverage and 90% coverage on
  every included day. Integrate linearly between observations at most 30 minutes
  apart; never bridge longer gaps or interpolate a daily peak.
- Duplicate identical timestamps are deduplicated. Conflicting, non-finite,
  negative, or fractional observations fail closed. Future observations do not
  contribute. More than 600,000 samples per title abstains for aggregation.
- Reviewed evidence must verify that store and runtime App IDs are the same
  standalone pass. It must not be expired and must contain HTTPS evidence.
- Require exactly one applicable calibration for this App ID and window, with
  mean cumulative hours per distinct online active player in the same window,
  validity dates, provenance, and independent validation evidence.
- Players = covered player-hours / calibrated mean hours per player, rounded to
  an integer. The result is an estimate of online active pass-client players,
  NOT downloads, new users, paid owners, or invited guests alone on hybrid SKUs.
- Missing intervals do not contribute hours. The small permitted missing
  fraction is not automatically extrapolated. Models below observed in-window
  concurrency are rejected, not silently floored.

These coverage thresholds are operational safeguards, not validation results.
No demo playtime, 130× review multiplier, paid-parent data, or campaign length
acts as a substitute denominator.

## Evidence registration

`server/signals/demos/pass-player-evidence.ts` holds the reviewed allowlist.
Adding a record requires the normal PR/approval process, own-runtime evidence,
pass-specific playtime provenance, applicable window/date bounds, and genuine
independent holdout results. Do not populate it with test fixtures, estimates
from another unvalidated model, or invented playtime.

Current/reference methodology:
https://gamalytic.com/blog/how-to-accurately-estimate-steam-sales

Current-player endpoint semantics:
https://partner.steamgames.com/doc/webapi/ISteamUserStats

## API and presentation

`GET /api/demos/leaderboard?kind=friends_pass&sort=players` sorts estimates with
nulls last in both directions, before pagination. Other filters continue to
apply. Demo requests reject `sort=players`. Default sorting remains downloads
descending on every period change.

Each pass row adds `playerEstimate`, including players/status, start/end,
sample count, coverage, covered player-hours, denominator and evidence URLs.
The pass-only column explains missing values. Shared runtimes remain
unmeasured; no values are copied into downloads or Saber dashboard cards.

## Verification

`npm test` runs the focused player-model/API suite first, then the existing
regression suite. Coverage includes synthetic positive/zero paths, sparse/stale
history, duplicates, invalid observations, gaps, calibration validity, runtime
isolation, all windows, bidirectional sorting, pagination, and unchanged
download results. Synthetic evidence exists only in tests.

The separate private QA server exercises the actual endpoint and rendered
leaderboard using an isolated Steam-data snapshot. Schema and scheduled jobs
are unchanged. Production feature behavior must still be checked after an
explicitly approved merge/deployment.
