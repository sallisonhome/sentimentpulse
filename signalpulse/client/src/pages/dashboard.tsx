import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Calendar, Users, Gamepad2, TrendingUp, DollarSign } from "lucide-react";
import { format } from "date-fns";
import { formatNumber, formatCurrency, formatDate, getPlatformClass, getPlayerFormatLabel } from "@/lib/utils";

export default function Dashboard() {
  const { data: products, isLoading } = useQuery<any[]>({
    queryKey: ["/api/products"],
  });

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="mb-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-72 mt-2" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[1, 2, 3].map(i => (
            <Skeleton key={i} className="h-64 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-lg font-semibold" data-testid="text-dashboard-title">Product Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          {products?.length ?? 0} titles tracked
        </p>
      </div>

      {(!products || products.length === 0) ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Gamepad2 className="h-12 w-12 text-muted-foreground/40 mb-4" />
          <h2 className="text-sm font-medium text-muted-foreground">No products yet</h2>
          <p className="text-xs text-muted-foreground/70 mt-1">Click "+ Add Product" to get started</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {products.map((product: any) => {
            const price = product.targetRetailPriceUsd ?? 0;
            const hasPrice = price > 0;

            // v1.1 (2026-07-22): show ORIGINAL and REVISED as distinct columns
            // when a revision exists (was collapsed into one 'bizLabel' col).
            // Delta moved to far right and now compares Dyn LT vs Revised
            // (falls back to Dyn LT vs Original when no revision exists).
            const originalUnits = product.compsForecastTotal;
            const hasRevision = product.latestRevisionTotal != null;
            const revisedUnits = hasRevision ? product.latestRevisionTotal : null;
            const dynFirstUnits = product.dynamicFirstMonthTotal;
            const dynYearUnits = product.dynamicFirstYearTotal;
            const dynLtUnits = product.dynamicLtTotal;

            // Financial: GMV = units × price × 0.66, Net = GMV × 0.70
            const originalGmv = Math.round(originalUnits * price * 0.66);
            const originalNet = Math.round(originalGmv * 0.70);
            const revisedGmv = revisedUnits != null ? Math.round(revisedUnits * price * 0.66) : null;
            const revisedNet = revisedGmv != null ? Math.round(revisedGmv * 0.70) : null;
            const dynFirstGmv = Math.round(dynFirstUnits * price * 0.66);
            const dynFirstNet = Math.round(dynFirstGmv * 0.70);
            const dynYearGmv = Math.round(dynYearUnits * price * 0.66);
            const dynYearNet = Math.round(dynYearGmv * 0.70);
            const dynLtGmv = Math.round(dynLtUnits * price * 0.66);
            const dynLtNet = Math.round(dynLtGmv * 0.70);

            // Delta: Dyn LT vs Revised (if revised exists) else vs Original
            const compareUnits = revisedUnits != null ? revisedUnits : originalUnits;
            let deltaStr = '—';
            let deltaColor = 'text-muted-foreground';
            if (compareUnits > 0) {
              const pct = ((dynLtUnits - compareUnits) / compareUnits) * 100;
              deltaStr = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
              deltaColor = pct > 0 ? 'text-emerald-600 dark:text-emerald-400'
                : pct < 0 ? 'text-red-500 dark:text-red-400'
                : 'text-muted-foreground';
            }
            const deltaSub = hasRevision ? "Dyn LT vs Revised" : "Dyn LT vs Original";
            const revisedLabel = hasRevision
              ? `Revised (${format(new Date(product.latestRevisionDate + "T00:00:00"), "MMM d, yyyy")})`
              : null;

            // Flag seeded dummy products by their known titles
            const DUMMY_TITLES = ['Warhammer 40,000: Space Marine 2', 'Expeditions: A New Earth'];
            const isDummy = DUMMY_TITLES.includes(product.title);

            return (
              <Link key={product.id} href={`/products/${product.id}`}>
                <Card
                  className="p-4 cursor-pointer transition-all duration-150 hover:shadow-lg dark:hover:border-primary/30 group border"
                  data-testid={`card-product-${product.id}`}
                >
                  {/* Dummy data disclaimer */}
                  {isDummy && (
                    <div className="text-[10px] font-semibold text-red-500 uppercase tracking-wide mb-2">
                      NOT ACTUAL DATA — USING DUMMY DATA FOR EXAMPLE
                    </div>
                  )}
                  {/* Header: Title + Meta */}
                  <div className="flex items-start justify-between mb-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-semibold group-hover:text-primary transition-colors line-clamp-1" data-testid={`text-title-${product.id}`}>
                        {product.title}
                      </h3>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-muted-foreground">{product.publisher}</span>
                        {!product.isSaberPublished && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-normal text-amber-600 dark:text-amber-400 border-amber-500/30">
                            External
                          </Badge>
                        )}
                      </div>
                    </div>
                    {hasPrice && (
                      <div className="inline-flex items-center px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-[11px] font-semibold tabular-nums text-foreground shrink-0 ml-3">
                        ${price.toFixed(2)}
                      </div>
                    )}
                  </div>

                  {/* Metadata row */}
                  <div className="flex items-center flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground mb-3">
                    <span className="flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {formatDate(product.releaseDate)}
                    </span>
                    <span className="flex items-center gap-1">
                      <Users className="h-3 w-3" />
                      {getPlayerFormatLabel(product.playerFormat)}
                    </span>
                    <span>{product.genre}</span>
                    <div className="flex flex-wrap gap-1">
                      {product.platforms.map((p: string) => (
                        <span
                          key={p}
                          className={`inline-flex items-center px-1.5 py-0 rounded text-[9px] font-medium border ${getPlatformClass(p)}`}
                        >
                          {p}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Wishlist row — Pre-Release WL (primary, drives forecasts)
                      + Current WL (with day-over-day delta) + PS5 WL. */}
                  {(() => {
                    const summary = product.steamWishlistSummary as {
                      preLaunchNet: number | null;
                      lifetimeNet: number | null;
                      dayOverDayDelta: number | null;
                      isStale: boolean;
                    } | null | undefined;
                    const preRelease = summary?.preLaunchNet ?? product.latestSteamWishlistCount;
                    const current = summary?.lifetimeNet ?? product.latestSteamWishlistCount;
                    const delta = summary?.dayOverDayDelta ?? null;
                    const deltaCls = delta == null
                      ? ""
                      : delta > 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : delta < 0
                          ? "text-red-600 dark:text-red-400"
                          : "text-muted-foreground";
                    return (
                      <div className="grid grid-cols-3 gap-x-3 gap-y-2 pt-3 border-t">
                        <div>
                          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Steam Pre-Release WL</div>
                          <div className="text-sm font-semibold tabular-nums mt-0.5" data-testid={`text-steam-wl-prerelease-${product.id}`}>
                            {formatNumber(preRelease)}
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Steam Current WL</div>
                          <div className="text-sm font-semibold tabular-nums mt-0.5" data-testid={`text-steam-wl-current-${product.id}`}>
                            {formatNumber(current)}
                          </div>
                          {delta != null && (
                            <div className={`text-[10px] font-medium tabular-nums ${deltaCls}`}>
                              {delta > 0 ? "+" : delta < 0 ? "" : "±"}{formatNumber(delta)}
                            </div>
                          )}
                        </div>
                        <div>
                          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">PS5 WL</div>
                          <div className="text-sm font-semibold tabular-nums mt-0.5" data-testid={`text-ps5-wl-${product.id}`}>
                            {formatNumber(product.latestPs5WishlistCount)}
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  {/* v1.1: Forecast data grid — 6 columns when a revision
                      exists (Original + Revised as separate cols), else 5 cols
                      (Original only). */}
                  <div className={`grid ${hasRevision ? "grid-cols-6" : "grid-cols-5"} gap-x-2 pt-3 mt-2 border-t`}>
                    {/* Dynamic First Month */}
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wide leading-tight">Dyn. 1st Mo</div>
                      <div className="text-sm font-semibold tabular-nums mt-0.5 text-blue-600 dark:text-blue-400">
                        {formatNumber(dynFirstUnits)}
                      </div>
                      {hasPrice && (
                        <div className="mt-1 space-y-0">
                          <div className="text-[10px] tabular-nums text-emerald-600 dark:text-emerald-400 font-medium">
                            {formatCurrency(dynFirstGmv)} <span className="text-muted-foreground font-normal">g</span>
                          </div>
                          <div className="text-[10px] tabular-nums text-emerald-600/80 dark:text-emerald-500 font-medium">
                            {formatCurrency(dynFirstNet)} <span className="text-muted-foreground font-normal">n</span>
                          </div>
                        </div>
                      )}
                    </div>
                    {/* Dynamic 1 Year */}
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wide leading-tight">Dyn. 1 Yr</div>
                      <div className="text-sm font-semibold tabular-nums mt-0.5 text-blue-600 dark:text-blue-400">
                        {formatNumber(dynYearUnits)}
                      </div>
                      {hasPrice && (
                        <div className="mt-1 space-y-0">
                          <div className="text-[10px] tabular-nums text-emerald-600 dark:text-emerald-400 font-medium">
                            {formatCurrency(dynYearGmv)} <span className="text-muted-foreground font-normal">g</span>
                          </div>
                          <div className="text-[10px] tabular-nums text-emerald-600/80 dark:text-emerald-500 font-medium">
                            {formatCurrency(dynYearNet)} <span className="text-muted-foreground font-normal">n</span>
                          </div>
                        </div>
                      )}
                    </div>
                    {/* Dynamic LT Forecast */}
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wide leading-tight">Dyn. LT</div>
                      <div className="text-sm font-semibold tabular-nums mt-0.5 text-blue-600 dark:text-blue-400">
                        {formatNumber(dynLtUnits)}
                      </div>
                      {hasPrice && (
                        <div className="mt-1 space-y-0">
                          <div className="text-[10px] tabular-nums text-emerald-600 dark:text-emerald-400 font-medium">
                            {formatCurrency(dynLtGmv)} <span className="text-muted-foreground font-normal">g</span>
                          </div>
                          <div className="text-[10px] tabular-nums text-emerald-600/80 dark:text-emerald-500 font-medium">
                            {formatCurrency(dynLtNet)} <span className="text-muted-foreground font-normal">n</span>
                          </div>
                        </div>
                      )}
                    </div>
                    {/* Original LT Biz Forecast (always shown) */}
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wide leading-tight">
                        Original LT Biz Forecast
                      </div>
                      <div className="text-sm font-semibold tabular-nums mt-0.5">
                        {formatNumber(originalUnits)}
                      </div>
                      {hasPrice && (
                        <div className="mt-1 space-y-0">
                          <div className="text-[10px] tabular-nums text-emerald-600 dark:text-emerald-400 font-medium">
                            {formatCurrency(originalGmv)} <span className="text-muted-foreground font-normal">g</span>
                          </div>
                          <div className="text-[10px] tabular-nums text-emerald-600/80 dark:text-emerald-500 font-medium">
                            {formatCurrency(originalNet)} <span className="text-muted-foreground font-normal">n</span>
                          </div>
                        </div>
                      )}
                    </div>
                    {/* Revised LT Biz Forecast (only when a revision exists) */}
                    {hasRevision && (
                      <div>
                        <div className="text-[10px] text-primary uppercase tracking-wide leading-tight font-semibold">
                          {revisedLabel}
                        </div>
                        <div className="text-sm font-semibold tabular-nums mt-0.5 flex items-center gap-1 text-primary" data-testid={`text-forecast-${product.id}`}>
                          <TrendingUp className="h-3 w-3" />
                          {formatNumber(revisedUnits!)}
                        </div>
                        {hasPrice && (
                          <div className="mt-1 space-y-0">
                            <div className="text-[10px] tabular-nums text-emerald-600 dark:text-emerald-400 font-medium">
                              {formatCurrency(revisedGmv!)} <span className="text-muted-foreground font-normal">g</span>
                            </div>
                            <div className="text-[10px] tabular-nums text-emerald-600/80 dark:text-emerald-500 font-medium">
                              {formatCurrency(revisedNet!)} <span className="text-muted-foreground font-normal">n</span>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    {/* +/-% Delta (far right) */}
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wide leading-tight">Trend +/- %</div>
                      <div className={`text-sm font-bold tabular-nums mt-0.5 ${deltaColor}`}>
                        {deltaStr}
                      </div>
                      <div className="text-[10px] text-muted-foreground mt-1">{deltaSub}</div>
                    </div>
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
