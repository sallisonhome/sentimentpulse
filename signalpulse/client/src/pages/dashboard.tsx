import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Calendar, Users, Gamepad2, TrendingUp, DollarSign, ExternalLink } from "lucide-react";
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

            // v2.5: Steam-only dynamic forecast (from PC (Steam) row only)
            const steamDynFirstUnits = product.steamDynamicFirstMonth;
            const steamDynYearUnits = product.steamDynamicFirstYear;
            const steamDynLtUnits = product.steamDynamicLt;
            const hasSteamDyn = steamDynFirstUnits != null;

            // v3.9 (2026-08-12): blended GMV factor. Server computes it as
            // 0.5 × observedSteamAspRatio + 0.5 × 0.66 when Steam actuals
            // exist. Pre-release or no actuals falls back to 0.66.
            const gmvFactor = product.gmvFactor ?? 0.66;
            const originalGmv = Math.round(originalUnits * price * gmvFactor);
            const originalNet = Math.round(originalGmv * 0.70);
            const revisedGmv = revisedUnits != null ? Math.round(revisedUnits * price * gmvFactor) : null;
            const revisedNet = revisedGmv != null ? Math.round(revisedGmv * 0.70) : null;
            const dynFirstGmv = Math.round(dynFirstUnits * price * gmvFactor);
            const dynFirstNet = Math.round(dynFirstGmv * 0.70);
            const dynYearGmv = Math.round(dynYearUnits * price * gmvFactor);
            const dynYearNet = Math.round(dynYearGmv * 0.70);
            const dynLtGmv = Math.round(dynLtUnits * price * gmvFactor);
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

                  {/* v3.4 (2026-08-11): Dynamic Forecasts, redesigned for clarity.
                      Split into two visually distinct blocks:
                        A. Units block — 1st Month / 1st Year / Lifetime, with
                           Steam-only inline underneath each All-Platforms total.
                        B. Revenue block — GMV + Net at each timeframe.
                      Followed by a per-platform breakdown table showing how the
                      All-Platforms total splits by platform. */}
                  <div className="pt-3 mt-3 border-t">
                    <div className="flex items-baseline justify-between mb-2">
                      <div className="text-[10px] uppercase tracking-widest font-semibold text-blue-600 dark:text-blue-400 flex items-center gap-1.5">
                        Dynamic Forecasts
                        <span className="text-[9px] normal-case tracking-normal text-muted-foreground/80 font-normal">
                          click card for methodology →
                        </span>
                      </div>
                      {/* v3.7: forecast provenance badge */}
                      {product.forecastMode === "actuals" && (
                        <span
                          title={`Actuals-driven: Steam 1st-Mo = ${formatNumber(product.steamActualFirstMonthUnits)} observed base units. Wishlist forecast was ${formatNumber(product.wishlistBasedSteamFirstMonth)} — lift ${(product.steamActualFirstMonthUnits / product.wishlistBasedSteamFirstMonth).toFixed(2)}x. Consoles receive dampened lift of ${product.consoleLiftFactor.toFixed(2)}x (50% of Steam lift).`}
                          className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-semibold uppercase tracking-wide"
                        >
                          Actuals-driven
                        </span>
                      )}
                      {product.forecastMode === "wishlist" && (
                        <span
                          title="Wishlist-based forecast: Steam 1st-Mo = pre-release wishlist × 27%. Consoles derived from platform mix. Switches to actuals-driven 30 days after release."
                          className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-semibold uppercase tracking-wide"
                        >
                          Wishlist-based
                        </span>
                      )}
                    </div>

                    {/* Block A — Units */}
                    <div className="mb-3">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5 font-medium">
                        Units
                      </div>
                      <div className="grid grid-cols-3 gap-x-3">
                        {[
                          { label: "1st Month", allUnits: dynFirstUnits, steamUnits: steamDynFirstUnits },
                          { label: "1st Year", allUnits: dynYearUnits, steamUnits: steamDynYearUnits },
                          { label: "Lifetime", allUnits: dynLtUnits, steamUnits: steamDynLtUnits },
                        ].map((col) => (
                          <div key={col.label} className="rounded-md border bg-blue-500/5 dark:bg-blue-500/10 p-2">
                            <div className="text-[10px] text-muted-foreground">{col.label}</div>
                            <div className="text-base font-bold tabular-nums text-blue-700 dark:text-blue-300 leading-tight">
                              {formatNumber(col.allUnits)}
                            </div>
                            <div className="text-[9px] text-muted-foreground">All Platforms</div>
                            {hasSteamDyn && col.steamUnits != null && (
                              <div className="mt-1 pt-1 border-t border-blue-500/20">
                                <div className="text-[10px] tabular-nums text-blue-600/80 dark:text-blue-400/80">
                                  {formatNumber(col.steamUnits)}
                                </div>
                                <div className="text-[9px] text-muted-foreground">Steam only</div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Block B — Revenue */}
                    {hasPrice && (
                      <div className="mb-3">
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5 font-medium">
                          Revenue (All Platforms) · GMV → Net
                        </div>
                        <div className="grid grid-cols-3 gap-x-3">
                          {[
                            { label: "1st Month", gmv: dynFirstGmv, net: dynFirstNet },
                            { label: "1st Year", gmv: dynYearGmv, net: dynYearNet },
                            { label: "Lifetime", gmv: dynLtGmv, net: dynLtNet },
                          ].map((col) => (
                            <div key={col.label} className="rounded-md border bg-emerald-500/5 dark:bg-emerald-500/10 p-2">
                              <div className="text-[10px] text-muted-foreground">{col.label}</div>
                              <div className="text-sm font-semibold tabular-nums text-emerald-700 dark:text-emerald-300 leading-tight">
                                {formatCurrency(col.gmv)}
                              </div>
                              <div className="text-[9px] text-muted-foreground">GMV (gross)</div>
                              <div className="mt-1 pt-1 border-t border-emerald-500/20">
                                <div className="text-[10px] tabular-nums text-emerald-600 dark:text-emerald-400">
                                  {formatCurrency(col.net)}
                                </div>
                                <div className="text-[9px] text-muted-foreground">Net (after Steam+dev cuts)</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Per-platform breakdown — shows how All-Platforms rolls up */}
                    {product.dynamicPerPlatform && product.dynamicPerPlatform.length > 0 && (
                      <details className="group" onClick={(e) => e.stopPropagation()}>
                        <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground select-none list-none flex items-center gap-1">
                          <span className="group-open:rotate-90 transition-transform inline-block">▶</span>
                          Per-Platform Split (rolls up into All Platforms above)
                        </summary>
                        <div className="mt-2 border rounded-md overflow-hidden">
                          <table className="w-full text-[11px] tabular-nums">
                            <thead className="bg-muted/50">
                              <tr className="text-left">
                                <th className="px-2 py-1 font-medium text-muted-foreground text-[10px] uppercase tracking-wide">Platform</th>
                                <th className="px-2 py-1 font-medium text-muted-foreground text-[10px] uppercase tracking-wide text-right">1st Month</th>
                                <th className="px-2 py-1 font-medium text-muted-foreground text-[10px] uppercase tracking-wide text-right">1st Year</th>
                                <th className="px-2 py-1 font-medium text-muted-foreground text-[10px] uppercase tracking-wide text-right">Lifetime</th>
                              </tr>
                            </thead>
                            <tbody>
                              {product.dynamicPerPlatform.map((row: any) => (
                                <tr key={row.platform} className="border-t">
                                  <td className="px-2 py-1 text-foreground">
                                    <span className={`inline-flex items-center px-1.5 py-0 rounded text-[9px] font-medium border ${getPlatformClass(row.platform)}`}>
                                      {row.platform}
                                    </span>
                                  </td>
                                  <td className="px-2 py-1 text-right text-blue-700 dark:text-blue-300">{formatNumber(row.firstMonth)}</td>
                                  <td className="px-2 py-1 text-right text-blue-700 dark:text-blue-300">{formatNumber(row.firstYear)}</td>
                                  <td className="px-2 py-1 text-right text-blue-700 dark:text-blue-300">{formatNumber(row.lifetime)}</td>
                                </tr>
                              ))}
                              <tr className="border-t bg-muted/30 font-semibold">
                                <td className="px-2 py-1 text-muted-foreground text-[10px] uppercase tracking-wide">Total</td>
                                <td className="px-2 py-1 text-right">{formatNumber(dynFirstUnits)}</td>
                                <td className="px-2 py-1 text-right">{formatNumber(dynYearUnits)}</td>
                                <td className="px-2 py-1 text-right">{formatNumber(dynLtUnits)}</td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      </details>
                    )}
                  </div>

                  {/* v3.4 (2026-08-11): 'Steam — Actuals' section. Shows only
                      when there's ingested sales data. Two subrows:
                        1. Revenue triad (Pre / Post / Total)
                        2. Units triad (Pre / Post / Total) with base ASP
                      Tagged 'Steam' explicitly so other platforms can slot in
                      later as parallel sections (Xbox — Actuals, PSN — Actuals). */}
                  {(() => {
                    const rev = product.steamRevenueSplit as {
                      preReleaseRevenueUsd: number;
                      postReleaseRevenueUsd: number;
                      totalRevenueUsd: number;
                      preReleaseBaseNetUnits: number;
                      postReleaseBaseNetUnits: number;
                      totalBaseNetUnits: number;
                      preReleaseBaseAspUsd: number | null;
                      postReleaseBaseAspUsd: number | null;
                      totalBaseAspUsd: number | null;
                      preReleaseRowCount: number;
                      postReleaseRowCount: number;
                      releaseDate: string | null;
                      latestDate: string | null;
                    } | null | undefined;
                    if (!rev || rev.totalRevenueUsd <= 0) return null;
                    const hasPre = rev.preReleaseRevenueUsd > 0;
                    return (
                      <div className="pt-3 mt-3 border-t">
                        <div className="flex items-baseline justify-between mb-2">
                          <div className="text-[10px] uppercase tracking-widest font-semibold text-blue-600 dark:text-blue-400 flex items-center gap-1.5">
                            Steam — Actuals
                            <span className="text-[9px] normal-case tracking-normal text-muted-foreground/80 font-normal">
                              click card for daily chart →
                            </span>
                          </div>
                          <div className="text-[9px] text-muted-foreground">
                            Through {rev.latestDate ?? "—"}
                          </div>
                        </div>
                        {/* Revenue row */}
                        <div className="grid grid-cols-3 gap-x-3 gap-y-1 mb-2">
                          <div>
                            <div className="text-[10px] text-muted-foreground">Steam Pre-Release Revenue</div>
                            <div className={`text-sm font-semibold tabular-nums ${hasPre ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground/50"}`}
                              data-testid={`text-steam-rev-prerelease-${product.id}`}>
                              {formatCurrency(rev.preReleaseRevenueUsd)}
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] text-muted-foreground">Steam Post-Release Revenue</div>
                            <div className="text-sm font-semibold tabular-nums text-emerald-600 dark:text-emerald-400"
                              data-testid={`text-steam-rev-postrelease-${product.id}`}>
                              {formatCurrency(rev.postReleaseRevenueUsd)}
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] text-muted-foreground">Steam Total Revenue</div>
                            <div className="text-sm font-bold tabular-nums text-emerald-700 dark:text-emerald-300"
                              data-testid={`text-steam-rev-total-${product.id}`}>
                              {formatCurrency(rev.totalRevenueUsd)}
                            </div>
                          </div>
                        </div>
                        {/* Units + ASP row */}
                        <div className="grid grid-cols-3 gap-x-3 gap-y-1">
                          <div>
                            <div className="text-[10px] text-muted-foreground">Steam Pre-Release Units · ASP</div>
                            <div className="text-sm font-semibold tabular-nums text-foreground"
                              data-testid={`text-steam-units-prerelease-${product.id}`}>
                              {formatNumber(rev.preReleaseBaseNetUnits)}
                            </div>
                            <div className="text-[10px] tabular-nums text-muted-foreground">
                              ASP {rev.preReleaseBaseAspUsd != null ? `\$${rev.preReleaseBaseAspUsd.toFixed(2)}` : "—"}
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] text-muted-foreground">Steam Post-Release Units · ASP</div>
                            <div className="text-sm font-semibold tabular-nums text-foreground"
                              data-testid={`text-steam-units-postrelease-${product.id}`}>
                              {formatNumber(rev.postReleaseBaseNetUnits)}
                            </div>
                            <div className="text-[10px] tabular-nums text-muted-foreground">
                              ASP {rev.postReleaseBaseAspUsd != null ? `\$${rev.postReleaseBaseAspUsd.toFixed(2)}` : "—"}
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] text-muted-foreground">Steam Total Units · ASP</div>
                            <div className="text-sm font-bold tabular-nums text-foreground"
                              data-testid={`text-steam-units-total-${product.id}`}>
                              {formatNumber(rev.totalBaseNetUnits)}
                            </div>
                            <div className="text-[10px] tabular-nums text-muted-foreground">
                              ASP {rev.totalBaseAspUsd != null ? `\$${rev.totalBaseAspUsd.toFixed(2)}` : "—"}
                            </div>
                          </div>
                        </div>
                        <div className="text-[9px] text-muted-foreground mt-1.5">
                          Base game only for ASP · revenue includes base + paid DLC
                        </div>
                      </div>
                    );
                  })()}

                  {/* v3.6 (2026-08-12): Bottom affordance strip so users always
                      know the whole card is clickable to open the full PDP. */}
                  <div className="flex items-center justify-between pt-3 mt-3 border-t">
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wide">
                      Click card to open full product details, PLS milestones, and interactive charts
                    </div>
                    <div className="flex items-center gap-1 text-[11px] font-medium text-primary">
                      <span>Open detail page</span>
                      <ExternalLink className="h-3 w-3" />
                    </div>
                  </div>

                  {/* v3.4: Business Case row (Original + Revised + Trend) — kept
                      compact at the bottom since it's the reference-point row. */}
                  <div className={`grid ${hasRevision ? "grid-cols-3" : "grid-cols-2"} gap-x-3 pt-3 mt-3 border-t`}>
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Original LT Biz Case</div>
                      <div className="text-sm font-semibold tabular-nums text-foreground">
                        {formatNumber(originalUnits)}
                      </div>
                      {hasPrice && (
                        <div className="text-[10px] tabular-nums text-muted-foreground">
                          {formatCurrency(originalNet)} net
                        </div>
                      )}
                    </div>
                    {hasRevision && (
                      <div>
                        <div className="text-[10px] text-primary uppercase tracking-wide font-semibold">
                          {revisedLabel}
                        </div>
                        <div className="text-sm font-semibold tabular-nums text-primary flex items-center gap-1"
                          data-testid={`text-forecast-${product.id}`}>
                          <TrendingUp className="h-3 w-3" />
                          {formatNumber(revisedUnits!)}
                        </div>
                        {hasPrice && (
                          <div className="text-[10px] tabular-nums text-muted-foreground">
                            {formatCurrency(revisedNet!)} net
                          </div>
                        )}
                      </div>
                    )}
                    <div>
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Dyn LT vs Biz Case</div>
                      <div className={`text-sm font-bold tabular-nums ${deltaColor}`}>
                        {deltaStr}
                      </div>
                      <div className="text-[10px] text-muted-foreground">{deltaSub}</div>
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
