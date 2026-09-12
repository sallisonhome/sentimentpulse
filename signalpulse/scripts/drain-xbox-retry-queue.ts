/**
 * scripts/drain-xbox-retry-queue.ts   (2026-09-12)
 *
 * Hourly worker. Pulls every retry-queue row whose next_attempt_at has
 * elapsed and runs the 3-source resolver against each bigId. Successes are
 * landed in xbox_title_cache (immutable) and removed from the queue.
 * Failures have their attempt counter bumped and next_attempt_at pushed
 * out by the schedule the resolver owns (hourly for 24h, then daily).
 *
 * Empty queue / nothing due = fast no-op, cron can run every hour cheaply.
 * Never fails loudly \u2014 exit 0 either way, structured stdout for the log.
 */

import { drainXboxRetryQueue } from "../server/signals/console/xbox-title-resolver";
import { rawSqlite } from "../server/storage";

async function main() {
  const started = new Date().toISOString();
  const beforeCache = (rawSqlite.prepare(`SELECT COUNT(*) AS n FROM xbox_title_cache`).get() as { n: number }).n;
  const beforeQueue = (rawSqlite.prepare(`SELECT COUNT(*) AS n FROM xbox_bigid_retry_queue`).get() as { n: number }).n;
  const dueNow = (rawSqlite.prepare(
    `SELECT COUNT(*) AS n FROM xbox_bigid_retry_queue WHERE next_attempt_at <= ?`,
  ).get(started) as { n: number }).n;

  console.log(`[drain-xbox-retry-queue] started=${started}`);
  console.log(`[drain-xbox-retry-queue] cache_size_before=${beforeCache} queue_size_before=${beforeQueue} due_now=${dueNow}`);

  if (dueNow === 0) {
    console.log(`[drain-xbox-retry-queue] nothing due — exiting`);
    return;
  }

  const res = await drainXboxRetryQueue();
  const afterCache = (rawSqlite.prepare(`SELECT COUNT(*) AS n FROM xbox_title_cache`).get() as { n: number }).n;
  const afterQueue = (rawSqlite.prepare(`SELECT COUNT(*) AS n FROM xbox_bigid_retry_queue`).get() as { n: number }).n;

  console.log(`[drain-xbox-retry-queue] attempted=${res.attempted} landed=${res.landed} stillQueued=${res.stillQueued}`);
  console.log(`[drain-xbox-retry-queue] cache_size_after=${afterCache} queue_size_after=${afterQueue}`);
}

main().then(() => process.exit(0)).catch(err => { console.error("[drain-xbox-retry-queue] fatal", err); process.exit(1); });
