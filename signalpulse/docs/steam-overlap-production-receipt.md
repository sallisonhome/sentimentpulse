# Steam overlap repair: production receipt

The approved repair was applied on September 24, 2026 EDT (September 25 UTC).
SignalPulse PR 136 was deployed first; hmap PR 192 contains the matching changelog.

- Code deployment: https://github.com/sallisonhome/sentimentpulse/actions/runs/36088162838
- Audited repair: https://github.com/sallisonhome/sentimentpulse/actions/runs/36088360158
- Repair run ID: `2026-09-25T02-57-15-534Z`
- Approved September 24 manifest SHA: `60dd64fdfba2af720f7fb78bc7f8ec7c4b8964cfad0311a12f00249579631123`
- Repaired 127 proven contaminated lifetime states; the other 765 states were unchanged by the repair.
- Backup retained on the droplet: `signalpulse/repair-backups/steam-overlap-2026-09-25T02-57-15-534Z.db`.
- Corrected estimator executed twice with identical numeric outputs.
- Protected reviews, ratings, coefficients, manual overrides and revenue anchors were unchanged.
- Daily mix evaluated in active mode: 679 families, zero adjustments.

## Post-maintenance incident and scoped recovery

Restoring the existing daily timer activated its service via `Requires=`.
Discovery received missing Steam metadata, overwrote 144 paid classifications
with `unknown`, then failed its paid-title-count gate before collecting signals
or rerunning the estimator. The repaired lifetime state was not the cause.

- Status evidence: https://github.com/sallisonhome/sentimentpulse/actions/runs/36088538370
- Read-only comparison: https://github.com/sallisonhome/sentimentpulse/actions/runs/36088623447
- Scoped recovery: https://github.com/sallisonhome/sentimentpulse/actions/runs/36088731650

Recovery restored only `business_model` and `business_model_source` for the 144
exact failed-response downgrades. It retained a second SQLite backup and a JSON
before/after audit. Other SKU fields, lifetime states, estimates, reviews,
ratings, coefficients, overrides and anchors were checked unchanged.
No full database rollback and no collector cancellation occurred.

## Live verification after recovery

All five periods passed 1,470 revenue-derived-unit arithmetic assertions and 57
leaderboard/PDP parity checks. hmap matched SignalPulse's per-platform and combined
figures. The correction-day revenue chart recorded zero, not a negative correction
or invented positive sale.

Zero Company's lifetime result at verification was 838,342 Steam units,
1,424,799 combined units and USD 55,878,288.77 combined revenue.
The d30 combined unit figure is 1,424,738 because the selected period's Xbox ASP
differs; the same revenue total does not imply identical unit totals across ASPs.
These remain model estimates, not Alinea-calibrated actuals.

Source API: http://104.236.239.46/signal/api/console/multiplatform-title/star%20wars%20zero%20company?window=ltd

The live hmap desktop/mobile matrix passed 48 period-switch states. SignalPulse's
production UI redirects to sign-in, so its live API was verified directly and
the previously completed local built-UI matrix is not represented as a signed-in
production browser test.

## Additional prevention patch: separate approval

The proposed patch preserves known paid Steam classification only when evidence
is unavailable. Explicit DLC/non-game evidence still removes paid eligibility;
new unknown SKUs remain unknown and manual overrides stay protected.

It also removes `Requires=signalpulse-daily.service` from the timer. On approval,
deploy SignalPulse, install the corrected timer unit, and run `daemon-reload`
without stopping/starting the timer. Compare the daily service's start timestamp
before and after and verify the timer remains active with its existing schedule.
The prevention patch changes no sales formula, coefficients or revenue anchors.
