export interface DashboardDemoDownloads {
  demoAppId: string;
  demoName: string;
  lifetimeDownloads: number | null;
  valueKind: "steamworks_actual" | "unavailable";
  asOfDate: string | null;
  fetchedAt: string | null;
  sourceUrl: string | null;
  refreshFailed: boolean;
  isArchived: boolean;
  isStale: boolean;
}
