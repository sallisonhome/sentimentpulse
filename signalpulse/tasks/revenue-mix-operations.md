# Revenue mix: shadow v1

The deployed mode is `shadow`, not an active revenue model. Each title retains existing published revenue, units and overrides. No code applies proposed shares to the estimator. hmap only renders SignalPulse's status message and aggregates.

## Evidence and limitations

Daily cumulative storefront observations are differenced into two non-overlapping blocks. Each platform is normalized against equal-weight, leave-one-family-out peers in the same release-age and price cohort. This cancels platform-level rating propensity without treating Steam reviews and console stars as directly comparable. This is a heuristic calibration experiment, not a model validated against publisher sales.

Every window has a separate audit: d7/d30/d90/m12 require complete daily history over that window. LTD evaluates the latest 28 days as a diagnostic only, NOT evidence to rewrite lifetime sales. It is explicitly tagged in the audit. Ten eligible peer families are required. Both blocks require at least 50 Steam/PS5 and 10 Xbox new ratings. A 1.5x deviation must recur; >5x anomalies are quarantined. Confidence is capped at 25%, total baseline deviation at 5 percentage points, daily proposal movement at 1 percentage point.

Incomplete/ambiguous families, duplicate platform base titles, unknown/young/staggered releases, Game Pass flags, manual overrides, anchors, stale/missing observations, resets and batch spikes are blocked. Only one signal per title/platform is used; editions are never summed. Promotions and unflagged subscriptions cannot reliably be detected from rating counts. Enabling active allocation must wait for additional event flags, price/ASP validation, publisher-ground-truth backtests and review. Many titles will legitimately remain baseline.

## Audit and scheduling

`revenue_mix_shadow_daily` is additive and idempotent on family/window/day/model version. `evidence_json` contains inputs and cohort; `result_json` contains candidate, confidence, peer count and rejection reason. Runs at server startup and after the existing daily console estimator. Same-day retries read only yesterday's candidate, preventing cap compounding.

Inspect with:

```sql
SELECT as_of_date, window, count(*) FROM revenue_mix_shadow_daily GROUP BY 1,2;
SELECT family_key, window, result_json FROM revenue_mix_shadow_daily ORDER BY as_of_date DESC LIMIT 30;
```

## Rollback

Through the existing authenticated app-settings management, set `revenue_mix_mode` to `off`. It is read each execution/request; audit writing stops and the public note reports calibration off. Existing audit rows remain. `shadow` restores collection. Unsupported values, including `active`, fail closed to off. Unset defaults to shadow.

For a code rollback, revert this release's commit and redeploy; the additive audit table may safely remain. Never delete historical rows to roll back. Live estimates require no restoration because this release never modifies them.
