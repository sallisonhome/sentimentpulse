/**
 * YouTube Data API v3 client with quota accounting.
 *
 * Quotas (developers.google.com/youtube/v3/determine_quota_cost, 2026-09-15):
 *   - search.list: its own bucket, 100 calls/day, 1 per call
 *   - everything else: 10,000 units/day, videos/commentThreads/comments.list = 1
 *   - quotas reset at midnight Pacific; invalid requests still cost ≥1
 *
 * Every request is charged BEFORE it is sent (so failures are counted) and
 * refused when the bucket's configured ceiling would be exceeded. Ceilings sit
 * below Google's limits to leave room for manual dry-runs.
 */
import type { YtDb } from "./db";

export const SEARCH_CALLS_CEILING = 95;
export const UNITS_CEILING = 9500;
const TIMEOUT_MS = 20_000;
const BASE = "https://www.googleapis.com/youtube/v3";

export type Bucket = "search" | "units";

export function ptDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function quotaUsed(db: YtDb, bucket: Bucket, now = new Date()): number {
  const r = db.prepare("SELECT used FROM yt_quota_daily WHERE pt_date=? AND bucket=?").get(ptDate(now), bucket) as any;
  return r?.used ?? 0;
}

export function quotaRemaining(db: YtDb, bucket: Bucket, now = new Date()): number {
  const ceiling = bucket === "search" ? SEARCH_CALLS_CEILING : UNITS_CEILING;
  return Math.max(0, ceiling - quotaUsed(db, bucket, now));
}

function charge(db: YtDb, bucket: Bucket, cost: number) {
  db.prepare(`INSERT INTO yt_quota_daily (pt_date, bucket, used) VALUES (?, ?, ?)
    ON CONFLICT(pt_date, bucket) DO UPDATE SET used = used + excluded.used`).run(ptDate(), bucket, cost);
}

export class QuotaExhaustedError extends Error {
  constructor(public bucket: Bucket) { super(`YouTube ${bucket} quota ceiling reached for ${ptDate()} PT`); }
}

export class YouTubeApiError extends Error {
  constructor(public status: number, public reason: string, message: string) { super(message); }
}

export interface ApiCounters { searchCalls: number; units: number }

export class YouTubeClient {
  counters: ApiCounters = { searchCalls: 0, units: 0 };
  constructor(private db: YtDb, private apiKey: string, private fetchImpl: typeof fetch = fetch) {}

  private async get(path: string, params: Record<string, string | number | null | undefined>, bucket: Bucket): Promise<any> {
    if (quotaRemaining(this.db, bucket) < 1) throw new QuotaExhaustedError(bucket);
    charge(this.db, bucket, 1);
    if (bucket === "search") this.counters.searchCalls++; else this.counters.units++;
    const qs = new URLSearchParams();
    // SQLite continuation columns are NULL after a completed sweep.
    // Never send the literal pageToken=null to YouTube.
    for (const [k, v] of Object.entries(params)) if (v != null && v !== "") qs.set(k, String(v));
    qs.set("key", this.apiKey);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(`${BASE}/${path}?${qs}`, { signal: ctrl.signal, headers: { Accept: "application/json" } });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        const reason = body?.error?.errors?.[0]?.reason || body?.error?.status || "unknown";
        // Google's own quota refusal: stop the run the same way as our ceiling.
        // Daily refusals also pin our local counter to the ceiling so later calls today short-circuit.
        if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
          charge(this.db, bucket, Math.max(0, quotaRemaining(this.db, bucket)));
          throw new QuotaExhaustedError(bucket);
        }
        if (reason === "rateLimitExceeded") throw new QuotaExhaustedError(bucket);
        throw new YouTubeApiError(res.status, reason, `YouTube ${path} ${res.status} ${reason}: ${body?.error?.message ?? ""}`.trim());
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  search(p: { q: string; publishedAfter?: string; publishedBefore?: string; pageToken?: string }) {
    return this.get("search", {
      part: "snippet", type: "video", order: "date", maxResults: 50, q: p.q,
      publishedAfter: p.publishedAfter, publishedBefore: p.publishedBefore, pageToken: p.pageToken,
      safeSearch: "none",
    }, "search");
  }

  videos(ids: string[]) {
    return this.get("videos", { part: "snippet,statistics,contentDetails", id: ids.join(","), maxResults: 50 }, "units");
  }

  commentThreads(p: { videoId: string; pageToken?: string }) {
    return this.get("commentThreads", {
      part: "snippet,replies", videoId: p.videoId, order: "time", maxResults: 100,
      textFormat: "plainText", pageToken: p.pageToken,
    }, "units");
  }

  commentsByParent(p: { parentId: string; pageToken?: string }) {
    return this.get("comments", { part: "snippet", parentId: p.parentId, maxResults: 100, textFormat: "plainText", pageToken: p.pageToken }, "units");
  }

  commentsById(ids: string[]) {
    return this.get("comments", { part: "snippet", id: ids.join(","), textFormat: "plainText" }, "units");
  }
}
