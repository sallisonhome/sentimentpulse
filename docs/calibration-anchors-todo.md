# Calibration follow-up — replace v0 defaults with a fitted multiplier set

**Status:** v0 estimator shipped 2026-09-11. Multipliers are public-benchmark
defaults tagged `confidence='v0-defaults'` in `ownership_multipliers`. Spec
§10.4: "boards remain internal until [multipliers carry] `calibration_titles`
receipts; MAPE reported alongside R²; boards remain internal until reviewed."

## What v0 does today

| Platform | Multiplier | CI | Digital share | Basis |
|---|---|---|---|---|
| Steam | 55× | ±30% | 1.00 | [GameDiscoverCo](https://newsletter.gamediscover.co/p/what-steam-review-count-tells-us), [VG Insights](https://vginsights.com/insights/article/steam-sales-estimation-methodology-and-accuracy) |
| Xbox  | 200× | ±50% | 0.90 | Scaled from Steam via [Raijin methodology](https://raijin.gg/methodology) 4× thinning; digital modelled since [Xbox Circana exit](https://kotaku.com/xbox-isnt-sharing-us-digital-sales-data-anymore-2000726257) |
| PS5   | 150× | ±50% | 0.76 | Scaled from Steam via [gamstat trophy back-test](https://arstechnica.com/gaming/2019/03/here-are-the-most-popular-playstation-games-based-on-public-trophy-data/) 3× thinning; digital = [Sony IR FY24 76%](https://www.sony.com/en/SonyInfo/IR/library/presen/er/pdf/25q2_supplement.pdf) |

Every leaderboard row shows a `v0` amber pill next to the "Est. units" column
header. The estimator writes `owners_low/mid/high`, `units_mid`, and a
`gated_reason` per (title, platform, window) into `window_estimates_daily` on
the daily seed workflow.

## What still needs to happen for a fitted set

### 1. Harvest anchor set (blocking)

Build `tasks/calibration-anchors.md` with rows of the form:

```
title | platform | disclosed_units | disclosure_date | source_url | cohort_key
```

Target: 8–12 anchors per platform, spanning cohorts.

Candidate anchors (public disclosures — need to verify each):

- **Forza Horizon 5 (Xbox):** 20M players, [Xbox news](https://www.videogameschronicle.com/news/forza-horizon-5-has-reached-20-million-players/) — cohort `gamepass-day-one`
- **Elden Ring (Steam / PS5):** ~25M SteamDB + [FromSoftware IR](https://www.kadokawa.co.jp/) — cohort `premium-exclusive-adjacent`
- **Baldur's Gate 3 (Steam / PS5):** 15M+ per Larian [State of the Game](https://larian.com/) — cohort `premium-single-player`
- **Cyberpunk 2077 (Steam / PS5 / Xbox):** ~30M per CD Projekt IR — cohort `premium-single-player`
- **Minecraft (Xbox / PS5):** 300M+ lifetime per [Mojang](https://www.minecraft.net/) — cohort `evergreen-multiplayer`
- **Hogwarts Legacy (Steam / PS5 / Xbox):** 24M per WBIE — cohort `premium-single-player`
- **Helldivers 2 (Steam / PS5):** 12M+ per Sony State of Play — cohort `premium-multiplayer`
- **Stellar Blade (PS5):** 1M+ per Sony IR — cohort `premium-exclusive`
- **Palworld (Steam / Xbox):** 25M per Pocketpair — cohort `gamepass-day-one`
- **EA FC 24 (Steam / PS5 / Xbox):** [EA IR](https://ir.ea.com/) — cohort `annual-sports`

### 2. Extend cohort schema

`ownership_multipliers.cohort_key` currently only has `'default'`. Add rows for:

- `gamepass-day-one` — Xbox first-party or Game Pass launch inclusion
- `ps-plus-day-one` — PS Plus launch inclusion
- `premium-exclusive` — first-party paid without subscription inclusion
- `premium-multiplayer` — live-service premium (Helldivers 2, Fortnite paid)
- `annual-sports` — EA Sports, 2K
- `evergreen-multiplayer` — Minecraft, Roblox-adjacent
- `indie-premium` — <$25 sub-1M expected

Cohort assignment goes in a new `platform_sku_map.cohort_key` column (nullable,
falls back to `'default'`) OR a separate `title_cohorts` join table if a title
can belong to multiple cohorts across platforms.

### 3. Fit the multipliers

For each (platform, cohort):

```
multiplier_hat = median(disclosed_units × digital_share / signal_at_disclosure_date)
```

The joined tables for the fit are:
- `store_rating_signal_daily.rating_count` at `capture_date == disclosure_date`
- `calibration_titles(title_id, disclosed_units, disclosure_date, source_url, cohort_key)`
- `ownership_multipliers(platform, cohort_key, digital_unit_share)`

Report MAPE (mean absolute percent error) and R² on the anchor set. Fitted
rows go into `ownership_multipliers` with `confidence='fitted'` and a new
`effective_from` date. The estimator reads whatever row has the greatest
`effective_from <= today`, so a fitted set drops in without touching the
estimator code.

### 4. Add anchor receipts

New table `calibration_titles`:

```sql
CREATE TABLE calibration_titles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  cohort_key TEXT NOT NULL,
  disclosed_units INTEGER NOT NULL,
  disclosure_date TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_notes TEXT,
  created_at TEXT NOT NULL
);
```

Add a `multiplier_id → calibration_titles[]` join via `multiplier_calibrations
(multiplier_id, calibration_id)`. The title detail page renders these as the
"multiplier receipts" per spec §9.

### 5. Un-gate the boards

Only after MAPE is reported does the `v0` pill come off the leaderboard header,
per spec §10.4 and Milestone 7. The pill's replacement is either `fit` (green)
with the fit date, or stays `v0` (amber) until then.

## Referenced spec sections

- §5 Estimation math
- §6 Cadence and the noise gate (noise_gate_min_signal, stored in app_settings)
- §10.4 "No published console coefficient"
- §11 Milestone 7 "First calibration fit"

## Referenced code

- `signalpulse/scripts/estimate-console-units.ts` — reads multipliers, writes window_estimates_daily
- `signalpulse/scripts/seed-ownership-multipliers.ts` — seeds v0 defaults
- `signalpulse/server/storage.ts` — `ownership_multipliers` schema
