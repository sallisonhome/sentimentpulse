/**
 * Amazon Retail — Product detail (`/amazon/product/:asin`).
 *
 * Four tabs: Overview / Also Bought / Rank History / Reviews.
 * Overview shows the latest scraped product record + the ASIN pin (if any)
 * + today's chart appearance. The other tabs hit their own endpoints for
 * data (rank history from /charts/:platform/history/:asin and reviews
 * from the reviews-pulse endpoint filtered client-side).
 */
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, ArrowLeft } from "lucide-react";

interface ProductDetail {
  asin: string;
  product: {
    asin: string;
    platform: string | null;
    title: string;
    imageUrl: string | null;
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
  } | null;
  chartToday: {
    platform: string;
    rank: number;
    rawRank: number | null;
  } | null;
  sparkline: Array<{ snapshotDate: string; rank: number; rawRank: number | null }>;
  sparklinePlatform: string | null;
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

  const title = detail?.latestProduct?.title ?? detail?.product?.title ?? `ASIN ${asin}`;
  const image = detail?.latestProduct?.imageUrl ?? detail?.product?.imageUrl ?? null;
  const platform = detail?.product?.platform ?? detail?.chartToday?.platform ?? detail?.sparklinePlatform;

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
              {detail?.product?.isTracked && <Badge variant="outline" style={{ borderColor: "#C0553A", color: "#C0553A" }}>Tracked</Badge>}
              {platform && <Badge variant="secondary" className="uppercase text-[10px]">{platform}</Badge>}
              {detail?.product?.isSwitch2 && <Badge variant="secondary">Switch 2</Badge>}
            </div>
            <div className="text-xs text-muted-foreground tabular-nums flex items-center gap-3 flex-wrap">
              <span>ASIN {asin}</span>
              {detail?.latestProduct?.price != null && (
                <span>${detail.latestProduct.price.toFixed(2)}{detail.latestProduct.currency && detail.latestProduct.currency !== "USD" ? ` ${detail.latestProduct.currency}` : ""}</span>
              )}
              {detail?.latestProduct?.rating != null && (
                <span>★ {detail.latestProduct.rating.toFixed(1)} ({(detail.latestProduct.ratingsTotal ?? 0).toLocaleString()})</span>
              )}
              {detail?.chartToday && (
                <span>Today #{detail.chartToday.rank} on {detail.chartToday.platform}</span>
              )}
              {detail?.latestProduct?.link && (
                <a href={detail.latestProduct.link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
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
          <Card className="p-4 text-xs text-muted-foreground">
            {detail?.latestProduct?.availability && <div>Availability: {detail.latestProduct.availability}</div>}
            {detail?.latestProduct?.brand && <div>Brand: {detail.latestProduct.brand}</div>}
            {detail?.latestProduct?.scrapedAt && <div>Last scraped: {new Date(detail.latestProduct.scrapedAt).toLocaleString()}</div>}
            {!detail?.latestProduct && <div>No product detail scraped yet.</div>}
          </Card>
        </TabsContent>

        <TabsContent value="also-bought" className="pt-4">
          <Card className="overflow-hidden">
            {!alsoBought || alsoBought.recommendations.length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">No "customers also bought" data yet.</div>
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
                      <div className="text-muted-foreground text-[10px]">ASIN {r.recommendedAsin}{r.position ? ` · pos ${r.position}` : ""}</div>
                    </div>
                    {r.isTracked && <Badge variant="outline" style={{ borderColor: "#C0553A", color: "#C0553A" }}>Tracked</Badge>}
                  </a>
                ))}
              </div>
            )}
          </Card>
        </TabsContent>

        <TabsContent value="rank-history" className="pt-4">
          <RankHistoryPanel platform={platform ?? "ps5"} asin={asin} />
        </TabsContent>

        <TabsContent value="reviews" className="pt-4">
          <Card className="p-4 text-xs text-muted-foreground">
            Review pulse for this ASIN is aggregated in the top-level Reviews view; per-ASIN review timeline is a Phase 2 refinement.
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function RankHistoryPanel({ platform, asin }: { platform: string; asin: string }) {
  const { data, isLoading } = useQuery<RankHistoryResponse>({
    queryKey: [`/api/amazon/charts/${platform}/history/${asin}`],
  });
  if (isLoading) return <Skeleton className="h-40 w-full rounded-xl" />;
  if (!data || data.rows.length === 0) {
    return <Card className="p-6 text-center text-xs text-muted-foreground">No rank history on {platform} yet.</Card>;
  }
  return (
    <Card className="overflow-hidden">
      <div className="divide-y">
        {data.rows.map((r) => (
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
