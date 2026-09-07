import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  TrendingUp,
  TrendingDown,
  BarChart3,
  Trophy,
  Gamepad2,
  LineChart,
  ShoppingBag,
} from "lucide-react";
import { LeaderboardBanner } from "@/components/leaderboard-banner";
import { ChartDetailModal } from "@/components/chart-detail-modal";
import { CompareChartModal, type CompareCandidate } from "@/components/compare-chart-modal";
import { OnPromoBadge } from "@/components/OnPromoBadge";
import { formatNumber, formatCurrency } from "@/lib/utils";

// Shared shape for the /api/onpromo/all response — used by both boards to
// render an OnPromoBadge under each row's game title. Fetched once per
// page load and looked up by steamAppId; leaderboard rows without a
// mapped AppID (or with no active promos) simply render nothing.
type OnPromoAll = Record<string, { platform: string; end_date: string }[]>;

// ─── Types ───────────────────────────────────────────────────────────────────

interface WishlistLeaderboardRow {
  productId: number;
  title: string;
  steamAppId: string; // Steam AppID as a string — looked up in /api/onpromo/all
  headerImage: string;
  wishlistTotal: number | null;
  wishlistDelta1d: number | null;
  wishlistAdds7d: number | null;
  wishlistAdds1dPct: number | null;
  wishlistAdds7dPct: number | null;
  followersTotal: number | null;
  followersDelta1d: number | null;
  rankCurrent: number | null;
  rankDelta7d: number | null;
  igdbHype: number | null;
}

interface LeaderboardMover {
  productId: number;
  title: string;
  headerImage: string;
  delta: number;
  direction: "up" | "down";
}

interface WishlistLeaderboardKpis {
  biggest24hWishlistMover: LeaderboardMover | null;
  biggest7dRankMover: LeaderboardMover | null;
  biggest24hFollowerMover: LeaderboardMover | null;
}

interface RevenueLeaderboardRow {
  productId: number;
  title: string;
  steamAppId: string;
  headerImage: string;
  units24h: number | null;
  unitsDeltaPct24h: number | null;
  revenue24hUsd: number | null;
  revenueDeltaPct24h: number | null;
  dlcUnits24h: number | null;
  dlcRevenue24h: number | null;
  ltdUnitsSold: number | null;
  ltdRevenueUsd: number | null;
  revenue30d: number | null;
  revenueDelta30dUsd: number | null;
  revenueDelta30dPct: number | null;
  asOfDate: string | null;
  isStale: boolean;
}

interface RevenueLeaderboardMover {
  productId: number;
  title: string;
  headerImage: string;
  delta: number;
  direction: "up" | "down";
  isPercent?: boolean;
}

interface RevenueLeaderboardKpis {
  biggest24hUnitsMover: RevenueLeaderboardMover | null;
  biggest24hRevenueMover: RevenueLeaderboardMover | null;
  biggest30dRevenueLift: RevenueLeaderboardMover | null;
  biggestPositive30dRevenueLift: RevenueLeaderboardMover | null;
}

type SortKey =
  | "wishlistTotal"
  | "wishlistDelta1d"
  | "wishlistAdds7d"
  | "wishlistAdds1dPct"
  | "wishlistAdds7dPct"
  | "followersTotal"
  | "followersDelta1d"
  | "rankCurrent"
  | "rankDelta7d"
  | "igdbHype";

