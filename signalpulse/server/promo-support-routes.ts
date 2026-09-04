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
}
