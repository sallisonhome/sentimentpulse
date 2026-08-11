// ─── Steamworks Portal HTML fetcher + parser (v3.1, 2026-08-11) ─────────
//
// Used for products where the CSV export path is empty because the sales
// data lives in a different publisher account (e.g. Space Marine 2 is
// published by Focus Entertainment; Mad Dog Games' CSV export returns 0
// rows for it, but the dashboard page renders the numbers because view
// permissions are per-user, not per-publisher).
//
// Approach:
//   1. User stores their logged-in Steamworks session cookie in
//      steamworks_sessions.cookie_value.
//   2. This module fetches a Steamworks app-details page with that cookie
//      + configurable date range params.
//   3. Parses the rendered HTML for the "Steam units" / "Steam revenue" /
//      "Steam DLC units" / per-SKU today rows.
//   4. Returns aggregated per-(date, sku_group) rows compatible with
//      InsertSteamSalesDaily so ingestion.ts can upsert into the same
//      table as CSV uploads.
//
// URL pattern (from user, 2026-08-11):
//   https://partner.steampowered.com/app/details/{appid}/
//     ?dateStart=YYYY-MM-DD&dateEnd=YYYY-MM-DD
//     &priorDateStart=YYYY-MM-DD&priorDateEnd=YYYY-MM-DD
//     &alignPriorAnnual=Immediate&submit=Update

import type { InsertSteamSalesDaily } from "@shared/schema";

export interface PortalFetchOptions {
  appId: number;
  dateStart: string; // YYYY-MM-DD
  dateEnd: string;   // YYYY-MM-DD
  cookieHeader: string; // raw Cookie: header value
}

export interface PortalFetchResult {
  ok: boolean;
  httpStatus?: number;
  htmlBytes?: number;
  error?: string;
  parsed?: ParsedPortalPage;
}

export interface ParsedPortalPage {
  appId: number;
  appName: string | null;
  // Lifetime totals from the top box
  lifetimeSteamRevenueGrossUsd: number | null;
  lifetimeSteamRevenueNetUsd: number | null;
  lifetimeSteamUnits: number | null;
  lifetimeRetailUnits: number | null;
  lifetimeTotalUnits: number | null;
  lifetimeUnitsReturned: number | null;
  lifetimeTotalDlcUnits: number | null;
  currentPlayers: number | null;
  dailyActiveUsers7dAvg: number | null;
  lifetimeUniqueUsers: number | null;
  wishlists: number | null;
  // Per-period totals from the middle box (matches URL's dateStart/dateEnd)
  periodLabel: string | null; // e.g. "Today", "1 month", or a custom range
  periodSteamUnits: number | null;
  periodSteamRevenueUsd: number | null;
  periodRetailActivations: number | null;
  periodDlcUnits: number | null;
  periodDlcRevenueUsd: number | null;
  // Per-SKU breakdown from the same box
  perSkuRows: PerSkuRow[];
  // Raw HTML head for debugging (first 1KB)
  rawExcerpt?: string;
}

export interface PerSkuRow {
  productName: string;
  category: "steam_units" | "retail_activations" | "steam_dlc_units" | "steam_soundtrack" | "steam_revenue" | "steam_dlc_revenue";
  value: number; // units or dollars depending on category
}

/**
 * Build the Steamworks app-details URL with a specific date range.
 * The `submit=Update` param is required to make the server re-render
 * the page with the URL-supplied range instead of falling back to "today".
 */
export function buildPortalUrl(appId: number, dateStart: string, dateEnd: string): string {
  // Prior comparison window: default to (dateEnd - 1 day) as a single-day
  // comparison. Steamworks will render a delta% column against this.
  const priorDate = shiftDate(dateStart, -1);
  const params = new URLSearchParams({
    dateStart,
    dateEnd,
    priorDateStart: priorDate,
    priorDateEnd: priorDate,
    alignPriorAnnual: "Immediate",
    submit: "Update",
  });
  return `https://partner.steampowered.com/app/details/${appId}/?${params.toString()}`;
}