type RevenueSortKey =
  | "units24h"
  | "unitsDeltaPct24h"
  | "revenue24hUsd"
  | "revenueDeltaPct24h"
  | "dlcUnits24h"
  | "dlcRevenue24h"
  | "ltdUnitsSold"
  | "ltdRevenueUsd"
  | "revenue30d"
  | "revenueDelta30dUsd"
  | "revenueDelta30dPct";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function DeltaValue({ value, invert = false }: { value: number | null; invert?: boolean }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  if (value === 0) return <span className="text-muted-foreground tabular-nums">0</span>;
  // invert=true means a lower raw number is "good" (not used currently —
  // rankDelta7d is pre-computed so positive already means improvement).
  const isUp = invert ? value < 0 : value > 0;
  const displayValue = Math.abs(value);
  return (
    <span className={`inline-flex items-center gap-1 tabular-nums font-medium ${isUp ? "text-emerald-500" : "text-red-500"}`}>
      {isUp ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {formatNumber(displayValue)}
    </span>
  );
}

function PercentDeltaValue({ value }: { value: number | null }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  if (value === 0) return <span className="text-muted-foreground tabular-nums">0%</span>;
  const isUp = value > 0;
  return (
    <span className={`inline-flex items-center gap-1 tabular-nums font-medium ${isUp ? "text-emerald-500" : "text-red-500"}`}>
      {isUp ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {Math.abs(value)}%
    </span>
  );
}

function CurrencyDeltaValue({ value }: { value: number | null }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  if (value === 0) return <span className="text-muted-foreground tabular-nums">$0</span>;
  const isUp = value > 0;
  return (
    <span className={`inline-flex items-center gap-1 tabular-nums font-medium ${isUp ? "text-emerald-500" : "text-red-500"}`}>
      {isUp ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {formatCurrency(Math.abs(value))}
    </span>
  );
}

function GameKeyart({ headerImage, title }: { headerImage: string; title: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="h-9 w-16 rounded bg-muted flex items-center justify-center shrink-0" data-testid={`img-fallback-${title}`}>
        <Gamepad2 className="h-4 w-4 text-muted-foreground/50" />
      </div>
    );
  }
  return (
    <img
      src={headerImage}
      alt={title}
      className="h-9 w-16 rounded object-cover shrink-0 bg-muted"
      onError={() => setFailed(true)}
    />
  );
}

function ChartButton({
  onClick,
  testId,
}: {
  onClick: () => void;
  testId: string;
}) {
  return (
    <Button
      variant="outline"
      size="icon"
      className="h-8 w-8 text-muted-foreground hover:text-foreground"
      onClick={onClick}
      title="View chart"
      aria-label="View chart"
      data-testid={testId}
    >
      <BarChart3 className="h-3.5 w-3.5" />
    </Button>
  );
}

function SortableHead<K extends string>({
  label,
  sortKey,
  activeSort,
  onSort,
}: {
  label: string;
  sortKey: K;
  activeSort: { key: K; dir: "asc" | "desc" } | null;
  onSort: (key: K) => void;
}) {
  const isActive = activeSort?.key === sortKey;
  return (
    <TableHead className="p-0">
      <button
        onClick={() => onSort(sortKey)}
        className="flex items-center gap-1.5 w-full h-12 px-4 text-left whitespace-nowrap font-medium text-muted-foreground hover:text-foreground transition-colors"
        data-testid={`button-sort-${sortKey}`}
      >
        {label}
        {isActive ? (
          activeSort!.dir === "desc" ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronUp className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-30" />
        )}
      </button>
    </TableHead>
  );
}

function MoverKpiCard({
  label,
  mover,
  onOpenChart,
  valueType = "number",
  emptyMessage = "No movement yet",
}: {
  label: string;
  mover: LeaderboardMover | RevenueLeaderboardMover | null;
  onOpenChart: (row: { productId: number; title: string }) => void;
  valueType?: "number" | "currency" | "percent";
  emptyMessage?: string;
}) {
  const formattedDelta =
    mover == null
      ? ""
      : valueType === "currency"
        ? formatCurrency(Math.abs(mover.delta))
        : valueType === "percent"
          ? `${Math.abs(mover.delta)}%`
          : formatNumber(Math.abs(mover.delta));
  return (
    <Card className="p-4">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-3">
        {label}
      </div>
      {mover == null ? (
        <div className="text-sm text-muted-foreground">{emptyMessage}</div>
      ) : (
        <button
          onClick={() => onOpenChart({ productId: mover.productId, title: mover.title })}
          className="flex items-center gap-3 w-full text-left group"
          data-testid={`button-kpi-${label.replace(/\s+/g, "-").toLowerCase()}`}
        >
          <GameKeyart headerImage={mover.headerImage} title={mover.title} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate group-hover:underline">{mover.title}</div>
            <div className={`inline-flex items-center gap-1 text-xl font-bold tabular-nums ${mover.direction === "up" ? "text-emerald-500" : "text-red-500"}`}>
              {mover.direction === "up" ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
              {formattedDelta}
            </div>
          </div>
        </button>
      )}
    </Card>
  );
}

// ─── Saber Amazon Leaderboard (third tab) ──────────────────────────────────

interface AmazonPlatformCell {
  // "chart" = pulled from amazonChartSnapshots (top-100 category rank).
  // "bsr"   = SKU isn't top-100 on any tracked category chart, but we
  //           still have real Amazon data from the products job
  //           (amazonProductDaily). Cell renders as "BSR #<n>".
  source?: "chart" | "bsr";
  rank: number | null;
  rawRank: number | null;
  bsr?: number | null;
  delta1d: number | null;
  delta7d: number | null;
  delta30d: number | null;
  price: number | null;
  rating: number | null;
  asin: string;
  isSwitch2: boolean;
  // Sales-signal columns:
  // recentSales    — raw Amazon label ("100+ bought in past month"). Free
  //                  ride on the products call — only present on
  //                  high-velocity SKUs, common to be null.
  // monthlySalesEstimate / weeklySalesEstimate — Rainforest sales_estimation
  //                  model output. 1 credit per ASIN per day. Null on
  //                  pre-orders and very-low-rank SKUs.
  // salesEstimateBsr — the BSR the estimate was computed against; if it
  //                    diverges wildly from current bsr the estimate is stale.
  recentSales?: string | null;
  monthlySalesEstimate?: number | null;
  weeklySalesEstimate?: number | null;
  salesEstimateBsr?: number | null;
  salesEstimateCategory?: string | null;
}

interface AmazonLeaderboardCompetitor {
  sentimentpulseGameId: number;
  name: string;
  platforms: {
    ps5:    AmazonPlatformCell | null;
    xbox:   AmazonPlatformCell | null;
    switch: AmazonPlatformCell | null;
  };
}

interface AmazonLeaderboardTitle {
  productId: number;
  title: string;
  platforms: {
    ps5:    AmazonPlatformCell | null;
    xbox:   AmazonPlatformCell | null;
    switch: AmazonPlatformCell | null;
  };
  competitors?: AmazonLeaderboardCompetitor[];
  noSaberAmazonPin?: boolean;
}

interface AmazonLeaderboardResponse {
  saberTitles: AmazonLeaderboardTitle[];
  // Flat competitor list, kept for backwards compat; the nested list under
  // each saberTitles[i].competitors is now the primary rendering path.
  competitorTitles: Array<AmazonLeaderboardCompetitor & { parentProductId: number; parentTitle: string | null }>;
}

// Terracotta chip color from the SignalPulse design tokens (see BUILD_BRIEF).
const SABER_ACCENT = "#C0553A";
const RANK_DOWN_MUTED = "#7A9E7E";

// Compact-number formatter for the sales-estimate column (7,921 → "7.9K",
// 1,204,000 → "1.2M"). Keeps the table row height stable when the numbers
// span 3-7 digits across the slate.
function formatCompactUnits(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000)    return `${Math.round(n / 1_000)}K`;
  if (abs >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

// Cell contents for a single (title, platform) intersection. Three
// stacked lines when we have data: rank line (chart # or BSR #), sales-est
// line (≈ N /mo), recent-sales line (raw Amazon label). Missing pieces
// gracefully drop out — pre-orders often show only the rank/BSR row.
function AmazonPlatformTableCell({
  cell,
  delta,
  platformLabel,
}: {
  cell: AmazonPlatformCell | null;
  delta: "1d" | "7d" | "30d";
  platformLabel: string;
}) {
  if (!cell) {
    return (
      <div className="text-[11px] text-muted-foreground/60 tabular-nums" title={`No SKU tracked on ${platformLabel}`}>
        —
      </div>
    );
  }
  const deltaVal = delta === "1d" ? cell.delta1d : delta === "7d" ? cell.delta7d : cell.delta30d;
  const showArrow = deltaVal != null && deltaVal !== 0;
  const isUp = deltaVal != null && deltaVal > 0;
  const isBsr = cell.source === "bsr" || (cell.rank == null && cell.bsr != null);
  const displayNumber = isBsr ? cell.bsr : cell.rank;
  const rankTitle = isBsr
    ? `${platformLabel} — Amazon Best Sellers Rank (not on top-100 category chart)`
    : `${platformLabel} — top-100 category rank`;
  const deltaSuffix = isBsr && deltaVal != null ? "%" : "";
  const hasRankLine = displayNumber != null;
  const monthly = cell.monthlySalesEstimate;
  const weekly = cell.weeklySalesEstimate;
  const category = cell.salesEstimateCategory;
  const recent = cell.recentSales;

  return (
    <div className="flex flex-col items-end gap-0.5 text-[11px] tabular-nums leading-tight">
      {hasRankLine ? (
        <div className="flex items-center gap-1.5" title={rankTitle}>
          {isBsr ? (
            <span className="text-[9px] uppercase tracking-wider text-muted-foreground/70">BSR</span>
          ) : null}
          <span className="font-semibold">#{displayNumber!.toLocaleString()}</span>
          {showArrow ? (
            <span
              className="inline-flex items-center gap-0.5 font-medium"
              style={{ color: isUp ? SABER_ACCENT : RANK_DOWN_MUTED }}
            >
              {isUp ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
              {Math.abs(deltaVal!)}{deltaSuffix}
            </span>
          ) : null}
        </div>
      ) : null}
      {monthly != null ? (
        <div
          className="text-muted-foreground"
          title={`Rainforest sales_estimation — ≈ ${monthly.toLocaleString()} units/mo` +
            (weekly != null ? ` (≈ ${weekly.toLocaleString()} units/wk)` : "") +
            (category ? `, based on rank in “${category}”` : "")}
        >
          ≈ {formatCompactUnits(monthly)}<span className="text-muted-foreground/70"> /mo</span>
        </div>
      ) : null}
      {recent ? (
        <div className="text-muted-foreground/80 text-[10px]" title={`Amazon PDP label: “${recent}”`}>
          {recent}
        </div>
      ) : null}
      {!hasRankLine && monthly == null && !recent ? (
        <span className="text-muted-foreground/60">—</span>
      ) : null}
    </div>
  );
}

// Table rendering: <AmazonBoardRow> emits a parent <TableRow> plus
// optional indented competitor rows so a single <TableBody> renders the
// full nested slate. Row-click still deep-links to the product detail
// view via a wrapping anchor around the title cell (whole rows can't be
// nested inside an <a> without breaking the table semantics).
function AmazonBoardRow({ title, delta }: { title: AmazonLeaderboardTitle; delta: "1d" | "7d" | "30d" }) {
  const primaryAsin = title.platforms.ps5?.asin ?? title.platforms.xbox?.asin ?? title.platforms.switch?.asin;
  const detailHref = primaryAsin ? `/amazon/product/${primaryAsin}` : undefined;
  const competitors = title.competitors ?? [];

  const titleContent = (
    <>
      <span className="font-medium text-sm">{title.title}</span>
      {title.noSaberAmazonPin ? (
        <span className="ml-2 text-[10px] uppercase tracking-wider text-muted-foreground font-normal">
          not on amazon
        </span>
      ) : null}
    </>
  );

  return (
    <>
      <TableRow
        className={"hover:bg-accent/50 transition-colors" + (detailHref ? " cursor-pointer" : "")}
        data-testid={`row-amazon-saber-${title.productId}`}
      >
        <TableCell className="align-top py-3">
          {detailHref ? (
            <a href={`#${detailHref}`} className="block truncate">{titleContent}</a>
          ) : (
            <div className="truncate">{titleContent}</div>
          )}
        </TableCell>
        <TableCell className="align-top py-3 text-right">
          <AmazonPlatformTableCell cell={title.platforms.ps5}  delta={delta} platformLabel="PS5" />
        </TableCell>
        <TableCell className="align-top py-3 text-right">
          <AmazonPlatformTableCell cell={title.platforms.xbox} delta={delta} platformLabel="Xbox" />
        </TableCell>
        <TableCell className="align-top py-3 text-right">
          <AmazonPlatformTableCell
            cell={title.platforms.switch}
            delta={delta}
            platformLabel={title.platforms.switch?.isSwitch2 ? "Switch 2" : "Switch"}
          />
        </TableCell>
      </TableRow>
      {competitors.length > 0 ? (
        <TableRow className="bg-muted/30 border-t-0">
          <TableCell colSpan={4} className="py-1 px-4">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
              Competitors ({competitors.length})
            </div>
          </TableCell>
        </TableRow>
      ) : null}
      {competitors.map((c) => {
        const compPrimaryAsin = c.platforms.ps5?.asin ?? c.platforms.xbox?.asin ?? c.platforms.switch?.asin;
        const compHref = compPrimaryAsin ? `/amazon/product/${compPrimaryAsin}` : undefined;
        return (
          <TableRow
            key={c.sentimentpulseGameId}
            className="bg-muted/20 hover:bg-accent/40 transition-colors"
            data-testid={`row-amazon-competitor-${c.sentimentpulseGameId}`}
          >
            <TableCell className="align-top py-2 pl-8">
              {compHref ? (
                <a href={`#${compHref}`} className="block truncate text-xs text-foreground/90">{c.name}</a>
              ) : (
                <div className="truncate text-xs text-foreground/90">{c.name}</div>
              )}
            </TableCell>
            <TableCell className="align-top py-2 text-right">
              <AmazonPlatformTableCell cell={c.platforms.ps5}    delta={delta} platformLabel="PS5" />
            </TableCell>
            <TableCell className="align-top py-2 text-right">
              <AmazonPlatformTableCell cell={c.platforms.xbox}   delta={delta} platformLabel="Xbox" />
            </TableCell>
            <TableCell className="align-top py-2 text-right">
              <AmazonPlatformTableCell cell={c.platforms.switch} delta={delta} platformLabel="Switch" />
            </TableCell>
          </TableRow>
        );
      })}
    </>
  );
}

function SaberAmazonBoard({
  delta,
  onDeltaChange,
}: {
  delta: "1d" | "7d" | "30d";
  onDeltaChange: (d: "1d" | "7d" | "30d") => void;
}) {
  const { data, isLoading } = useQuery<AmazonLeaderboardResponse>({
    queryKey: ["/api/amazon/leaderboard/saber"],
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  const saberTitles = data?.saberTitles ?? [];
  const compTitles = data?.competitorTitles ?? [];

  return (
    <div className="space-y-6">
      {/* Delta toggle top-right */}
      <div className="flex justify-end">
        <div className="inline-flex rounded-md border border-border p-0.5">
          {(["1d", "7d", "30d"] as const).map((d) => (
            <button
              key={d}
              onClick={() => onDeltaChange(d)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${delta === d ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground hover:text-foreground"}`}
              data-testid={`button-amazon-delta-${d}`}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      {/* Saber Titles */}
      <Card className="overflow-hidden">
        <div className="px-4 py-3 border-b bg-card flex items-center gap-2">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ backgroundColor: SABER_ACCENT }}
            aria-hidden="true"
          />
          <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: SABER_ACCENT }}>
            Saber Titles
          </span>
          <span className="text-xs text-muted-foreground ml-2">{saberTitles.length} titles tracked</span>
        </div>
        {saberTitles.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            No Saber titles pinned yet. Add ASIN mappings from the Amazon Retail app to populate this leaderboard.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[38%] min-w-[220px]">Game Title</TableHead>
                <TableHead className="text-right">PS5</TableHead>
                <TableHead className="text-right">Xbox</TableHead>
                <TableHead className="text-right">Switch</TableHead>
              </TableRow>
              <TableRow className="border-t-0">
                <TableCell className="py-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">
                  Rank / est. units / recent sales
                </TableCell>
                <TableCell colSpan={3} className="py-1 text-[10px] text-right uppercase tracking-wider text-muted-foreground/70">
                  # = category rank · BSR = Best Sellers Rank · ≈ N/mo = Rainforest est.
                </TableCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {saberTitles.map((t) => (
                <AmazonBoardRow key={t.productId} title={t} delta={delta} />
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Competitor Watch — flat cross-parent list (kept as a secondary
          view; primary rendering is now nested under each Saber parent above). */}
      {compTitles.length > 0 ? (
        <Card className="overflow-hidden">
          <div className="px-4 py-3 border-b bg-card flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-muted-foreground" aria-hidden="true" />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              All Tracked Competitors
            </span>
            <span className="text-xs text-muted-foreground ml-2">{compTitles.length} pinned</span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[38%] min-w-[220px]">Competitor</TableHead>
                <TableHead className="text-right">PS5</TableHead>
                <TableHead className="text-right">Xbox</TableHead>
                <TableHead className="text-right">Switch</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {compTitles.map((c) => (
                <TableRow
                  key={c.sentimentpulseGameId}
                  data-testid={`row-amazon-flat-competitor-${c.sentimentpulseGameId}`}
                  className="hover:bg-accent/40 transition-colors"
                >
                  <TableCell className="align-top py-2">
                    <div className="min-w-0">
                      <div className="text-xs truncate">{c.name}</div>
                      {c.parentTitle ? (
                        <div className="text-[10px] text-muted-foreground">under {c.parentTitle}</div>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="align-top py-2 text-right">
                    <AmazonPlatformTableCell cell={c.platforms.ps5}    delta={delta} platformLabel="PS5" />
                  </TableCell>
                  <TableCell className="align-top py-2 text-right">
                    <AmazonPlatformTableCell cell={c.platforms.xbox}   delta={delta} platformLabel="Xbox" />
                  </TableCell>
                  <TableCell className="align-top py-2 text-right">
                    <AmazonPlatformTableCell cell={c.platforms.switch} delta={delta} platformLabel="Switch" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : null}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function Leaderboards() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const boardParam = params.get("board");
  const board: "wishlist" | "revenue" | "saber-amazon" =
    boardParam === "revenue" ? "revenue"
    : boardParam === "saber-amazon" ? "saber-amazon"
    : "wishlist";
  // Which delta window to show inside the platform pill on the Saber Amazon
  // leaderboard. Persisted as component state (does not change the URL).
  const [amazonDelta, setAmazonDelta] = useState<"1d" | "7d" | "30d">("1d");

  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "wishlistTotal",
    dir: "desc",
  });
  // v3.21 (2026-08-18): default sort changed to 24h revenue (was 30d
  // revenue) per explicit request -- the sales leaderboard should always
  // open ranked by 24h revenue. Still fully user-sortable by clicking any
  // column header; this only changes the initial/default ordering.
  const [revenueSort, setRevenueSort] = useState<{ key: RevenueSortKey; dir: "asc" | "desc" }>({
    key: "revenue24hUsd",
    dir: "desc",
  });
  const [chartModal, setChartModal] = useState<{ productId: number; title: string; dataType: "steamWishlist" | "steamRevenueDaily" } | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);

  const { data: rows, isLoading: rowsLoading } = useQuery<WishlistLeaderboardRow[]>({
    queryKey: ["/api/leaderboards/wishlist"],
    enabled: board === "wishlist",
  });

  const { data: kpis, isLoading: kpisLoading } = useQuery<WishlistLeaderboardKpis>({
    queryKey: ["/api/leaderboards/wishlist/kpis"],
    enabled: board === "wishlist",
  });

  const { data: revenueRows, isLoading: revenueRowsLoading } = useQuery<RevenueLeaderboardRow[]>({
    queryKey: ["/api/leaderboards/revenue"],
    enabled: board === "revenue",
  });

  const { data: revenueKpis, isLoading: revenueKpisLoading } = useQuery<RevenueLeaderboardKpis>({
    queryKey: ["/api/leaderboards/revenue/kpis"],
    enabled: board === "revenue",
  });

  // Cross-app "On Promo" badges. One shared query for BOTH boards — the
  // response is a small object keyed by Steam AppID, so the per-row
  // lookup is O(1). Uses 60s staleTime to match the server-side cache in
  // promo-calendar-client.ts and never blocks the leaderboard render:
  // while this query is loading, `onPromo` is undefined and every row
  // simply renders no badge (identical to the pre-feature baseline).
  const { data: onPromo } = useQuery<OnPromoAll>({
    queryKey: ["/api/onpromo/all"],
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  const sortedRows = useMemo(() => {
    if (!rows) return [];
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      // Nulls always sort last regardless of direction — an untracked
      // metric shouldn't outrank a title with real (even low) data.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return sort.dir === "desc" ? bv - av : av - bv;
    });
    return copy;
  }, [rows, sort]);

  const sortedRevenueRows = useMemo(() => {
    if (!revenueRows) return [];
    const copy = [...revenueRows];
    copy.sort((a, b) => {
      const av = a[revenueSort.key];
      const bv = b[revenueSort.key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return revenueSort.dir === "desc" ? bv - av : av - bv;
    });
    return copy;
  }, [revenueRows, revenueSort]);

  function handleSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "desc" ? "asc" : "desc" }
        : { key, dir: "desc" },
    );
  }

  function handleRevenueSort(key: RevenueSortKey) {
    setRevenueSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "desc" ? "asc" : "desc" }
        : { key, dir: "desc" },
    );
  }

  function handleTabChange(value: string) {
    navigate(`/?board=${value}`);
  }

  const compareCandidates: CompareCandidate[] = useMemo(() => {
    if (board === "revenue") {
      return (revenueRows ?? []).map((r) => ({ productId: r.productId, title: r.title }));
    }
    return (rows ?? []).map((r) => ({ productId: r.productId, title: r.title }));
  }, [board, rows, revenueRows]);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <LeaderboardBanner
        title={
          board === "wishlist" ? "Pre-Release Steam Wishlist Leaderboard"
          : board === "revenue" ? "Steam Revenue Leaderboard"
          : "Saber Amazon Leaderboard"
        }
        subtitle={
          board === "wishlist"
            ? "Daily-refreshed wishlist, follower, rank, and hype tracking for every unreleased Saber title on Steam"
            : board === "revenue"
            ? "Daily-refreshed prepurchase and post-release sales for every Saber title on Steam"
            : "Daily Amazon retail chart position for every Saber title across PS5, Xbox, and Nintendo Switch"
        }
      />

      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <Tabs value={board} onValueChange={handleTabChange}>
          <TabsList>
            <TabsTrigger value="wishlist" data-testid="tab-wishlist">
              <Trophy className="h-3.5 w-3.5 mr-1.5" />
              Wishlist Leaderboard
            </TabsTrigger>
            <TabsTrigger value="revenue" data-testid="tab-revenue">
              <BarChart3 className="h-3.5 w-3.5 mr-1.5" />
              Revenue Leaderboard
            </TabsTrigger>
            <TabsTrigger value="saber-amazon" data-testid="tab-saber-amazon">
              <ShoppingBag className="h-3.5 w-3.5 mr-1.5" />
              Saber Amazon Leaderboard
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs gap-1.5"
          disabled={compareCandidates.length === 0}
          onClick={() => setCompareOpen(true)}
          data-testid="button-open-compare"
        >
          <LineChart className="h-3.5 w-3.5" />
          Compare Titles
        </Button>
      </div>

      {board === "saber-amazon" ? (
        <SaberAmazonBoard
          delta={amazonDelta}
          onDeltaChange={setAmazonDelta}
        />
      ) : board === "revenue" ? (
        revenueRowsLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-64 w-full rounded-xl" />
            <div className="grid grid-cols-3 gap-4">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-24 rounded-xl" />
              ))}
            </div>
          </div>
        ) : !revenueRows || revenueRows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <BarChart3 className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <h2 className="text-sm font-medium text-muted-foreground">No revenue-eligible titles yet</h2>
            <p className="text-xs text-muted-foreground/70 mt-1">
              Titles start tracking here once prepurchases open or the title releases on Steam.
            </p>
          </div>
        ) : (
          <>
            <Card className="overflow-hidden mb-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[220px]">Game Title</TableHead>
                    <TableHead className="w-[56px] text-center">Chart</TableHead>
                    <SortableHead label="24h Units" sortKey="units24h" activeSort={revenueSort} onSort={handleRevenueSort} />
                    <SortableHead label="24h Units Δ%" sortKey="unitsDeltaPct24h" activeSort={revenueSort} onSort={handleRevenueSort} />
                    <SortableHead label="24h Revenue" sortKey="revenue24hUsd" activeSort={revenueSort} onSort={handleRevenueSort} />
                    <SortableHead label="24h Rev Δ%" sortKey="revenueDeltaPct24h" activeSort={revenueSort} onSort={handleRevenueSort} />
                    <SortableHead label="24h DLC Units" sortKey="dlcUnits24h" activeSort={revenueSort} onSort={handleRevenueSort} />
                    <SortableHead label="24h DLC Revenue" sortKey="dlcRevenue24h" activeSort={revenueSort} onSort={handleRevenueSort} />
                    <SortableHead label="LTD Units" sortKey="ltdUnitsSold" activeSort={revenueSort} onSort={handleRevenueSort} />
                    <SortableHead label="LTD Revenue" sortKey="ltdRevenueUsd" activeSort={revenueSort} onSort={handleRevenueSort} />
                    <SortableHead label="30d Revenue" sortKey="revenue30d" activeSort={revenueSort} onSort={handleRevenueSort} />
                    <SortableHead label="30d Rev Δ$" sortKey="revenueDelta30dUsd" activeSort={revenueSort} onSort={handleRevenueSort} />
                    <SortableHead label="30d Rev Δ%" sortKey="revenueDelta30dPct" activeSort={revenueSort} onSort={handleRevenueSort} />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedRevenueRows.map((row) => (
                    <TableRow key={row.productId} data-testid={`row-revenue-leaderboard-${row.productId}`}>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-3">
                            <GameKeyart headerImage={row.headerImage} title={row.title} />
                            <span className="font-medium text-sm truncate">{row.title}</span>
                            {row.isStale && (
                              <span
                                className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0"
                                title={`24h/30d figures as of ${row.asOfDate} — ingestion is running behind (check the Steam cookie)`}
                                data-testid={`indicator-stale-${row.productId}`}
                              />
                            )}
                          </div>
                          {/* On-Promo badge — renders nothing when the title has no active promos.
                              Wrapped in a flex row so the badge shrinks to its content instead of
                              stretching to the table cell width. */}
                          {onPromo?.[row.steamAppId]?.length ? (
                            <OnPromoBadge
                              promos={onPromo[row.steamAppId]}
                              className="w-fit"
                              testId={`badge-on-promo-revenue-${row.productId}`}
                            />
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        <ChartButton
                          onClick={() => setChartModal({ productId: row.productId, title: row.title, dataType: "steamRevenueDaily" })}
                          testId={`button-chart-revenue-${row.productId}`}
                        />
                      </TableCell>
                      <TableCell className="tabular-nums">{formatNumber(row.units24h)}</TableCell>
                      <TableCell><PercentDeltaValue value={row.unitsDeltaPct24h} /></TableCell>
                      <TableCell className="tabular-nums">{formatCurrency(row.revenue24hUsd)}</TableCell>
                      <TableCell><PercentDeltaValue value={row.revenueDeltaPct24h} /></TableCell>
                      <TableCell className="tabular-nums">{formatNumber(row.dlcUnits24h)}</TableCell>
                      <TableCell className="tabular-nums">{formatCurrency(row.dlcRevenue24h)}</TableCell>
                      <TableCell className="tabular-nums">{formatNumber(row.ltdUnitsSold)}</TableCell>
                      <TableCell className="tabular-nums">{formatCurrency(row.ltdRevenueUsd)}</TableCell>
                      <TableCell className="tabular-nums">{formatCurrency(row.revenue30d)}</TableCell>
                      <TableCell><CurrencyDeltaValue value={row.revenueDelta30dUsd} /></TableCell>
                      <TableCell><PercentDeltaValue value={row.revenueDelta30dPct} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>

            {!revenueKpisLoading && revenueKpis && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <MoverKpiCard
                  label="Biggest 24hr Mover — Units"
                  mover={revenueKpis.biggest24hUnitsMover}
                  onOpenChart={(row) => setChartModal({ ...row, dataType: "steamRevenueDaily" })}
                />
                <MoverKpiCard
                  label="Biggest 24hr Mover — $"
                  mover={revenueKpis.biggest24hRevenueMover}
                  onOpenChart={(row) => setChartModal({ ...row, dataType: "steamRevenueDaily" })}
                  valueType="currency"
                />
                <MoverKpiCard
                  label={
                    revenueKpis.biggest30dRevenueLift?.direction === "down"
                      ? "Biggest % Revenue Drop vs Prior 30 Days"
                      : "Biggest % Revenue Lift vs Prior 30 Days"
                  }
                  mover={revenueKpis.biggest30dRevenueLift}
                  onOpenChart={(row) => setChartModal({ ...row, dataType: "steamRevenueDaily" })}
                  valueType="percent"
                />
                <MoverKpiCard
                  label="Biggest % Revenue Lift (Positive Only)"
                  mover={revenueKpis.biggestPositive30dRevenueLift}
                  onOpenChart={(row) => setChartModal({ ...row, dataType: "steamRevenueDaily" })}
                  valueType="percent"
                  emptyMessage="N/A — no positive revenue lift in period"
                />
              </div>
            )}
          </>
        )
      ) : rowsLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-64 w-full rounded-xl" />
          <div className="grid grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
        </div>
      ) : !rows || rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Trophy className="h-12 w-12 text-muted-foreground/40 mb-4" />
          <h2 className="text-sm font-medium text-muted-foreground">No pre-release titles yet</h2>
          <p className="text-xs text-muted-foreground/70 mt-1">
            Titles start tracking here automatically once added to SignalPulse with a future release date.
          </p>
        </div>
      ) : (
        <>
          <Card className="overflow-hidden mb-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[240px]">Game Title</TableHead>
                  <TableHead className="w-[56px] text-center">Chart</TableHead>
                  <SortableHead label="Total WL" sortKey="wishlistTotal" activeSort={sort} onSort={handleSort} />
                  <SortableHead label="1D WL Δ" sortKey="wishlistDelta1d" activeSort={sort} onSort={handleSort} />
                  <SortableHead label="1D Adds Δ%" sortKey="wishlistAdds1dPct" activeSort={sort} onSort={handleSort} />
                  <SortableHead label="7D WL Adds" sortKey="wishlistAdds7d" activeSort={sort} onSort={handleSort} />
                  <SortableHead label="7D Adds Δ%" sortKey="wishlistAdds7dPct" activeSort={sort} onSort={handleSort} />
                  <SortableHead label="Total Followers" sortKey="followersTotal" activeSort={sort} onSort={handleSort} />
                  <SortableHead label="1D Follower Δ" sortKey="followersDelta1d" activeSort={sort} onSort={handleSort} />
                  <SortableHead label="Rank" sortKey="rankCurrent" activeSort={sort} onSort={handleSort} />
                  <SortableHead label="7D Rank Δ" sortKey="rankDelta7d" activeSort={sort} onSort={handleSort} />
                  <SortableHead label="IGDB Hype" sortKey="igdbHype" activeSort={sort} onSort={handleSort} />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedRows.map((row) => (
                  <TableRow key={row.productId} data-testid={`row-leaderboard-${row.productId}`}>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-3">
                          <GameKeyart headerImage={row.headerImage} title={row.title} />
                          <span className="font-medium text-sm truncate">{row.title}</span>
                        </div>
                        {/* On-Promo badge — renders nothing when the title has no active promos.
                            Wrapped in a flex row so the badge shrinks to its content instead of
                            stretching to the table cell width. */}
                        {onPromo?.[row.steamAppId]?.length ? (
                          <OnPromoBadge
                            promos={onPromo[row.steamAppId]}
                            className="w-fit"
                            testId={`badge-on-promo-wishlist-${row.productId}`}
                          />
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-center">
                      <ChartButton
                        onClick={() => setChartModal({ productId: row.productId, title: row.title, dataType: "steamWishlist" })}
                        testId={`button-chart-${row.productId}`}
                      />
                    </TableCell>
                    <TableCell className="tabular-nums">{formatNumber(row.wishlistTotal)}</TableCell>
                    <TableCell><DeltaValue value={row.wishlistDelta1d} /></TableCell>
                    <TableCell><PercentDeltaValue value={row.wishlistAdds1dPct} /></TableCell>
                    <TableCell className="tabular-nums">{formatNumber(row.wishlistAdds7d)}</TableCell>
                    <TableCell><PercentDeltaValue value={row.wishlistAdds7dPct} /></TableCell>
                    <TableCell className="tabular-nums">{formatNumber(row.followersTotal)}</TableCell>
                    <TableCell><DeltaValue value={row.followersDelta1d} /></TableCell>
                    <TableCell className="tabular-nums">
                      {row.rankCurrent == null ? <span className="text-muted-foreground">—</span> : `#${row.rankCurrent}`}
                    </TableCell>
                    <TableCell><DeltaValue value={row.rankDelta7d} /></TableCell>
                    <TableCell className="tabular-nums">{formatNumber(row.igdbHype)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          {!kpisLoading && kpis && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <MoverKpiCard
                label="Biggest 24hr Mover — Wishlist"
                mover={kpis.biggest24hWishlistMover}
                onOpenChart={(row) => setChartModal({ ...row, dataType: "steamWishlist" })}
              />
              <MoverKpiCard
                label="Biggest Mover — 7 Day Rank"
                mover={kpis.biggest7dRankMover}
                onOpenChart={(row) => setChartModal({ ...row, dataType: "steamWishlist" })}
              />
              <MoverKpiCard
                label="Biggest 24hr Mover — Followers"
                mover={kpis.biggest24hFollowerMover}
                onOpenChart={(row) => setChartModal({ ...row, dataType: "steamWishlist" })}
              />
            </div>
          )}
        </>
      )}

      {chartModal && (
        <ChartDetailModal
          open={!!chartModal}
          onOpenChange={(open) => setChartModal(open ? chartModal : null)}
          productId={chartModal.productId}
          productTitle={chartModal.title}
          dataType={chartModal.dataType}
          releaseDate={null}
        />
      )}

      {/* CompareChartModal only supports steam wishlist/revenue boards —
          on the Amazon tab we hide it. Passing a narrowed board keeps the
          existing prop contract intact. */}
      {board !== "saber-amazon" && (
        <CompareChartModal
          open={compareOpen}
          onOpenChange={setCompareOpen}
          board={board}
          candidates={compareCandidates}
        />
      )}
    </div>
  );
}
