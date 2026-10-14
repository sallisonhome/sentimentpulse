/**
 * TikTok Pulse — daily schedule.
 *
 * Mirrors YouTube Pulse's `cron.ts`. Runs at 04:30 America/New_York with
 * catch-up through 20:00. Snapshots use UTC dates, so two runs on the same
 * UTC date do not create a new day-over-day comparison.
 */
import { ttDb, type TtDb } from "./db";
import { runPipeline } from "./pipeline";
import { EnsembleDataClient, ensembleTokenFromEnv } from "./api";
import { log } from "../log";

export const TIKTOK_RUN_HOUR = 4;
export const TIKTOK_RUN_MINUTE = 30;
export const TIKTOK_CATCHUP_END_HOUR = 20;

/** In-process daily scheduler. Mirrors youtube/cron.ts: daily 04:30
 * America/New_York, catch-up until 20:00 ET after a deploy. Registers via
 * index.ts so it actually runs (not just exported). */
let tiktokTimer: NodeJS.Timeout | null = null;

function easternPartsTikTok(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "numeric", minute: "numeric", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24, minute: Number(get("minute")) };
}

export function scheduledTikTokRunDue(now: Date, lastScheduledEtDate: string | null): boolean {
  const { date, hour, minute } = easternPartsTikTok(now);
  const minutes = hour * 60 + minute;
  return minutes >= TIKTOK_RUN_HOUR * 60 + TIKTOK_RUN_MINUTE && minutes < TIKTOK_CATCHUP_END_HOUR * 60 && lastScheduledEtDate !== date;
}

function lastScheduledTikTokRunEtDate(): string | null {
  const r = ttDb().prepare("SELECT started_at FROM tt_ingest_runs WHERE trigger='scheduled' ORDER BY id DESC LIMIT 1").get() as any;
  return r ? easternPartsTikTok(new Date(r.started_at)).date : null;
}

export function startTikTokCron(run: (trigger: string) => Promise<unknown>) {
  if (tiktokTimer) return;
  // Startup cleanup: mark any runs still 'running' as 'aborted'. A process
  // restart (deploy) kills the in-flight pipeline, but the run row stays
  // 'running' forever because nothing marks it failed. Runs 3 and 8 both
  // orphaned this way during signalpulse deploy restarts.
  try {
    const db = ttDb();
    const orphaned = db.prepare(`SELECT id FROM tt_ingest_runs WHERE status='running'`).all() as Array<{ id: number }>;
    if (orphaned.length) {
      db.prepare(`UPDATE tt_ingest_runs SET status='aborted', finished_at=?, message='aborted: orphaned by signalpulse restart' WHERE status='running'`)
        .run(new Date().toISOString());
      log(`TikTok Pulse: marked ${orphaned.length} orphaned run(s) as aborted (killed by restart): ${orphaned.map(r => r.id).join(", ")}`, "tiktok");
    }
  } catch (e) {
    log(`TikTok Pulse: failed to clean up orphaned runs: ${e}`, "tiktok");
  }
  log("TikTok Pulse cron started (daily 04:30 America/New_York, catch-up until 20:00)", "tiktok");
  tiktokTimer = setInterval(() => {
    try {
      if (!scheduledTikTokRunDue(new Date(), lastScheduledTikTokRunEtDate())) return;
      run("scheduled").catch((e) => log(`TikTok scheduled run error: ${e}`, "tiktok"));
    } catch (e) {
      log(`TikTok cron tick error: ${e}`, "tiktok");
    }
  }, 60_000);
}

export function isTikTokRunWindow(now = new Date()): boolean {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const h = et.getHours();
  if (h < TIKTOK_RUN_HOUR) return false;
  if (h >= TIKTOK_CATCHUP_END_HOUR) return false;
  if (h > TIKTOK_RUN_HOUR) return true;
  return et.getMinutes() >= TIKTOK_RUN_MINUTE;
}

export function buildEnsembleClient(): EnsembleDataClient | null {
  const tok = ensembleTokenFromEnv();
  if (!tok) return null;
  return new EnsembleDataClient({ token: tok });
}

export async function runDailyTikTok(db: TtDb, trigger: string, now = new Date()): Promise<{ id: number; status: string } | null> {
  if (!isTikTokRunWindow(now)) return null;
  const startedAt = now.toISOString();
  const ins = db.prepare(`INSERT INTO tt_ingest_runs (trigger, started_at, status)
    VALUES (?, ?, 'running')`).run(trigger, startedAt);
  const runRow = { id: Number(ins.lastInsertRowid) };
  const client = buildEnsembleClient();
  if (!client) {
    db.prepare(`UPDATE tt_ingest_runs SET finished_at=?, status='failed',
      message='EnsembleData token not configured' WHERE id=?`).run(now.toISOString(), runRow.id);
    return { id: runRow.id, status: "failed" };
  }
  await runPipeline(db, client, { extendedStorageApproved: true }, trigger, runRow);
  const row = db.prepare("SELECT status FROM tt_ingest_runs WHERE id=?").get(runRow.id) as any;
  return { id: runRow.id, status: row.status };
}
