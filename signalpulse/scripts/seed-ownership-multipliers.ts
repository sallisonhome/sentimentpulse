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
  gp_rating_deflator: number | null;
}

// v0.3 (2026-09-11): fitted from 150-title LTD anchor research pass (see
// docs/multiplier-recalibration-v03.md and anchors/ltd_units_research.md).
// For each anchor we computed implied_multiplier = public_units × digital_share
// / raw_ratings, then took the median after applying denylist + minimum-ratings
// filters. Xbox is split by Game Pass inclusion — GP subs rate without buying,
// which suppresses the observed multiplier by ~1.4× vs non-GP paid titles. The
// estimator applies gp_rating_deflator to raw ratings before multiplying so
// GP-flagged SKUs collapse toward the non-GP multiplier.
//
// Anchors that drove the fit:
//   Steam: n=31 quality anchors → median 25.35× (band ±113%). Terraria 70M@1.34M
//     reviews = 52×; BG3 20M all-platform, Steam-major fraction; Palworld 30.5M
//     analyst estimate (Steam ~65%) balanced against Helldivers 2 20M cross-
//     platform; median settled at 25× once denylisted MMO/free-tier titles were
//     removed.
//   PS5:  n=15 anchors → median 23.6× (band ±257%). Sparse because PS5 anchors
//     with disclosed units are dominated by exclusives; Ghost of Yotei (3.3M
//     first month PS5-exclusive), BG3 PS5 (~5M), Helldivers 2 (PS5 majority of
//     20M) all sit in 20-30× range. Rounded to 24.
//   Xbox non-GP: n=5 provisional anchors → median 147.1× (band ±141%).
//     MK11 80×, Injustice 2 96×, Castle Crashers 174×, It Takes Two 392×,
//     Phasmophobia 407× — the mid of that stack.
//   Xbox GP:     n=6 anchors → median 104.65×. Deflator = 147.1 / 104.65 = 1.406.
//     GP anchors: Texas Chain Saw 10×, Ark Ascended 24×, ARC Raiders 70×, Ready
//     or Not 159×, Helldivers 2 147×, Valheim 139×. GP-flagged SKUs get their
//     ratings divided by 1.406 before the 147× multiplier is applied.
//
// Digital-unit-share (denominator for units_mid = owners_mid / share) uses
// ASP-corrected unit-share view: Steam 1.00, PS5 0.76 (Sony IR FY24), Xbox
// 0.90 (post-Circana modelled).
const V0_ROWS: SeedRow[] = [
  {
    platform: "steam", cohort_key: "default",
    multiplier: 25, ci_pct: 1.13, digital_unit_share: 1.00,
    confidence: "fitted", method: "ltd-anchor-median-v03",
    notes: "v0.3 fit from 150-title LTD anchor pass. n=31 quality-filtered anchors; median implied multiplier 25.35x, filtered CI band ±113%. Rounded down to 25 to be conservative against evergreen inflation.",
    gp_rating_deflator: null,
  },
  {
    platform: "xbox", cohort_key: "default",
    multiplier: 147, ci_pct: 1.41, digital_unit_share: 0.90,
    confidence: "fitted", method: "ltd-anchor-median-v03-gp-segmented",
    notes: "v0.3 fit segmented by Game Pass inclusion. Non-GP paid anchors (n=5): median 147.1x. GP anchors (n=6): median 104.65x — lower because GP subscribers rate without buying, inflating the ratings denominator. Deflator 1.406 = non-GP / GP; applied by the estimator to raw ratings on GP-flagged SKUs so both cohorts share the 147x multiplier. ±141% CI reflects small anchor n.",
    gp_rating_deflator: 1.406,
  },
  {
    platform: "ps5", cohort_key: "default",
    multiplier: 24, ci_pct: 2.57, digital_unit_share: 0.76,
    confidence: "fitted", method: "ltd-anchor-median-v03",
    notes: "v0.3 fit from LTD anchors. n=15 quality-filtered anchors; median implied multiplier 23.6x (Ghost of Yotei PS5-exclusive 3.3M, BG3 PS5 ~5M, Helldivers 2 PS5-majority of 20M). Rounded to 24. Wide ±257% band — anchor pool is small and dominated by exclusives; will tighten as forward-only PS5 history accumulates.",
    gp_rating_deflator: null,
  },
];

async function main() {
  const db = rawSqlite;
  const nowIso = new Date().toISOString();
  // Use a fixed effective_from date so re-running the workflow doesn't create
  // a new row per day. If we change any coefficient we bump this date manually.
  const effectiveFrom = "2026-09-11T14:00Z"; // v0.3 anchor-fitted multipliers with Game Pass segmentation; bumped from 12:00Z (v0.2). Kept in the past so effective_from <= nowIso allows the estimator to pick it up on the same day.

  // ─── 1. ownership_multipliers ─────────────────────────────────────────────
  const existing = db.prepare(
    `SELECT platform, cohort_key FROM ownership_multipliers
      WHERE effective_from = ?`
  ).all(effectiveFrom) as Array<{ platform: string; cohort_key: string }>;
  const existingKeys = new Set(existing.map(r => `${r.platform}|${r.cohort_key}`));

  const insert = db.prepare(
    `INSERT INTO ownership_multipliers
       (platform, cohort_key, multiplier, ci_pct, digital_unit_share,
        confidence, method, notes, gp_rating_deflator, effective_from, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      r.confidence, r.method, r.notes, r.gp_rating_deflator, effectiveFrom, nowIso,
    );
    seeded++;
    const gpNote = r.gp_rating_deflator ? ` gp_deflator=${r.gp_rating_deflator}` : "";
    console.log(`[seed-ownership-multipliers] inserted ${key}: multiplier=${r.multiplier} ci=±${(r.ci_pct * 100).toFixed(0)}% digital=${r.digital_unit_share}${gpNote}`);
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
