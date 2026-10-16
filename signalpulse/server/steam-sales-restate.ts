// Steam sales restatement (2026-10-16).
//
// The daily cron fetches GMT-yesterday from the Steamworks portal at 09:15
// UTC. Steamworks keeps adding late transactions to that day for hours
// afterwards, and the stored snapshot was never refreshed. On 2026-10-16 the
// Revenue Leaderboard's Oct 15 row was short for every high-volume title
// (Space Marine 2 -17 units / -$217, Hellraiser -9 / -$283, World War Z -6,
// SnowRunner -7, RoadCraft -2) while low-volume titles matched exactly. The
// 24h delta compares against a prior day that was frozen the same way.
//
// Fix: each run also re-fetches the previous `restateDays` day(s). Rows are
// keyed (product_id, date, sku_group) and the batch id is deterministic, so
// a re-fetch overwrites in place and never double-counts.

export const STEAM_SALES_RESTATE_SETTING = "steam_sales_restate_days";
export const DEFAULT_RESTATE_DAYS = 1;
export const MAX_RESTATE_DAYS = 7;

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Parse the operator setting; invalid or missing values use the default. */
export function parseRestateDays(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw.trim() === "") return DEFAULT_RESTATE_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_RESTATE_DAYS;
  return Math.min(n, MAX_RESTATE_DAYS);
}

/**
 * Dates to fetch for one run: the restated prior days (oldest first), then
 * the target day. `restateDays=0` returns just the target day.
 */
export function steamSalesFetchDates(targetDate: string, restateDays: number): Array<{
  date: string;
  restatement: boolean;
}> {
  const out: Array<{ date: string; restatement: boolean }> = [];
  for (let k = restateDays; k >= 1; k--) {
    out.push({ date: shiftDate(targetDate, -k), restatement: true });
  }
  out.push({ date: targetDate, restatement: false });
  return out;
}

export interface SalesTotals {
  baseUnits: number;
  baseRevenueUsd: number;
  dlcUnits: number;
  dlcRevenueUsd: number;
}

/** Totals for one product/day from stored or freshly parsed rows. */
export function salesTotalsForDate(
  rows: Array<{ date: string; skuGroup: string; netUnits: number | null; netRevenueUsd: number | null }>,
  date: string,
): SalesTotals {
  const t: SalesTotals = { baseUnits: 0, baseRevenueUsd: 0, dlcUnits: 0, dlcRevenueUsd: 0 };
  for (const r of rows) {
    if (r.date !== date) continue;
    if (r.skuGroup === "base") {
      t.baseUnits += r.netUnits ?? 0;
      t.baseRevenueUsd += r.netRevenueUsd ?? 0;
    } else if (r.skuGroup === "dlc") {
      t.dlcUnits += r.netUnits ?? 0;
      t.dlcRevenueUsd += r.netRevenueUsd ?? 0;
    }
  }
  return t;
}

/** Short human-readable change line, or null when nothing moved. */
export function describeRestatement(title: string, date: string, before: SalesTotals, after: SalesTotals): string | null {
  const du = after.baseUnits - before.baseUnits;
  const dr = Math.round((after.baseRevenueUsd - before.baseRevenueUsd) * 100) / 100;
  const ddu = after.dlcUnits - before.dlcUnits;
  const ddr = Math.round((after.dlcRevenueUsd - before.dlcRevenueUsd) * 100) / 100;
  if (du === 0 && dr === 0 && ddu === 0 && ddr === 0) return null;
  const sign = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  return `${title} ${date}: base ${sign(du)} units / ${sign(dr)} USD, dlc ${sign(ddu)} units / ${sign(ddr)} USD`;
}
