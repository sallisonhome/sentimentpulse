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
  // Separate licenses metric (2026-10-17): Steamworks "Lifetime free
  // licenses" -- demo-SKU grants, NOT downloads. Displayed alongside
  // playtime downloads, never instead of them. Null when no snapshot.
  lifetimeFreeLicenses: number | null;
  licensesAsOf: string | null;
  licensesStale: boolean;
}
