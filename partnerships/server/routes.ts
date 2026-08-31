import type { Express, Request, Response } from "express";

/**
 * Partnerships API routes.
 *
 * Nginx proxies `http://104.236.239.46/partnerships/api/*` →
 * `http://127.0.0.1:5002/api/*`, so every route here is mounted under `/api`.
 *
 * Scaffold PR: only the health check is live. Follow-up PRs add:
 *   - GET  /api/titles                — SignalPulse title projection
 *   - GET  /api/titles/:id            — PDP payload (with all opportunities)
 *   - POST /api/opportunities         — create
 *   - PATCH /api/opportunities/:id    — update / change state / soft-flag
 *   - POST /api/physical-retail       — add partner
 *   - POST /api/collectors/items      — add CE item
 */
export async function registerRoutes(app: Express): Promise<void> {
  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      app: "partnerships",
      version: "0.1.0",
      time: new Date().toISOString(),
    });
  });

  // Placeholder — returns an empty list until PR 3 lands the SignalPulse sync.
  app.get("/api/titles", (_req: Request, res: Response) => {
    res.json({ titles: [], note: "SignalPulse sync lands in PR 3" });
  });
}
