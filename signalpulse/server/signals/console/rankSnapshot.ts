// Console storefront rank snapshot writer + churn metric (Push 2, Change 11).
//
// Called from the discovery pipeline once per (platform, sort_key) after
// discovery has resolved storefront items to title_ids. Records rank so we
// can compute:
//
//   1. top50_churn_pct  \u2014 % of the top-50 titles that entered or exited vs.
//      the previous UTC day's snapshot on the SAME (platform, sort_key).
//      Once this holds <20% for 14 consecutive days on a platform we can
//      safely relax that platform's daily deep-scan to weekly. The relaxation
//      itself is an operator decision \u2014 this file only produces the metric.
//   2. Rank-velocity hot badge  \u2014 a title climbing >=5 positions in 24h.
//      Emitted by getRankVelocity(); consumed by the leaderboard route.
//
// Design notes:
//
//   \u2022 UTC snapshot_date. Discovery runs at fixed UTC times, so a same-day
//     re-run upserts the row in place rather than creating a second snapshot.
//     Local-time boundaries never matter for the churn window.
//
//   \u2022 REPLACE (INSERT OR REPLACE) rather than UPSERT-ON-CONFLICT. Simpler,
//     avoids the SQLite version-dependent ON CONFLICT syntax variants, and
//     the semantics are identical here since the PK fully identifies the row.
//
//   \u2022 Rank writes are wrapped in a single transaction. Discovery typically
//     writes 100\u2013250 rows per (platform, sort_key); a transaction turns\n//     that into a single fsync instead of 250 and makes the write atomic
//     (partial writes on a crash never leave a half-updated top-N).\n//
//   \u2022 Churn compares TOP-50 sets on (platform, sort_key). If either day is
//     missing (first-ever run, cron miss, storefront outage), returns null
//     rather than a misleading 100%. Callers should log/skip nulls.

import { rawSqlite } from "../../storage";

export type SortKey =
  | "psn_api_sales30"
  | "psn_web_bestsellers"
  | "xbox_api_top_paid"
  | "xboxcom_web_top_paid";

export interface RankEntry {
  titleId: number;
  rank: number;
}

/**
 * Write a full ranked list for one (platform, sort_key) to the snapshot
 * table for today's UTC date. Idempotent: re-running on the same day
 * updates ranks in place rather than duplicating rows.
 *
 * Callers should pass the FULL list they discovered (typically 100\u2013250
 * entries). Passing an empty list is treated as \u201cnothing to snapshot\u201d and
 * skips the transaction entirely \u2014 we do NOT wipe prior-day rows on empty,
 * because an upstream storefront outage should not look like a churn event.
 */
export function writeRankSnapshot(
  platform: "ps5" | "xbox",
  sortKey: SortKey,
  entries: RankEntry[],
): { rowsWritten: number; snapshotDate: string } {
  if (entries.length === 0) return { rowsWritten: 0, snapshotDate: todayIsoUtc() };
  const snapshotDate = todayIsoUtc();
  const snapshotAt = new Date().toISOString();

  const insert = rawSqlite.prepare(`
    INSERT OR REPLACE INTO console_storefront_rank_daily
      (platform, sort_key, snapshot_date, title_id, rank, snapshot_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const tx = rawSqlite.transaction((rows: RankEntry[]) => {
    for (const r of rows) {
      insert.run(platform, sortKey, snapshotDate, r.titleId, r.rank, snapshotAt);
    }
  });
  tx(entries);
  return { rowsWritten: entries.length, snapshotDate };
}

/**
 * Compute % of today's top-50 that is NEW vs. yesterday's top-50 on the
 * same (platform, sort_key). "% churn" answers the operator question
 * "what fraction of today's top-50 wasn't in yesterday's top-50?" — and
 * by symmetry, when both sets are the same size, that's also the fraction
 * of yesterday's top-50 that exited.
 *
 *   entered
 *   ---------  \u00d7 100     (bounded 0..100)
 *   |today|
 *
 * Where `entered = |today \ yesterday|`. We also return `exitedCount`
 * (`|yesterday \ today|`) so an operator can spot asymmetric partial days
 * (e.g. yesterday's storefront returned only 30 rows while today has 50).
 *
 * Returns null when either day is missing (no baseline yet) or when both
 * days have fewer than 10 rows (not enough signal). Callers should log the
 * null case and skip.
 */
export function computeTop50Churn(
  platform: "ps5" | "xbox",
  sortKey: SortKey,
  todayDate?: string,
): { churnPct: number | null; enteredCount: number; exitedCount: number; todayN: number; yesterdayN: number } {
  const today = todayDate ?? todayIsoUtc();
  const yesterday = daysAgoUtc(1, today);

  const pull = rawSqlite.prepare(`
    SELECT title_id
      FROM console_storefront_rank_daily
     WHERE platform = ? AND sort_key = ? AND snapshot_date = ? AND rank <= 50
     ORDER BY rank
  `);

  const todaySet = new Set<number>(
    (pull.all(platform, sortKey, today) as Array<{ title_id: number }>).map((r) => r.title_id),
  );
  const yesterdaySet = new Set<number>(
    (pull.all(platform, sortKey, yesterday) as Array<{ title_id: number }>).map((r) => r.title_id),
  );

  if (todaySet.size < 10 || yesterdaySet.size < 10) {
    return { churnPct: null, enteredCount: 0, exitedCount: 0, todayN: todaySet.size, yesterdayN: yesterdaySet.size };
  }

  let entered = 0;
  todaySet.forEach((t) => { if (!yesterdaySet.has(t)) entered++; });
  let exited = 0;
  yesterdaySet.forEach((t) => { if (!todaySet.has(t)) exited++; });

  // Fraction of today's top-N that is new. Bounded to [0, 100]. Uses today's
  // set size as denominator so a partial yesterday (e.g. 30-row shelf) can't
  // inflate the metric past 100%.
  const churnPct = (entered / todaySet.size) * 100;
  return { churnPct, enteredCount: entered, exitedCount: exited, todayN: todaySet.size, yesterdayN: yesterdaySet.size };
}

/**
 * Rank velocity for a single (platform, title_id): today's best rank
 * across all sort_keys minus yesterday's best rank across the same set.
 * A positive delta means the title CLIMBED (rank number got smaller).
 *
 * "Best rank across sort keys" is used so a title that dropped off one
 * source but stayed on another isn't wrongly flagged as a mover. Returns
 * null when either day lacks any rank for this title.
 */
export function getRankVelocity(
  platform: "ps5" | "xbox",
  titleId: number,
  todayDate?: string,
): { velocity: number | null; todayBestRank: number | null; yesterdayBestRank: number | null } {
  const today = todayDate ?? todayIsoUtc();
  const yesterday = daysAgoUtc(1, today);
  const best = rawSqlite.prepare(`
    SELECT MIN(rank) AS r
      FROM console_storefront_rank_daily
     WHERE platform = ? AND title_id = ? AND snapshot_date = ?
  `);
  const t = (best.get(platform, titleId, today) as { r: number | null } | undefined)?.r ?? null;
  const y = (best.get(platform, titleId, yesterday) as { r: number | null } | undefined)?.r ?? null;
  if (t == null || y == null) return { velocity: null, todayBestRank: t, yesterdayBestRank: y };
  // Positive velocity == climbed (rank number decreased).
  return { velocity: y - t, todayBestRank: t, yesterdayBestRank: y };
}

// UTC helpers kept local so this module doesn't depend on discovery internals.
function todayIsoUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoUtc(n: number, from?: string): string {
  const d = from ? new Date(from + "T00:00:00Z") : new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
