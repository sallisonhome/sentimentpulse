import type { DashboardDemoDownloads } from "@shared/demo-dashboard";

export function DashboardDemoDownloadSummary({ demos }: { demos?: DashboardDemoDownloads[] }) {
  if (!demos?.length) return null;
  return (
    <section className="mb-3 rounded-md border border-border bg-muted/30 px-3 py-2.5"
      aria-label="Lifetime demo downloads from Steamworks">
      <div className="text-xs font-medium text-muted-foreground">Demo downloads · lifetime</div>
      <div className="mt-1.5 space-y-2">
        {demos.map(demo => (
          <div key={demo.demoAppId} data-testid={`dashboard-demo-${demo.demoAppId}`}
            className="flex flex-col sm:flex-row sm:flex-wrap items-start justify-between gap-x-4 gap-y-1">
            <div className="min-w-0 flex-1">
              <div className="text-xs break-words">{demo.demoName}</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {demo.valueKind === "steamworks_actual" ? "Steamworks actual" : "Actuals unavailable"}
                {demo.isArchived ? " · Deactivated; lifetime only" : ""}
                {demo.refreshFailed ? " · Refresh failed" : demo.isStale && demo.lifetimeDownloads != null ? " · Stale snapshot" : ""}
              </div>
            </div>
            <div className="text-left sm:text-right shrink-0">
              <div className="text-base font-semibold tabular-nums" title="Steamworks all-history Total Downloads: users who recorded playtime or preloaded the demo. Not free licenses, paid sales, or a review-based estimate. Steam reporting may lag.">
                {demo.lifetimeDownloads == null ? "—" : demo.lifetimeDownloads.toLocaleString()}
              </div>
              {demo.fetchedAt && <div className="text-xs text-muted-foreground" title={`Retrieved ${demo.fetchedAt}; all-history report through ${demo.asOfDate}`}>
                Checked {demo.fetchedAt.slice(0, 10)}
              </div>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
