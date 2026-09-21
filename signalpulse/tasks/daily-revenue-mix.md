# Automatic daily revenue-mix application

User approved the guarded daily-application stage on 2026-09-21.
Governing CLAUDE/PRINCIPLES/lessons reviewed during this workstream.

## Contract
- The daily job evaluates newly accumulated ratings, not average rating scores.
- Complete three-platform families only; regional duplicates count once. Ambiguous edition signals fail closed. New staggered releases are blocked; mature ports can qualify once every platform is at least 90 days old.
- Require 14 prior daily increments plus today's increment (16 consecutive observations), adequate volume, and 10 comparable qualifying peers.
- Compare normalized platform activity with equal-weight cohort norms and the title's own history. Normal/insufficient/noisy evidence uses baseline for that day.
- Anomaly adjustments can grow by at most 0.5 percentage points per day and stay within 5 points of baseline. A normal day resets to baseline rather than carrying an uplift forever.
- Steam revenue remains the reference; console revenue is derived using the candidate-to-Steam ratios. This does not artificially hold combined estimated revenue constant.
- Apply to measured daily Steam revenue increments only. Persist baseline, proposed/applied mix, daily revenue deltas, evidence, reason, and version.
- Window KPIs add only recorded daily dollar deltas within that window; never multiply an entire historical period by today's split or manufacture pre-activation history.
- Verified anchors, manual multipliers, Game Pass/subscription families, protected IP ratios, ambiguous identity and release mismatches are ineligible.
- Price/config/family changes, bad daily revenue increments, missing observations, failed fresh daily evaluation, or invalid modes fail closed.
- No raw ratings, raw unit estimates, LTD state, or revenue anchors are modified.
- Active adjustment happens before revenue-authoritative unit resolution; hmap rebroadcasts the exact results.

## Controls and rollback
`revenue_mix_daily_mode`: active / shadow / off, seeded active for this explicitly approved rollout. Unknown values behave as off.
`revenue_mix_mode=off` remains a global veto. The older windowed shadow audit is retained, not silently relabeled as active.
Switch daily mode to off to return every view to baseline immediately (subject to hmap's existing five-minute cache), retaining the ledger for audit. Code rollback is additive-schema safe.

## QA gates
- Pure model: normal days, ordinary surges, persistent over-indexing, cohort normalization, small samples, resets, extreme spikes, caps, normalization, reversals.
- Ledger: schema twice, same-day rerun idempotence, before/after mode flips, chronological window boundaries, stale-job fallback, protected-title veto, raw data immutability.
- Real routes: applied day changes every board/PDP consistently; unit/revenue arithmetic remains reconciled; all five periods; baseline fallback; source note truthfulness.
- Both builds, TypeScript, full test suites, desktop/mobile rendering, actual CSV exports, hmap pass-through.
- Production activation only with merge/deploy approval after QA; verify real eligibility counts and scheduled job wiring rather than claiming every title will adjust.

## Completed pre-deploy QA (2026-09-21)
- 95 SignalPulse tests, TypeScript, production build, and shell syntax passed.
- Real Express/SQLite integration checks active/off across all five windows, three platform boards, both PDP types, combined boards, daily series, protected-title veto, arithmetic, and unchanged raw estimator data.
- Ledger tests cover schema twice, same-day idempotence, window boundaries, stale jobs, sparse/reset/batch-spike data, protected anchors, price/identity changes, active/shadow/off modes, corrupt rows, and bounded numerical behavior.
- Both frontends rendered 192 checked states using captured real-title inputs and a labeled synthetic eligible outlier; desktop 1440px/mobile 390px, all period controls, six actual CSV downloads, zero/unknown/error states, no browser exceptions/overflow.
- hmap's real pass-through service returned unchanged upstream JSON.
- The systemd timer remains daily 09:15 UTC with its existing jitter. Phase 5 runs only after collection, estimation and anchor writing have succeeded. No new unattended Perplexity task is needed.
- Live read-only diagnostic: Steam 12 captured days, Xbox 12, PS5 11, through 2026-09-21. Thus the history gate cannot yet pass; earliest possible qualification is 2026-09-26, conditional on uninterrupted observations, adequate volume and 10 qualifying peers.
  Diagnostic: https://github.com/sallisonhome/sentimentpulse/actions/runs/35655722122

## Remaining deployment checks
Merge/deploy approval, production startup/schema and baseline fallback, actual timer/phase-5 files, live hmap values/labels/changelog. No claim of predictive accuracy or production-applied adjustments is made from synthetic QA.
