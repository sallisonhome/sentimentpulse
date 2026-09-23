# Pass / Parent Activity

This is a separate Steam runtime engagement comparison. It is not conversion, paid-player penetration, downloads, unique users, or attributable sales. Parent counts never enter the existing pass player-estimation or download-estimation paths.

## Collection and identity

- Existing daily pipeline remains at **03:00 America/New_York**. No new schedule, higher polling cadence, SteamDB scraping, or new credentials.
- Daily Friends Pass discovery supplies the eligible roster. The new collector revalidates each pass's parent and an explicit `steam://run/<pass-id>` or `steam://install/<pass-id>` offer before measuring it.
- Demo-typed pass clients use Steam `appdetails.fullgame.appid`; parent must return the exact App ID and `type=game`. The already-existing discovery gate separately establishes playable game identity.
- Game-typed standalone clients have no reliable metadata parent field. Only reviewed exceptions are permitted:
  - Operation: Tango pass **1377150** → parent **1335790**. [Publisher FAQ](https://clever-plays.com/operation-tango/faq/) and [parent store page](https://store.steampowered.com/app/1335790/Operation_Tango/).
  - Timemelters pass **2477230** → parent **1096140**. [Pass description](https://store.steampowered.com/app/2477230/Timemelters__Friend_Pass/) and [parent store page](https://store.steampowered.com/app/1096140/Timemelters/).
- Both exceptions still require the exact current parent name, exact parent App ID, and a current own-runtime launch offer. Names alone never discover mappings.
- Curated shared-runtime storefronts are hard-excluded before requests. It Takes Two **2995920** remains unverified rather than inferring its runtime identity.
- Hybrids retain “Demo + pass activity”: public CCU cannot separate the client's demo sessions from invited co-op.

Both CCU requests launch concurrently. We retain request and receipt timestamps independently for pass and parent. A valid pair requires ≤10 seconds of request-start skew, ≤10 seconds of receipt skew, and ≤30 seconds overall duration. Counts must be nonnegative integers and both API calls must succeed. These are **near-synchronized API observations**, not guaranteed simultaneous underlying counts: Steam caches its responses and does not return each cache's original sample timestamp. [Steam current-player API](https://partner.steamgames.com/doc/webapi/ISteamUserStats).

## Formulas and gates

- **Latest ratio** = pass CCU / parent CCU. Example: 41 / 95 = **0.43×**, not 43% purchase conversion.
- **Combined activity share** = pass CCU / (pass CCU + parent CCU). The same example yields **30.1%**.
- Latest pair and mapping verification must each be ≤36 hours old. Future timestamps are excluded.
- Parent CCU below **10** suppresses the ratio/share; raw paired counts remain visible. This is an explicit denominator safeguard, not an empirically validated precision guarantee.
- Ratios above 1 are allowed; they are not capped at 100%. Zero pass CCU with a sufficiently active parent is a valid zero.
- A failed refresh is explicitly unavailable while retaining historical pairs. It never becomes zero or silently falls back to parent/player estimates.

## Period comparison

The independent comparison selector offers Latest, 7-day daily samples, and 30-day daily samples. Download/player windows and their default descending download sort are unchanged. Activity is sortable in either direction, with unavailable values last before pagination.

Period views are **daily-sampled comparisons, not continuous activity or player-hours**. They use one earliest valid pair per complete UTC day, restricted to the existing daily collection slot of 03:00–05:00 Eastern. Manual checks outside that slot update Latest only; duplicate samples do not overweight a day. If the pipeline runs later than that slot, its sample remains eligible for Latest but not a period aggregate.

- Require **6 of 7** or **24 of 30** daily samples (80% coverage, rounded up).
- Period ratio = sum of pass samples / sum of parent samples, not the mean of each day's ratio.
- Mean sampled parent CCU must be ≥10. Zero-count days are included if successfully measured; missing days are not imputed as zero.
- Share = summed pass / (summed pass + summed parent).
- Trend = 100 × (current ratio − previous equal-period ratio), in **percentage points**. Only published when both periods meet gates. Coverage may differ, and a daily slot can be unrepresentative of all-day activity; no causal, statistical-significance or whole-day claim.
- No fabricated historical backfill. Newly enabled titles build their paired history going forward.

## Storage and operational isolation

Two additive SQLite tables, `pass_parent_mappings` and `pass_parent_ccu_pairs`, hold current verification/error state and immutable paired observations. Both have title foreign keys; pairs have a title/time index and nonnegative count checks. Startup DDL is idempotent for existing and fresh databases.

No writes to `demo_ccu_snapshots`, downloads/actuals, review counts, player-calibration evidence, Saber cards, or paid-title records. Runtime reads hard-block known shared passes and filter historical pairs by the currently verified parent. Read queries are bounded to 62 days/5,000 pairs per title; daily cadence is well below that cap.

## QA and release

Before merge: run TypeScript check, full tests, production build, isolated live Steam collection, fresh/upgrade migration checks, real HTTP API sorting/window/pagination tests, and browser checks for latest/period/status/zero/above-one values, paired evidence, shared runtimes, filters, theme and mobile scroll containment. Synthetic test histories never enter production or the review preview.

Squash merge and production deployment require explicit approval. An optional first production pass-only refresh must also be approved; it creates current observations, not historical activity. Post-deploy verify table schemas/integrity, served bundle and API behavior, recorded paired timestamps, unchanged Saber actuals, and the existing daily scheduler log before claiming live success.
