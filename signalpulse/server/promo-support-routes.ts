// Cross-app support endpoint: revenue lookup for the Promo Calendar's
// "Promos Live Now" cards. Promo Calendar owns campaign start/end dates;
// SignalPulse owns Steam daily sales. When Promo Calendar renders a live
// Steam beat it calls this endpoint with the beat's steam_app_id + window
// dates and displays the sum inline on the card.
//
// Same posture as on-promo-routes.ts:
//   - read-only, unauthenticated (mirrors /api/leaderboards/*);
//   - always resolves to 200 with a valid shape (a failure MUST NOT break
//     the caller's page render — Promo Calendar treats missing revenue as
//     "not available yet");
//   - registered under /api/promo-support/* and exposed at
//     /signal/api/promo-support/* through nginx.

import type { Express, Request, Response } from "express";
import { storage } from "./storage";

// Shape validation: cheap runtime checks in place of a full Zod schema.
// The endpoint is called by a single trusted sibling service over
// loopback — we just need enough validation to reject a malformed
// payload with a clear 400 rather than crashing the DB writer.
function validateSyncEventsBody(
  body: unknown,
): { ok: true; steamAppId: string; events: Array<{ program: string; start_date: string; end_date: string }> } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  const rawAppId = b.steam_app_id;
  let steamAppId: string | null = null;
  if (typeof rawAppId === "number" && Number.isFinite(rawAppId)) {
    steamAppId = String(rawAppId);
  } else if (typeof rawAppId === "string" && /^\d+$/.test(rawAppId)) {
    steamAppId = rawAppId;
  }
  if (!steamAppId) {
    return { ok: false, error: "steam_app_id is required (numeric)" };
  }

  if (!Array.isArray(b.events)) {
    return { ok: false, error: "events must be an array" };
  }
  const events: Array<{ program: string; start_date: string; end_date: string }> = [];
  const eventsArr = b.events as unknown[];
  for (let i = 0; i < eventsArr.length; i++) {
    const raw = eventsArr[i];
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: `events[${i}] must be an object` };
    }
    const e = raw as Record<string, unknown>;
    if (typeof e.program !== "string" || e.program.length === 0) {
      return { ok: false, error: `events[${i}].program must be a non-empty string` };
    }
    if (typeof e.start_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(e.start_date)) {
      return { ok: false, error: `events[${i}].start_date must be YYYY-MM-DD` };
    }
    if (typeof e.end_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(e.end_date)) {
      return { ok: false, error: `events[${i}].end_date must be YYYY-MM-DD` };
    }
    events.push({ program: e.program, start_date: e.start_date, end_date: e.end_date });
  }
  return { ok: true, steamAppId, events };
}

function validateRevenueBatchBody(
  body: unknown,
):
  | { ok: true; items: Array<{ steamAppId: string; since?: string; until?: string }> }
  | { ok: false; error: string } {
  if (!Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON array of {steam_app_id, since?, until?}" };
  }
  if (body.length > 200) {
    return { ok: false, error: "batch too large: max 200 items per request" };
  }
  const items: Array<{ steamAppId: string; since?: string; until?: string }> = [];
  for (let i = 0; i < body.length; i++) {
    const raw = body[i];
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: `[${i}] must be an object` };
    }
    const r = raw as Record<string, unknown>;
    let steamAppId: string | null = null;
    if (typeof r.steam_app_id === "number" && Number.isFinite(r.steam_app_id)) {
      steamAppId = String(r.steam_app_id);
    } else if (typeof r.steam_app_id === "string" && /^\d+$/.test(r.steam_app_id)) {
      steamAppId = r.steam_app_id;
    }
    if (!steamAppId) {
      return { ok: false, error: `[${i}] steam_app_id is required (numeric)` };
    }
    const since = typeof r.since === "string" ? r.since : undefined;
    const until = typeof r.until === "string" ? r.until : undefined;
    if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      return { ok: false, error: `[${i}] since must be YYYY-MM-DD` };
    }
    if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      return { ok: false, error: `[${i}] until must be YYYY-MM-DD` };
    }
    items.push({ steamAppId, since, until });
  }
  return { ok: true, items };
}

