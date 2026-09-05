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

import type { InsertSteamSalesDaily, InsertSteamSalesByCountry } from "@shared/schema";

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
  // Per-country breakdown from the four `salesregion_panelN` /
  // `activationsregion_panelN` tables. Aggregated across all countries for
  // the URL's date range. `units` + `revenueUsd` come from the Sales
  // panels (panel1 = units, panel3 = revenue), `activations` +
  // `activationRevenueUsd` from the Activations panels (panel1 = units,
  // panel3 = revenue). Countries are joined on ISO code.
  //
  // Added v3.30 (2026-09-05) to power the Sales-by-Country pages on
  // SignalPulse + Promo Calendar. See shared/schema.ts
  // `steam_sales_by_country_period` for storage.
  countryBreakdown: CountryBreakdownRow[];
  // Raw HTML head for debugging (first 1KB)
  rawExcerpt?: string;
}

export interface CountryBreakdownRow {
  /** ISO 3166-1 alpha-2 country code as reported by Steamworks. */
  countryIso: string;
  countryName: string;
  units: number;
  revenueUsd: number;
  activations: number;
  activationRevenueUsd: number;
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
    countryBreakdown: [],
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

  // Per-country breakdown. Verified against a real SM2 portal fetch on
  // 2026-09-05 (see one-shot probe removed after inspection).
  //
  // The country data lives in FOUR sibling <table> elements inside
  // <div class="salesregion_panelN"> and <div class="activationsregion_panelN">
  // wrappers:
  //   - salesregion_panel1        → Country / Units / Percent of Units
  //   - salesregion_panel3        → Country / Revenue / Percent of Revenue
  //   - activationsregion_panel1  → Country / Activations / % of Activations
  //   - activationsregion_panel3  → Country / Activation Revenue / %
  //
  // Each row is a <tr> with a leading <td> containing an anchor of the
  // shape <a href="...country.php?countryCode=XX...">Country Name</a>
  // followed by two data <td> cells (value, then percent). Panels also
  // contain "breakdownParent" rows for the region-level totals (Africa,
  // Central Asia, etc.) which we skip; only rows with a countryCode= URL
  // param count.
  result.countryBreakdown = extractCountryBreakdown(html);

  return result;
}

/**
 * Extract the merged per-country breakdown from a Steamworks app-details
 * HTML page. Reads the four `salesregion_panel*` / `activationsregion_panel*`
 * tables, keys rows by ISO code, and returns one row per country with
 * {units, revenueUsd, activations, activationRevenueUsd} — zero for any
 * panel where that country didn't appear.
 *
 * Robustness:
 *   - Rows without a `countryCode=` parameter (region roll-ups like Africa,
 *     Central Asia) are skipped by design; they'd double-count the country
 *     rows they contain.
 *   - HTML entities in the country name (&amp;, &#39;) are decoded.
 *   - Numeric cells with commas, currency prefixes, or percent suffixes are
 *     stripped down to a plain float; unparseable cells default to 0.
 *   - If a panel is missing entirely, its metric stays 0 across all
 *     countries — downstream callers can still trust the ISO set is complete.
 */
export function extractCountryBreakdown(html: string): CountryBreakdownRow[] {
  type Rows = Map<string, CountryBreakdownRow>;
  const rows: Rows = new Map();

  const upsert = (iso: string, name: string, patch: Partial<CountryBreakdownRow>) => {
    const key = iso.toUpperCase();
    if (!rows.has(key)) {
      rows.set(key, {
        countryIso: key,
        countryName: name,
        units: 0,
        revenueUsd: 0,
        activations: 0,
        activationRevenueUsd: 0,
      });
    }
    const row = rows.get(key)!;
    // Prefer a filled name over an empty one; don't overwrite with '' if
    // the country later appears in a panel without a rendered name.
    if (patch.countryName && (!row.countryName || row.countryName.length < patch.countryName.length)) {
      row.countryName = patch.countryName;
    }
    if (patch.units != null) row.units = patch.units;
    if (patch.revenueUsd != null) row.revenueUsd = patch.revenueUsd;
    if (patch.activations != null) row.activations = patch.activations;
    if (patch.activationRevenueUsd != null) row.activationRevenueUsd = patch.activationRevenueUsd;
  };

  const panels: Array<{
    className: string;
    metric: "units" | "revenueUsd" | "activations" | "activationRevenueUsd";
  }> = [
    { className: "salesregion_panel1", metric: "units" },
    { className: "salesregion_panel3", metric: "revenueUsd" },
    { className: "activationsregion_panel1", metric: "activations" },
    { className: "activationsregion_panel3", metric: "activationRevenueUsd" },
  ];

  for (const panel of panels) {
    const panelHtml = extractPanelHtml(html, panel.className);
    if (!panelHtml) continue;
    for (const row of extractCountryRowsFromPanel(panelHtml)) {
      upsert(row.iso, row.name, { [panel.metric]: row.value });
    }
  }

  // Sort by revenue DESC then units DESC so the UI has a natural default
  // ordering even without a table sort applied.
  return Array.from(rows.values()).sort((a, b) => {
    if (b.revenueUsd !== a.revenueUsd) return b.revenueUsd - a.revenueUsd;
    return b.units - a.units;
  });
}

