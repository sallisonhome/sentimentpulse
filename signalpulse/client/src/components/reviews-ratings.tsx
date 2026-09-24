import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import type { RatingStatus, ReviewsRatings } from "@shared/reviews-ratings";

const STATUS: Record<RatingStatus, string> = {
  ready: "", stale: "Cached score; refresh overdue", loading: "Checking latest scores…",
  unavailable: "Rating unavailable", not_found: "No verified OpenCritic match",
  unconfigured: "OpenCritic is not configured", ambiguous: "Title match needs verification",
  budget_exhausted: "Refresh paused: API allowance reached",
  rate_limited: "Refresh paused by provider", error: "Provider temporarily unavailable",
  unsupported: "No separate critic rating for this product",
};
function value(n: number | null, suffix: string) {
  return n == null ? "Not available" : `${Number(n.toFixed(suffix === " / 5" ? 2 : 1))}${suffix}`;
}
function date(stamp: string | null) {
  return stamp && Number.isFinite(Date.parse(stamp)) ? new Date(stamp).toISOString().slice(0, 10) : null;
}
export function ReviewsRatingsSection({ kind, id }: { kind: "steam" | "title" | "family" | "product" | "amazon"; id: string | number }) {
  const path = `/api/reviews-ratings/${kind}/${encodeURIComponent(id)}`;
  const query = useQuery<ReviewsRatings>({
    queryKey: [path], queryFn: async () => (await apiRequest("GET", path)).json(),
    staleTime: 30_000, retry: 1,
    refetchInterval: q => q.state.data?.refreshing && q.state.dataUpdateCount < 16 ? 3000 : false,
  });
  return <ReviewsRatingsView data={query.data} loading={query.isLoading} error={query.isError}
    retry={() => { void query.refetch(); }} />;
}

// Pure view also used by local UI QA; fixtures never enter production routes.
export function ReviewsRatingsView({ data, loading = false, error = false, retry }: {
  data?: ReviewsRatings; loading?: boolean; error?: boolean; retry?: () => void;
}) {
  const oc = data?.openCritic;
  return (
    <Card className="p-5 space-y-4 mb-6" data-testid="reviews-ratings-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Reviews and Ratings</h2>
        {(error || data?.refreshing) && retry &&
          <Button size="sm" variant="outline" onClick={retry} data-testid="ratings-retry">Check again</Button>}
      </div>
      <p className="text-xs text-muted-foreground">
        Latest available ratings, independent of the sales window. Player opinions and professional reviews use different scales.
      </p>
      {loading && <p role="status" className="text-sm text-muted-foreground">Loading ratings…</p>}
      {error && <p role="status" className="text-sm text-muted-foreground">Ratings could not be loaded. The rest of this product page is still available.</p>}
      {data && <>
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Player ratings</h3>
          {data.players.length === 0
            ? <p className="text-sm text-muted-foreground">{data.refreshing ? "Checking available storefronts…" : "No verified storefront ratings available for this product."}</p>
            : <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {data.players.map(p => (
                <div key={p.source} className="rounded-lg border p-4 min-w-0 space-y-2" data-testid={`rating-${p.source}`}>
                  {p.url ? <a href={p.url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium underline underline-offset-4">{p.label}</a>
                    : <div className="text-sm font-medium">{p.label}</div>}
                  <div className="text-xl font-semibold tabular-nums">{value(p.value, p.scale === 100 ? "% positive" : " / 5")}</div>
                  {p.description && <p className="text-xs text-muted-foreground">{p.description}</p>}
                  {p.count != null && <p className="text-xs text-muted-foreground">{p.count.toLocaleString()} {p.source === "steam" ? "Steam-purchase reviews · all languages" : "player ratings"}</p>}
                  {date(p.capturedAt) && <p className="text-xs text-muted-foreground">Captured {date(p.capturedAt)}</p>}
                  {p.status !== "ready" && <p className="text-xs text-muted-foreground" role="status">{STATUS[p.status]}</p>}
                </div>
              ))}
            </div>}
        </div>
        <div className="space-y-2 border-t pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">OpenCritic · Professional reviews</h3>
            {oc?.url && <a href={oc.url} target="_blank" rel="noopener noreferrer" className="text-xs underline underline-offset-4" data-testid="opencritic-source">View on OpenCritic</a>}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              ["Critics Recommend", value(oc?.criticsRecommend ?? null, "%")],
              ["Top Critic Score", value(oc?.topCriticScore ?? null, " / 100")],
              ["OpenCritic Rating", oc?.rating ?? "Not available"],
            ].map(([label, text], i) => <div key={label} className="rounded-lg border p-4 min-w-0 space-y-2" data-testid={`rating-critic-${i}`}>
              <div className="text-sm text-muted-foreground">{label}</div>
              <div className="text-xl font-semibold tabular-nums">{text}</div>
            </div>)}
          </div>
          {oc?.name && <p className="text-xs text-muted-foreground" data-testid="critic-aggregate-title">Review aggregate: {oc.name}</p>}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {oc?.reviewCount != null && <span>{oc.reviewCount.toLocaleString()} critic reviews</span>}
            {oc && date(oc.capturedAt) && <span>Captured {date(oc.capturedAt)}</span>}
            {oc && oc.status !== "ready" && <span role="status">{STATUS[oc.status]}</span>}
          </div>
          <p className="text-xs text-muted-foreground">Title-level critic aggregate, not platform-specific. OpenCritic data via OmkarCloud; viewed titles refresh after 24 hours when available.</p>
        </div>
      </>}
    </Card>
  );
}
