/**
 * TikTok Pulse — daily schedule.
 *
 * Mirrors YouTube Pulse's `cron.ts`. Runs at 04:30 America/New_York with
 * catch-up through 20:00. Snapshots use UTC dates, so two runs on the same
 * UTC date do not create a new day-over-day comparison.
 */
import type { TtDb } from "./db";
import { runPipeline } from "./pipeline";
import { EnsembleDataClient, ensembleTokenFromEnv } from "./api";

export const TIKTOK_RUN_HOUR = 4;
export const TIKTOK_RUN_MINUTE = 30;
export const TIKTOK_CATCHUP_END_HOUR = 20;

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
