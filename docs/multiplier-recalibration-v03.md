# v0.3 Ownership-Multiplier Recalibration

**Trigger:** LTD unit estimates on the console leaderboard look off. User request
(2026-09-11) — recalibrate ratings→units multipliers using publicly-stated total
units and an AAA-typical platform mix.

## Source

- User-uploaded 2026-07 Digital Sales Report V2 (Saber-confidential):
  `/home/user/workspace/uploaded_attachments/ceefbfcfafea41ac8cccb1da8cd260cf/2026.07-All-Games-Digital-Sales-Report-V2.pdf`
- Page 9 lifetime platform-revenue split per title informed the initial Saber-mix
  discussion; the user then supplied a fixed AAA-typical mix (below) to use
  instead of the Saber-portfolio-weighted average.

## Locked-in platform mix (user-specified, 2026-09-11)

**Raw REVENUE-share input (100% total):**

- PC (Steam) 46%
- PS5 33%
- Xbox 18%
- Switch 2 3%

**ASP correction** — Steam ASPs run ~50% of console ASPs (steep Steam discounting
means one dollar of Steam revenue represents ~2× the units of one dollar of
console revenue). Multiply Steam's revenue share by 2 before renormalizing:

    raw_units_parts = { Steam: 46*2, PS5: 33, Xbox: 18, Switch: 3 }
                    = { Steam: 92,   PS5: 33, Xbox: 18, Switch: 3 }
    total_parts     = 146

**Final UNIT-share used to apportion each anchor title's public total-units:**

| Platform | Unit share |
|---|---|
| Steam (PC) | **63.0%** (92 / 146) |
| PS5        | **22.6%** (33 / 146) |
| Xbox       | **12.3%** (18 / 146) |
| Switch 2   |  **2.1%** ( 3 / 146) |

Applied uniformly to every anchor title (no per-title genre matching in v0.3).

## Anchor construction

For each platform we track (Steam, PS5, Xbox), pull the top 100 titles by
**30-day storefront rating_count** from `store_rating_signal_daily.window_label='d30'`,
joined with `console_title_igdb.name` and `platform_sku_map.business_model='paid'`.

Rationale for 30-day (not LTD) as the anchor **seed**: our discovery cadence
targets the current 30-day-hot universe (`sales30` on PS5, `topsellers` on
Steam/Xbox). Anchoring the LTD-multiplier fit against titles that are still
active today keeps the fit relevant. LTD rating counts and LTD units are pulled
FOR each seed title.

For each of those 100 titles per platform, research publicly-stated **total units
sold across all platforms**. Realistic hit rate ~20-30% — accept that as the
anchor sample size.

Anchor row:

```
title | platform | rating_count_ltd | total_units_all_platforms | source_url
```

Derived per-platform units for that title:

```
derived_units[platform] = total_units × platform_unit_share[platform]
implied_multiplier      = derived_units / rating_count_ltd
```

Where `platform_unit_share` is the ASP-corrected table above.

## Multiplier fit

Per platform, compute across the ~20-30 anchor titles that yielded a public
total-units number:

- `p50` (median) — the new multiplier value (this is what production uses)
- `p10` and `p90` — the confidence band; expose as `±(p90-p10)/2 / p50` % on the leaderboard tile

## v0.2 → v0.3 delta expectations

v0.2 multipliers (currently deployed, `effective_from='2026-09-11T12:00Z'`):

| Platform | Multiplier | Band | Digital share |
|---|---|---|---|
| Steam | 40× | ±40% | 1.00 |
| Xbox  | 12× | ±60% | 0.90 |
| PS5   |  6× | ±60% | 0.76 |

If the v0.3 fit lands within ±30% of these, v0.2 was on-target and we bump the
band/publish v0.3 with the same central values but tighter uncertainty.
If materially different (>±30%), v0.3 replaces them and the estimator's next
run recomputes every (title, platform, window) row in `window_estimates_daily`.

## Windows other than LTD

The multiplier is fit against LTD ratings vs LTD units. Windowed estimates
(d7/d30/d90/m12) are already derived from LTD by the existing estimator's
decay-and-share logic — no change required. Only the LTD central multiplier
moves in v0.3.

## Shipped values (effective_from 2026-09-11T14:00Z)

Values pushed to `ownership_multipliers` (effective_from `2026-09-11T14:00Z`):

| Platform | Cohort | Multiplier | CI band | Digital share | GP deflator | Method |
|---|---|---:|---:|---:|---:|---|
| steam | default | **25** | ±113% | 1.00 | — | ltd-anchor-median-v03 |
| ps5   | default | **24** | ±257% | 0.76 | — | ltd-anchor-median-v03 |
| xbox  | default | **147** | ±141% | 0.90 | **1.406** | ltd-anchor-median-v03-gp-segmented |

Fit inputs and quality-filtered anchor sets are captured in
`anchors/v03_fit_filtered.csv` (Steam n=31, PS5 n=15, Xbox non-GP n=5) and
`anchors/v03_fit_gp_segmented.json` (Xbox GP n=6).

### Xbox Game Pass segmentation

Estimator applies `effective_signal = raw_signal / gp_rating_deflator` when
`platform_sku_map.is_gamepass = 1`, then multiplies by the base xbox multiplier
(147×). Non-GP xbox rows are untouched. GP flags are seeded from
`scripts/seed-xbox-gamepass-flags.ts` (hand-curated starter list) and will be
replaced by IGDB `game_service_availability` or an Xbox Wire feed in a
follow-up.

### What this changes in the leaderboards

- **Steam Top 100** — every eligible LTD row now multiplied by 25 (down from 40)
  and CI widened from ±40% to ±113% pending more anchors.
- **PS5 Top 68** (DB ceiling today; discovery still filling toward Top 100) —
  every eligible LTD row multiplied by 24 (up from 6). Wider ±257% band reflects
  the sparse anchor pool of PS5-exclusive-heavy titles.
- **Xbox Top 100** — non-GP rows multiplied by 147 (up from 12); GP rows
  effectively multiplied by 147/1.406 = ~104. Both cohorts share the 147 base
  multiplier so future GP-flag corrections propagate without a re-seed.

### Not yet closed

- PS5 discovery is short of Top 100 (68 titles in DB); the daily seed cron
  should fill this over 30 days as new PS5 charts poll new SKUs.
- Xbox d90 and m12 windows have no data (Xbox native ratings expose only d7/d30
  + LTD; forward-only history will backfill d90/m12 by day 90/365).
- PS5 windowed cells (d7/d30/d90/m12) remain gated `insufficient_history` until
  ≥N+1 days of forward-only daily snapshots exist.
- `is_gamepass` flag automation (IGDB `game_service_availability` or Xbox
  Wire scrape) still pending.