export function registerPromoSupportRoutes(app: Express): void {
  // GET /api/promo-support/steam-revenue
  //   ?steam_app_id=2183900&since=2026-09-03&until=2026-09-04
  // → {
  //     steam_app_id: 2183900,
  //     product_id: 5 | null,
  //     since: "2026-09-03",
  //     until: "2026-09-04",
  //     net_revenue_usd: 12345.67,   // base+dlc net revenue in the window
  //     gross_revenue_usd: 13000.00, // base+dlc gross revenue in the window
  //     days_covered: 2,             // count of distinct days with sales rows
  //     found: true,                 // false when no matching product OR no rows
  //   }
  //
  // `since` / `until` are INCLUSIVE calendar-day strings in YYYY-MM-DD.
  // No `since`/`until` → returns lifetime for the AppID (rarely useful; here
  // for symmetry with getSteamSales).
  app.get("/api/promo-support/steam-revenue", (req, res) => {
    try {
      const appidRaw = req.query.steam_app_id;
      const since = typeof req.query.since === "string" ? req.query.since : undefined;
      const until = typeof req.query.until === "string" ? req.query.until : undefined;

      if (typeof appidRaw !== "string" || !/^\d+$/.test(appidRaw)) {
        return res.status(400).json({
          error: "steam_app_id query param required (numeric)",
        });
      }

      const appid = appidRaw;

      // Find the product row for this AppID. Product.steamAppId is text.
      const product = storage.getAllProducts().find((p) => p.steamAppId === appid);
      if (!product) {
        // No product for that AppID (mapping might be stale, or the title
        // isn't yet tracked in SignalPulse). Return a safe empty shape so
        // the caller can render "revenue: —" rather than error.
        return res.json({
          steam_app_id: Number(appid),
          product_id: null,
          since: since ?? null,
          until: until ?? null,
          net_revenue_usd: 0,
          gross_revenue_usd: 0,
          days_covered: 0,
          found: false,
        });
      }

      const rows = storage.getSteamSales(product.id, { since, until });

      // Sum base+dlc only (skip 'other'). Track distinct days.
      let net = 0;
      let gross = 0;
      const days = new Set<string>();
      for (const r of rows) {
        if (r.skuGroup !== "base" && r.skuGroup !== "dlc") continue;
        net += r.netRevenueUsd || 0;
        gross += r.grossRevenueUsd || 0;
        days.add(r.date);
      }

      res.json({
        steam_app_id: Number(appid),
        product_id: product.id,
        since: since ?? null,
        until: until ?? null,
        net_revenue_usd: Math.round(net * 100) / 100,
        gross_revenue_usd: Math.round(gross * 100) / 100,
        days_covered: days.size,
        found: days.size > 0,
      });
    } catch (err) {
      console.error("[promo-support] steam-revenue error", err);
      // Never 500 — return an empty shape so the caller can render a
      // graceful "revenue unavailable" fallback.
      res.json({
        steam_app_id: null,
        product_id: null,
        since: null,
        until: null,
        net_revenue_usd: 0,
        gross_revenue_usd: 0,
        days_covered: 0,
        found: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // POST /api/promo-support/steam-revenue-batch
  // Body: [ {steam_app_id, since?, until?}, ... ]  → max 200 items
  // Response: [ SteamRevenueForWindow, ... ]  (same order + shape as GET)
  //
  // Purpose: Promo Calendar's past-promos view on a per-title PDP can show
  // 20–80+ historical Steam campaigns; enriching them via the singular
  // GET would fan out to 80 requests per PDP load. This batches them into
  // one HTTP round-trip. Still read-only, still no PII, same cache layer.
  app.post("/api/promo-support/steam-revenue-batch", (req, res) => {
    try {
      const val = validateRevenueBatchBody(req.body);
      if (!val.ok) {
        return res.status(400).json({ error: val.error });
      }
      // Pre-index products by AppID once so a 200-item batch is O(products+items)
      // rather than O(products × items).
      const productsByAppId = new Map<string, number>();
      for (const p of storage.getAllProducts()) {
        if (p.steamAppId) productsByAppId.set(p.steamAppId, p.id);
      }
      const results = val.items.map(({ steamAppId, since, until }) => {
        const productId = productsByAppId.get(steamAppId);
        if (productId == null) {
          return {
            steam_app_id: Number(steamAppId),
            product_id: null,
            since: since ?? null,
            until: until ?? null,
            net_revenue_usd: 0,
            gross_revenue_usd: 0,
            days_covered: 0,
            found: false,
          };
        }
        const rows = storage.getSteamSales(productId, { since, until });
        let net = 0;
        let gross = 0;
        const days = new Set<string>();
        for (const r of rows) {
          if (r.skuGroup !== "base" && r.skuGroup !== "dlc") continue;
          net += r.netRevenueUsd || 0;
          gross += r.grossRevenueUsd || 0;
          days.add(r.date);
        }
        return {
          steam_app_id: Number(steamAppId),
          product_id: productId,
          since: since ?? null,
          until: until ?? null,
          net_revenue_usd: Math.round(net * 100) / 100,
          gross_revenue_usd: Math.round(gross * 100) / 100,
          days_covered: days.size,
          found: days.size > 0,
        };
      });
      res.json(results);
    } catch (err) {
      console.error("[promo-support] steam-revenue-batch error", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // POST /api/promo-support/sync-steam-pls-events
  // Body: {steam_app_id: number|string, events: [{program, start_date, end_date}, ...]}
  // Response: {
  //   steam_app_id, product_id, name_format,
  //   created, updated, soft_deleted, un_soft_deleted,
  //   skipped: "no_product" | null,
  // }
  //
  // Called by Promo Calendar at the end of every sheet upload to sync
  // Steam promo campaigns → PLS milestones (category='promotion'). Names
  // are deterministic (buildPromoName) so re-uploading the same sheet is a
  // no-op. Campaigns removed from the current sheet soft-delete their
  // PLS row; campaigns added back un-soft-delete.
  //
  // AUTH: ops-token-gated (see saber-auth.ts OPS_TOKEN_PATHS). Requires
  // x-ops-token header matching INGESTION_OPS_TOKEN.
  app.post("/api/promo-support/sync-steam-pls-events", (req: Request, res: Response) => {
    try {
      const val = validateSyncEventsBody(req.body);
      if (!val.ok) {
        return res.status(400).json({ error: val.error });
      }
      const { steamAppId, events } = val;

      const product = storage.getAllProducts().find((p) => p.steamAppId === steamAppId);
      if (!product) {
        // No SignalPulse product for that AppID yet (title not tracked).
        // Not an error — caller expects this class of "skipped" per its
        // sync-warning collection logic.
        return res.json({
          steam_app_id: Number(steamAppId),
          product_id: null,
          name_format: "{program} (Steam · {start}→{end})",
          created: 0,
          updated: 0,
          soft_deleted: 0,
          un_soft_deleted: 0,
          skipped: "no_product",
        });
      }

      const counts = storage.upsertPromoPlsMilestones(product.id, events);

      res.json({
        steam_app_id: Number(steamAppId),
        product_id: product.id,
        name_format: "{program} (Steam · {start}→{end})",
        created: counts.created,
        updated: counts.updated,
        soft_deleted: counts.softDeleted,
        un_soft_deleted: counts.unSoftDeleted,
        skipped: null,
      });
    } catch (err) {
      console.error("[promo-support] sync-steam-pls-events error", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // GET /api/promo-support/sales-by-country (v3.32, 2026-09-05)
  //   ?steam_app_id=2183900&since=2026-09-03&until=2026-09-04
  // → {
  //     steam_app_id, product_id, since, until,
  //     total_units, total_revenue_usd, asp_usd, countries_count,
  //     countries: [{country_iso, country_name, units, revenue_usd, asp_usd, pct_of_total}],
  //     shares_source: 'authoritative' | 'legacy',
  //     days_with_shares, days_in_window, days_authoritative_rev
  //   }
  //
  // v3.32 reconciliation model (see lessons.md v3.32):
  //   1. Enumerate every day D in [since, until].
  //   2. For each D, look up authoritative net revenue and units from
  //      steam_sales_daily (base+dlc SKUs).
  //   3. Pick the best country-shares row for that day:
  //        - granularity='day' with period_start=period_end=D  (best)
  //        - granularity='month' whose window contains D       (medium)
  //        - granularity='custom' whose window contains D      (fallback)
  //   4. Per-country revenue for D = day_total_rev * country.pct_of_revenue.
  //      Per-country units    for D = day_total_units * country.pct_of_units.
  //   5. Sum across all days.
  // This guarantees the country total EXACTLY reconciles to
  // steam_sales_daily on any date-window query.
  app.get("/api/promo-support/sales-by-country", (req, res) => {
    try {
      const appidRaw = req.query.steam_app_id;
      const sinceQ = typeof req.query.since === "string" ? req.query.since : undefined;
      const untilQ = typeof req.query.until === "string" ? req.query.until : undefined;

      if (typeof appidRaw !== "string" || !/^\d+$/.test(appidRaw)) {
        return res.status(400).json({ error: "steam_app_id query param required (numeric)" });
      }
      if (sinceQ && !/^\d{4}-\d{2}-\d{2}$/.test(sinceQ)) {
        return res.status(400).json({ error: "since must be YYYY-MM-DD" });
      }
      if (untilQ && !/^\d{4}-\d{2}-\d{2}$/.test(untilQ)) {
        return res.status(400).json({ error: "until must be YYYY-MM-DD" });
      }

      const appid = appidRaw;
      const product = storage.getAllProducts().find((p) => p.steamAppId === appid);
      if (!product) {
        return res.json({
          steam_app_id: Number(appid), product_id: null,
          since: sinceQ ?? null, until: untilQ ?? null,
          total_units: 0, total_revenue_usd: 0, asp_usd: 0,
          countries_count: 0, countries: [], found: false,
          shares_source: "authoritative",
          days_with_shares: 0, days_in_window: 0, days_authoritative_rev: 0, total_units_authoritative: 0,
        });
      }

      const result = computeSalesByCountry(product.id, sinceQ, untilQ);
      res.json({
        steam_app_id: Number(appid),
        product_id: product.id,
        since: sinceQ ?? null, until: untilQ ?? null,
        ...result,
        found: result.countries.length > 0,
      });
    } catch (err) {
      console.error("[promo-support] sales-by-country error", err);
      res.json({
        steam_app_id: null, product_id: null,
        since: null, until: null,
        total_units: 0, total_revenue_usd: 0, asp_usd: 0,
        countries_count: 0, countries: [], found: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

// ---------------------------------------------------------------------------
// v3.32 shared reconciliation helper
// ---------------------------------------------------------------------------
//
// Both /api/promo-support/sales-by-country (this file) and
// /api/products/:id/sales-by-country (routes.ts) call this. The math is
// identical; only the input keying (AppID vs product_id) differs.

type CountryRowOut = {
  country_iso: string;
  country_name: string;
  units: number;
  revenue_usd: number;
  asp_usd: number;
  pct_of_total: number;
};

export function computeSalesByCountry(
  productId: number,
  since: string | undefined,
  until: string | undefined,
): {
  total_units: number;
  total_revenue_usd: number;
  asp_usd: number;
  countries_count: number;
  countries: CountryRowOut[];
  shares_source: "authoritative" | "legacy";
  days_with_shares: number;
  days_in_window: number;
  days_authoritative_rev: number;
  total_units_authoritative: number;
  base_units: number;
  dlc_units: number;
  base_revenue_usd: number;
  dlc_revenue_usd: number;
} {
  // Determine effective window bounds. If since/until omitted, use
  // full range of what steam_sales_daily has for this product.
  const dailyRows = storage.getSteamSales(productId, { since, until });
  // Sum base+dlc per day for the combined authoritative totals used by the
  // country attribution algorithm. Also keep base-only and dlc-only splits
  // (v3.33.3, 2026-09-05) so the KPI strip can show 'Base game units' and
  // 'DLC units' separately on the card without a second query.
  const dayTotalRev = new Map<string, number>();
  const dayTotalUnits = new Map<string, number>();
  let baseUnitsTot = 0, dlcUnitsTot = 0;
  let baseRevTot  = 0, dlcRevTot  = 0;
  for (const r of dailyRows) {
    if (r.skuGroup !== "base" && r.skuGroup !== "dlc") continue;
    dayTotalRev.set(r.date, (dayTotalRev.get(r.date) ?? 0) + (r.netRevenueUsd || 0));
    dayTotalUnits.set(r.date, (dayTotalUnits.get(r.date) ?? 0) + (r.netUnits || 0));
    if (r.skuGroup === "base") {
      baseUnitsTot += r.netUnits || 0;
      baseRevTot  += r.netRevenueUsd || 0;
    } else {
      dlcUnitsTot += r.netUnits || 0;
      dlcRevTot  += r.netRevenueUsd || 0;
    }
  }

  const daysAuthoritative = dayTotalRev.size;

  if (daysAuthoritative === 0) {
    // No authoritative daily rows in window — nothing to attribute.
    return {
      total_units: 0, total_revenue_usd: 0, asp_usd: 0,
      countries_count: 0, countries: [],
      shares_source: "authoritative",
      days_with_shares: 0, days_in_window: 0, days_authoritative_rev: 0, total_units_authoritative: 0,
      base_units: 0, dlc_units: 0, base_revenue_usd: 0, dlc_revenue_usd: 0,
    };
  }

  // Pull all country rows overlapping the window. We reason per-day so
  // the granularity preference is applied per-day, not per-window.
  const dayCountryRows   = storage.getSteamSalesByCountry(productId, { since, until, granularity: "day" });
  const monthCountryRows = storage.getSteamSalesByCountry(productId, { since, until, granularity: "month" });
  const customCountryRows= storage.getSteamSalesByCountry(productId, { since, until, granularity: "custom" });

  // Index by exact day (for day granularity) and by (period_start,period_end)
  // for wider windows so per-day lookup is O(1) with a linear month scan.
  type SharesRow = {
    countryIso: string; countryName: string;
    pctOfUnits: number | null; pctOfRevenue: number | null;
    units: number; revenueUsd: number;
  };
  const dayIndex = new Map<string, SharesRow[]>();
  for (const r of dayCountryRows) {
    const key = r.periodStart;
    if (!dayIndex.has(key)) dayIndex.set(key, []);
    dayIndex.get(key)!.push({
      countryIso: r.countryIso, countryName: r.countryName,
      pctOfUnits: r.pctOfUnits, pctOfRevenue: r.pctOfRevenue,
      units: r.units, revenueUsd: r.revenueUsd,
    });
  }
  // Wider windows: list of {start, end, rows}
  type WideBucket = { start: string; end: string; rows: SharesRow[] };
  const wideBuckets: WideBucket[] = [];
  const pushWide = (list: typeof monthCountryRows) => {
    const groups = new Map<string, SharesRow[]>();
    for (const r of list) {
      const key = `${r.periodStart}|${r.periodEnd}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({
        countryIso: r.countryIso, countryName: r.countryName,
        pctOfUnits: r.pctOfUnits, pctOfRevenue: r.pctOfRevenue,
        units: r.units, revenueUsd: r.revenueUsd,
      });
    }
    groups.forEach((rows, key) => {
      const [start, end] = key.split("|");
      wideBuckets.push({ start, end, rows });
    });
  };
  pushWide(monthCountryRows);
  pushWide(customCountryRows);

  // For each day with authoritative revenue, pick best shares bucket.
  // Prefer: exact day > smallest wide bucket containing the day.
  type Agg = { iso: string; name: string; units: number; revenue: number };
  const byCountry = new Map<string, Agg>();
  const push = (iso: string, name: string, u: number, r: number) => {
    const cur = byCountry.get(iso);
    if (cur) { cur.units += u; cur.revenue += r; if (name && !cur.name) cur.name = name; }
    else byCountry.set(iso, { iso, name, units: u, revenue: r });
  };

  let daysWithShares = 0;
  let usedLegacyFallback = false;

  const dayEntries: Array<[string, number]> = [];
  dayTotalRev.forEach((v, k) => dayEntries.push([k, v]));
  for (const [day, dayRev] of dayEntries) {
    const dayUnits = dayTotalUnits.get(day) ?? 0;

    // 1. Prefer exact-day shares
    let sharesRows: SharesRow[] | null = dayIndex.get(day) ?? null;

    // 2. Wide-bucket fallback: pick the SHORTEST bucket that contains this day
    if (!sharesRows) {
      let bestBucket: WideBucket | null = null;
      let bestLen = Number.POSITIVE_INFINITY;
      for (const b of wideBuckets) {
        if (b.start <= day && day <= b.end) {
          const len = (Date.parse(b.end) - Date.parse(b.start)) / 86400000 + 1;
          if (len < bestLen) { bestLen = len; bestBucket = b; }
        }
      }
      if (bestBucket) sharesRows = bestBucket.rows;
    }

    if (!sharesRows || sharesRows.length === 0) continue;
    daysWithShares++;

    // v3.33 (2026-09-05): per-day units + raw revenue accumulation.
    // ASP capping + reconciliation now happens ONCE at the window level
    // after all days are aggregated (see "Window-level ASP cap" below).
    // Doing it per-day + renormalizing every day was unstable: clipped
    // rows got scaled back UP when sumClipped < dayRev, pushing them back
    // above the ceiling.
    let totalPctRev = 0;
    let totalPctUnits = 0;
    for (const s of sharesRows) {
      if (s.pctOfRevenue != null) totalPctRev += s.pctOfRevenue;
      if (s.pctOfUnits != null) totalPctUnits += s.pctOfUnits;
    }
    const hasShares = totalPctRev > 0 || totalPctUnits > 0;

    if (hasShares) {
      for (const s of sharesRows) {
        const revShare = s.pctOfRevenue != null && totalPctRev > 0
          ? s.pctOfRevenue / totalPctRev
          : 0;
        const unitShare = s.pctOfUnits != null && totalPctUnits > 0
          ? s.pctOfUnits / totalPctUnits
          : 0;
        if (revShare === 0 && unitShare === 0) continue;
        push(s.countryIso, s.countryName, dayUnits * unitShare, dayRev * revShare);
      }
    } else {
      usedLegacyFallback = true;
      let sumU = 0, sumR = 0;
      for (const s of sharesRows) { sumU += s.units; sumR += s.revenueUsd; }
      for (const s of sharesRows) {
        const revShare = sumR > 0 ? s.revenueUsd / sumR : 0;
        const unitShare = sumU > 0 ? s.units / sumU : 0;
        if (revShare === 0 && unitShare === 0) continue;
        push(s.countryIso, s.countryName, dayUnits * unitShare, dayRev * revShare);
      }
    }
  }

  // ---------------------------------------------------------------------
  // v3.33 (2026-09-05): window-level ASP cap + renormalization.
  // ---------------------------------------------------------------------
  // pct_of_units and pct_of_revenue come from separate Steamworks panels;
  // their per-country ranks can diverge sharply so naive multiplication
  // yields absurd per-country ASPs (e.g. ZA 29 units / \$165k = \$5,700).
  //
  // The fix works on aggregated (window-level) country totals rather than
  // per day so we can iterate to a stable answer:
  //   1. Compute window-level title ASP from the authoritative totals
  //      (sum of steam_sales_daily net rev / net units in the window).
  //   2. Clip each country's implied ASP to [0.35x, 1.75x] the title ASP;
  //      out-of-band revenue -> units * capped_asp.
  //   3. Renormalize revenue so sum matches sum(dayRev). Renormalization
  //      can push some values back out of band, so re-clip + re-normalize.
  //   4. Repeat up to N iterations (converges within 3-5 passes typically
  //      because clip step is monotone).
  //
  // The band 0.35 - 1.75 covers Steam's real regional-pricing spread:
  // CN/RU/BR/TR/ID at ~0.5-0.7x US, most EU/JP at 1.0-1.2x, a few
  // Nordic/AU at 1.1-1.3x. Anything outside is a panel-rank artefact.
  const ASP_FLOOR_MULT = 0.35;
  const ASP_CEIL_MULT  = 1.75;
  const MAX_ITER = 8;

  const authoritativeWindowRev = Array.from(dayTotalRev.values()).reduce((s, v) => s + v, 0);
  const authoritativeWindowUnits = Array.from(dayTotalUnits.values()).reduce((s, v) => s + v, 0);
  const titleAsp = authoritativeWindowUnits > 0
    ? authoritativeWindowRev / authoritativeWindowUnits
    : 0;

  // v3.33.2: first renormalize UNITS so per-country units sum exactly to
  // steam_sales_daily's authoritative window units. Steamworks unit-panel
  // pct sometimes doesn't sum to 100% (missing "Other" bucket, rounding at
  // 0.1%). This scaling closes that gap on the units side.
  if (authoritativeWindowUnits > 0 && byCountry.size > 0) {
    let sumU = 0;
    byCountry.forEach(a => { sumU += a.units; });
    if (sumU > 0 && Math.abs(sumU - authoritativeWindowUnits) > 0.5) {
      const scale = authoritativeWindowUnits / sumU;
      byCountry.forEach(a => { a.units *= scale; });
    }
  }

  if (titleAsp > 0 && byCountry.size > 0) {
    const aspFloor = titleAsp * ASP_FLOOR_MULT;
    const aspCeil  = titleAsp * ASP_CEIL_MULT;
    for (let iter = 0; iter < MAX_ITER; iter++) {
      // Step 1: clip revenue based on per-country implied ASP.
      let clippedAny = false;
      byCountry.forEach((agg) => {
        if (agg.units <= 0) {
          if (agg.revenue !== 0) { agg.revenue = 0; clippedAny = true; }
          return;
        }
        const impliedAsp = agg.revenue / agg.units;
        if (impliedAsp < aspFloor) { agg.revenue = agg.units * aspFloor; clippedAny = true; }
        else if (impliedAsp > aspCeil) { agg.revenue = agg.units * aspCeil; clippedAny = true; }
      });
      // Step 2: renormalize revenue so sum matches authoritative window rev.
      let sumRev = 0;
      byCountry.forEach((a) => { sumRev += a.revenue; });
      if (sumRev > 0 && Math.abs(sumRev - authoritativeWindowRev) > 0.01) {
        const scale = authoritativeWindowRev / sumRev;
        byCountry.forEach((a) => { a.revenue *= scale; });
      }
      // Convergence check: if nothing was clipped, all ASPs are in-band
      // and the renormalize was a no-op (or nearly so). Stop.
      if (!clippedAny) break;
    }
  }

  const totalRevenue = Array.from(byCountry.values()).reduce((s, r) => s + r.revenue, 0);
  const totalUnits = Array.from(byCountry.values()).reduce((s, r) => s + r.units, 0);

  const countries: CountryRowOut[] = Array.from(byCountry.values())
    .map(r => ({
      country_iso: r.iso,
      country_name: r.name || r.iso,
      units: Math.round(r.units),
      revenue_usd: Math.round(r.revenue * 100) / 100,
      asp_usd: r.units > 0 ? r.revenue / r.units : 0,
      pct_of_total: totalRevenue > 0 ? r.revenue / totalRevenue : 0,
    }))
    .sort((a, b) => b.revenue_usd - a.revenue_usd);

  // v3.33.2 (2026-09-05): authoritative unit total from steam_sales_daily.
  // We compute it here so callers can compare against total_units (the sum
  // of per-country attributed units) and see any small drift caused by
  // Steamworks unit-panel percentages not summing to exactly 100%.
  let authoritativeWindowUnitsTot = 0;
  dayTotalUnits.forEach(v => { authoritativeWindowUnitsTot += v; });

  return {
    total_units: Math.round(totalUnits),
    total_units_authoritative: Math.round(authoritativeWindowUnitsTot),
    total_revenue_usd: Math.round(totalRevenue * 100) / 100,
    asp_usd: totalUnits > 0 ? totalRevenue / totalUnits : 0,
    countries_count: countries.length,
    countries,
    shares_source: usedLegacyFallback ? "legacy" : "authoritative",
    days_with_shares: daysWithShares,
    days_in_window: daysAuthoritative,
    days_authoritative_rev: Math.round(
      Array.from(dayTotalRev.values()).reduce((s, v) => s + v, 0) * 100,
    ) / 100,
    // v3.33.3 (2026-09-05): base + DLC split totals from steam_sales_daily.
    // Consumers can display 'Base units' and 'DLC units' separately on the
    // KPI card without needing a second query. Country table rows stay
    // combined (base + dlc) so ASPs remain sensible per country.
    base_units: Math.round(baseUnitsTot),
    dlc_units: Math.round(dlcUnitsTot),
    base_revenue_usd: Math.round(baseRevTot * 100) / 100,
    dlc_revenue_usd: Math.round(dlcRevTot * 100) / 100,
  };
}

