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

import type { Express } from "express";
import { storage } from "./storage";

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
}
