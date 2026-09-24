/**
 * YouTube Pulse — in-process daily scheduler.
 *
 * 04:30 America/New_York: after YouTube's midnight-Pacific quota reset
 * (03:00 ET) and before SentimentPulse's morning ingest, so the comment feed
 * is fresh when SentimentPulse reads it. Same 60-second wall-clock poll
 * pattern as amazon-cron.ts / leaderboard-digest.ts.
 *
 * Catch-up: if the process restarts after the slot (deploys), the first tick
 * after 04:30 ET still runs when today's scheduled run has not happened yet,
 * up to 20:00 ET, so a deploy never silently skips a day.
 */
import { ytDb } from "./db";
import { log } from "../log";

let timer: NodeJS.Timeout | null = null;

function easternParts(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "numeric", minute: "numeric", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24, minute: Number(get("minute")) };
}

export function scheduledRunDue(now: Date, lastScheduledEtDate: string | null): boolean {
  const { date, hour, minute } = easternParts(now);
  const minutes = hour * 60 + minute;
  return minutes >= 4 * 60 + 30 && minutes < 20 * 60 && lastScheduledEtDate !== date;
}

function lastScheduledRunEtDate(): string | null {
  const r = ytDb().prepare("SELECT started_at FROM yt_ingest_runs WHERE trigger='scheduled' ORDER BY id DESC LIMIT 1").get() as any;
  return r ? easternParts(new Date(r.started_at)).date : null;
}

export function startYoutubeCron(run: (trigger: string) => Promise<unknown>) {
  if (timer) return;
  log("YouTube Pulse cron started (daily 04:30 America/New_York, catch-up until 20:00)", "youtube");
  timer = setInterval(() => {
    try {
      if (!scheduledRunDue(new Date(), lastScheduledRunEtDate())) return;
      run("scheduled").catch((e) => log(`YouTube scheduled run error: ${e}`, "youtube"));
    } catch (e) {
      log(`YouTube cron tick error: ${e}`, "youtube");
    }
  }, 60_000);
}
