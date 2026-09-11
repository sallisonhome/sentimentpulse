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

const V0_ROWS: SeedRow[] = [
  {
    platform: "steam", cohort_key: "default",
    multiplier: 55, ci_pct: 0.30, digital_unit_share: 1.00,
    confidence: "v0-defaults", method: "gamediscoverco-baseline",
    notes: "GameDiscoverCo baseline 50-70x owners/review; VG Insights published 55x. ±30% is the tight end because Steam has the deepest public back-tests.",
  },
  {
    platform: "xbox", cohort_key: "default",
    multiplier: 200, ci_pct: 0.50, digital_unit_share: 0.90,
    confidence: "v0-defaults", method: "raijin-scaled-from-steam",
    notes: "UsageData ratings are ~4x thinner per owner than Steam reviews per Raijin methodology (55*4≈220, rounded to 200 for conservatism). Digital 0.90 modelled since Xbox exited Circana's digital panel in July 2026.",
  },
  {
    platform: "ps5", cohort_key: "default",
    multiplier: 150, ci_pct: 0.50, digital_unit_share: 0.76,
    confidence: "v0-defaults", method: "gamstat-scaled-from-steam",
    notes: "PSN star ratings are ~3x thinner per owner than Steam reviews per the gamstat trophy-sampling back-test. Digital 0.76 = Sony IR FY24 full-game digital unit share.",
  },
];

async function main() {
  const db = rawSqlite;
  const nowIso = new Date().toISOString();
  // Use a fixed effective_from date so re-running the workflow doesn't create
  // a new row per day. If we change any coefficient we bump this date manually.
  const effectiveFrom = "2026-09-11";

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
