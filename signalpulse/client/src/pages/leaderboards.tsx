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
} from "lucide-react";
import { LeaderboardBanner } from "@/components/leaderboard-banner";
import { ChartDetailModal } from "@/components/chart-detail-modal";
import { formatNumber, formatCurrency } from "@/lib/utils";

// ─── Types ───────────────────────────────────────────────────────────────────

interface WishlistLeaderboardRow {
  productId: number;
  title: string;
  steamAppId: string;
  headerImage: string;
  wishlistTotal: number | null;
  wishlistDelta1d: number | null;
  wishlistAdds7d: number | null;
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

// ─── Page ────────────────────────────────────────────────────────────────────

export default function Leaderboards() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const board = params.get("board") === "revenue" ? "revenue" : "wishlist";

  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "wishlistTotal",
    dir: "desc",
  });
  const [revenueSort, setRevenueSort] = useState<{ key: RevenueSortKey; dir: "asc" | "desc" }>({
    key: "revenue30d",
    dir: "desc",
  });
  const [chartModal, setChartModal] = useState<{ productId: number; title: string; dataType: "steamWishlist" | "steamRevenueDaily" } | null>(null);

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

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <LeaderboardBanner
        title={board === "wishlist" ? "Pre-Release Steam Wishlist Leaderboard" : "Steam Revenue Leaderboard"}
        subtitle={
          board === "wishlist"
            ? "Daily-refreshed wishlist, follower, rank, and hype tracking for every unreleased Saber title on Steam"
            : "Daily-refreshed prepurchase and post-release sales for every Saber title on Steam"
        }
      />

      <Tabs value={board} onValueChange={handleTabChange} className="mb-5">
        <TabsList>
          <TabsTrigger value="wishlist" data-testid="tab-wishlist">
            <Trophy className="h-3.5 w-3.5 mr-1.5" />
            Wishlist Leaderboard
          </TabsTrigger>
          <TabsTrigger value="revenue" data-testid="tab-revenue">
            <BarChart3 className="h-3.5 w-3.5 mr-1.5" />
            Revenue Leaderboard
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {board === "revenue" ? (
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
                    <SortableHead label="24h Units" sortKey="units24h" activeSort={revenueSort} onSort={handleRevenueSort} />
                    <SortableHead label="24h Units Δ%" sortKey="unitsDeltaPct24h" activeSort={revenueSort} onSort={handleRevenueSort} />
                    <SortableHead label="24h Revenue" sortKey="revenue24hUsd" activeSort={revenueSort} onSort={handleRevenueSort} />
                    <SortableHead label="24h Rev Δ%" sortKey="revenueDeltaPct24h" activeSort={revenueSort} onSort={handleRevenueSort} />
                    <SortableHead label="24h DLC Units" sortKey="dlcUnits24h" activeSort={revenueSort} onSort={handleRevenueSort} />
                    <SortableHead label="24h DLC Revenue" sortKey="dlcRevenue24h" activeSort={revenueSort} onSort={handleRevenueSort} />
                    <SortableHead label="LTD Revenue" sortKey="ltdRevenueUsd" activeSort={revenueSort} onSort={handleRevenueSort} />
                    <SortableHead label="30d Revenue" sortKey="revenue30d" activeSort={revenueSort} onSort={handleRevenueSort} />
                    <SortableHead label="30d Rev Δ$" sortKey="revenueDelta30dUsd" activeSort={revenueSort} onSort={handleRevenueSort} />
                    <SortableHead label="30d Rev Δ%" sortKey="revenueDelta30dPct" activeSort={revenueSort} onSort={handleRevenueSort} />
                    <TableHead className="text-right">Chart</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedRevenueRows.map((row) => (
                    <TableRow key={row.productId} data-testid={`row-revenue-leaderboard-${row.productId}`}>
                      <TableCell>
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
                      </TableCell>
                      <TableCell className="tabular-nums">{formatNumber(row.units24h)}</TableCell>
                      <TableCell><PercentDeltaValue value={row.unitsDeltaPct24h} /></TableCell>
                      <TableCell className="tabular-nums">{formatCurrency(row.revenue24hUsd)}</TableCell>
                      <TableCell><PercentDeltaValue value={row.revenueDeltaPct24h} /></TableCell>
                      <TableCell className="tabular-nums">{formatNumber(row.dlcUnits24h)}</TableCell>
                      <TableCell className="tabular-nums">{formatCurrency(row.dlcRevenue24h)}</TableCell>
                      <TableCell className="tabular-nums">{formatCurrency(row.ltdRevenueUsd)}</TableCell>
                      <TableCell className="tabular-nums">{formatCurrency(row.revenue30d)}</TableCell>
                      <TableCell><CurrencyDeltaValue value={row.revenueDelta30dUsd} /></TableCell>
                      <TableCell><PercentDeltaValue value={row.revenueDelta30dPct} /></TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-[11px] gap-1.5"
                          onClick={() => setChartModal({ productId: row.productId, title: row.title, dataType: "steamRevenueDaily" })}
                          data-testid={`button-chart-revenue-${row.productId}`}
                        >
                          <BarChart3 className="h-3 w-3" />
                          View Chart
                        </Button>
                      </TableCell>
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
                  <SortableHead label="Total WL" sortKey="wishlistTotal" activeSort={sort} onSort={handleSort} />
                  <SortableHead label="1D WL Δ" sortKey="wishlistDelta1d" activeSort={sort} onSort={handleSort} />
                  <SortableHead label="7D WL Adds" sortKey="wishlistAdds7d" activeSort={sort} onSort={handleSort} />
                  <SortableHead label="Total Followers" sortKey="followersTotal" activeSort={sort} onSort={handleSort} />
                  <SortableHead label="1D Follower Δ" sortKey="followersDelta1d" activeSort={sort} onSort={handleSort} />
                  <SortableHead label="Rank" sortKey="rankCurrent" activeSort={sort} onSort={handleSort} />
                  <SortableHead label="7D Rank Δ" sortKey="rankDelta7d" activeSort={sort} onSort={handleSort} />
                  <SortableHead label="IGDB Hype" sortKey="igdbHype" activeSort={sort} onSort={handleSort} />
                  <TableHead className="text-right">Chart</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedRows.map((row) => (
                  <TableRow key={row.productId} data-testid={`row-leaderboard-${row.productId}`}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <GameKeyart headerImage={row.headerImage} title={row.title} />
                        <span className="font-medium text-sm truncate">{row.title}</span>
                      </div>
                    </TableCell>
                    <TableCell className="tabular-nums">{formatNumber(row.wishlistTotal)}</TableCell>
                    <TableCell><DeltaValue value={row.wishlistDelta1d} /></TableCell>
                    <TableCell className="tabular-nums">{formatNumber(row.wishlistAdds7d)}</TableCell>
                    <TableCell className="tabular-nums">{formatNumber(row.followersTotal)}</TableCell>
                    <TableCell><DeltaValue value={row.followersDelta1d} /></TableCell>
                    <TableCell className="tabular-nums">
                      {row.rankCurrent == null ? <span className="text-muted-foreground">—</span> : `#${row.rankCurrent}`}
                    </TableCell>
                    <TableCell><DeltaValue value={row.rankDelta7d} /></TableCell>
                    <TableCell className="tabular-nums">{formatNumber(row.igdbHype)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-[11px] gap-1.5"
                        onClick={() => setChartModal({ productId: row.productId, title: row.title, dataType: "steamWishlist" })}
                        data-testid={`button-chart-${row.productId}`}
                      >
                        <BarChart3 className="h-3 w-3" />
                        View Chart
                      </Button>
                    </TableCell>
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
    </div>
  );
}
