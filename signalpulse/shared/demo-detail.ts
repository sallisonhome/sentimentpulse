export type DemoRange = "7" | "30" | "90" | "365" | "all";
export interface DemoHistoryPoint {
  date: string;
  dailyDownloads: number | null;
  lifetimeDownloads: number | null;
  downloadObservedAt: string | null;
  reportEndDate: string | null;
  downloadMethod: string | null;
  multiplierId: string | null;
  reviewsAdded: number | null;
  positiveAdded: number | null;
  negativeAdded: number | null;
  reviewBucketObservedAt: string | null;
  totalReviews: number | null;
  positivePercent: number | null;
  reviewObservedAt: string | null;
  reviewSource: string | null;
  ccuLatest: number | null;
  ccuPeak: number | null;
  ccuSamples: number | null;
}
export interface DemoMedia {
  igdbId: number; name?: string; summary: string | null;
  screenshotIds: string[]; videoIds: string[];
  coverId?: string | null; genres?: string[]; developers?: string[]; publishers?: string[];
  releaseDate?: string | null;
  matchedAppId: string; scope: "demo" | "parent";
}
export interface DemoMediaResponse {
  media: DemoMedia | null; fetchedAt: string | null;
  status: "matched" | "no_match" | "unavailable"; stale: boolean;
}
export interface DemoDetail {
  appId: string; name: string; isSaber: boolean; archived: boolean;
  genre: string | null; releaseDate: string | null;
  firstSeenAt: string; lastCheckedAt: string | null;
  start: string; end: string; range: DemoRange; multiplier: number | null;
  latest: {
    downloads: number | null; observedMinimum: boolean;
    reviews: number | null; positivePercent: number | null;
    ccu: number | null; peak: number | null; ccuObservedAt: string | null;
    actualsAsOf: string | null; actualsStale: boolean; actualsRefreshFailed: boolean;
  };
  rows: DemoHistoryPoint[];
  firstHistoryDate: string | null;
  latestWindows: Array<{ window: string; downloads: number | null; asOf: string | null; source: string }>;
}

export function demoHistoryCsv(data: DemoDetail): string {
  const keys: Array<keyof DemoHistoryPoint> = ["date","dailyDownloads","lifetimeDownloads","downloadObservedAt",
    "reportEndDate","downloadMethod","multiplierId","reviewsAdded","positiveAdded","negativeAdded",
    "reviewBucketObservedAt","totalReviews","positivePercent","reviewObservedAt","reviewSource","ccuLatest","ccuPeak","ccuSamples"];
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g,'""')}"`;
  return [
    ["appId","downloadBasis","dailyDownloadDefinition",...keys].join(","),
    ...data.rows.map(r=>[data.appId,data.isSaber ? "Steamworks actual" : "provisional review model",
      data.isSaber ? "net change in consecutive comparable observed LTD totals; not audited daily downloads" : `daily review bucket x ${data.multiplier}`,
      ...keys.map(k=>r[k])].map(cell).join(",")),
  ].join("\r\n");
}
