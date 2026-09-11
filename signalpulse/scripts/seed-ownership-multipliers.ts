/**
 * Seed the ownership_multipliers table with v0 public-benchmark defaults, plus
 * the app_settings.noise_gate_min_signal row. Idempotent — reruns compare-and-
 * skip against the effective_from date, so re-running the daily workflow every
 * night doesn't create a new row per day.
 *
 * v0 defaults sourced from public benchmarks. These are DELIBERATELY tagged
 * confidence='v0-defaults' and MUST be replaced by a fitted set (see
 * docs/calibration-anchors-todo.md) before the boards leave the internal-only
 * state per console_leaderboards_spec §10.4.
 *
 *   Steam:  55×  ±30%   digital=1.00
 *     Basis: GameDiscoverCo — Steam review counts translate to ~50–70× owners
 *     for indie-through-mid-tier games (https://newsletter.gamediscover.co/p/what-steam-review-count-tells-us).
 *     Aligns with VG Insights' 55× public number (https://vginsights.com/insights/article/steam-sales-estimation-methodology-and-accuracy).
 *     ±30% is the tight end because Steam has the deepest public back-tests.
 *
 *   Xbox:   200× ±50%   digital=0.90
 *     Basis: Microsoft Store UsageData ratings are ~4× thinner per owner than
 *     Steam reviews per Raijin methodology (https://raijin.gg/methodology). At
 *     ~55/4 → per-rating multiplier ≈ 220; rounded to 200 for a conservative
 *     v0. Digital 0.90 modelled since Xbox exited Circana's digital panel in
 *     July 2026 (https://kotaku.com/xbox-isnt-sharing-us-digital-sales-data-anymore-2000726257).
 *     ±50% reflects the missing panel data.
 *
 *   PS5:    150× ±50%   digital=0.76
 *     Basis: PSN star ratings are ~3× thinner per owner than Steam reviews per
 *     the gamstat trophy-sampling back-test
 *     (https://arstechnica.com/gaming/2019/03/here-are-the-most-popular-playstation-games-based-on-public-trophy-data/).
 *     Digital 0.76 = Sony IR FY24 disclosed full-game digital unit share
 *     (https://www.sony.com/en/SonyInfo/IR/library/presen/er/pdf/25q2_supplement.pdf).
 *     ±50% because the star-rating signal is thin and PS gates the reviews
 *     wall to a curated subset.
 */

/* eslint-disable no-console */

import { rawSqlite } from "../server/storage";

interface SeedRow {
  platform: string;
  cohort_key: string;
  multiplier: number;
  ci_pct: number;
  digital_unit_share: number;
  confidence: string;
  method: string;
  notes: string;
}

// v0.2 (2026-09-11): first-run outputs vs public disclosures showed the
// initial multipliers were too high for evergreen titles — Xbox Minecraft came
// out at 930M units, PS BG3 at 154M. Recalibrated against a handful of
// public anchors to produce plausible top-of-board numbers. These are still
// v0 defaults — not fitted — and per-cohort fits (Game Pass inclusion, PS Plus
// day-one, premium exclusive, indie) come with the calibration follow-up.
//
// Cross-check math the numbers below satisfy:
//   Steam Terraria: 1.34M reviews × 40 → 53M units      (real ~58M)
//   Steam BG3:      ~500K reviews × 40 → 20M units      (real ~15M steam)
//   Xbox Minecraft: 4.18M ratings × 12 / 0.90 → 55M     (real ~40-50M xbox)
//   Xbox Forza H5:  67K ratings × 12 / 0.90 → 900K       (real ~6M xbox, but 20M "players" incl. Game Pass streaming)
//   PS5  Minecraft: 1.98M ratings × 6 / 0.76 → 15.6M     (real ~15-20M ps)
//   PS5  BG3:       780K ratings × 6 / 0.76 → 6.2M       (real ~5M ps)
const V0_ROWS: SeedRow[] = [
  {
    platform: "steam", cohort_key: "default",
    multiplier: 40, ci_pct: 0.40, digital_unit_share: 1.00,
    confidence: "v0-defaults", method: "gamediscoverco-adjusted",
    notes: "GameDiscoverCo baseline 50-70x owners/review over-estimates evergreen titles; anchor cross-check against Terraria (58M actual @ 1.34M reviews = 43x) and BG3 Steam (~15M @ ~500K reviews = 30x) narrows the plausible range to ~30-45x. 40x with ±40% covers both.",
  },
  {
    platform: "xbox", cohort_key: "default",
    multiplier: 12, ci_pct: 0.60, digital_unit_share: 0.90,
    confidence: "v0-defaults", method: "anchor-cross-checked",
    notes: "Anchor cross-check: Minecraft Xbox (4.18M ratings, ~40-50M lifetime) implies ~10-12x. Elden Ring Nightreign (182K ratings, ~2M Xbox) implies ~10x. Forza Horizon 5 (67K ratings, 20M cross-platform Game Pass players) sits high but Game Pass streaming inflates player counts. Digital 0.90 modelled since Xbox exited Circana panel July 2026. ±60% because Game Pass inclusion is a very large cohort effect not yet captured.",
  },
  {
    platform: "ps5", cohort_key: "default",
    multiplier: 6, ci_pct: 0.60, digital_unit_share: 0.76,
    confidence: "v0-defaults", method: "anchor-cross-checked",
    notes: "Anchor cross-check: BG3 PS5 (780K ratings, ~5M lifetime) implies 4.9x. Minecraft PS (1.98M ratings, ~15-20M lifetime) implies 5-8x. PSN star-ratings are a passive 1-tap prompt so their rate-per-owner is much higher than Steam's active review action. Digital 0.76 = Sony IR FY24 full-game digital unit share.",
  },
];

