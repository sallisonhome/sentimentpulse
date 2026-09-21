import { createHash } from "node:crypto";
import { raw } from "./db.js";
import { CALENDARS, type CalendarId } from "../shared/schema.js";
import type { EventPerformance } from "../shared/event-performance.js";
import { archiveStartedEvents, listEvents, serverToday, type EventRow } from "./storage.js";
import { steamAppIdForCode } from "./signalpulse-map.js";
import { getSteamRevenueBatch } from "./signalpulse-client.js";

type RevenueQuery = { source_id: string; since: string; until: string };
type RevenueRow = { net_revenue_usd: number; gross_revenue_usd: number; days_covered: number; found: boolean };
export interface ActualSalesAdapter {
  source: string; // Version this when source scope/mapping semantics change.
  platform: string;
  resolve: (gameCode: string) => string | null;
  fetch: (queries: RevenueQuery[]) => Promise<RevenueRow[]>;
}
/** Add Sony -> PS5 partner-actuals here once SignalPulse exposes that feed.
 * Do NOT wire the public console estimator into this actual-sales contract. */
export const actualSalesAdapters: Record<string, ActualSalesAdapter> = {
  Steam: {
    source: "signalpulse.steam.actuals.base-dlc.v1", platform: "steam",
    resolve: code => { const id = steamAppIdForCode(code); return id == null ? null : String(id); },
    fetch: queries => getSteamRevenueBatch(queries.map(q => ({
      steam_app_id: Number(q.source_id), since: q.since, until: q.until,
    }))),
  },
};

type Saved = { fingerprint: string; payload: string | null; checked_at: string | null; next_refresh_at: string; refresh_error: number };
const DAY = 86400000;
export function eventWindow(e: EventRow, today: string) {
  const until = e.end_date < today ? e.end_date : today;
  return { since: e.start_date, until, days: Math.max(0, Math.round((Date.parse(until) - Date.parse(e.start_date)) / DAY) + 1) };
}
function fingerprint(e: EventRow, a: ActualSalesAdapter) {
  return createHash("sha256").update(JSON.stringify([
    a.source, a.platform, e.start_date, e.end_date,
    [...new Set(e.games.map(g => g.game_code))].sort().map(c => [c, a.resolve(c)]),
  ])).digest("hex");
}
function load(calendar: string, key: string): Saved | undefined {
  return raw.prepare("SELECT * FROM event_performance WHERE calendar=? AND event_key=?").get(calendar, key) as Saved | undefined;
}
function retainOnFailure(calendar: string, e: EventRow, fp: string, saved: Saved | undefined, now: Date) {
  raw.prepare(`INSERT INTO event_performance(calendar,event_key,fingerprint,payload,checked_at,next_refresh_at,refresh_error)
    VALUES(?,?,?,?,?,?,1) ON CONFLICT(calendar,event_key) DO UPDATE SET
    fingerprint=excluded.fingerprint,payload=excluded.payload,checked_at=excluded.checked_at,
    next_refresh_at=excluded.next_refresh_at,refresh_error=1`).run(calendar, e.event_key, fp,
      saved?.fingerprint === fp ? saved.payload : null, now.toISOString(), new Date(now.getTime() + 60_000).toISOString());
}
function empty(e: EventRow, today: string, a?: ActualSalesAdapter): EventPerformance {
  const w = eventWindow(e, today);
  const codes = [...new Set(e.games.map(g => g.game_code))];
  return {
    platform: a?.platform ?? e.platform.toLowerCase(), source: a?.source ?? null,
    currency: "USD", basis: "actual",
    status: e.end_date < e.start_date ? "invalid_window" : e.start_date > today ? "not_started" : a ? "pending" : "unsupported",
    window_start: w.since, window_end: w.until,
    net_revenue_usd: null, gross_revenue_usd: null, titles_total: codes.length,
    titles_mapped: codes.filter(c => a?.resolve(c) != null).length,
    titles_covered: 0, title_days_covered: 0, title_days_expected: w.days * codes.length,
    checked_at: null, fetched_at: null, stale: false, refresh_error: false,
    titles: codes.map(c => ({ game_code: c, source_id: a?.resolve(c) ?? null, days_covered: 0, net_revenue_usd: null, gross_revenue_usd: null })),
  };
}

/** Synchronous local read: page load never fans out into SignalPulse. */
export function readEventPerformance(calendar: string, e: EventRow, today: string, now = new Date()): EventPerformance {
  const a = actualSalesAdapters[e.platform];
  const base = empty(e, today, a);
  if (base.status !== "pending" || !a) return base;
  const saved = load(calendar, e.event_key);
  if (!saved || saved.fingerprint !== fingerprint(e, a)) return base;
  const p: EventPerformance = saved.payload ? JSON.parse(saved.payload) : base;
  // Demo date overrides must never reveal data beyond the requested date.
  if (p.window_end > base.window_end) return base;
  return { ...p, checked_at: saved.checked_at, refresh_error: !!saved.refresh_error,
    stale: !!saved.payload && (!!saved.refresh_error || saved.next_refresh_at <= now.toISOString() || p.window_end !== base.window_end) };
}

export function withEventPerformance<T extends EventRow>(calendar: string, e: T, today: string) {
  const performance = readEventPerformance(calendar, e, today);
  return { ...e, performance,
    // Backwards-compatible fields; new UI consumes the generic contract.
    ...(e.platform === "Steam" && performance.net_revenue_usd != null ? {
      steam_total_net_revenue_usd: performance.net_revenue_usd,
      steam_total_gross_revenue_usd: performance.gross_revenue_usd,
      steam_titles_covered: performance.titles_covered,
      steam_total_days_covered: Math.max(0, ...performance.titles.map(t => t.days_covered)),
    } : {}),
  };
}

