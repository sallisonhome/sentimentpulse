# Portrait artwork and shadow revenue calibration

Governing CLAUDE.md, PRINCIPLES.md and lessons.md read before implementation.

- [x] Keep cover/portrait selection separate from landscape headers; reject mismatched identity.
- [x] Verify Halloween Steam, PS5, Xbox and family PDPs with real source dimensions in isolated live-identity QA.
- [x] Add client dimension/error fallback, no landscape-to-portrait crop masquerading as key art.
- [x] Implement additive, auditable per-family revenue calibration in shadow mode only.
- [x] Gate on fresh, sustained, normalized signals; protect overrides and questionable evidence.
- [x] Test all five windows, unchanged published totals, schema idempotency and off rollback.
- [x] Build/test both apps and check desktop/mobile rendered pages.
- [x] Update public changelog, lessons and operational rollback documentation.
- [ ] PR, deploy SignalPulse first, confirm live API, then hmap and live browser checks.

Acceptance: publisher identity must stay correct, portrait must load with native height greater than width (not CSS cropping), and unavailable art must fail safely. Calibration never modifies live estimates in this release; observed inputs and reasons must be persisted for future validation.

Pre-deployment evidence: 18 focused tests pass; type check and both builds pass. Twenty-five HTTP before/after comparisons against the previous route implementation preserve every numeric field across five periods. Both apps' four Halloween PDPs pass 1440px/390px browser checks with actual 600x900 Steam artwork. hmap's deliberately substituted landscape asset is rejected. SP mobile screenshots taken after the sidebar-collapse transition settles.

Full suite: existing unrelated promo-calendar-client `active beats from /live-now...` assertion fails because response includes extra fields; 67/68 passed before the added collector test. No promo-calendar files changed.
