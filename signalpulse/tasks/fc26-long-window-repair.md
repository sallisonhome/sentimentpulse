# FC 26 12-month and lifetime extension

## Approved scope

Extend the existing conservative FC26 family consistency policy to m12/LTD.
No new coefficient, native-rating edit, accumulator repair, catalog enrollment,
database migration, schedule or cross-title change.

## Acceptance checks

- [x] Same-period native peer constraint for m12/LTD; no short-window scaling.
- [x] Exclude circular Steam/peer backfills; protect actuals and title overrides.
- [x] Preserve Steam10/PS5 65/Xbox25 mix and revenue-authoritative units.
- [x] Platform boards, combined boards, individual and family PDPs agree.
- [x] Existing d7/d30/d90 numerical outputs unchanged.
- [x] All unrelated families and stored evidence unchanged.
- [x] Repeat real daily writer stages on a production-derived clone.
- [x] All-window and long-window-only kill switches restore their baselines.
- [x] Builds, regression tests, desktop/mobile UI and proxy cache QA pass.
- [x] Public changelog and model caveat reflect all-period scope.

## QA evidence

Production-derived SQLite replay reproduced the September 26 post-refresh
FC26 values across all platforms and periods with the long extension disabled.
Enabling it lowered m12 to $244,782,552.22 combined (PS5 native model limits)
and LTD to $290,986,392.58 (Xbox native model limits). These are model outputs,
not independently validated purchase totals.

50 actual Express API surfaces and 100 cold/warm hmap proxy reads passed.
Two repeats of seed, estimator, anchor and daily-mix writers retained all
1,022 LTD unit/high-water states and the resolved results. Read-only model
evaluation did not change catalog, ratings, histories, estimates, anchors,
overrides or lifetime state. Controls protect other title families and all
short-window numerical results. Typecheck, both builds and regression tests pass.

Both built UIs passed all five period controls, desktop and 390px mobile checks,
with no page errors or horizontal overflow. The standalone QA server does not
mount the independent Reviews and Ratings service, so its unavailable panel
is an explicit local harness limitation, not a tested production regression.

Production deployment and post-deploy checks remain pending approval.

## Rollback

`FC26_LONG_FAMILY_ENABLED=0` restores the previous m12/LTD read model while
retaining the short-window correction. `FC26_RECENT_FAMILY_ENABLED=0` retains
its original role of disabling the entire FC26 consistency policy.
No database restore is needed: this extension only changes resolved read values.