let running = false;
/** One globally single-flight worker, <=24 events and <=200 query items/batch.
 * Persisted retry deadlines survive restarts. Completed windows refresh every
 * six hours for late data/corrections; live windows every minute. Errors retain
 * the last successful totals, with explicit stale/error flags. */
export async function refreshEventPerformance(today = serverToday(null), now = new Date(), limit = 24) {
  if (running) return;
  running = true;
  try {
    const due: Array<{ calendar: CalendarId; e: EventRow; a: ActualSalesAdapter; fp: string; saved?: Saved }> = [];
    for (const calendar of CALENDARS) {
      archiveStartedEvents(calendar, today);
      for (const e of listEvents(calendar, today)) {
        const a = actualSalesAdapters[e.platform];
        if (!a || e.start_date > today || e.end_date < e.start_date) continue;
        const saved = load(calendar, e.event_key);
        const fp = fingerprint(e, a);
        if (saved?.fingerprint === fp && saved.next_refresh_at > now.toISOString()) continue;
        due.push({ calendar, e, a, fp, saved });
      }
    }
    // Live first; then least-recently attempted, newest events first on cold start.
    due.sort((x, y) => Number(y.e.is_active) - Number(x.e.is_active) ||
      (x.saved?.checked_at ?? "").localeCompare(y.saved?.checked_at ?? "") ||
      y.e.end_date.localeCompare(x.e.end_date));
    const selected = due.slice(0, Math.max(1, Math.min(limit, 24)));
    for (const a of new Set(selected.map(x => x.a))) {
      const group = selected.filter(x => x.a === a);
      const queries = new Map<string, RevenueQuery>();
      const key = (id: string, since: string, until: string) => `${id}|${since}|${until}`;
      for (const { e } of group) {
        const w = eventWindow(e, today);
        for (const g of e.games) {
          const id = a.resolve(g.game_code);
          if (id) queries.set(key(id, w.since, w.until), { source_id: id, since: w.since, until: w.until });
        }
      }
      try {
        const entries = [...queries.entries()];
        const results = new Map<string, RevenueRow>();
        for (let i = 0; i < entries.length; i += 200) {
          const batch = entries.slice(i, i + 200);
          const rows = await a.fetch(batch.map(([, q]) => q));
          if (rows.length !== batch.length) throw new Error("Incomplete actual-sales response");
          rows.forEach((r, j) => results.set(batch[j][0], r));
        }
        for (const { calendar, e, fp, saved } of group) {
          const p = empty(e, today, a);
          const w = eventWindow(e, today);
          const seen = new Set<string>();
          let net = 0, gross = 0;
          for (const t of p.titles) {
            if (!t.source_id || seen.has(t.source_id)) continue;
            seen.add(t.source_id);
            const r = results.get(key(t.source_id, w.since, w.until));
            if (!r || !r.found || !r.days_covered) continue;
            if (r.days_covered > w.days || !Number.isFinite(r.net_revenue_usd) || !Number.isFinite(r.gross_revenue_usd)) {
              throw new Error("Invalid actual-sales coverage");
            }
            Object.assign(t, { days_covered: r.days_covered, net_revenue_usd: r.net_revenue_usd, gross_revenue_usd: r.gross_revenue_usd });
            p.titles_covered++;
            p.title_days_covered += r.days_covered;
            net += r.net_revenue_usd; gross += r.gross_revenue_usd;
          }
          p.status = !p.titles_covered ? "unavailable" : p.title_days_covered === p.title_days_expected ? "complete" : "partial";
          p.net_revenue_usd = p.titles_covered ? Math.round(net * 100) / 100 : null;
          p.gross_revenue_usd = p.titles_covered ? Math.round(gross * 100) / 100 : null;
          p.fetched_at = now.toISOString(); p.checked_at = p.fetched_at;
          // A transient backfill purge must not erase an already captured
          // window. Revenue corrections with equal/better coverage ARE allowed.
          const previous: EventPerformance | null = saved?.fingerprint === fp && saved.payload ? JSON.parse(saved.payload) : null;
          if (previous && previous.titles.some(t =>
            t.days_covered > (p.titles.find(n => n.game_code === t.game_code)?.days_covered ?? 0))) {
            console.warn(`[event-performance] coverage regressed for ${e.event_key}; retaining saved totals`);
            retainOnFailure(calendar, e, fp, saved, now);
            continue;
          }
          raw.prepare(`INSERT INTO event_performance(calendar,event_key,fingerprint,payload,checked_at,next_refresh_at,refresh_error)
            VALUES(?,?,?,?,?,?,0) ON CONFLICT(calendar,event_key) DO UPDATE SET
            fingerprint=excluded.fingerprint,payload=excluded.payload,checked_at=excluded.checked_at,
            next_refresh_at=excluded.next_refresh_at,refresh_error=0`).run(calendar, e.event_key, fp, JSON.stringify(p),
              now.toISOString(), new Date(now.getTime() + (e.is_active ? 60_000 : 6 * 3600_000)).toISOString());
        }
      } catch (error) {
        console.warn("[event-performance] refresh failed:", error instanceof Error ? error.message : String(error));
        for (const { calendar, e, fp, saved } of group) {
          retainOnFailure(calendar, e, fp, saved, now);
        }
      }
    }
  } finally { running = false; }
}

export function startEventPerformanceRefresh() {
  const tick = () => void refreshEventPerformance().catch(err => console.error("[event-performance]", err));
  tick();
  const timer = setInterval(tick, 15_000);
  timer.unref();
  return () => clearInterval(timer);
}
