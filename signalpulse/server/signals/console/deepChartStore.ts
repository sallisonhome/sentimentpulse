// Storage for the deep daily chart (see deepChart.ts). Imports only the database, so the route layer can read it
// without pulling in discovery.
import { rawSqlite } from "../../storage";
import type { RankedDeepItem } from "./deepChartCore";

export type DeepPlatform = "ps5" | "xbox";
export const DEEP_SORT_KEY: Record<DeepPlatform, string> = { ps5: "psn_api_sales30", xbox: "xbox_api_top_paid" };
export const DEEP_MIN_ROWS_TO_STORE = 20;

export function writeDeepChart(platform: DeepPlatform, items: RankedDeepItem[], date?: string): { rowsWritten: number; snapshotDate: string; skipped: string | null } {
  const snapshotDate = date ?? new Date().toISOString().slice(0, 10);
  if (items.length < DEEP_MIN_ROWS_TO_STORE) return { rowsWritten: 0, snapshotDate, skipped: `too_few_rows(${items.length})` };
  const sortKey = DEEP_SORT_KEY[platform]; const at = new Date().toISOString();
  const del = rawSqlite.prepare(`DELETE FROM console_chart_rank_deep_daily WHERE platform = ? AND sort_key = ? AND snapshot_date = ?`);
  const ins = rawSqlite.prepare(`INSERT INTO console_chart_rank_deep_daily (platform, sort_key, snapshot_date, raw_position, paid_rank, external_sku, name, business_model, msrp_usd_cents, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  rawSqlite.transaction((rows: RankedDeepItem[]) => {
    del.run(platform, sortKey, snapshotDate);
    for (const r of rows) ins.run(platform, sortKey, snapshotDate, r.rawPosition, r.paidRank, r.externalSku, r.name, r.businessModel, r.msrpUsdCents, at);
  })(items);
  return { rowsWritten: items.length, snapshotDate, skipped: null };
}

/** title_id -> best (lowest) paid_rank on the newest deep snapshot, joined through platform_sku_map. */
export function readDeepRankByTitle(platform: DeepPlatform): { ranks: Map<number, number>; snapshotDate: string | null; paidRows: number } {
  const sortKey = DEEP_SORT_KEY[platform];
  const date = (rawSqlite.prepare(`SELECT MAX(snapshot_date) AS d FROM console_chart_rank_deep_daily WHERE platform = ? AND sort_key = ?`).get(platform, sortKey) as any)?.d ?? null;
  if (!date) return { ranks: new Map(), snapshotDate: null, paidRows: 0 };
  const rows = rawSqlite.prepare(
    `SELECT m.title_id AS title_id, MIN(d.paid_rank) AS paid_rank
       FROM console_chart_rank_deep_daily d
       JOIN platform_sku_map m ON m.platform = d.platform AND m.external_sku = d.external_sku
      WHERE d.platform = ? AND d.sort_key = ? AND d.snapshot_date = ? AND d.paid_rank IS NOT NULL
      GROUP BY m.title_id`,
  ).all(platform, sortKey, date) as Array<{ title_id: number; paid_rank: number }>;
  const paidRows = (rawSqlite.prepare(`SELECT COUNT(*) AS n FROM console_chart_rank_deep_daily WHERE platform = ? AND sort_key = ? AND snapshot_date = ? AND paid_rank IS NOT NULL`).get(platform, sortKey, date) as any).n as number;
  return { ranks: new Map(rows.map(r => [r.title_id, r.paid_rank])), snapshotDate: date, paidRows };
}

