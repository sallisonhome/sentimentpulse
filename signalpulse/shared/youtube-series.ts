/** Shared API contract and exact-visible-data CSV export. Dates are UTC. */
export type YoutubeBucket = "day" | "week" | "month";
export interface YoutubeSeriesPoint {
  date: string;
  endDate: string;
  publishedVideos: number;
  shortFormVideos: number;
  collectedComments: number;
  snapshotVideos: number | null;
  knownCommentVideos: number | null;
  snapshotComments: number | null;
  snapshotViews: number | null;
  matchedVideos: number | null;
  netViews: number | null;
  netComments: number | null;
}
export interface YoutubeSeries {
  titleId: number; title: string; isSaber: boolean; parentTitle: string | null;
  start: string; end: string; bucket: YoutubeBucket; timezone: "UTC";
  includeArchived: boolean; generatedAt: string;
  firstSnapshot: string | null; lastSnapshot: string | null;
  retainedVideos: number; archivedVideos: number; retainedComments: number;
  rows: YoutubeSeriesPoint[];
}
function csvCell(v: unknown): string {
  if (v == null) return "";
  // Preserve signed numeric deltas, neutralize formula-like string fields.
  let s = String(v);
  if (typeof v === "string" && /^[\s]*[=+\-@]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}
export function youtubeSeriesCsv(s: YoutubeSeries): string {
  const fields: Array<keyof YoutubeSeriesPoint> = [
    "date", "endDate", "publishedVideos", "shortFormVideos", "collectedComments",
    "snapshotVideos", "knownCommentVideos", "snapshotComments", "snapshotViews",
    "matchedVideos", "netViews", "netComments",
  ];
  const headers = ["title_id", "title", "range_start", "range_end", "bucket", "timezone",
    "include_archived", "generated_at", ...fields];
  return "\uFEFF" + [headers.join(","), ...s.rows.map(r => [
    s.titleId, s.title, s.start, s.end, s.bucket, s.timezone, s.includeArchived, s.generatedAt,
    ...fields.map(k => r[k]),
  ].map(csvCell).join(","))].join("\r\n") + "\r\n";
}
