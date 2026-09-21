# Revenue-authoritative sales units

## Plan and acceptance gates
- [x] Extract the existing platform revenue resolver for reuse by boards and PDPs; preserve its verified-anchor and shorter-window protection rules.
- [x] Resolve published units only after final revenue. Keep raw estimator evidence untouched and expose reconciliation provenance.
- [x] Use unrounded, weighted realized ASP for edition families. Verified manual revenue/unit pairs retain their actual units and implied ASP. Otherwise calculate round(final revenue / modeled ASP).
- [x] Missing/invalid ASP or revenue produces unknown units, not contradictory estimates. Zero revenue produces zero units.
- [x] Align individual and combined PDPs and combined boards with the canonical per-platform result across all five windows. Sort final units, not pre-anchor units.
- [x] Regression tests: anchors, overlays, raw values, zero/missing prices, partial families, regional duplication, protected anchors, bounded windows, sorting, and unchanged database evidence.
- [x] Run tests, type checks, builds, and rendered desktop/mobile checks; log hmap’s visible behavior.
- [ ] Request approval before merging/deploying; SignalPulse first.

## Daily model extension
The user subsequently approved an explicit guarded daily application stage. See `daily-revenue-mix.md`.
The older windowed model remains shadow-only; the new daily ledger applies before this unit resolver.

## Rollback
The unit fix is read-side only. The daily extension adds audit tables but does not alter estimator or anchor records.
Disable `revenue_mix_daily_mode` to restore baseline revenue with reconciled units; revert the application commit to restore the prior presentation entirely. Audit records and raw measurements remain intact.

## QA evidence
95 SignalPulse tests passed, including isolated migrated SQLite + real Express endpoints. TypeScript and production builds passed. Both actual frontends passed 192 browser states total: captured No Man's Sky inputs and an explicitly synthetic qualifying daily-outlier family, on desktop/mobile across all five windows and return-to-start navigation. Six CSV downloads, zero/unknown/error states, API equality, and screenshots were checked.

Captured NMS d7 inputs now produce PS5 revenue $1,634,248.4598533332 / modeled ASP $47.992 = 34,053 units, instead of the earlier raw 13,200. Steam revenue remains $2,134,440.6006; no raw measurements were rewritten.
