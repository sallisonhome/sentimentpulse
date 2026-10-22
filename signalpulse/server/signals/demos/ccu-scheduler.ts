/**
 * Demos leaderboard — hourly CCU poll (2026-10-22).
 *
 * The demos leaderboard's CCU columns used to be fed only by the nightly
 * pipeline (one sample per day, taken ~03:50 ET), so "Latest Sampled CCU"
 * could be 23h stale and "Peak Observed CCU" was the best of those daily
 * samples. Demos charting on Steam's own live CCU chart
 * (store.steampowered.com/charts/mostplayed — Rank / Current Players /
 * Peak Today, demos included) showed peak volumes well above our stored
 * maxima (Probably Stolen Demo: 39,811 from Steam's charts API vs 19,428
 * as our once-daily max, live-verified 2026-10-22).
 *
 * This scheduler mirrors the Saber-games poll (server/ccu-poll.ts) for
 * the demo catalog, staggered to :05 past every UTC hour (the games poll
 * fires on the hour):
 *   1. Fetch Steam's most-played top 100 (GetGamesByConcurrentPlayers)
 *      and upsert its per-app peak figure for every tracked appid that
 *      charts (demo_ccu_steam_peaks). Apps that left the chart are
 *      removed on every successful refresh so a departed app never shows
 *      a stale rank as current; on refresh failure the last-known rows
 *      keep their captured timestamps and age out of presentation after
 *      24h. Steam labels its figure "Peak Today" — we present it as
 *      Steam's chart peak without claiming a verified window.
 *   2. Sweep GetNumberOfCurrentPlayers for the whole tracked catalog in
 *      concurrent batches (runDemosCcuCollector, batchSize 10, 250ms
 *      between batches). A 429 aborts the sweep — remaining demos keep
 *      their last good samples.
 *   3. Record sweep completion state, then once per UTC day roll up and
 *      prune raw snapshots older than 7 days. Pruning is lossless for
 *      history: per-day rollups (latest value + time, sample count, max)
 *      and per-demo daily peaks are written first, and each demo's most
 *      recent snapshot is always kept so a failing endpoint never loses
 *      its last good current observation.
 *
 * On boot, a catch-up sweep runs shortly after startup when the last
 * COMPLETED sweep is missing or older than an hour (per-sweep state, not
 * a catalog-wide newest-sample check, so one fresh sample from an
 * interrupted sweep cannot mask a missed one).
 */

import { rawSqlite } from "../../storage";
import { log } from "../../log";
import { loadDemoCatalog } from "./catalog";
import { runDemosCcuCollector } from "./ccu";

const MOST_PLAYED_URL = "https://api.steampowered.com/ISteamChartsService/GetGamesByConcurrentPlayers/v1/?format=json";
const SWEEP_BATCH_SIZE = 10;
const SNAPSHOT_RETENTION_DAYS = 7;

interface SteamRankEntry {
  rank: number;
  appid: number;
  concurrent_in_game: number;
  peak_in_game: number;
}

let pollInterval: NodeJS.Timeout | null = null;
let lastFiredHourKey: string | null = null;
let lastPruneDayKey: string | null = null;
let sweeping = false;

/**
 * Upserts Steam's charts peak for tracked appids that appear in the top
 * 100 and deletes rows for apps that left the chart. Returns the number
 * of tracked charting appids stored.
 */