/**
 * Slice the sub-HTML for a `salesregion_panelN` or `activationsregion_panelN`
 * <div> from a full page. Non-greedy grab up to the next
 * `<div class="...region_panel" or end-of-panels container; we deliberately
 * over-grab and rely on extractCountryRowsFromPanel's per-row regex to
 * filter noise, so the exact terminator doesn't matter.
 */
function extractPanelHtml(html: string, className: string): string | null {
  const openIdx = html.indexOf(`class="${className}"`);
  if (openIdx === -1) return null;
  // Grab a generous slice — the panels are ~20KB max in the SM2 sample.
  return html.slice(openIdx, openIdx + 60000);
}

/**
 * Pull one row per country from a panel HTML slice. Regex targets the
 * exact shape emitted by Steamworks:
 *   <td><a href="...country.php?countryCode=XX&...">Country Name</a></td>
 *   <td ...>value</td>
 *   <td ...>pct%</td>
 *
 * Region roll-up rows (Africa, Central Asia, ...) have no countryCode
 * query param, so they naturally fall out of the match set.
 */
function extractCountryRowsFromPanel(
  panelHtml: string,
): Array<{ iso: string; name: string; value: number }> {
  const results: Array<{ iso: string; name: string; value: number }> = [];
  const rx =
    /<td[^>]*>\s*<a[^>]*countryCode=([A-Z]{2})[^>]*>([^<]+)<\/a>\s*<\/td>\s*<td[^>]*>\s*([^<]+?)\s*<\/td>/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(panelHtml)) !== null) {
    const iso = m[1].toUpperCase();
    const name = decodeHtmlEntities(m[2].trim());
    const value = parseNumericCell(m[3]);
    results.push({ iso, name, value });
  }
  return results;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseNumericCell(raw: string): number {
  const clean = raw.replace(/[$,%\s]/g, "").trim();
  const n = parseFloat(clean);
  return Number.isFinite(n) ? n : 0;
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

/**
 * Convert the per-country breakdown from a parsed portal page into insert
 * rows for `steam_sales_by_country_period`. One row per country appearing
 * in ANY of the 4 country panels (sales-units, sales-revenue,
 * activations-units, activations-revenue). Countries whose row is all
 * zeros across every metric are dropped so the table doesn't accumulate
 * pointless noise.
 *
 * `granularity` tells downstream aggregation how to prefer overlapping
 * rows: 'day' > 'month' > 'custom'. Callers should pass:
 *   - 'day'    when the URL date range is exactly one day
 *   - 'month'  when the range covers a full calendar month
 *   - 'custom' for anything else (backfill runs, ad-hoc UI fetches)
 *
 * Added v3.30 (2026-09-05) alongside portalToSalesRows() so the same
 * fetchPortalPage() result populates both the daily sales table and the
 * new by-country table with zero extra HTTP fetches.
 */
export function portalToCountryRows(
  parsed: ParsedPortalPage,
  productId: number,
  periodStart: string,
  periodEnd: string,
  granularity: "day" | "month" | "custom",
): InsertSteamSalesByCountry[] {
  const rows: InsertSteamSalesByCountry[] = [];
  for (const c of parsed.countryBreakdown ?? []) {
    if (
      c.units === 0 &&
      c.revenueUsd === 0 &&
      c.activations === 0 &&
      c.activationRevenueUsd === 0
    ) {
      continue;
    }
    rows.push({
      productId,
      periodStart,
      periodEnd,
      granularity,
      countryIso: c.countryIso,
      countryName: c.countryName,
      units: c.units,
      revenueUsd: c.revenueUsd,
      activations: c.activations,
      activationRevenueUsd: c.activationRevenueUsd,
      source: "portal_fetch",
    });
  }
  return rows;
}
