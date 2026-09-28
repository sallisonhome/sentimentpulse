# Steam milestone calibration and shadow learning

Approved build scope: Wardogs anchor plus Steam-only shadow learning. Production
activation, push, merge and deploy require separate approval.

## Acceptance
- [x] Confirm identity: Wardogs, Steam 1867240, title 10000, released 2026-09-10.
- [x] Preserve the modeled daily shape; use 3,000,000 as the disclosed minimum
  on 2026-09-26. Date-only reporting does not establish the precise sales hour.
- [x] Freeze audited daily weights through the milestone. Never add overlapping
  weekly buckets, reinterpret player milestones as units, or label modeled revenue actual.
- [x] Keep raw reviews, previous anchors, overrides and LTD states unchanged.
- [x] Daily refresh maintains a separate calibrated daily ledger, without
  compounding repeat runs, dips/rebounds or announcement-day spikes.
- [x] Exact identity, explicit anchor supersession, protected new actuals and
  absent-platform guards; no automatic console propagation.
- [x] All five periods, individual/family boards/PDPs and daily charts agree.
- [x] Shadow proposals are Steam-only, evidence-bearing, bounded, never applied;
  no automatic graduation, new timer or scheduler.
- [x] Test real routes and both apps, schema initialization, repeated writers,
  kill switch, rollback and unrelated-title invariance before PR approval.

Local QA completed September 28 UTC: 328 SignalPulse tests, 17 hmap frontend
tests, TypeScript, both builds, 21 paired routes and 15 full boards on a catalog
clone. Two actual writer reruns, rollback/reactivation and legacy-table
preservation passed. Both rendered apps passed desktop 1440px and mobile 390px
period changes, rapid switching and chart toggle checks. Full-history controls
were corrected to use the upstream start date; all calibrated launch days are
included and daily sums reconcile. YAML and embedded-shell syntax passed.

Limitations: SignalPulse authentication is stubbed only in the local harness;
the separate reviews/ratings router is not connected there and shows its
unavailable state. Existing SignalPulse PDP behavior defaults to 30d rather
than taking the window from query links; all five in-page controls pass.
These are not production verification. Push, merge, deploy and activation
still require approval.

## Evidence
GamesBeat, 2026-09-27:
https://gamesbeat.com/wardogs-hits-3m-copies-sold-in-early-access-in-16-days/
The embedded announcement is dated September 26. Revenue is not disclosed.

Production audit:
https://github.com/sallisonhome/sentimentpulse/actions/runs/36368390073
Daily review evidence:
https://github.com/sallisonhome/sentimentpulse/actions/runs/36368483504

The retained day buckets sum to 81,240 through September 26. The September 26
09:22 observation was only 80,574; do not mix that intraday snapshot with the
later complete activity-day pattern. Calibrate the frozen pattern, not stale
monotonic LTD units or the displayed 1.6M anchor.
