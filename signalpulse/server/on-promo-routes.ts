// Express routes for the cross-app "On Promo" badge.
//
// These endpoints wrap `promo-calendar-client.ts` and are the only surface
// the SignalPulse SPA touches for promo data. Both endpoints:
//   - are read-only, unauthenticated (same posture as the leaderboards);
//   - always resolve to 200 with a valid shape, even on backend failure
//     (the client returns `[]` on error — a Promo Calendar outage MUST NOT
//     break a SignalPulse page render);
//   - are cached at the client for 60s (see promo-calendar-client.ts).
//
// Route layout: registered under `/api/onpromo/*`, which is exposed as
// `/signal/api/onpromo/*` in prod via nginx (see settings.tsx comments
// referencing the `/signal/` base path).

import type { Express } from "express";
import { getActivePromosFor, getAllActivePromos } from "./promo-calendar-client";

export function registerOnPromoRoutes(app: Express): void {
  // GET /api/onpromo/all
  // → { [steamAppId: string]: [{ platform, end_date }, ...] }
  // Only titles WITH at least one active promo appear as keys.
  // Used by both leaderboards (single fetch, per-row lookup) and the
  // Dashboard "On Promo Now" summary card.
  app.get("/api/onpromo/all", async (_req, res) => {
    try {
      const all = await getAllActivePromos();
      res.json(all);
    } catch (err: any) {
      // getAllActivePromos already swallows per-title errors; anything
      // reaching here would be exceptional. Still return the empty shape
      // so the client stays happy.
      console.warn(`[on-promo] /all fell through: ${err?.message || err}`);
      res.json({});
    }
  });

  // GET /api/onpromo/:steamAppId
  // → [{ platform, end_date }, ...]
  // Used by the PDP to load promos for a single title on mount.
  // Returns `[]` for any AppID not in the mapping table.
  app.get("/api/onpromo/:steamAppId", async (req, res) => {
    try {
      const raw = req.params.steamAppId;
      const appId = Number(raw);
      if (!Number.isFinite(appId)) {
        // Bad input still returns `[]` — the badge component's contract is
        // "render nothing" for an empty array, which is the right UX when
        // the AppID is missing or malformed on the PDP.
        return res.json([]);
      }
      const promos = await getActivePromosFor(appId);
      res.json(promos);
    } catch (err: any) {
      console.warn(`[on-promo] /:steamAppId fell through: ${err?.message || err}`);
      res.json([]);
    }
  });
}
