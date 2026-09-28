# Public Steam unit milestones and shadow evaluation

## Authority and limitations

Wardogs' publisher announcement, dated September 26, reports over three million
copies; GamesBeat's September 27 article reproduces it:
https://gamesbeat.com/wardogs-hits-3m-copies-sold-in-early-access-in-16-days/

The calibration target is the disclosed minimum, 3,000,000, not an exact final
total. The report has date-level precision, not a verified sales timestamp.
Neither revenue nor daily sales were disclosed. We allocate the target over
the retained September 10–26 modeled daily review pattern (81,240 reviews),
using largest-remainder rounding so allocated units sum exactly to 3,000,000.
This is a historical model restatement, not a historical actual-sales feed.
Later days use the same coefficient until a new separately approved milestone.

The title/app identity, immutable manifest, source quote, legacy anchor
before-image and daily allocations are retained. Raw reviews, estimator
history, title overrides, prior anchors and LTD state are not rewritten.
The public overlay only supersedes the named legacy assumption. Other anchors
block it; portal actuals and newer verified overrides retain authority.
No Steam calibration propagates into a console projection.

## Writer and rollback

`manage-steam-unit-milestone.ts audit` is read-only. `apply` requires the manifest
SHA-256 in `APPROVED_MILESTONE_SHA256` and runs inside a transaction. It activates
one milestone and its daily ledger; it does not deploy, restart or schedule.
The operator must hold `/run/lock/signalpulse-maintenance.lock` around activation.
The existing estimator refreshes only the separate calibrated ledger. Repeating
the same signal replaces a date's high-water count, rather than adding units
again. Missing daily coverage remains unavailable. Coarse histograms are never
divided into fabricated daily data. Ledger observations retain raw observation
timestamps; the displayed as-of date is the last covered activity day.

`rollback` with the identical manifest hash sets only that milestone's `active`
to zero. All new audit/ledger evidence remains; the original published model is
visible again. It does not erase fresh ingestion or rewind the database.
The old model is known to be under-calibrated: rollback restores prior behavior,
not a claim that it was accurate. Reactivation is idempotent.
`STEAM_UNIT_CALIBRATION_ENABLED=0` is a process-level read/write bypass; the
durable milestone `active=0` is the cross-process rollback.

## Steam shadow learner

One bounded Steam current-CCU chart read is added to the existing successful
daily collection entrypoint. No timer, refresh or scheduler is added. This is
top-chart coverage, not full Steam coverage. Absent titles remain unknown.
Each App ID has at most one timestamped CCU sample per UTC date; this is a
sample, not a daily average/peak. HTTP 429 Retry-After is durable across days.
Collector failure is explicit and cannot overwrite successful sales collection.

Daily evaluation reads paid Steam identities, original review activity and
independent public-unit calibration when available. It stores evidence,
coverage and rejection reasons, never modifies published sales/multipliers.
It compares two completed seven-day blocks only after 14 paired days at
comparable UTC sample times (90-minute maximum spread), rejects review shocks
and protected actual/manual cases, and suggests at most a 10% non-compounding
uplift when sustained CCU and review activity diverge. This is a conservative
candidate policy, not an empirically trained coefficient. Normal days stay at
factor 1. It does not currently estimate causal sales from CCU or infer that an
update/free event is new buying.

There is no automatic promotion or active-application path. A future release
would need held-out independent sales milestones, event controls and explicit
approval. Our own estimated revenues are never training labels.

Durable cross-process off switch:
`app_settings.key='steam_sales_shadow_enabled', value='0'`.
`STEAM_SALES_SHADOW_ENABLED=0` also disables the current process.
Evidence is in `steam_sales_ccu_samples`, `steam_sales_shadow_collection` and
`steam_sales_shadow_daily`, keyed to native Steam App IDs.
