import type { Request, Response, NextFunction } from "express";

/**
 * Short-lived in-memory response cache for the public board GETs. Board data changes at most daily
 * (one poll per day plus estimator applies), but each build costs seconds of synchronous CPU that blocks the
 * whole process. Identical refreshes inside the TTL are served from memory.
 * - Only 200 JSON responses are stored; errors are never cached.
 * - Requests carrying an Authorization header, or ?nocache=1, bypass the cache (admin and verification probes).
 * - Cleared on process restart, so every deploy starts fresh.
 */
export function boardResponseCache(opts: { ttlMs: number; maxEntries?: number; now?: () => number }) {
  const store = new Map<string, { at: number; body: unknown }>();
  const maxEntries = opts.maxEntries ?? 300;
  const now = opts.now ?? Date.now;
  return function boardCache(req: Request, res: Response, next: NextFunction) {
    if (opts.ttlMs <= 0 || req.method !== "GET" || req.headers.authorization || req.query.nocache === "1") return next();
    const key = req.originalUrl;
    const hit = store.get(key);
    if (hit && now() - hit.at < opts.ttlMs) {
      res.setHeader("X-Board-Cache", "hit");
      return res.json(hit.body);
    }
    const origJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (res.statusCode === 200) {
        if (store.size >= maxEntries) store.delete(store.keys().next().value as string);
        store.set(key, { at: now(), body });
        res.setHeader("X-Board-Cache", "miss");
      }
      return origJson(body);
    }) as typeof res.json;
    next();
  };
}
