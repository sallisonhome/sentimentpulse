/**
 * CCU Detail — standalone page (`/ccu/:id`).
 *
 * The Saber Steam CCU Leaderboard's title link opens THIS page, not the
 * generic multi-purpose Product Detail page (`/products/:id`, which bundles
 * Wishlist/Sales/PS5/Forecast cards for the title). This page is a single-
 * topic view of concurrent-player data only, styled after howmanyareplaying's
 * GameDetail page (hero + stat badges + media + history/hourly charts +
 * related titles, all on one scroll) rather than nested inside SignalPulse's
 * collapsible-section PDP.
 *
 * Reuses the same content blocks as ccu-pdp-section.tsx's embedded
 * <CcuPdpSection> (that section still renders as-is inside the generic PDP
 * for anyone landing there via Dashboard/Add Product/etc.) so the two
 * surfaces never drift apart on data or chart behavior — only the header/
 * layout differ.
 */
import { useQuery } from "@tanstack/react-query";
import { useParams } from "wouter";
import { ArrowLeft, Gamepad2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate, getPlatformClass, getPlayerFormatLabel } from "@/lib/utils";
import {
  StatBadge,
  GameMediaCarousel,
  CcuHistoryChart,
  CcuHourlyChart,
  RelatedGamesGrid,
  type CcuKpiCard,
  type IgdbMediaResult,
  type RelatedGame,
} from "@/components/ccu-pdp-section";

interface CcuHeader {
  productId: number;
  title: string;
  publisher: string;
  releaseDate: string | null;
  genre: string | null;
  playerFormat: string | null;
  targetRetailPriceUsd: number | null;
  platforms: string[];
  headerImage: string | null;
}

function formatNumber(n: number | null): string {
  return n == null ? "—" : n.toLocaleString("en-US");
}

export default function CcuDetail() {
  const params = useParams<{ id: string }>();
  const productId = parseInt(params.id!);

  const { data: header, isLoading } = useQuery<CcuHeader>({
    queryKey: ["/api/products", productId, "ccu", "header"],
  });
  const { data: kpi } = useQuery<CcuKpiCard>({
    queryKey: ["/api/products", productId, "ccu", "kpi"],
  });
  const { data: media } = useQuery<IgdbMediaResult>({
    queryKey: ["/api/products", productId, "ccu", "media"],
  });
  const { data: related } = useQuery<RelatedGame[]>({
    queryKey: ["/api/products", productId, "ccu", "related"],
  });

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      {/* Explicit ?board=ccu#/ (not a relative "#/") so this always lands
          back on the CCU tab, regardless of which tab's outer query string
          was active before navigating here. */}
      <a
        href="?board=ccu#/"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        data-testid="link-back-to-ccu-leaderboard"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to CCU Leaderboard
      </a>

      {isLoading ? (
        <Skeleton className="h-32 w-full rounded-xl" />
      ) : !header ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">Title not found.</Card>
      ) : (
        <Card className="p-5 flex flex-wrap items-start gap-5" data-testid="card-ccu-hero">
          {header.headerImage ? (
            <img
              src={header.headerImage}
              alt={header.title}
              className="h-[69px] w-[184px] rounded-md object-cover shrink-0 bg-muted"
              data-testid="img-ccu-hero-keyart"
            />
          ) : (
            <div className="h-[69px] w-[184px] rounded-md bg-muted flex items-center justify-center shrink-0">
              <Gamepad2 className="h-6 w-6 text-muted-foreground/40" />
            </div>
          )}

          <div className="flex-1 min-w-[240px] space-y-2">
            <h1 className="text-xl font-semibold" data-testid="text-ccu-hero-title">{header.title}</h1>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>Publisher: <strong className="text-foreground">{header.publisher}</strong></span>
              {header.releaseDate && (
                <span>Release: <strong className="text-foreground">{formatDate(header.releaseDate)}</strong></span>
              )}
              {header.genre && <span>Genre: <strong className="text-foreground">{header.genre}</strong></span>}
              {header.playerFormat && (
                <span>Format: <strong className="text-foreground">{getPlayerFormatLabel(header.playerFormat)}</strong></span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {header.platforms.map((p) => (
                <span key={p} className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium border ${getPlatformClass(p)}`}>
                  {p}
                </span>
              ))}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-2" data-testid="ccu-kpi-row">
              <StatBadge
                label="Live Rank"
                value={kpi?.liveRank == null ? "—" : `#${formatNumber(kpi.liveRank)}`}
                badge={kpi?.liveRank == null ? "Outside of Steam Top 100 CCU" : undefined}
              />
              <StatBadge label="Current Players" value={formatNumber(kpi?.currentPlayers ?? null)} />
              <StatBadge label="24H Peak" value={formatNumber(kpi?.peak24h ?? null)} />
              <StatBadge
                label="All-Time Peak"
                value={formatNumber(kpi?.allTimePeak ?? null)}
                sub={
                  kpi?.allTimePeakDate
                    ? `${formatDate(kpi.allTimePeakDate)}${kpi.vsLastMonthPct != null ? ` · ${kpi.vsLastMonthPct > 0 ? "+" : ""}${kpi.vsLastMonthPct}% vs last month` : ""}`
                    : undefined
                }
              />
            </div>
          </div>
        </Card>
      )}

      <Card className="p-5 space-y-2">
        <div className="text-sm font-medium">Screenshots &amp; Trailers</div>
        <GameMediaCarousel media={media} />
      </Card>

      <Card className="p-5 space-y-2">
        <div className="text-sm font-medium">Concurrent Players Over Time</div>
        <CcuHistoryChart productId={productId} />
      </Card>

      <Card className="p-5 space-y-2">
        <div className="text-sm font-medium">Peak Hours of Day (Trailing 30 Days, ET)</div>
        <CcuHourlyChart productId={productId} />
      </Card>

      <Card className="p-5 space-y-2">
        <div className="text-sm font-medium">Top 5 Steam Crossover Games</div>
        <RelatedGamesGrid games={related} />
      </Card>
    </div>
  );
}
