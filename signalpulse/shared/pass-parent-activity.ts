export type ActivityWindow = "latest" | "d7" | "d30";
export const ACTIVITY_GATES = { maxSkewMs: 10_000, maxRequestMs: 30_000,
  maxAgeHours: 36, minParentCcu: 10, minDayCoverage: 0.8 } as const;
export const ACTIVITY_STATUS_LABELS = {
  available: "Available", shared_runtime: "Shared runtime",
  unverified: "Parent/runtime unverified", no_samples: "Awaiting paired sample",
  stale: "Stale paired sample", failed: "Pair refresh failed",
  insufficient_history: "Building paired history", low_parent: "Parent activity too low",
} as const;
export type ActivityStatus = keyof typeof ACTIVITY_STATUS_LABELS;
export interface PassParentActivity {
  status: ActivityStatus;
  window: ActivityWindow;
  ratio: number | null;
  sharePercent: number | null;
  changePercentagePoints: number | null;
  parentAppId: string | null;
  parentName: string | null;
  evidenceUrl: string | null;
  verifiedAt: string | null;
  sampledAt: string | null;
  passCcu: number | null;
  parentCcu: number | null;
  skewMs: number | null;
  sampleDays: number;
  requiredDays: number;
  periodStart: string | null;
  periodEnd: string | null;
}
