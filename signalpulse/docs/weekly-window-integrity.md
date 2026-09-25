# Weekly window integrity

## Defect and scope

The d7 API cascade selected d30 when weekly units were gated or missing.
Dispatch exposed this through a 47-rating weekly signal below the minimum gate:
its 304-rating monthly estimate appeared as roughly $1.066m in a weekly view.
This was not evidence to change its Game Pass flag or multiplier.

The September 25 read-only production audit found 200 eligible paid title/platform
records with missing d7 units and non-null d30 units: 81 Steam, 34 PS5, 85 Xbox.
These are candidate records, not 200 independently affected public titles.
Source: https://github.com/sallisonhome/sentimentpulse/actions/runs/36185228673

The live Top 100 outputs contained 56 wider-window rows (5 Steam, 8 PS5, 43 Xbox),
including Dispatch, Crimson Moon, Marvel Tokon, Planet Coaster 2, UFC 6 and
Mortal Kombat 11. Some consoles inherited the wider Steam window through the
existing revenue-ratio model. These observations were pre-deployment.

## Policy

- d7 selects d7 only in platform boards, combined boards and both PDP forms.
- Existing explicitly same-week Steam-derived models and verified d7 anchors
  remain valid. A model is not a wider-period total.
- A protected LTD anchor may calibrate an available d7 signal, but must not
  convert a missing one to zero through JavaScript's null multiplication.
- Missing revenue stays null; absent platforms remain zero contributions.
  Combined available values are subtotals, not complete totals. Incomplete
  summaries suppress percentages and pies rather than treating unknown as zero.
- Other periods retain their existing selection policy, including the legacy
  d30-to-d90 fallback. This change does not claim to remove that separate policy.
- No multiplier, classification, SKU identity, raw rating or stored estimate
  repair is part of this change.

## Verification before deployment

- 261 SignalPulse tests and TypeScript check passed; both production builds passed.
- 3 hmap presentation/CSV tests passed.
- Dedicated real Express + migrated SQLite regression reproduces Dispatch's
  production gate/anchor/estimate inputs. Verifies all four HTTP surfaces,
  monthly/quarterly/yearly/lifetime values, missing vs gated rows, true zero,
  exact-window anchors, same-week models, and no monthly propagation through
  Steam-derived console estimates.
- Production-shaped snapshot supplemented with the 200 fresh gate pairs:
  all 200 candidate PDPs have d7 or unavailable, never d30. In that local replay,
  175 were unavailable and 25 retained legitimate same-week modeled values.
  All 12 non-weekly platform boards matched the prior code exactly; the seven
  protected data tables were unchanged by the presentation fix.
- Real hmap Buying router/cache preserved 10 captured SP route responses,
  including nulls and incomplete-summary fields.
- Built clients tested in Playwright at 1440px and 375px. All five period
  controls worked; incomplete d7 hid pies while complete periods rendered them.

## Daily refresh and rollback

This is durable version-controlled API policy, not a corrective DB write.
Daily discovery/collection can update evidence; estimation, anchors and mix
evaluation cannot re-enable the removed d7-to-d30 read path.

Persistence QA ran the actual estimator, anchor writer and daily mix evaluator
twice in an isolated production-shaped database. All six scripts succeeded;
all 200 candidate PDPs and the three weekly boards still obeyed exact d7
selection afterwards. Source-file hash remained unchanged. This is local
writer-path proof, not a claim that a future production refresh has completed.

No new schedule, service, lock or database migration is introduced.
Rollback is to revert this PR and redeploy SignalPulse, then revert/redeploy the
hmap presentation companion if desired. No DB restore is needed. Once enough
new weekly evidence is available, the normal estimator can legitimately resume
publishing a d7 value; that is recovery, not a rollback of the guard.
