import type Database from "better-sqlite3";
import { consoleDayActualFor, CONSOLE_DAY_UNIT_ACTUALS, relevelConsoleLtd } from "./console-day-unit-actuals";

// Hellraiser: Revival daily revenue (released 2026-10-08). Steam is Steamworks ACTUAL revenue: D1 is the whole
// pre-purchase period plus release-day sales, then actual daily revenue. PS5 and Xbox start at their first chart-based
// lifetime estimate; the units up to that day are placed on release day..first-estimate day by Steam's own actual daily
// shape, and later gaps in the estimate history are split by the same shape. A recorded operator day-one
// actual anchors its platform's launch day: that day's units are the actual (revenue applies the reported
// SKU mix at list price through the same ASP factor — modeled, not actual), later days stay chart-based
// increments, and LTD plus every window still containing the anchor day carry the same anchored
// contribution (estimate-console-units §8c writes the same values). Read-side only: nothing is
// written, no day before D1 is filled, and a day without evidence stays null.
export const HELLRAISER_DAILY_VERSION = "hellraiser_steam_actuals_v2";
export const HELLRAISER_SCOPE = {
  key: "clive barker's hellraiser: revival", release: "2026-10-08", steamAppId: "1551980",
  // steam, ps5 base, ps5 deluxe edition, xbox (base and Deluxe share one title id)
  titles: [{ platform: "steam", id: 10664 }, { platform: "ps5", id: 11296 }, { platform: "ps5", id: 10990 }, { platform: "xbox", id: 11355 }],
} as const;
const DAY = 86400000;
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);

export type SteamDay = { date: string; units: number; revenue: number };
export type Ltd = { date: string; units: number | null; method?: string | null };

/** Steam series: pre-release rows roll into D1; days after the latest actual are unavailable (null). */
export function steamDailyActual(rows: SteamDay[], release: string): { days: Map<string, { revenue: number; units: number; partial?: boolean }>; latest: string | null } {
  const days = new Map<string, { revenue: number; units: number; partial?: boolean }>();
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const pre = sorted.filter(r => r.date < release);
  const latest = sorted.length ? sorted[sorted.length - 1].date : null;
  if (!latest || !pre.length) return { days, latest };
  let revenue = pre.reduce((s, r) => s + r.revenue, 0), units = pre.reduce((s, r) => s + r.units, 0);
  const d1 = sorted.find(r => r.date === release);
  if (d1) { revenue += d1.revenue; units += d1.units; }
  days.set(release, { revenue, units, ...(d1 ? {} : { partial: true }) });
  for (const r of sorted) if (r.date > release) days.set(r.date, { revenue: r.revenue, units: r.units });
  return { days, latest };
}

/**
 * One console listing: lifetime units to daily units. The first positive estimate carries everything up to its date;
 * it is split over release..that date by `weights` (Steam actual daily revenue). Gaps later split the same way.
 * Returns date -> units; a decrease or missing weights leaves the day null instead of inventing a value.
 */
export function consoleDailyUnits(ltd: Ltd[], weights: Map<string, number>, release: string): Map<string, number | null> {
  const out = new Map<string, number | null>();
  const rows = ltd.filter(r => r.units != null && r.date >= release).sort((a, b) => a.date.localeCompare(b.date)) as Array<{ date: string; units: number }>;
  const firstIdx = rows.findIndex(r => r.units > 0);
  if (firstIdx < 0) return out;
  const split = (from: string, to: string, units: number) => {
    const span: string[] = []; for (let d = from; d <= to; d = addDays(d, 1)) span.push(d);
    const w = span.map(d => weights.get(d));
    if (span.length === 1 || !w.every(x => typeof x === "number" && x! > 0)) { out.set(to, units); return; }
    const sum = (w as number[]).reduce((s, x) => s + x, 0);
    span.forEach((d, i) => out.set(d, units * (w[i] as number) / sum));
  };
  split(release, rows[firstIdx].date, rows[firstIdx].units);
  for (let i = firstIdx + 1; i < rows.length; i++) {
    const delta = rows[i].units - rows[i - 1].units;
    if (!(delta >= 0)) { out.set(rows[i].date, null); continue; }
    split(addDays(rows[i - 1].date, 1), rows[i].date, delta);
  }
  return out;
}