async function main() {
  const db = rawSqlite;
  const nowIso = new Date().toISOString();
  // Use a fixed effective_from date so re-running the workflow doesn't create
  // a new row per day. If we change any coefficient we bump this date manually.
  const effectiveFrom = "2026-09-11T12:00Z"; // bumped from 2026-09-11 when v0.2 anchor-cross-checked multipliers replaced initial GameDiscoverCo-only defaults

  // ─── 1. ownership_multipliers ─────────────────────────────────────────────
  const existing = db.prepare(
    `SELECT platform, cohort_key FROM ownership_multipliers
      WHERE effective_from = ? AND confidence = 'v0-defaults'`
  ).all(effectiveFrom) as Array<{ platform: string; cohort_key: string }>;
  const existingKeys = new Set(existing.map(r => `${r.platform}|${r.cohort_key}`));

  const insert = db.prepare(
    `INSERT INTO ownership_multipliers
       (platform, cohort_key, multiplier, ci_pct, digital_unit_share,
        confidence, method, notes, effective_from, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let seeded = 0;
  for (const r of V0_ROWS) {
    const key = `${r.platform}|${r.cohort_key}`;
    if (existingKeys.has(key)) {
      console.log(`[seed-ownership-multipliers] ${key} @ ${effectiveFrom} already exists — skipping`);
      continue;
    }
    insert.run(
      r.platform, r.cohort_key, r.multiplier, r.ci_pct, r.digital_unit_share,
      r.confidence, r.method, r.notes, effectiveFrom, nowIso,
    );
    seeded++;
    console.log(`[seed-ownership-multipliers] inserted ${key}: multiplier=${r.multiplier} ci=±${(r.ci_pct * 100).toFixed(0)}% digital=${r.digital_unit_share}`);
  }
  console.log(`[seed-ownership-multipliers] ownership_multipliers seeded=${seeded}, already-present=${V0_ROWS.length - seeded}`);

  // ─── 2. app_settings.noise_gate_min_signal ────────────────────────────────
  const gate = db.prepare(
    `SELECT value FROM app_settings WHERE key = 'noise_gate_min_signal'`
  ).get() as { value: string } | undefined;
  if (!gate) {
    db.prepare(
      `INSERT INTO app_settings (key, value, label, category, is_secret, created_at, updated_at)
       VALUES ('noise_gate_min_signal', '50',
               'Console leaderboards: minimum signal count to unblock an estimate cell',
               'console_leaderboards', 0, ?, ?)`
    ).run(nowIso, nowIso);
    console.log(`[seed-ownership-multipliers] app_settings.noise_gate_min_signal inserted (value=50)`);
  } else {
    console.log(`[seed-ownership-multipliers] app_settings.noise_gate_min_signal already present (value=${gate.value})`);
  }

}

main().catch((err) => {
  console.error("[seed-ownership-multipliers] FATAL:", err);
  process.exit(1);
});
