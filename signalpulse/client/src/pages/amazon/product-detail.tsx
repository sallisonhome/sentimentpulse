/**
 * Amazon Retail — Product detail (`/amazon/product/:asin`).
 *
 * Four tabs: Overview / Also Bought / Rank History / Reviews.
 * Overview shows the latest scraped product record + the ASIN pin (if any)
 * + today's chart appearance. The other tabs hit their own endpoints for
 * data.
 *
 * v3.36 (2026-09-07):
 * - server now returns a proper `product` display record for competitor
 *   ASINs (previously null → blank page for anything not in amazon_asin_map).
 * - `chartToday` is a single {platform, rank, rawRank} instead of a
 *   per-platform bag → header renders correctly.
 * - `platformBsr` + `platformBsrCategory` surface Amazon's per-platform
 *   bestseller rank ("#30 in PlayStation 5 Games") in Overview.
 * - RankHistory reads `data.rows` (client contract) — the server now
 *   returns both `rows` and legacy `points`.
 * - Reviews tab is real: reads from /reviews and can force a refresh.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExternalLink, ArrowLeft, RefreshCw, ShieldCheck, ThumbsUp } from "lucide-react";
import { useState } from "react";
import { apiRequest } from "@/lib/queryClient";

interface ProductDetail {
  asin: string;
  product: {
    asin: string;
    platform: string | null;
    title: string;
    imageUrl: string | null;
    link: string | null;
    productId: number | null;
    isTracked: boolean;
    isSwitch2: boolean;
  } | null;
  pin: any;
  latestProduct: {
    title: string;
    brand: string | null;
    price: number | null;
    currency: string | null;
    availability: string | null;
    rating: number | null;
    ratingsTotal: number | null;
    imageUrl: string | null;
    link: string | null;
    scrapedAt: string | null;
    buyboxSeller: string | null;
    buyboxIsAmazon: number | null;
    isPrime: number | null;
    mainBsr: number | null;
    recentSales: number | null;
    monthlySalesEstimate: number | null;
    weeklySalesEstimate: number | null;
    snapshotDate: string | null;
  } | null;
  chartToday: {
    platform: string;
    rank: number;
    rawRank: number | null;
  } | null;
  sparkline: Array<{ snapshotDate: string; rank: number; rawRank: number | null }>;
  sparklinePlatform: string | null;
  platformBsr: number | null;
  platformBsrCategory: string | null;
}

interface AlsoBoughtResponse {
  asin: string;
  snapshotDate: string | null;
  recommendations: Array<{
    recommendedAsin: string;
    position: number | null;
    title: string | null;
    imageUrl: string | null;
    isTracked: boolean;
  }>;
}

interface RankHistoryResponse {
  platform: string;
  asin: string;
  rows: Array<{ snapshotDate: string; rank: number; rawRank: number | null }>;
  points?: Array<{ date: string; rank: number; rawRank: number | null }>;
}

interface ReviewsResponse {
  asin: string;
  latestFetch: string | null;
  reviews: Array<{
    reviewId: string;
    title: string | null;
    body: string | null;
    rating: number | null;
    reviewDate: string | null;
    verifiedPurchase: number | null;
    helpfulVotes: number | null;
    reviewerName: string | null;
    variantAttrs: unknown;
    imageUrls: unknown;
    fetchedAt: string | null;
  }>;
}

function MiniSparkline({ points }: { points: Array<{ rank: number }> }) {
  if (!points.length) return null;
  const w = 200;
  const h = 40;
  const ranks = points.map((p) => p.rank);
  const min = Math.min(...ranks);
  const max = Math.max(...ranks);
  const span = Math.max(1, max - min);
  const d = points
    .map((p, i) => {
      const x = (i / Math.max(1, points.length - 1)) * w;
      // Invert: lower rank number = higher on chart
      const y = ((p.rank - min) / span) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} className="text-muted-foreground">
      <path d={d} stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface ProductDetailProps {
  params: { asin: string };
}

export default function AmazonProductDetail({ params }: ProductDetailProps) {
  const asin = params.asin;
  const [, navigate] = useLocation();

  const { data: detail, isLoading } = useQuery<ProductDetail>({
    queryKey: [`/api/amazon/product/${asin}`],
  });
  const { data: alsoBought } = useQuery<AlsoBoughtResponse>({
    queryKey: [`/api/amazon/product/${asin}/also-bought`],
  });

  const lp = detail?.latestProduct ?? null;
  const title = lp?.title ?? detail?.product?.title ?? `ASIN ${asin}`;
  const image = lp?.imageUrl ?? detail?.product?.imageUrl ?? null;
  // Resolve platform for the header + rank-history tab. Prefer the pin's
  // platform, fall back to the platform behind today's chart rank, then to
  // whatever platform has the freshest sparkline data.
  const platform: string | null =
    detail?.product?.platform ??
    detail?.chartToday?.platform ??
    detail?.sparklinePlatform ??
    null;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <button
        onClick={() => navigate("/amazon")}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        data-testid="button-back-to-amazon"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Amazon Retail
      </button>

      {isLoading ? (
        <Skeleton className="h-32 w-full rounded-xl" />
      ) : (
        <Card className="p-4 flex gap-4">
          {image ? (
            <img src={image} alt={title} className="h-24 w-24 object-cover rounded" />
          ) : (
            <div className="h-24 w-24 rounded bg-muted" />
          )}
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg font-semibold truncate">{title}</h1>
              {detail?.product?.isTracked && (
                <Badge variant="outline" style={{ borderColor: "#C0553A", color: "#C0553A" }}>
                  Tracked
                </Badge>
              )}
              {platform && (
                <Badge variant="secondary" className="uppercase text-[10px]">{platform}</Badge>
              )}
              {detail?.product?.isSwitch2 && <Badge variant="secondary">Switch 2</Badge>}
            </div>
            <div className="text-xs text-muted-foreground tabular-nums flex items-center gap-3 flex-wrap">
              <span>ASIN {asin}</span>
              {lp?.price != null && (
                <span>
                  ${lp.price.toFixed(2)}
                  {lp.currency && lp.currency !== "USD" ? ` ${lp.currency}` : ""}
                </span>
              )}
              {lp?.rating != null && (
                <span>★ {lp.rating.toFixed(1)} ({(lp.ratingsTotal ?? 0).toLocaleString()})</span>
              )}
              {detail?.chartToday && detail.chartToday.platform && (
                <span>
                  Today #{detail.chartToday.rank} on {detail.chartToday.platform}
                </span>
              )}
              {detail?.platformBsr != null && detail?.platformBsrCategory && (
                <span>
                  #{detail.platformBsr.toLocaleString()} in {detail.platformBsrCategory}
                </span>
              )}
              {(lp?.link ?? detail?.product?.link) && (
                <a
                  href={(lp?.link ?? detail?.product?.link)!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 hover:text-foreground"
                >
                  Amazon <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
            {detail?.sparkline && detail.sparkline.length > 1 && (
              <div className="pt-2">
                <MiniSparkline points={detail.sparkline} />
              </div>
            )}
          </div>
        </Card>
      )}

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview" data-testid="tab-product-overview">Overview</TabsTrigger>
          <TabsTrigger value="also-bought" data-testid="tab-product-also-bought">Also Bought</TabsTrigger>
          <TabsTrigger value="rank-history" data-testid="tab-product-rank-history">Rank History</TabsTrigger>
          <TabsTrigger value="reviews" data-testid="tab-product-reviews">Reviews</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="pt-4">
          <Card className="p-4 space-y-2 text-xs">
            {!lp ? (
              <div className="text-muted-foreground">No product detail scraped yet.</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-1.5 tabular-nums">
                {lp.price != null && (
                  <OverviewRow label="Buybox price" value={`$${lp.price.toFixed(2)}${lp.currency && lp.currency !== "USD" ? ` ${lp.currency}` : ""}`} />
                )}
                {lp.availability && <OverviewRow label="Availability" value={lp.availability} />}
                {lp.buyboxSeller && (
                  <OverviewRow
                    label="Buybox seller"
                    value={
                      <span className="inline-flex items-center gap-1.5">
                        {lp.buyboxSeller}
                        {lp.buyboxIsAmazon ? (
                          <Badge variant="outline" className="text-[9px] px-1">Amazon</Badge>
                        ) : null}
                        {lp.isPrime ? (
                          <Badge variant="outline" className="text-[9px] px-1">Prime</Badge>
                        ) : null}
                      </span>
                    }
                  />
                )}
                {lp.rating != null && (
                  <OverviewRow
                    label="Rating"
                    value={`★ ${lp.rating.toFixed(1)} (${(lp.ratingsTotal ?? 0).toLocaleString()} ratings)`}
                  />
                )}
                {detail?.platformBsr != null && detail?.platformBsrCategory && (
                  <OverviewRow
                    label="Platform BSR"
                    value={`#${detail.platformBsr.toLocaleString()} in ${detail.platformBsrCategory}`}
                  />
                )}
                {lp.mainBsr != null && (
                  <OverviewRow label="Main BSR" value={`#${lp.mainBsr.toLocaleString()}`} />
                )}
                {lp.recentSales != null && (
                  <OverviewRow label="Recent sales" value={lp.recentSales.toLocaleString()} />
                )}
                {lp.monthlySalesEstimate != null && (
                  <OverviewRow
                    label="Monthly sales est."
                    value={lp.monthlySalesEstimate.toLocaleString()}
                  />
                )}
                {lp.weeklySalesEstimate != null && (
                  <OverviewRow
                    label="Weekly sales est."
                    value={lp.weeklySalesEstimate.toLocaleString()}
                  />
                )}
                {lp.brand && <OverviewRow label="Brand" value={lp.brand} />}
                {lp.snapshotDate && (
                  <OverviewRow label="Snapshot date" value={lp.snapshotDate} />
                )}
                {lp.scrapedAt && (
                  <OverviewRow
                    label="Last scraped"
                    value={new Date(lp.scrapedAt).toLocaleString()}
                  />
                )}
              </div>
            )}
          </Card>
        </TabsContent>

        <TabsContent value="also-bought" className="pt-4">
          <Card className="overflow-hidden">
            {!alsoBought || alsoBought.recommendations.length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">
                No "customers also bought" data yet.
              </div>
            ) : (
              <div className="divide-y">
                {alsoBought.recommendations.map((r) => (
                  <a
                    key={r.recommendedAsin}
                    href={`#/amazon/product/${r.recommendedAsin}`}
                    className="flex items-center gap-3 px-4 py-2 hover:bg-accent/50 transition-colors"
                    data-testid={`row-also-bought-${r.recommendedAsin}`}
                  >
                    {r.imageUrl ? (
                      <img src={r.imageUrl} alt={r.title ?? r.recommendedAsin} className="h-8 w-8 rounded object-cover" />
                    ) : (
                      <div className="h-8 w-8 rounded bg-muted" />
                    )}
                    <div className="flex-1 min-w-0 text-xs">
                      <div className="font-medium truncate">{r.title ?? r.recommendedAsin}</div>
                      <div className="text-muted-foreground text-[10px]">
                        ASIN {r.recommendedAsin}
                        {r.position ? ` · pos ${r.position}` : ""}
                      </div>
                    </div>
                    {r.isTracked && (
                      <Badge variant="outline" style={{ borderColor: "#C0553A", color: "#C0553A" }}>
                        Tracked
                      </Badge>
                    )}
                  </a>
                ))}
              </div>
            )}
          </Card>
        </TabsContent>

        <TabsContent value="rank-history" className="pt-4">
          <RankHistoryPanel platform={platform} asin={asin} />
        </TabsContent>

        <TabsContent value="reviews" className="pt-4">
          <ReviewsPanel asin={asin} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function OverviewRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

function RankHistoryPanel({ platform, asin }: { platform: string | null; asin: string }) {
  // If we don't have a platform yet, don't fire the query with a bogus slug.
  const enabled = !!platform;
  const { data, isLoading } = useQuery<RankHistoryResponse>({
    queryKey: [`/api/amazon/charts/${platform ?? "ps5"}/history/${asin}`],
    enabled,
  });
  if (!enabled) {
    return (
      <Card className="p-6 text-center text-xs text-muted-foreground">
        No platform assigned to this ASIN yet.
      </Card>
    );
  }
  if (isLoading) return <Skeleton className="h-40 w-full rounded-xl" />;
  const rows = data?.rows ?? [];
  if (rows.length === 0) {
    return (
      <Card className="p-6 text-center text-xs text-muted-foreground">
        No rank history on {platform} yet.
      </Card>
    );
  }
  return (
    <Card className="overflow-hidden">
      <div className="divide-y">
        {rows.map((r) => (
          <div key={r.snapshotDate} className="flex items-center justify-between px-4 py-1.5 text-xs tabular-nums">
            <span>{r.snapshotDate}</span>
            <span>
              #{r.rank}
              {r.rawRank != null && r.rawRank !== r.rank && (
                <span className="text-muted-foreground ml-2">(A#{r.rawRank})</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function ReviewsPanel({ asin }: { asin: string }) {
  const queryClient = useQueryClient();
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const { data, isLoading } = useQuery<ReviewsResponse>({
    queryKey: [`/api/amazon/product/${asin}/reviews`],
  });

  const refresh = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/amazon/product/${asin}/reviews/refresh`);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      setRefreshError(null);
      queryClient.invalidateQueries({ queryKey: [`/api/amazon/product/${asin}/reviews`] });
    },
    onError: (err: unknown) => {
      setRefreshError(err instanceof Error ? err.message : String(err));
    },
  });

  const reviews = data?.reviews ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {data?.latestFetch
            ? `Last fetched ${new Date(data.latestFetch).toLocaleString()}`
            : "No reviews fetched for this ASIN yet."}
          {reviews.length > 0 && ` · ${reviews.length} stored`}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          data-testid="button-refresh-reviews"
        >
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${refresh.isPending ? "animate-spin" : ""}`} />
          {refresh.isPending ? "Fetching..." : "Refresh from Amazon"}
        </Button>
      </div>

      {refreshError && (
        <Card className="p-3 text-xs text-red-500 border-red-500/40">
          Refresh failed: {refreshError}
        </Card>
      )}

      {isLoading ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : reviews.length === 0 ? (
        <Card className="p-6 text-center text-xs text-muted-foreground">
          No reviews stored yet. Click "Refresh from Amazon" to pull the latest 20 reviews.
        </Card>
      ) : (
        <div className="space-y-2">
          {reviews.map((r) => (
            <Card key={r.reviewId} className="p-3 space-y-1.5" data-testid={`row-review-${r.reviewId}`}>
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2 text-xs">
                  {r.rating != null && (
                    <span className="tabular-nums font-medium">★ {r.rating.toFixed(1)}</span>
                  )}
                  {r.title && <span className="font-medium truncate">{r.title}</span>}
                </div>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  {r.verifiedPurchase ? (
                    <span className="inline-flex items-center gap-1">
                      <ShieldCheck className="h-3 w-3" />
                      Verified
                    </span>
                  ) : null}
                  {r.helpfulVotes != null && r.helpfulVotes > 0 && (
                    <span className="inline-flex items-center gap-1 tabular-nums">
                      <ThumbsUp className="h-3 w-3" />
                      {r.helpfulVotes}
                    </span>
                  )}
                  {r.reviewDate && <span className="tabular-nums">{r.reviewDate}</span>}
                </div>
              </div>
              {r.body && (
                <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
                  {r.body}
                </p>
              )}
              {r.reviewerName && (
                <div className="text-[10px] text-muted-foreground">— {r.reviewerName}</div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
