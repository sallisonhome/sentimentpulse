# v0.3 Ownership-Multiplier Recalibration

**Trigger:** LTD unit estimates on the console leaderboard look off. User request
(2026-09-11) — recalibrate ratings→units multipliers using publicly-stated total
units and an AAA-typical platform mix.

## Platform mix (user-specified, applied to every anchor title)

The lifetime-unit total for a given multi-platform title is apportioned across
platforms using this fixed mix:

- **Steam / PC**: 47%
- **PS5**: 36%
- **Xbox**: 12%
- **Switch 2**: 5%

Rationale: closer to AAA multi-platform typical distribution than the
Saber-portfolio revenue split from the 2026-07 sales report (which had heavy
Focus/simulator Steam skew: SM2 53% Steam, RoadCraft 53%, SnowRunner only 25%
because of its long EGS window). The user's mix is an industry-typical
weighting.

Treated as **unit share**, not revenue share (i.e. no ASP correction on top).

## Anchor construction

For each platform (Steam, PS5, Xbox), pull the top 100 titles by **LTD**
storefront rating_count from `store_rating_signal_daily.window_label='ltd'`,
joined with `console_title_igdb.name` and `platform_sku_map.business_model='paid'`.

We anchor LTD units vs LTD ratings (not 30-day) because:

- Publicly-stated units figures are almost always cumulative (LTD), not windowed.
- Steam review counts accrue over the lifetime of a title; PSN and Xbox likewise.
- Fitting on LTD gives the strongest calibration; windowed multipliers (d7/d30/d90/m12) are then derived by proportional decay from LTD.

For each of those 100 titles per platform, research publicly-stated total units
across all platforms. Realistic hit rate ~20-30% — accept that as the anchor
sample size.

Anchor row:
```
title | platform | rating_count_ltd | total_units_all_platforms | source_url
```

Derived per-platform units:
```
derived_units = total_units × platform_share
implied_multiplier = derived_units / rating_count_ltd
```

## Multiplier fit

Per platform, compute:
- `p50` (median) — the new multiplier value
- `p10` and `p90` — the confidence band; report as `±(p90-p10)/2 / p50` % on the leaderboard

## v0.2 → v0.3 delta expectations

v0.2 multipliers (currently deployed):
- Steam: 40× ±40%, digital=1.00
- Xbox: 12× ±60%, digital=0.90
- PS5: 6× ±60%, digital=0.76

If the fit lands near these values, v0.2 was on target. If materially different
(>±30%), v0.3 replaces them.
