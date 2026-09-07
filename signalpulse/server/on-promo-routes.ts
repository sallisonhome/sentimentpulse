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
import { getActivePromosFor, getAllActivePromos, getPromoCalendarHealth } from "./promo-calendar-client";
import { STEAM_APPID_TO_PROMO_CODE } from "./promo-calendar-map";

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

  // GET /api/onpromo/_health  (2026-09-07 hardening)
  // → { bridge: PromoCalendarHealth, mappedTitleCount, activeNow: {...} }
  //
  // Registered BEFORE the /:steamAppId route below so Express matches this
  // literal path first — otherwise "_health" would be parsed as a
  // (non-numeric, harmless-but-wrong) steamAppId param.
  //
  // Exists because the 2026-09-04 incident (badge silently went empty for
  // ~3 days despite a live Steam sale) took a full manual investigation to
  // diagnose: re-cloning a stale local repo, diffing commits, and curling
  // both the old and new upstream endpoints by hand. This route answers
  // "is the SignalPulse ↔ Promo Calendar bridge actually healthy right now"
  // in one call — no code archaeology required next time.
  app.get("/api/onpromo/_health", async (_req, res) => {
    try {
      // Sequenced, not Promise.all: getPromoCalendarHealth() resolves
      // synchronously, so running it concurrently with getAllActivePromos()
      // would snapshot health from BEFORE this call's own fetches land,
      // showing stale (often all-null on a freshly restarted process)
      // state instead of the result of the fetch this very request just
      // triggered.
      const activeNow = await getAllActivePromos();
      const health = getPromoCalendarHealth();
      const mappedTitleCount = Object.keys(STEAM_APPID_TO_PROMO_CODE).length;
      const titlesWithActivePromoNow = Object.keys(activeNow).length;
      // A healthy bridge with genuinely zero live sales looks the same as a
      // broken bridge from the outside (both report 0 titles on promo).
      // Flag it so a human/monitor knows to double-check against the Promo
      // Calendar's own /live-now output before assuming it's fine.
      const zeroActiveWarning =
        titlesWithActivePromoNow === 0
          ? "0 titles currently on promo — this IS the expected shape when nothing is on sale, but if a sale is known to be live, treat this as suspicious and check lastErrorKind below."
          : null;
      res.json({
        bridge: health,
        mappedTitleCount,
        titlesWithActivePromoNow,
        zeroActiveWarning,
        activeNow,
      });
    } catch (err: any) {
      console.error(`[on-promo] /_health itself failed: ${err?.message || err}`);
      res.status(500).json({ error: err?.message || String(err) });
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
