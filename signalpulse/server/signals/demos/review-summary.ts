import { rawSqlite } from "../../storage";

export interface DemoReviewSummary {
  positive: number;
  negative: number;
  total: number;
  positivePercent: number | null;
}

/** Histogram rollups cover lifetime. Never add overlapping recent daily
 * buckets to them, or mix old weekly and newer monthly representations.
 * App IDs are the demo's own; no parent-game join or fallback is permitted.
 */
export function loadDemoReviewSummaries(): Map<string, DemoReviewSummary> {
  const groups = rawSqlite.prepare(`
    SELECT h.app_id,h.bucket_granularity AS grain,
      SUM(h.recommendations_up) AS positive,SUM(h.recommendations_down) AS negative,
      MIN(h.bucket_start) AS coverage_start,MAX(h.created_at) AS newest_bucket_seen,
      t.release_date
    FROM steam_review_history h JOIN demo_titles t ON t.steam_app_id=h.app_id
    WHERE t.tracking_excluded_reason IS NULL AND (t.is_active=1 OR t.sku_kind='demo')
    GROUP BY h.app_id,h.bucket_granularity
    ORDER BY h.app_id,
      CASE h.bucket_granularity WHEN 'day' THEN 1 ELSE 0 END,
      newest_bucket_seen DESC,
      CASE h.bucket_granularity WHEN 'month' THEN 0 ELSE 1 END
  `).all() as Array<{ app_id: string; grain: string; positive: number; negative: number;
    coverage_start: number; newest_bucket_seen: string; release_date: string | null }>;
  const summaries = new Map<string, DemoReviewSummary>();
  for (const group of groups) {
    if (summaries.has(group.app_id) || !["day", "week", "month"].includes(group.grain)) continue;
    if (group.grain === "day") {
      // Recent-only daily data cannot establish a lifetime score for an older
      // demo. A date-only release boundary is intentionally conservative.
      const release = group.release_date ? Date.parse(`${group.release_date}T00:00:00Z`) : NaN;
      if (!Number.isFinite(release) || release < group.coverage_start * 1000 || release > Date.now()) continue;
    }
    const { positive, negative } = group;
    const total = positive + negative;
    summaries.set(group.app_id, { positive, negative, total,
      positivePercent: total > 0 ? positive / total * 100 : null });
  }
  return summaries;
}