async function refreshSteamPeaks(): Promise<number> {
  const res = await fetch(MOST_PLAYED_URL, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GetGamesByConcurrentPlayers responded HTTP ${res.status}`);
  const json = (await res.json()) as { response?: { ranks?: SteamRankEntry[] } };
  const ranks = json?.response?.ranks;
  if (!Array.isArray(ranks)) throw new Error("GetGamesByConcurrentPlayers returned unexpected response shape");

  const tracked = new Set(
    [...loadDemoCatalog("demo"), ...loadDemoCatalog("friends_pass")].map(d => d.steam_app_id)
  );
  const nowIso = new Date().toISOString();
  const upsert = rawSqlite.prepare(
    `INSERT INTO demo_ccu_steam_peaks (steam_app_id, global_rank, current_ccu, peak_ccu, captured_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(steam_app_id) DO UPDATE SET
       global_rank=excluded.global_rank, current_ccu=excluded.current_ccu,
       peak_ccu=excluded.peak_ccu, captured_at=excluded.captured_at`
  );
  const charting: string[] = [];
  for (const r of ranks) {
    const appId = String(r.appid);
    if (!tracked.has(appId)) continue;
    if (!Number.isSafeInteger(r.peak_in_game) || r.peak_in_game < 0) continue;
    if (!Number.isSafeInteger(r.concurrent_in_game) || r.concurrent_in_game < 0) continue;
    upsert.run(appId, r.rank, r.concurrent_in_game, r.peak_in_game, nowIso);
    charting.push(appId);
  }
  // Departure handling: a successful chart response that omits an app
  // ends its presentation immediately — a departed app must not keep
  // showing its last rank as if current.
  const placeholders = charting.map(() => "?").join(",");
  const removed = charting.length
    ? rawSqlite.prepare(`DELETE FROM demo_ccu_steam_peaks WHERE steam_app_id NOT IN (${placeholders})`).run(...charting)
    : rawSqlite.prepare(`DELETE FROM demo_ccu_steam_peaks`).run();
  if (removed.changes > 0) {
    log(`demo Steam peak overlay: removed ${removed.changes} appid(s) no longer charting`, "demos-ccu");
  }
  return charting.length;
}

/**
 * Lossless history compaction: writes one rollup row per demo per day
 * (latest value + timestamp, sample count, max) for every day whose raw
 * snapshots are about to be pruned, then deletes those raw snapshots —
 * always keeping each demo's single most recent snapshot so a failing
 * endpoint never loses its last good current observation. Daily peaks
 * are untouched.
 */
function pruneAndRollupOldSnapshots(): void {
  const cutoff = new Date(Date.now() - SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const upsertRollup = rawSqlite.prepare(
    `INSERT INTO demo_ccu_daily_rollups (demo_title_id, rollup_date, latest_ccu, latest_captured_at, sample_count, max_ccu, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(demo_title_id, rollup_date) DO UPDATE SET
       latest_ccu=excluded.latest_ccu, latest_captured_at=excluded.latest_captured_at,
       sample_count=excluded.sample_count, max_ccu=excluded.max_ccu, created_at=excluded.created_at`
  );
  const nowIso = new Date().toISOString();
  const days = rawSqlite.prepare(
    `SELECT demo_title_id, substr(captured_at,1,10) AS d, COUNT(*) AS n, MAX(ccu) AS mx
     FROM demo_ccu_snapshots WHERE captured_at < ?
     GROUP BY demo_title_id, substr(captured_at,1,10)`
  ).all(cutoff) as Array<{ demo_title_id: number; d: string; n: number; mx: number }>;
  for (const day of days) {
    const latest = rawSqlite.prepare(
      `SELECT ccu, captured_at FROM demo_ccu_snapshots
       WHERE demo_title_id=? AND substr(captured_at,1,10)=?
       ORDER BY captured_at DESC, id DESC LIMIT 1`
    ).get(day.demo_title_id, day.d) as { ccu: number; captured_at: string } | undefined;
    if (latest) {
      upsertRollup.run(day.demo_title_id, day.d, latest.ccu, latest.captured_at, day.n, day.mx, nowIso);
    }
  }
  // Keep each demo's most recent snapshot regardless of age.
  const pruned = rawSqlite.prepare(
    `DELETE FROM demo_ccu_snapshots WHERE captured_at < ? AND id NOT IN
       (SELECT id FROM (SELECT MAX(id) AS id FROM demo_ccu_snapshots GROUP BY demo_title_id))`
  ).run(cutoff);
  if (pruned.changes > 0) {
    log(`rolled up and pruned ${pruned.changes} CCU snapshots older than ${SNAPSHOT_RETENTION_DAYS} days (daily peaks and last samples kept)`, "demos-ccu");
  }
}

/** Records the sweep completion state used by the boot catch-up check. */
function markSweepCompleted(): void {
  rawSqlite.prepare(
    `INSERT INTO demo_ccu_poll_state (id, last_sweep_completed_at) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET last_sweep_completed_at=excluded.last_sweep_completed_at`
  ).run(new Date().toISOString());
}

function lastSweepCompletedAt(): string | null {
  const row = rawSqlite.prepare(`SELECT last_sweep_completed_at FROM demo_ccu_poll_state WHERE id=1`).get() as { last_sweep_completed_at: string } | undefined;
  return row?.last_sweep_completed_at ?? null;
}

/** One poll: Steam peak overlay + full-catalog sample sweep. No-op if a sweep is already running. */
export async function pollDemoCcu(): Promise<void> {
  if (sweeping) {
    log("demo CCU poll skipped: previous sweep still running", "demos-ccu");
    return;
  }
  sweeping = true;
  try {
    try {
      const stored = await refreshSteamPeaks();
      log(`demo Steam peak overlay refreshed: ${stored} charting appid(s)`, "demos-ccu");
    } catch (err) {
      // Peak overlay failure must not block the sample sweep. Last-known
      // rows keep their captured timestamps and age out of presentation.
      log(`demo Steam peak overlay failed: ${(err as Error).message}`, "demos-ccu");
    }
    const todayKey = new Date().toISOString().slice(0, 10);
    if (todayKey !== lastPruneDayKey) {
      lastPruneDayKey = todayKey;
      try {
        pruneAndRollupOldSnapshots();
      } catch (err) {
        log(`demo CCU snapshot rollup/prune failed: ${(err as Error).message}`, "demos-ccu");
      }
    }
    await runDemosCcuCollector(250, undefined, { batchSize: SWEEP_BATCH_SIZE });
    markSweepCompleted();
  } finally {
    sweeping = false;
  }
}

export function startDemoCcuPollScheduler(): void {
  if (pollInterval) return; // idempotent
  log("Demos CCU poll scheduler started (hourly, :05 past each UTC hour)", "demos-ccu");

  pollInterval = setInterval(() => {
    const now = new Date();
    if (now.getUTCMinutes() !== 5) return;
    const hourKey = now.toISOString().slice(0, 13); // yyyy-mm-ddThh
    if (hourKey === lastFiredHourKey) return; // already fired this hour
    lastFiredHourKey = hourKey;
    pollDemoCcu().catch((err) => log(`[demos-ccu] unhandled error: ${(err as Error).message}`, "demos-ccu"));
  }, 60_000);

  // Catch-up after restarts: if the last COMPLETED sweep is missing or
  // older than an hour, sweep shortly after boot instead of waiting for
  // the next hourly boundary.
  const completed = lastSweepCompletedAt();
  const completedAge = completed ? Date.now() - Date.parse(completed) : Infinity;
  if (!Number.isFinite(completedAge) || completedAge > 60 * 60 * 1000) {
    setTimeout(() => {
      pollDemoCcu().catch((err) => log(`[demos-ccu] catch-up error: ${(err as Error).message}`, "demos-ccu"));
    }, 45_000);
  }
}

export function stopDemoCcuPollScheduler(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    log("Demos CCU poll scheduler stopped", "demos-ccu");
  }
}