function shiftDate(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Fetch the Steamworks app-details page with the given cookie + date range.
 * Returns raw HTML (via .text()) on success, or an error struct on failure.
 * The parser is a separate call so we can retry / cache without re-fetching.
 */
export async function fetchPortalPage(opts: PortalFetchOptions): Promise<PortalFetchResult> {
  const url = buildPortalUrl(opts.appId, opts.dateStart, opts.dateEnd);
  try {
    const resp = await fetch(url, {
      headers: {
        Cookie: opts.cookieHeader,
        "User-Agent": "SignalPulse/1.0 (portal-fetcher; +https://saber.games)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "manual", // Steamworks redirects to login when session expires
    });
    if (resp.status === 302 || resp.status === 301) {
      // Redirect indicates expired session.
      const loc = resp.headers.get("location") || "";
      return {
        ok: false,
        httpStatus: resp.status,
        error: `Session expired (redirected to ${loc.slice(0, 100)})`,
      };
    }
    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => "");
      return {
        ok: false,
        httpStatus: resp.status,
        error: `HTTP ${resp.status}: ${bodyText.slice(0, 300)}`,
      };
    }
    const html = await resp.text();
    const parsed = parsePortalHtml(html, opts.appId);
    return {
      ok: true,
      httpStatus: resp.status,
      htmlBytes: html.length,
      parsed,
    };
  } catch (err: any) {
    return { ok: false, error: `fetch error: ${err.message}` };
  }
}

/**
 * Parse a Steamworks app-details HTML page into structured numbers.
 *
 * The page has three main data areas:
 *   1. Top "lifetime" box: revenue gross/net, lifetime units, DLC units,
 *      players, DAU, unique users, wishlists.
 *   2. Middle "period" box: date-range selector row + per-SKU units.
 *   3. Country heatmap + timeline chart (skipped for now).
 *
 * Rather than depend on a DOM parser (cheerio would work but adds a dep),
 * this uses regexes tuned to the specific HTML shapes Valve renders.
 * If Valve changes the markup, the parser needs regex updates \u2014 but
 * we return partial results so we can see which rows still parse.
 */
