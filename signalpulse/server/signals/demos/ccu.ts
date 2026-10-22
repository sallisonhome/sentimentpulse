/**
 * Steam Demos leaderboard — CCU collector.
 *
 * Uses ISteamUserStats/GetNumberOfCurrentPlayers/v1 — free, keyless,
 * confirmed working against demo appids this session (e.g. Hellraiser
 * Revival demo 5184670 returned live player_count with response.result=1).
 * Mirrors SteamDB's own "Most played game demos" chart
 * (steamdb.info/charts/?category=10), which ranks by Current / 24h Peak /
 * All-Time Peak CCU — this collector feeds the Current + All-Time Peak
 * columns. The daily pipeline calls this for available and retired demos;
 * the hourly scheduler (ccu-scheduler.ts) also calls it in concurrent
 * batches so "latest sampled CCU" stays under an hour old and daily peaks
 * reflect real peaks, not the once-daily trough sample.
 */

import { rawSqlite } from "../../storage";
import { log } from "../../log";
import {loadDemoCatalog} from "./catalog";

const CCU_ENDPOINT = "https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/";

interface DemoForCcu {
  id: number;
  steam_app_id: string;
  sku_kind: string;
}

function loadActiveDemosForCcu(): DemoForCcu[] {
  return [...loadDemoCatalog("demo"),...loadDemoCatalog("friends_pass")];
}

const insertSnapshotStmt = () => rawSqlite.prepare(
  `INSERT INTO demo_ccu_snapshots (demo_title_id, captured_at, ccu) VALUES (?, ?, ?)`
);

const upsertDailyPeakStmt = () => rawSqlite.prepare(
  `INSERT INTO demo_ccu_daily_peaks (demo_title_id, peak_date, peak_ccu, created_at)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(demo_title_id, peak_date) DO UPDATE SET
     peak_ccu = MAX(peak_ccu, excluded.peak_ccu)`
);

export interface CcuRunResult {
  attempted: number;
  succeeded: number;
  failed: number;
  unavailable: number;
  rateLimited: boolean;
  failureSample: Array<{ appId: string; reason: string }>;
}

export async function fetchCurrentPlayers(appId: string): Promise<number | null> {
  const res = await fetch(`${CCU_ENDPOINT}?appid=${encodeURIComponent(appId)}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as { response?: { result?: number; player_count?: number } };
  if (json.response?.result !== 1) return null;
  const n=json.response.player_count;
  return Number.isSafeInteger(n)&&n!>=0?n!:null;
}

/** Records one demo's sample. Shared by the sequential and batched paths. */
async function recordDemoCcu(demo: DemoForCcu, result: CcuRunResult): Promise<void> {
  try {
    const ccu = await fetchCurrentPlayers(demo.steam_app_id);
    // Timestamp each observation individually: a sweep can run for minutes
    // and cross UTC midnight, and a sweep-start stamp would file late
    // responses into the wrong daily peak bucket.
    const nowIso = new Date().toISOString();
    const today = nowIso.slice(0, 10);
    if (ccu !== null) {
      insertSnapshotStmt().run(demo.id, nowIso, ccu);
      upsertDailyPeakStmt().run(demo.id, today, ccu, nowIso);
      result.succeeded += 1;
    } else if (demo.sku_kind === "friends_pass") {
      result.unavailable += 1;
    } else {
      result.failed += 1;
      if (result.failureSample.length < 5) result.failureSample.push({ appId: demo.steam_app_id, reason: "result != 1" });
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    // Rate limited: stop issuing requests rather than hammering the
    // endpoint; the failed request is not a zero and keeps no fresh
    // timestamp.
    if (/HTTP 429/.test(reason)) throw new CcuRateLimitedError(reason);
    // Some pass storefront SKUs grant a parent's runtime and have no own
    // player-count endpoint. Do not copy the parent's CCU or fabricate zero.
    if (demo.sku_kind === "friends_pass" && reason === "HTTP 404") result.unavailable += 1;
    else {
      result.failed += 1;
      if (result.failureSample.length < 5) result.failureSample.push({ appId: demo.steam_app_id, reason });
    }
  }
}

/** Thrown when Steam rate-limits the sweep; aborts remaining batches. */
class CcuRateLimitedError extends Error {}

/**
 * Sample current players for the tracked demo catalog.
 *
 * batchSize=1 (default) keeps the nightly pipeline's polite sequential
 * behavior (one request, then delayMs). batchSize>1 processes batches of
 * that many requests concurrently with delayMs between batches — used by
 * the hourly scheduler so a full-catalog sweep finishes in minutes
 * instead of hours. Failure handling is identical in both paths: failed
 * requests are counted and never written as zero or given a fresh
 * timestamp.
 */
export async function runDemosCcuCollector(delayMs = 250, eligibleAppIds?: ReadonlySet<string>, options?: { batchSize?: number }): Promise<CcuRunResult> {
  const demos = loadActiveDemosForCcu().filter(d => !eligibleAppIds || eligibleAppIds.has(d.steam_app_id));
  const result: CcuRunResult = { attempted: demos.length, succeeded: 0, failed: 0, unavailable: 0, rateLimited: false, failureSample: [] };
  const batchSize = Math.max(1, Math.floor(options?.batchSize ?? 1));

  if (batchSize === 1) {
    for (const demo of demos) {
      try {
        await recordDemoCcu(demo, result);
      } catch (err) {
        if (err instanceof CcuRateLimitedError) {
          result.rateLimited = true;
          break;
        }
        throw err;
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  } else {
    for (let i = 0; i < demos.length; i += batchSize) {
      const batch = demos.slice(i, i + batchSize);
      try {
        await Promise.all(batch.map(demo => recordDemoCcu(demo, result)));
      } catch (err) {
        if (err instanceof CcuRateLimitedError) {
          result.rateLimited = true;
          break;
        }
        throw err;
      }
      if (delayMs > 0 && i + batchSize < demos.length) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  if (result.rateLimited) {
    log(`demos CCU run rate-limited by Steam; aborted after ${result.succeeded}/${result.attempted} — remaining demos keep their last good samples`, "demos-ccu");
  }
  log(`demos CCU run: attempted=${result.attempted} succeeded=${result.succeeded} failed=${result.failed}`, "demos-ccu");
  return result;
}