export function buildHellraiserDaily(db: Database.Database, from: string, to: string, econ: { steamAsp: number; ps5Asp: number; xboxAsp: number }) {
  const S = HELLRAISER_SCOPE;
  const prod = db.prepare("SELECT id FROM products WHERE steam_app_id=?").get(S.steamAppId) as { id: number } | undefined;
  if (!prod) return null;
  const steamRows = (db.prepare(`SELECT date, net_units AS units, net_revenue_usd AS revenue FROM steam_sales_daily
    WHERE product_id=? AND sku_group='base' ORDER BY date`).all(prod.id) as SteamDay[]);
  const steam = steamDailyActual(steamRows, S.release);
  if (!steam.days.size) return null;
  const weights = new Map(Array.from(steam.days, ([d, v]) => [d, v.revenue] as [string, number]));
  const rev: Record<"ps5" | "xbox", Map<string, number | null>> = { ps5: new Map(), xbox: new Map() };
  const asp = { ps5: econ.ps5Asp, xbox: econ.xboxAsp };
  const units: Record<"ps5" | "xbox", Map<string, number | null>> = { ps5: new Map(), xbox: new Map() };
  for (const t of S.titles) {
    if (t.platform === "steam") continue;
    const p = t.platform as "ps5" | "xbox";
    const sku = db.prepare("SELECT msrp_usd_cents AS m FROM platform_sku_map WHERE title_id=? AND platform=? ORDER BY CASE sku_role WHEN 'base' THEN 0 ELSE 1 END LIMIT 1").get(t.id, p) as { m: number } | undefined;
    if (!sku || !(sku.m > 0)) continue;
    const actual = consoleDayActualFor(t.id, p);
    let ltd = db.prepare("SELECT as_of_date AS date, units_mid AS units, method FROM window_estimates_daily WHERE title_id=? AND platform=? AND window='ltd' ORDER BY as_of_date").all(t.id, p) as Ltd[];
    // A day-one actual relevels the native LTD series (tagged rows pass through,
    // so a partially backfilled history is never double-lifted).
    if (actual) ltd = relevelConsoleLtd(ltd, actual);
    // The anchor day's revenue uses the reported SKU mix: standard at this
    // title's base price, the family's edition at its price. Other days price
    // at the base SKU, exactly as before.
    let blendCents = sku.m;
    if (actual) {
      const sibIds = S.titles.filter(x => x.platform === p).map(x => x.id);
      const ed = db.prepare(`SELECT MIN(msrp_usd_cents) AS m FROM platform_sku_map WHERE platform=? AND sku_role='edition' AND title_id IN (${sibIds.map(() => "?").join(",")}) AND msrp_usd_cents IS NOT NULL`).get(p, ...sibIds) as { m: number | null } | undefined;
      if (ed && ed.m != null && ed.m > 0) blendCents = Math.round(actual.standardShare * sku.m + actual.deluxeShare * ed.m);
    }
    for (const [d, u] of Array.from(consoleDailyUnits(ltd, weights, S.release))) {
      if (u == null) { if (!rev[p].has(d)) rev[p].set(d, null); continue; }
      const price = actual && d === actual.date ? blendCents : sku.m;
      rev[p].set(d, (rev[p].get(d) ?? 0) + (u * price * asp[p]) / 100);
      units[p].set(d, (units[p].get(d) ?? 0) + u);
    }
    // The day-one actual is served even when the estimator has no LTD rows
    // for this platform yet — missing evidence is not zero sales.
    if (actual && units[p].get(actual.date) == null) {
      units[p].set(actual.date, actual.units);
      rev[p].set(actual.date, (rev[p].get(actual.date) ?? 0) + (actual.units * blendCents * asp[p]) / 100);
    }
  }
  const anchorBasis = (p: "ps5" | "xbox", d: string): string | null => {
    for (const t of S.titles) {
      if (t.platform !== p) continue;
      const a = consoleDayActualFor(t.id, p);
      if (a && d === a.date) return "operator_actual_anchor";
    }
    return null;
  };
  const points: any[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const st = steam.days.get(d);
    const steamV = st ? st.revenue : null;
    const ps5 = rev.ps5.get(d) ?? null, xbox = rev.xbox.get(d) ?? null;
    const vals = [steamV, ps5, xbox].filter((v): v is number => typeof v === "number");
    points.push({
      date: d, steam: steamV, ps5, xbox, combined: vals.length ? vals.reduce((s, v) => s + v, 0) : null,
      source: HELLRAISER_DAILY_VERSION,
      ...(d === S.release ? { d1: true, ...(st?.partial ? { d1Status: "prepurchase_only_release_day_actuals_pending" } : {}) } : {}),
      basis: {
        steam: st ? "steamworks_actual" : "unavailable",
        ps5: anchorBasis("ps5", d) ?? (rev.ps5.has(d) ? "chart_estimate_steam_shaped" : "unavailable"),
        xbox: anchorBasis("xbox", d) ?? (rev.xbox.has(d) ? "chart_estimate_steam_shaped" : "unavailable"),
      },
    });
  }
  const dayOneActuals = CONSOLE_DAY_UNIT_ACTUALS.filter(a => S.titles.some(t => t.id === a.titleId && t.platform === a.platform));
  return {
    from, to, collectionStart: S.release, asOfDate: steam.latest, version: HELLRAISER_DAILY_VERSION, points,
    ...(dayOneActuals.length ? { dayOneActuals } : {}),
    methodology: "Steam is Steamworks actual base-game net revenue: release day (D1) is every pre-release day plus release-day sales, then actual daily revenue; days after the latest Steamworks day are unavailable. PS5 and Xbox start at their first chart-based lifetime estimate; units up to that day are placed on release day onward by Steam's actual daily shape, later gaps are split by the same shape, and a day without evidence stays blank. A recorded operator day-one actual anchors its platform's launch day: that day's units are the actual (revenue applies the reported SKU mix at list price through the same ASP factor — modeled, not actual), later days remain chart-based increments, and LTD plus every window still containing the anchor day carry the same anchored contribution.",
  };
}