export function parsePortalHtml(html: string, appId: number): ParsedPortalPage {
  const result: ParsedPortalPage = {
    appId,
    appName: null,
    lifetimeSteamRevenueGrossUsd: null,
    lifetimeSteamRevenueNetUsd: null,
    lifetimeSteamUnits: null,
    lifetimeRetailUnits: null,
    lifetimeTotalUnits: null,
    lifetimeUnitsReturned: null,
    lifetimeTotalDlcUnits: null,
    currentPlayers: null,
    dailyActiveUsers7dAvg: null,
    lifetimeUniqueUsers: null,
    wishlists: null,
    periodLabel: null,
    periodSteamUnits: null,
    periodSteamRevenueUsd: null,
    periodRetailActivations: null,
    periodDlcUnits: null,
    periodDlcRevenueUsd: null,
    perSkuRows: [],
    rawExcerpt: html.slice(0, 1000),
  };

  // App name: <h1>Game: {name} ({appid})</h1>
  const nameMatch = html.match(/<h1[^>]*>\s*Game:\s*([^(]+)\s*\(\d+\)\s*<\/h1>/i);
  if (nameMatch) result.appName = nameMatch[1].trim();

  // Lifetime label \u2192 value pairs. Steamworks renders these as a table with
  // <td>Lifetime Steam revenue (gross)</td> ... <td>$273,162,107</td> ...
  // Regex to pull the numeric text following a labeled row.
  const findValueAfterLabel = (label: RegExp): string | null => {
    // The value cell may contain HTML tags (links, spans, etc.) so we
    // look for the label, then the next chunk of text that looks like a
    // number (possibly with $, %, commas, or +/- sign).
    const rx = new RegExp(`${label.source}[\\s\\S]*?([$-]?[\\d,]+(?:\\.\\d+)?%?)`, "i");
    const m = html.match(rx);
    return m ? m[1] : null;
  };

  const parseNum = (s: string | null): number | null => {
    if (!s) return null;
    const clean = s.replace(/[$,%]/g, "").trim();
    const n = parseFloat(clean);
    return Number.isFinite(n) ? n : null;
  };

  result.lifetimeSteamRevenueGrossUsd = parseNum(findValueAfterLabel(/Lifetime\s+Steam\s+revenue\s*\(gross\)/i));
  result.lifetimeSteamRevenueNetUsd = parseNum(findValueAfterLabel(/Lifetime\s+Steam\s+revenue\s*\(net\)/i));
  result.lifetimeSteamUnits = parseNum(findValueAfterLabel(/Lifetime\s+Steam\s+units/i));
  result.lifetimeRetailUnits = parseNum(findValueAfterLabel(/Lifetime\s+retail\s+units/i));
  result.lifetimeTotalUnits = parseNum(findValueAfterLabel(/Lifetime\s+total\s+units/i));
  result.lifetimeUnitsReturned = parseNum(findValueAfterLabel(/Lifetime\s+units\s+returned/i));
  result.lifetimeTotalDlcUnits = parseNum(findValueAfterLabel(/Lifetime\s+total\s+DLC\s+units/i));
  result.currentPlayers = parseNum(findValueAfterLabel(/Current\s+players/i));
  result.dailyActiveUsers7dAvg = parseNum(findValueAfterLabel(/Daily\s+active\s+users/i));
  result.lifetimeUniqueUsers = parseNum(findValueAfterLabel(/Lifetime\s+unique\s+users/i));
  result.wishlists = parseNum(findValueAfterLabel(/Wishlists/i));

  // Period section (matches the "Today" / custom-range table lower on the page).
  // Structure per screenshot:
  //   <div>Warhammer 40,000: Space Marine 2 units sold, today ( view as .csv )</div>
  //   <table>
  //     <tr><th>Steam units</th><th>211</th></tr>
  //     <tr><td>- Warhammer 40,000: Space Marine 2 - Standard Edition</td><td>183</td></tr>
  //     ...
  //     <tr><th>Retail activations</th><th>804</th></tr>
  //     ...
  //     <tr><th>Steam DLC units</th><th>1,412</th></tr>
  //     ...
  //     <tr><th>Steam revenue</th><th>$12,553</th></tr>
  //     ...
  //     <tr><th>Steam DLC revenue</th><th>$12,259</th></tr>
  //
  // Regex-based totals: match the section headers to their numeric neighbor.
  result.periodSteamUnits = parseNum(findValueAfterLabel(/(?:^|>)\s*Steam\s+units\s*(?:<|$)/im));
  result.periodRetailActivations = parseNum(findValueAfterLabel(/(?:^|>)\s*Retail\s+activations\s*(?:<|$)/im));
  result.periodDlcUnits = parseNum(findValueAfterLabel(/(?:^|>)\s*Steam\s+DLC\s+units\s*(?:<|$)/im));
  result.periodSteamRevenueUsd = parseNum(findValueAfterLabel(/(?:^|>)\s*Steam\s+revenue\s*(?:<|$)/im));
  result.periodDlcRevenueUsd = parseNum(findValueAfterLabel(/(?:^|>)\s*Steam\s+DLC\s+revenue\s*(?:<|$)/im));

  // Try to detect the period label (e.g. "today", "1 month", "5/1 - 8/11")
  const periodLabelMatch = html.match(/units\s+sold,\s*([^(<]+?)\s*(?:\(|<)/i);
  if (periodLabelMatch) result.periodLabel = periodLabelMatch[1].trim();

  return result;
}

/**
 * Convert a portal fetch result into steam_sales_daily insert rows.
 * Only the aggregated per-period totals are stored (not per-SKU rows,
 * which the CSV path handles better). One insert per skuGroup for the
 * date range end date (representing the period's contribution).
 *
 * NOTE: This is a simpler contract than the CSV path — the portal page
 * shows aggregate period totals, not per-day granularity. For daily
 * granularity we'd need to hit the portal N times with 1-day windows,
 * which is expensive. For now, one call = one snapshot for the period
 * with the row's date = dateEnd.
 */
export function portalToSalesRows(
  parsed: ParsedPortalPage,
  productId: number,
  reportDate: string,
  batchId: string,
): InsertSteamSalesDaily[] {
  const rows: InsertSteamSalesDaily[] = [];
  if (parsed.periodSteamUnits != null && parsed.periodSteamUnits > 0) {
    rows.push({
      productId,
      date: reportDate,
      skuGroup: "base",
      netUnits: parsed.periodSteamUnits,
      grossUnits: parsed.periodSteamUnits,
      returns: 0,
      netRevenueUsd: parsed.periodSteamRevenueUsd ?? 0,
      grossRevenueUsd: parsed.periodSteamRevenueUsd ?? 0,
      source: "portal_fetch",
      batchId,
    });
  }
  if (parsed.periodDlcUnits != null && parsed.periodDlcUnits > 0) {
    rows.push({
      productId,
      date: reportDate,
      skuGroup: "dlc",
      netUnits: parsed.periodDlcUnits,
      grossUnits: parsed.periodDlcUnits,
      returns: 0,
      netRevenueUsd: parsed.periodDlcRevenueUsd ?? 0,
      grossRevenueUsd: parsed.periodDlcRevenueUsd ?? 0,
      source: "portal_fetch",
      batchId,
    });
  }
  return rows;
}
