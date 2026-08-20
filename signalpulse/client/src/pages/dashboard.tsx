import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Calendar, Users, Gamepad2, ExternalLink } from "lucide-react";
import { formatNumber, formatCurrency, formatDate, getPlatformClass, getPlayerFormatLabel } from "@/lib/utils";
import { useForecastScenario } from "@/hooks/use-forecast-scenario";
import { ForecastScenarioToggle } from "@/components/forecast-scenario-toggle";
import { queryClient } from "@/lib/queryClient";
import { SHARED_WISHLIST_FIELDS, PRODUCT_QUERY_STALE_TIME_MS } from "@/lib/shared-product-fields";

export default function Dashboard() {
  // v3.35 (2026-08-20): staleTime was Infinity with no refetch trigger, so a
  // dashboard tab left open across the daily 07:00 UTC ingestion cron kept
  // showing yesterday's cached numbers indefinitely (root cause of the
  // stale wishlist-card bug). Bounded staleTime + refetchOnWindowFocus caps
  // the worst case at 5 minutes without polling for data that only changes
  // once a day. Targeted to this query only -- the global default is
  // unchanged for queries that intentionally want it.
  const { data: products, isLoading } = useQuery<any[]>({
    queryKey: ["/api/products"],
    staleTime: PRODUCT_QUERY_STALE_TIME_MS,
    refetchOnWindowFocus: true,
  });

  // v3.35 (2026-08-20): single source of truth sync -- whenever this list
  // query resolves with fresh data, push the shared wishlist/forecast
  // fields into any already-cached PDP detail entry for that product too.
  // Only updates entries that already exist in the cache (never creates a
  // new, partially-shaped one), so a PDP the user has open or cached from
  // an earlier visit can't keep showing numbers older than what the
  // dashboard just fetched.
  useEffect(() => {
    if (!products) return;
    for (const p of products) {
      queryClient.setQueryData<any>(["/api/products", p.id], (old: any) => {
        if (!old) return old;
        const next = { ...old };
        for (const field of SHARED_WISHLIST_FIELDS) next[field] = p[field];
        return next;
      });
    }
  }, [products]);
  // v3.32 (2026-08-19): one page-level Bull/Bear toggle controls every
  // card's locked Dynamic Pre-Launch Forecast basis simultaneously
  // (persisted globally -- see hook). Does NOT affect the separate
  // "Dynamic Actuals Driven Forecast" block, which is live/actuals-driven
  // and has no Bull/Bear scenario of its own.
  const [scenario, setScenario] = useForecastScenario();

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
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold" data-testid="text-dashboard-title">Product Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {products?.length ?? 0} titles tracked
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <ForecastScenarioToggle value={scenario} onChange={setScenario} />
          <p className="text-[10px] text-muted-foreground max-w-[220px] text-right">
            Locked Dynamic Pre-Launch Forecast basis for every card's Steam Actuals delta
          </p>
        </div>
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

            // v3.25 (2026-08-19): manually-entered biz case forecasts
            // (compsForecastTotal / latestRevisionTotal) are no longer
            // displayed on the dashboard card -- we only track dynamic
            // forecasts (wishlist-based, or actuals-driven once live).
            const dynFirstUnits = product.dynamicFirstMonthTotal;
            const dynYearUnits = product.dynamicFirstYearTotal;
            const dynLtUnits = product.dynamicLtTotal;

            // v2.5: Steam-only dynamic forecast (from PC (Steam) row only)
            const steamDynFirstUnits = product.steamDynamicFirstMonth;
            const steamDynYearUnits = product.steamDynamicFirstYear;
            const steamDynLtUnits = product.steamDynamicLt;
            const hasSteamDyn = steamDynFirstUnits != null;

            // v3.25 (2026-08-19): the launch-day baseline snapshot and its
            // ±Δ% ('Launch ● Current') tracking were removed from the
            // Dynamic Forecast display per request -- visually noisy and
            // not needed for routine use. formatDeltaPct is kept as a
            // general current-vs-reference percent helper, now used only
            // for the Steam Actuals-vs-Forecast delta below.
            function formatDeltaPct(current: number, baseline: number): { text: string; cls: string } {
              if (baseline <= 0) return { text: '—', cls: 'text-muted-foreground' };
              const pct = ((current - baseline) / baseline) * 100;
              const sign = pct > 0 ? '+' : '';
              const text = `${sign}${pct.toFixed(1)}%`;
              const cls = pct > 0.5 ? 'text-emerald-600 dark:text-emerald-400'
                : pct < -0.5 ? 'text-red-500 dark:text-red-400'
                : 'text-muted-foreground';
              return { text, cls };
            }

            // v3.9 (2026-08-12): blended GMV factor. Server computes it as
            // 0.5 × observedSteamAspRatio + 0.5 × 0.66 when Steam actuals
            // exist. Pre-release or no actuals falls back to 0.66.
            const gmvFactor = product.gmvFactor ?? 0.66;
            const dynFirstGmv = Math.round(dynFirstUnits * price * gmvFactor);
            const dynFirstNet = Math.round(dynFirstGmv * 0.70);
            const dynYearGmv = Math.round(dynYearUnits * price * gmvFactor);
            const dynYearNet = Math.round(dynYearGmv * 0.70);
            const dynLtGmv = Math.round(dynLtUnits * price * gmvFactor);
            const dynLtNet = Math.round(dynLtGmv * 0.70);

            // v3.28 (2026-08-19): the LOCKED Dynamic Pre-Launch Forecast for
            // Steam (wishlist/prepurchase-derived, frozen at first-observed-
            // release, never recomputed). This is now the baseline every
            // actuals delta on this card is measured against — NOT the
            // live Dynamic Actuals-Driven Forecast (steamDynLtUnits), which
            // itself now projects up/down from actuals and would make the
            // delta partially self-referential.
            // v3.32 (2026-08-19): basis now follows the page-level Bull/Bear
            // toggle -- forecastScenarios.{bull,bear} are recomputed from the
            // exact same locked snapshot inputs, just at a different Steam
            // wishlist first-month conversion rate. Falls back to the
            // pre-scenario snapshot field if forecastScenarios is ever absent
            // (e.g. stale cached response).
            const scenarioForecast = product.forecastScenarios?.[scenario];
            const steamPreLaunchLtUnits: number | null =
              scenarioForecast?.steamLifetime ?? product.launchForecastSnapshot?.steamLifetime ?? null;
            const steamPreLaunchLtGmv = (steamPreLaunchLtUnits != null && steamPreLaunchLtUnits > 0)
              ? Math.round(steamPreLaunchLtUnits * price * gmvFactor)
              : null;
            const steamPreLaunchFirstYearUnits: number | null =
              scenarioForecast?.steamFirstYear ?? product.launchForecastSnapshot?.steamFirstYear ?? null;
            const steamPreLaunchFirstYearGmv = (steamPreLaunchFirstYearUnits != null && steamPreLaunchFirstYearUnits > 0)
              ? Math.round(steamPreLaunchFirstYearUnits * price * gmvFactor)
              : null;

            // v3.29 (2026-08-19): comparing a few days of actuals against a
            // LIFETIME forecast produces a misleadingly huge negative % for
            // every freshly-released title (e.g. Twisted Tower at -93% two
            // days post-release). Gate + bucket the actuals-vs-forecast
            // delta by days since release so the comparison basis always
            // matches how much of the title's life has actually elapsed:
            //   < 30d   -> hidden entirely (too little signal to be meaningful)
            //   30-365d -> compare vs the locked First-Year forecast
            //   365d+   -> compare vs the locked Lifetime forecast
            const releaseDateStr: string | null = product.releaseDate ?? null;
            const daysSinceRelease = releaseDateStr
              ? Math.floor((Date.now() - Date.parse(releaseDateStr)) / 86400000)
              : null;
            const deltaBasis: "none" | "firstYear" | "lifetime" =
              daysSinceRelease == null || daysSinceRelease < 30 ? "none"
              : daysSinceRelease < 365 ? "firstYear"
              : "lifetime";
            const deltaBasisUnits = deltaBasis === "firstYear" ? steamPreLaunchFirstYearUnits
              : deltaBasis === "lifetime" ? steamPreLaunchLtUnits
              : null;
            const deltaBasisGmv = deltaBasis === "firstYear" ? steamPreLaunchFirstYearGmv
              : deltaBasis === "lifetime" ? steamPreLaunchLtGmv
              : null;
            const scenarioLabel = scenario === "bear" ? "Bear 18%" : "Bull 45%";
            const deltaBasisLabel = deltaBasis === "firstYear" ? "1st-yr forecast" : "lifetime forecast";

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

                  {/* v3.25 (2026-08-19): 'Steam — Actuals' now renders FIRST
                      (was second) so actuals are the primary read and the
                      forecast sits below for context. Shows only when
                      there's ingested sales data. Two subrows:
                        1. Revenue triad (Pre / Post / Total)
                        2. Units triad (Pre / Post / Total) with base ASP
                      v3.25: Total Revenue / Total Units now also show the
                      delta vs the Steam Dynamic Lifetime Forecast, but only
                      when that forecast exists -- otherwise no delta line.
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
                    // v3.28: delta now measured vs the locked Dynamic
                    // Pre-Launch Forecast (steamPreLaunchLtGmv/Units), not
                    // the live actuals-driven forecast.
                    const revDelta = deltaBasisGmv != null && deltaBasisGmv > 0
                      ? formatDeltaPct(rev.totalRevenueUsd, deltaBasisGmv)
                      : null;
                    const unitsDelta = deltaBasisUnits != null && deltaBasisUnits > 0
                      ? formatDeltaPct(rev.totalBaseNetUnits, deltaBasisUnits)
                      : null;
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
                            {revDelta && (
                              <div
                                title={`Steam Total Revenue vs the locked Dynamic Pre-Launch Forecast's ${deltaBasisLabel} (${scenarioLabel} wishlist/prepurchase baseline) -- hidden until 30 days post-release`}
                                className={`text-[10px] font-semibold tabular-nums ${revDelta.cls}`}
                              >
                                {revDelta.text} vs {deltaBasisLabel}
                              </div>
                            )}
                            {!revDelta && daysSinceRelease != null && daysSinceRelease < 30 && (
                              <div className="text-[10px] text-muted-foreground/70">
                                Δ vs forecast in {30 - daysSinceRelease}d
                              </div>
                            )}
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
                            {unitsDelta && (
                              <div
                                title={`Steam Total Units vs the locked Dynamic Pre-Launch Forecast's ${deltaBasisLabel} (${scenarioLabel} wishlist/prepurchase baseline) -- hidden until 30 days post-release`}
                                className={`text-[10px] font-semibold tabular-nums ${unitsDelta.cls}`}
                              >
                                {unitsDelta.text} vs {deltaBasisLabel}
                              </div>
                            )}
                            {!unitsDelta && daysSinceRelease != null && daysSinceRelease < 30 && (
                              <div className="text-[10px] text-muted-foreground/70">
                                Δ vs forecast in {30 - daysSinceRelease}d
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="text-[9px] text-muted-foreground mt-1.5">
                          Base game only for ASP · revenue includes base + paid DLC
                        </div>
                      </div>
                    );
                  })()}

                  {/* v3.25 (2026-08-19): Dynamic Forecast Across All Platforms
                      (renamed from 'Dynamic Forecasts'; now renders SECOND,
                      below Steam Actuals). Simplified per request:
                        • Launch-baseline / ±Δ% tracking removed from the
                          Units tiles — visually noisy, not needed routinely.
                        • Manually-entered biz case forecasts removed
                          entirely — dynamic forecasts (wishlist-based, or
                          actuals-driven once live) are now the only forecast
                          tracked on this card.
                      Still split into two blocks:
                        A. Units block — 1st Month / 1st Year / Lifetime, with
                           Steam-only inline underneath each All-Platforms total.
                        B. Revenue block — GMV + Net at each timeframe.
                      Followed by a per-platform breakdown table showing how the
                      All-Platforms total splits by platform. */}
                  <div className="pt-3 mt-3 border-t">
                    <div className="flex items-baseline justify-between mb-2">
                      <div className="text-[10px] uppercase tracking-widest font-semibold text-blue-600 dark:text-blue-400 flex items-center gap-1.5">
                        Dynamic Actuals Driven Forecast
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
                          title="Wishlist-based forecast: Steam 1st-Mo = pre-release wishlist × 45%. Consoles derived from platform mix. Switches to actuals-driven 30 days after release."
                          className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-semibold uppercase tracking-wide"
                        >
                          Wishlist-based
                        </span>
                      )}
                    </div>

                    {/* Block A — Units. Clean single-line-per-tile display:
                        current dynamic forecast value only, no baseline, no
                        delta. */}
                    <div className="mb-3">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
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
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
