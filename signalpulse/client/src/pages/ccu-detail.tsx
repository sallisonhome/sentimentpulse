/**
 * CCU Detail — standalone page (`/ccu/:id`).
 *
 * As of 2026-09-11, the Wishlist, Revenue, and Saber Steam CCU Leaderboard
 * title links all open THIS same page, not the generic multi-purpose
 * Product Detail page (`/products/:id`, which bundles Wishlist/Sales/PS5/
 * Forecast cards for the title). This page is a single-topic view of
 * concurrent-player data (plus general title metadata/media/related titles),
 * styled after howmanyareplaying's GameDetail page (hero + stat badges +
 * media + history/hourly charts + related titles, all on one scroll) rather
 * than nested inside SignalPulse's collapsible-section PDP. Pre-release
 * wishlist titles simply render the CCU stat badges as "—" until the game
 * launches and Steam CCU tracking begins.
 *
 * The "Back" link at the top returns to whichever leaderboard tab the user
 * came from (see `originBoard` below), not always the CCU tab.
 *
 * Reuses the same content blocks as ccu-pdp-section.tsx's embedded
 * <CcuPdpSection> (media/CCU charts/related games) so the two surfaces
 * never drift apart on data or chart behavior — only the header/layout
 * differ. As of 2026-09-08 the CCU/IGDB card and the per-title Steam
 * Sales by Country panel were deprecated off the generic PDP
 * (product-detail.tsx) entirely -- this standalone page is now the only
 * place both live for a title.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useSearch } from "wouter";
import { ArrowLeft, Gamepad2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate, formatShortDate, getPlatformClass, getPlayerFormatLabel } from "@/lib/utils";
import {
  StatBadge,
  GameMediaCarousel,
  CcuHistoryChart,
  CcuHourlyChart,
  RelatedGamesGrid,
  PopularUpcomingGrid,
  type CcuKpiCard,
  type IgdbMediaResult,
  type RelatedGame,
  type PopularUpcomingGame,
} from "@/components/ccu-pdp-section";
import {
  SalesByCountry,
  RangeChips,
  rangeFor,
  type RangeKey,
  type SalesByCountryData,
} from "@/components/SalesByCountry";

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

const BACK_BOARD_LABEL: Record<string, string> = {
  wishlist: "Wishlist",
  revenue: "Revenue",
  ccu: "CCU",
};

export default function CcuDetail() {
  const params = useParams<{ id: string }>();
  const productId = parseInt(params.id!);

  // The Wishlist, Revenue, and CCU leaderboards all link into this same
  // standalone detail page. Each leaderboard tab persists its own board in
  // the outer (pre-hash) `?board=` query string, and a same-page hash-only
  // link (`#/ccu/:id`) never touches that outer query -- so whatever board
  // was active when the title was clicked is still readable here. Use it to
  // send "Back" to the leaderboard the user actually came from, defaulting
  // to CCU only if the param is missing/unrecognized.
  const outerSearch = useSearch();
  const originBoardParam = new URLSearchParams(outerSearch).get("board");
  const originBoard = originBoardParam && BACK_BOARD_LABEL[originBoardParam] ? originBoardParam : "ccu";

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
  const { data: popularUpcoming } = useQuery<PopularUpcomingGame[]>({
    queryKey: ["/api/products", productId, "ccu", "popular-upcoming"],
  });

  // ─── Steam Sales by Country (moved here 2026-09-08 from the generic PDP) ─
  const [sbcRange, setSbcRange] = useState<RangeKey>("90d");
  const [sbcCustomSince, setSbcCustomSince] = useState<string>("");
  const [sbcCustomUntil, setSbcCustomUntil] = useState<string>("");
  const sbcRangeSpec = rangeFor(sbcRange, sbcCustomSince, sbcCustomUntil);
  const sbcQueryEnabled = !!productId && (sbcRange !== "custom" || (!!sbcCustomSince && !!sbcCustomUntil));
  const { data: sbcData, isLoading: sbcLoading, error: sbcError } = useQuery<SalesByCountryData & { since: string | null; until: string | null; product_id: number; product_title: string }>({
    queryKey: ["sales-by-country-product", productId, sbcRangeSpec.since ?? "", sbcRangeSpec.until ?? ""],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (sbcRangeSpec.since) p.set("since", sbcRangeSpec.since);
      if (sbcRangeSpec.until) p.set("until", sbcRangeSpec.until);
      const res = await fetch(`/signal/api/products/${productId}/sales-by-country?${p.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: sbcQueryEnabled,
    staleTime: 5 * 60 * 1000,
  });

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4">
      {/* Explicit ?board=<origin>#/ (not a relative "#/") so this lands back
          on whichever leaderboard tab (Wishlist, Revenue, or CCU) the user
          actually clicked the title from -- read from the outer query string
          via `originBoard` above, defaulting to CCU if it's missing. */}
      <a
        href={`?board=${originBoard}#/`}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        data-testid="link-back-to-leaderboard"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to {BACK_BOARD_LABEL[originBoard]} Leaderboard
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

            {kpi?.trackingSince && (
              <p className="text-xs text-muted-foreground mt-1" data-testid="text-ccu-tracking-since">
                Tracking since {formatShortDate(kpi.trackingSince)} — history will accumulate from that date forward as more data is collected.
              </p>
            )}
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

      <Card className="p-5 space-y-2">
        <div className="text-sm font-medium">Popular Upcoming</div>
        <PopularUpcomingGrid games={popularUpcoming} />
      </Card>

      <Card className="p-5 space-y-3" data-testid="card-ccu-sales-by-country">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-medium">Steam Sales by Country</div>
          {sbcData && (
            <span className="text-xs text-muted-foreground">
              {sbcData.countries_count} countries · {sbcRangeSpec.label}
            </span>
          )}
        </div>
        <RangeChips
          value={sbcRange}
          onChange={setSbcRange}
          customSince={sbcCustomSince}
          customUntil={sbcCustomUntil}
          onCustomChange={(s, u) => { setSbcCustomSince(s); setSbcCustomUntil(u); }}
        />
        {sbcError && (
          <div className="rounded-md border border-destructive/50 p-3 text-xs text-destructive">
            Failed to load country data: {(sbcError as Error).message}
          </div>
        )}
        <SalesByCountry
          data={sbcData}
          isLoading={sbcLoading}
          worldAtlasUrl={`${import.meta.env.BASE_URL}world-atlas-110m.json`}
          emptyMessage="No country data ingested for this range yet. Try widening to LTD to see historic monthly rows."
          mapHeight={340}
          showKpis={true}
        />
      </Card>
    </div>
  );
}
