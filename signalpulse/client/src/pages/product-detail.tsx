import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useState } from "react";
import {
  ArrowLeft, Edit2, ChevronDown, ChevronRight, Info, AlertTriangle, BarChart3, Plus, Clock,
  Upload, DollarSign, Trash2
} from "lucide-react";
import { formatNumber, formatCurrency, formatDate, getPlatformClass, getPlayerFormatLabel } from "@/lib/utils";
import { AddProductDialog } from "@/components/add-product-dialog";
import { PLSSection } from "@/components/pls-section";
import { DataInputDialog } from "@/components/data-input-dialog";
import { ChartDetailModal, type ChartDataType } from "@/components/chart-detail-modal";
import { SparklineChart, type TimeSeriesDataPoint, SectionSparkline } from "@/components/time-series-chart";
import { SteamSalesCard } from "@/components/steam-sales-card";
import { ClickablePreview, SectionActions } from "@/components/clickable-preview";
import { ALL_PLATFORMS } from "@shared/schema";
import { useQuery as useChartQuery } from "@tanstack/react-query";

export default function ProductDetail() {
  const params = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const productId = parseInt(params.id!);
  const [editOpen, setEditOpen] = useState(false);
  const [inputDialog, setInputDialog] = useState<{ type: string; open: boolean }>({ type: "", open: false });
  const [chartModal, setChartModal] = useState<{ type: ChartDataType; open: boolean } | null>(null);

  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    steamWishlist: true,
    steamPrepurchase: true,
    steamSales: true,
    ps5Wishlist: true,
    ps5Prepurchase: true,
    ps5Forecast: true,
    dynamicForecasts: true,
    pls: true,
  });

  const toggleSection = (key: string) => {
    setOpenSections(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const { data: product, isLoading } = useQuery<any>({
    queryKey: ["/api/products", productId],
  });

  if (isLoading) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <Skeleton className="h-8 w-64 mb-4" />
        <Skeleton className="h-4 w-96 mb-6" />
        <div className="space-y-4">
          {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-32 rounded-xl" />)}
        </div>
      </div>
    );
  }

  if (!product) {
    return (
      <div className="p-6 text-center">
        <p className="text-muted-foreground">Product not found</p>
      </div>
    );
  }

  const isSaber = product.isSaberPublished;
  const platforms: string[] = product.platforms;
  const hasSteam = platforms.includes("PC (Steam)");
  const hasPs5 = platforms.includes("PS5");
  const prepurchaseActive = product.prepurchaseActive;
  const prepurchaseStartDate = product.prepurchaseStartDate;
  const prepurchaseTargetDate = product.prepurchaseTargetDate;

  // v3.5 (2026-08-11): the Steam Purchases section should render whenever we
  // have EITHER pre-purchase telemetry OR ingested sales data — including for
  // non-Saber titles like SM2 where we don't have Saber's pre-purchase feed
  // but do have portal-fetched daily sales rows.
  const steamRev = product.steamRevenueSplit as {
    preReleaseRevenueUsd: number;
    postReleaseRevenueUsd: number;
    totalRevenueUsd: number;
    preReleaseBaseNetUnits: number;
    postReleaseBaseNetUnits: number;
    totalBaseNetUnits: number;
    totalBaseAspUsd: number | null;
    latestDate: string | null;
  } | null | undefined;
  const hasSteamSalesData = !!steamRev && steamRev.totalRevenueUsd > 0;
  const showSteamPurchasesSection = hasSteam && (
    (isSaber && prepurchaseActive) || hasSteamSalesData
  );

  return (
    <div className="p-6 max-w-5xl mx-auto pb-20">
      {/* Back + Edit */}
      <div className="flex items-center justify-between mb-5">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setLocation("/")}
          className="h-8 text-xs gap-1.5"
          data-testid="button-back"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Dashboard
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setEditOpen(true)}
          className="h-8 text-xs gap-1.5"
          data-testid="button-edit-product"
        >
          <Edit2 className="h-3.5 w-3.5" /> Edit Product
        </Button>
      </div>

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-semibold" data-testid="text-product-title">{product.title}</h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-2 text-xs text-muted-foreground">
          <span>
            Publisher: <strong className="text-foreground">{product.publisher}</strong>
            {!isSaber && (
              <Badge variant="outline" className="ml-1.5 text-[10px] px-1.5 py-0 h-4 font-normal text-amber-600 dark:text-amber-400 border-amber-500/30">
                External
              </Badge>
            )}
          </span>
          <span>Release: <strong className="text-foreground">{formatDate(product.releaseDate)}</strong></span>
          <span>Genre: <strong className="text-foreground">{product.genre}</strong></span>
          <span>Format: <strong className="text-foreground">{getPlayerFormatLabel(product.playerFormat)}</strong></span>
          {product.targetRetailPriceUsd != null && product.targetRetailPriceUsd > 0 && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-[11px] font-semibold tabular-nums text-foreground">
              ${product.targetRetailPriceUsd.toFixed(2)} USD
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
          {platforms.map((p: string) => (
            <span key={p} className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium border ${getPlatformClass(p)}`}>
              {p}
            </span>
          ))}
          <AddPlatformButton productId={productId} currentPlatforms={platforms} />
        </div>
      </div>

      <div className="space-y-3">
        {/* ─── Steam Wishlist Count ───────────────────────────────────── */}
        {hasSteam && (() => {
          // v2.1 (2026-08-11): show current count, day-over-day delta,
          // pre-launch snapshot (locked at release), and first-month
          // forecast (locked to pre-launch × 0.45 once released).
          const summary = product.steamWishlistSummary as {
            preLaunchNet: number | null;
            postLaunchNet: number | null;
            lifetimeNet: number | null;
            dayOverDayDelta: number | null;
            latestDate: string | null;
            dayOverDayComparisonDate: string | null;
            isStale: boolean;
            rowCount: number;
          } | null | undefined;

          const lifetime = summary?.lifetimeNet ?? product.latestSteamWishlistCount;
          const delta = summary?.dayOverDayDelta ?? null;
          const preLaunch = summary?.preLaunchNet ?? null;
          const isStale = summary?.isStale ?? false;
          const latestDate = summary?.latestDate ?? null;

          // Only show pre-launch section if the game has released AND we have
          // pre-launch data to show. Pre-release products don't need this row
          // (their pre-launch total == lifetime count already shown above).
          const today = new Date().toISOString().split("T")[0];
          const releaseDate = product.releaseDate as string | null | undefined;
          const hasReleased = !!releaseDate && releaseDate <= today;
          const showPreLaunchRow = hasReleased && preLaunch != null;

          // Format the day-over-day delta with sign + color.
          const deltaEl = delta != null ? (
            <span
              className={
                delta > 0
                  ? "text-emerald-500"
                  : delta < 0
                    ? "text-red-500"
                    : "text-muted-foreground"
              }
              data-testid="text-steam-wl-delta"
            >
              {delta > 0 ? "+" : delta < 0 ? "" : "±"}{formatNumber(delta)}
            </span>
          ) : null;

          return (
          <CollapsibleSection
            title="Steam Wishlist Count"
            sectionKey="steamWishlist"
            open={openSections.steamWishlist}
            onToggle={toggleSection}
            rightContent={
              <span className="text-sm font-semibold tabular-nums" data-testid="text-steam-wl-ltd">
                LTD: {formatNumber(lifetime)}
              </span>
            }
          >
            <div className="space-y-3">
              {/* Two-cell headline row: Pre-Release (primary, drives forecast)
                  + Current (secondary, with day-over-day delta).
                  Before release they show the same number; after release
                  Pre-Release is locked and Current updates daily. */}
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 grid grid-cols-2 gap-4">
                  {/* Pre-Release count (primary, larger). Always shown. */}
                  <div>
                    <div className="text-xs text-muted-foreground">
                      Steam Pre-Release Wishlist Count
                      {hasReleased && (
                        <span className="ml-1 text-[10px]">(locked at release {releaseDate})</span>
                      )}
                    </div>
                    <div className="text-2xl font-semibold tabular-nums mt-0.5" data-testid="text-steam-wl-prerelease">
                      {formatNumber(preLaunch ?? lifetime)}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      Drives dynamic forecasts
                    </div>
                  </div>

                  {/* Current count (secondary, smaller). Always shown. */}
                  <div>
                    <div className="text-xs text-muted-foreground">
                      Steam Current Wishlist Count
                      {isStale && latestDate && (
                        <span className="ml-1 text-amber-500" title={`Last updated ${latestDate} — data ingestion may be behind`}>
                          ⚠
                        </span>
                      )}
                    </div>
                    <div className="text-lg font-semibold tabular-nums mt-0.5" data-testid="text-steam-wl-current">
                      {formatNumber(lifetime)}
                    </div>
                    {deltaEl && (
                      <div className="text-xs font-medium mt-0.5">
                        {deltaEl}
                        <span className="ml-1 text-[10px] text-muted-foreground font-normal">
                          vs prior day
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setChartModal({ type: "steamWishlist", open: true })}
                    className="h-7 text-[11px] gap-1.5"
                    data-testid="button-chart-steam-wl"
                  >
                    <BarChart3 className="h-3 w-3" />
                    View chart with PLS events
                    <span className="text-primary">→</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setInputDialog({ type: "steamWishlist", open: true })}
                    className="h-7 text-[11px] gap-1"
                    data-testid="button-input-steam-wl"
                  >
                    <span>+</span>
                    Input data
                  </Button>
                </div>
              </div>

              {/* First Month Forecast — always based on pre-release count */}
              <div className="flex items-center justify-between border-t pt-3">
                <div>
                  <div className="text-xs text-muted-foreground">
                    Steam First Month Forecast
                    <span className="ml-1 text-[10px]">
                      (Steam Pre-Release WL × 0.45{hasReleased ? " — locked" : ""})
                    </span>
                  </div>
                  <div className="text-lg font-semibold tabular-nums mt-0.5" data-testid="text-steam-first-month">
                    {formatNumber(product.steamFirstMonthForecast)}{" "}
                    <span className="text-xs font-normal text-muted-foreground">units</span>
                  </div>
                </div>
              </div>

              {/* Sparkline wrapped in ClickablePreview so clicking anywhere
                  opens the detail chart (which includes PLS event overlays). */}
              <ClickablePreview
                onClick={() => setChartModal({ type: "steamWishlist", open: true })}
                testIdPrefix="clickable-steam-wl"
                affordanceLabel="Click for full chart with PLS event overlays →"
              >
                <SectionSparkline productId={productId} endpoint={`/api/products/${productId}/steam/wishlists`} color="#2563EB" />
              </ClickablePreview>
              <InfoMessage>
                Wishlist counts update daily via the Steamworks Partner API. Dynamic
                forecasts (first-month = 45% of pre-release count) are calculated ONLY
                from the pre-release wishlist count.
                {hasReleased
                  ? " Since this title has released, that count is locked to the value as of release day — post-release wishlist growth is informational and does not update the forecast."
                  : " Before release the two counts are identical and the forecast updates daily."}
              </InfoMessage>
            </div>
          </CollapsibleSection>
          );
        })()}

        {/* ─── Steam Pre-Purchase Count ──────────────────────────────── */}
        {/* Steam Purchases (Pre-Release + Post-Release Sales) removed v3.11 (2026-08-12).
            The click-to-chart affordance moved into the Steam Sales section
            below as two side-by-side chart cards (Sales by Units + Sales
            by Revenue). Input Data for pre-purchase is still accessible
            through the pre-release wishlist section flow. */}

        {/* Steam Sales (CSV upload ingest v3.0) */}
        {hasSteam && (
          <CollapsibleSection
            title="Steam Sales"
            sectionKey="steamSales"
            open={openSections.steamSales}
            onToggle={toggleSection}
          >
            <SteamSalesCard
              productId={productId}
              productTitle={product.title}
              releaseDate={product.releaseDate ?? null}
            />
          </CollapsibleSection>
        )}

        {/* ─── PS5 Wishlist Count ────────────────────────────────────── */}
        {hasPs5 && (
          <CollapsibleSection
            title="PS5 Wishlist Count"
            sectionKey="ps5Wishlist"
            open={openSections.ps5Wishlist}
            onToggle={toggleSection}
            rightContent={
              isSaber ? (
                <span className="text-sm font-semibold tabular-nums">
                  LTD: {formatNumber(product.latestPs5WishlistCount)}
                </span>
              ) : null
            }
          >
            {isSaber ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs text-muted-foreground">
                    Updated daily via Sony Partner Portal
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setChartModal({ type: "ps5Wishlist", open: true })}
                      className="h-7 text-[10px] gap-1"
                    >
                      <BarChart3 className="h-3 w-3" /> View Charts
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setInputDialog({ type: "ps5Wishlist", open: true })}
                      className="h-7 text-[10px]"
                    >
                      + Input Data
                    </Button>
                  </div>
                </div>
                {/* Sparkline */}
                <ClickablePreview
                  onClick={() => setChartModal({ type: "ps5Wishlist", open: true })}
                  testIdPrefix="clickable-ps5-wl"
                  affordanceLabel="Click for full chart with PLS event overlays →"
                >
                  <SectionSparkline productId={productId} endpoint={`/api/products/${productId}/ps5/wishlists`} color="#6366F1" />
                </ClickablePreview>
                <InfoMessage>
                  PS5 forecasts do not take into account Wishlist counts due to the omission of the KPI from the PS Store algorithm.
                </InfoMessage>
              </div>
            ) : (
              <NaMessage>Titles not published by Saber are not tracked.</NaMessage>
            )}
          </CollapsibleSection>
        )}

        {/* ─── PS5 Pre-Purchase Count ────────────────────────────────── */}
        {hasPs5 && (
          <CollapsibleSection
            title="PS5 Pre-Purchase Count"
            sectionKey="ps5Prepurchase"
            open={openSections.ps5Prepurchase}
            onToggle={toggleSection}
            rightContent={
              isSaber && prepurchaseActive ? (
                <span className="text-sm font-semibold tabular-nums">
                  LTD: {formatNumber(product.latestPs5PrepurchaseCount)}
                </span>
              ) : null
            }
          >
            {!isSaber ? (
              <NaMessage>
                N/A — published by {product.publisher}. This data is only tracked for Saber-published titles.
              </NaMessage>
            ) : !prepurchaseActive ? (
              <PrepurchaseNotStarted targetDate={prepurchaseTargetDate} />
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs text-muted-foreground">PS5 Dynamic LT Forecast (Pre-Purchase × 8) · Pre-purchase started {formatDate(prepurchaseStartDate)}</div>
                    <div className="text-lg font-semibold tabular-nums mt-0.5" data-testid="text-ps5-first-month">
                      {formatNumber(product.ps5FirstMonthForecast)} <span className="text-xs font-normal text-muted-foreground">LT units</span>
                    </div>
                    <div className="text-xs tabular-nums text-muted-foreground mt-0.5">
                      1 Year: {formatNumber(Math.round(product.ps5FirstMonthForecast / 2))} · 1st Month: {formatNumber(Math.round(product.ps5FirstMonthForecast / 4))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setChartModal({ type: "ps5Prepurchase", open: true })}
                      className="h-7 text-[10px] gap-1"
                    >
                      <BarChart3 className="h-3 w-3" /> View Charts
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setInputDialog({ type: "ps5Prepurchase", open: true })}
                      className="h-7 text-[10px]"
                    >
                      + Input Data
                    </Button>
                  </div>
                </div>
                {/* Sparkline */}
                <ClickablePreview
                  onClick={() => setChartModal({ type: "ps5Prepurchase", open: true })}
                  testIdPrefix="clickable-ps5-pre"
                  affordanceLabel="Click for full chart with PLS event overlays →"
                >
                  <SectionSparkline productId={productId} endpoint={`/api/products/${productId}/ps5/prepurchases`} color="#6366F1" />
                </ClickablePreview>
                <InfoMessage>
                  PS5 Pre-Purchase counts updated daily. Dynamic LT Forecast = 8× PS5 Prepurchase Count. Dynamic 1 Year = LT ÷ 2. Dynamic 1st Month = 1 Year ÷ 2. Other console platforms (Xbox, Switch) are proportioned from PS5 based on platform mix. This number is not relevant for forecasting until 8 weeks prior to launch. Prior to 8 weeks this information is for reference only.
                </InfoMessage>
              </div>
            )}
          </CollapsibleSection>
        )}

        {/* ─── Dynamic Forecasts ─────────────────────────────────────── */}
        <CollapsibleSection
          title="Dynamic Pre Launch Forecasts (All Platforms derived from Steam Wishlist Counts and projected against a normal platform spread based on SKUs)"
          sectionKey="dynamicForecasts"
          open={openSections.dynamicForecasts}
          onToggle={toggleSection}
        >
          <ForecastTable
            dynamicForecasts={product.dynamicForecasts}
            dynamicFullForecasts={product.dynamicFullForecasts}
            preLaunchSnapshot={product.launchForecastSnapshot}
            releaseDate={product.releaseDate ?? null}
            platforms={platforms}
            targetRetailPriceUsd={product.targetRetailPriceUsd}
            perPlatformPricing={product.perPlatformPricing}
            gmvFactor={product.gmvFactor ?? 0.66}
            actualUnitsByPlatform={{
              // v3.26 (2026-08-19): only Steam has a live actuals pipeline
              // today. Add a PS5 entry here once a PSN API key/actuals feed
              // exists -- the table renders "--" for any platform with no
              // entry, so no further UI changes are needed when that lands.
              "PC (Steam)": steamRev?.totalBaseNetUnits ?? undefined,
            }}
          />
        </CollapsibleSection>

        {/* ─── Product Launch Schedule ────────────────────────────────── */}
        <CollapsibleSection
          title="Product Launch Schedule (PLS)"
          sectionKey="pls"
          open={openSections.pls}
          onToggle={toggleSection}
        >
          <PLSSection productId={productId} playerFormat={product.playerFormat} />
        </CollapsibleSection>
      </div>

      {/* Edit Dialog */}
      {editOpen && (
        <AddProductDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          editProduct={product}
        />
      )}

      {/* Data Input Dialog */}
      {inputDialog.open && (
        <DataInputDialog
          open={inputDialog.open}
          onOpenChange={(open) => setInputDialog({ ...inputDialog, open })}
          type={inputDialog.type}
          productId={productId}
        />
      )}

      {/* Chart Detail Modal */}
      {chartModal?.open && (
        <ChartDetailModal
          open={chartModal.open}
          onOpenChange={(open) => setChartModal(open ? chartModal : null)}
          productId={productId}
          productTitle={product.title}
          dataType={chartModal.type}
          releaseDate={product.releaseDate ?? null}
        />
      )}
    </div>
  );
}

// ─── Section Sparkline ───────────────────────────────────────────────────────

// SectionSparkline moved to components/time-series-chart.tsx (v3.10) so
// steam-sales-card.tsx can reuse it. Import above.

// ─── Collapsible Section Component ──────────────────────────────────────────

function CollapsibleSection({
  title, sectionKey, open, onToggle, rightContent, children,
}: {
  title: string;
  sectionKey: string;
  open: boolean;
  onToggle: (key: string) => void;
  rightContent?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={() => onToggle(sectionKey)}>
      <Card className="border overflow-hidden">
        <CollapsibleTrigger asChild>
          <div
            className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors"
            data-testid={`section-toggle-${sectionKey}`}
          >
            <div className="flex items-center gap-2">
              {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
              <span className="text-sm font-semibold">{title}</span>
            </div>
            {rightContent}
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-4 pb-4 pt-1 border-t">
            {children}
          </div>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

// ─── Info Message ───────────────────────────────────────────────────────────

function InfoMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 p-2.5 rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800/40">
      <Info className="h-3.5 w-3.5 text-blue-500 shrink-0 mt-0.5" />
      <p className="text-[11px] text-blue-700 dark:text-blue-300 leading-relaxed">{children}</p>
    </div>
  );
}

// ─── N/A Message ────────────────────────────────────────────────────────────

function NaMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 p-2.5 rounded-md bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/30">
      <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
      <p className="text-[11px] text-amber-700 dark:text-amber-300 leading-relaxed">{children}</p>
    </div>
  );
}

// ─── Pre-Purchase Not Started Message ────────────────────────────────────────

function PrepurchaseNotStarted({ targetDate }: { targetDate: string | null }) {
  return (
    <div className="flex gap-2.5 p-3 rounded-md bg-slate-50 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-700/50">
      <Clock className="h-4 w-4 text-slate-400 shrink-0 mt-0.5" />
      <div>
        <p className="text-xs font-medium text-slate-600 dark:text-slate-300">
          Pre-purchase period has not started yet
        </p>
        {targetDate ? (
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
            Target start date: <strong>{formatDate(targetDate)}</strong>. Data will appear here once the Prepurchase Start milestone has an actual date set in the PLS.
          </p>
        ) : (
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
            No target date set. Set a Prepurchase Start date in the Product Launch Schedule to begin tracking.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Forecast Table ─────────────────────────────────────────────────────────

function ForecastTable({
  dynamicForecasts,
  dynamicFullForecasts,
  preLaunchSnapshot,
  releaseDate,
  platforms,
  targetRetailPriceUsd,
  perPlatformPricing,
  gmvFactor,
  actualUnitsByPlatform,
}: {
  dynamicForecasts: any[];
  dynamicFullForecasts?: any[];
  preLaunchSnapshot?: { perPlatformForecasts?: { platform: string; firstMonth: number; firstYear: number; lifetime: number }[] } | null;
  releaseDate?: string | null;
  platforms: string[];
  targetRetailPriceUsd: number | null;
  perPlatformPricing: Record<string, number> | null;
  // v3.9 (2026-08-12): blended GMV factor. Server-provided; 0.66 default.
  gmvFactor: number;
  // v3.26 (2026-08-19): cumulative actual units sold to date, keyed by
  // platform label. Only platforms with a live actuals pipeline have an
  // entry here (currently just "PC (Steam)"); any platform without an
  // entry renders "—" for both the Actual and Delta columns.
  actualUnitsByPlatform: Partial<Record<string, number>>;
}) {
  // Use server-calculated full forecasts (handles PS5 prepurchase LT-first logic)
  const dynamicMap: Record<string, number> = {};
  const dynamic1YearMap: Record<string, number> = {};
  const dynamicLtMap: Record<string, number> = {};
  if (dynamicFullForecasts && dynamicFullForecasts.length > 0) {
    for (const f of dynamicFullForecasts) {
      dynamicMap[f.platform] = f.firstMonth;
      dynamic1YearMap[f.platform] = f.firstYear;
      dynamicLtMap[f.platform] = f.lifetime;
    }
  } else {
    // Fallback to old dynamicForecasts
    dynamicForecasts?.forEach((d: any) => {
      dynamicMap[d.platform] = d.forecastUnits;
      dynamic1YearMap[d.platform] = d.forecastUnits * 2;
      dynamicLtMap[d.platform] = d.forecastUnits * 4;
    });
  }

  // v3.30 (2026-08-19): ALL THREE forecast columns are now the LOCKED
  // Dynamic Pre-Launch Forecast per platform (once a snapshot exists) --
  // NOT the live Dynamic Actuals-Driven Forecast (dynamicMap/
  // dynamic1YearMap/dynamicLtMap), so the whole row stays a fixed,
  // internally-consistent family (1st Month x2 = 1 Year, x2 again =
  // Lifetime) instead of overperforming titles showing a Lifetime column
  // smaller than the actuals-inflated First Month / 1 Year columns. Each
  // map falls back to the live dynamic equivalent only pre-release,
  // before any snapshot has been captured.
  const preLaunchFirstMonthMap: Record<string, number> = {};
  const preLaunchLtMap: Record<string, number> = {};
  const preLaunchFirstYearMap: Record<string, number> = {};
  for (const f of preLaunchSnapshot?.perPlatformForecasts ?? []) {
    preLaunchFirstMonthMap[f.platform] = f.firstMonth;
    preLaunchLtMap[f.platform] = f.lifetime;
    preLaunchFirstYearMap[f.platform] = f.firstYear;
  }
  const hasPreLaunchSnapshot = Object.keys(preLaunchLtMap).length > 0;
  const effectiveFirstMonthMap: Record<string, number> = {};
  const effectiveFirstYearMap: Record<string, number> = {};
  const effectiveLtMap: Record<string, number> = {};
  for (const p of platforms) {
    effectiveFirstMonthMap[p] = preLaunchFirstMonthMap[p] ?? dynamicMap[p] ?? 0;
    effectiveFirstYearMap[p] = preLaunchFirstYearMap[p] ?? dynamic1YearMap[p] ?? 0;
    effectiveLtMap[p] = preLaunchLtMap[p] ?? dynamicLtMap[p] ?? 0;
  }
  const dynamicTotal = Object.values(effectiveFirstMonthMap).reduce((a, b) => a + b, 0);
  const dynamic1YearTotal = Object.values(effectiveFirstYearMap).reduce((a, b) => a + b, 0);
  const dynamicLtTotal = Object.values(effectiveLtMap).reduce((a, b) => a + b, 0);

  // v3.29 (2026-08-19): the Delta vs Forecast column compares CUMULATIVE
  // actuals-to-date against a locked baseline -- comparing 2 days of
  // actuals against the LIFETIME forecast produces a misleadingly huge
  // negative % for every freshly-released title. Gate + bucket by days
  // since release, same convention as the dashboard card:
  //   < 30d   -> hidden entirely (too little signal to be meaningful)
  //   30-365d -> compare vs the locked First-Year forecast
  //   365d+   -> compare vs the locked Lifetime forecast
  const daysSinceRelease = releaseDate
    ? Math.floor((Date.now() - Date.parse(releaseDate)) / 86400000)
    : null;
  const deltaBasis: "none" | "firstYear" | "lifetime" =
    daysSinceRelease == null || daysSinceRelease < 30 ? "none"
    : daysSinceRelease < 365 ? "firstYear"
    : "lifetime";
  const deltaBaseMap: Record<string, number> = deltaBasis === "firstYear" ? preLaunchFirstYearMap : effectiveLtMap;
  const deltaBasisLabel = deltaBasis === "firstYear" ? "1st-Yr" : "Lifetime";

  // ─── Financial Calculations ─────────────────────────────────────────────
  // GMV (Gross Sales) = Units × Full USD Price × gmvFactor
  // Net Revenue       = GMV × 0.70
  // v3.9 (2026-08-12): gmvFactor is blended — 0.5 × observed Steam
  // ASP/list ratio + 0.5 × 0.66 when Steam actuals exist; else 0.66.
  const price = targetRetailPriceUsd ?? 0;

  function calcGmv(unitsByPlatform: Record<string, number>): number {
    let gmv = 0;
    for (const p of platforms) {
      const units = unitsByPlatform[p] ?? 0;
      const pPrice = perPlatformPricing?.[p] ?? price;
      gmv += units * pPrice * gmvFactor;
    }
    return Math.round(gmv);
  }

  function calcNetFromGmv(gmv: number): number {
    return Math.round(gmv * 0.70);
  }

  const dynamicGmv = calcGmv(effectiveFirstMonthMap);
  const dynamic1YearGmv = calcGmv(effectiveFirstYearMap);
  const dynamicLtGmv = calcGmv(effectiveLtMap);
  const dynamicNet = calcNetFromGmv(dynamicGmv);
  const dynamic1YearNet = calcNetFromGmv(dynamic1YearGmv);
  const dynamicLtNet = calcNetFromGmv(dynamicLtGmv);

  const hasPrice = price > 0;

  // v3.26 (2026-08-19): actual-to-date vs Dynamic LT Forecast delta — same
  // convention as the dashboard's "Steam — Actuals" card (formatDeltaPct):
  // compares CUMULATIVE units sold so far against the LIFETIME forecast, so
  // a negative % early in a title's life is expected and does NOT mean the
  // title is "missing" its forecast — it just hasn't reached end-of-life yet.
  function formatDeltaPct(current: number, baseline: number): { text: string; cls: string } {
    if (baseline <= 0) return { text: "—", cls: "text-muted-foreground" };
    const pct = ((current - baseline) / baseline) * 100;
    const sign = pct > 0 ? "+" : "";
    const text = `${sign}${pct.toFixed(1)}%`;
    const cls = pct > 0.5 ? "text-emerald-600 dark:text-emerald-400"
      : pct < -0.5 ? "text-red-500 dark:text-red-400"
      : "text-muted-foreground";
    return { text, cls };
  }

  const platformsWithActuals = platforms.filter(
    (p) => actualUnitsByPlatform[p] != null && (actualUnitsByPlatform[p] as number) > 0
  );
  const actualUnitsTotal = platformsWithActuals.reduce(
    (sum, p) => sum + (actualUnitsByPlatform[p] as number), 0
  );
  const actualsLtTotal = platformsWithActuals.reduce(
    (sum, p) => sum + (deltaBaseMap[p] ?? 0), 0
  );
  // v3.30 (2026-08-19): the Total Units row only gets a delta when EVERY
  // tracked platform has a live actuals pipeline -- comparing a
  // Steam-only actual against an all-platform forecast total
  // mechanically overstates the delta (e.g. SM2 showed the same +158.2%
  // on Total as on the PC row alone, when every other platform's
  // forecast units were silently included in the denominator with zero
  // actuals to offset them). Once PS5 (and others) report live actuals,
  // this naturally starts showing a real blended total delta.
  const totalDelta = platformsWithActuals.length === platforms.length && deltaBasis !== "none"
    ? formatDeltaPct(actualUnitsTotal, actualsLtTotal)
    : null;

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="table-forecasts">
          <thead>
            <tr className="border-b">
              <th className="text-left py-2 text-xs font-medium text-muted-foreground min-w-[120px]">Platform</th>
              <th className="text-right py-2 text-xs font-medium text-blue-600 dark:text-blue-400 min-w-[130px]">Pre-Launch 1st Month</th>
              <th className="text-right py-2 text-xs font-medium text-blue-600 dark:text-blue-400 min-w-[130px]">Pre-Launch 1 Year</th>
              <th className="text-right py-2 text-xs font-medium text-blue-600 dark:text-blue-400 min-w-[140px]">Pre-Launch Lifetime</th>
              <th className="text-right py-2 text-xs font-medium text-muted-foreground min-w-[130px]">Actual (to date)</th>
              <th className="text-right py-2 text-xs font-medium text-muted-foreground min-w-[100px]">Δ vs Forecast{deltaBasis !== "none" ? ` (${deltaBasisLabel})` : ""}</th>
            </tr>
          </thead>
          <tbody>
            {platforms.map((p) => {
              const actual = actualUnitsByPlatform[p];
              const dynLt = effectiveLtMap[p] ?? 0;
              const deltaBase = deltaBaseMap[p] ?? 0;
              const delta = actual != null && deltaBasis !== "none" ? formatDeltaPct(actual, deltaBase) : null;
              return (
                <tr key={p} className="border-b border-border/50">
                  <td className="py-2">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium border ${getPlatformClass(p)}`}>
                      {p}
                    </span>
                  </td>
                  <td className="text-right py-2 tabular-nums font-semibold text-blue-600 dark:text-blue-400">{formatNumber(effectiveFirstMonthMap[p] ?? 0)}</td>
                  <td className="text-right py-2 tabular-nums font-semibold text-blue-600 dark:text-blue-400">{formatNumber(effectiveFirstYearMap[p] ?? 0)}</td>
                  <td className="text-right py-2 tabular-nums font-semibold text-blue-600 dark:text-blue-400">{formatNumber(dynLt)}</td>
                  <td className="text-right py-2 tabular-nums font-medium">{actual != null ? formatNumber(actual) : "—"}</td>
                  <td className={`text-right py-2 tabular-nums text-xs font-semibold ${delta ? delta.cls : "text-muted-foreground"}`}>
                    {delta ? delta.text : "—"}
                  </td>
                </tr>
              );
            })}
            {/* ── Unit Totals Row ── */}
            <tr className="font-semibold border-b">
              <td className="py-2 text-xs uppercase tracking-wide text-muted-foreground">Total Units</td>
              <td className="text-right py-2 tabular-nums">{formatNumber(dynamicTotal)}</td>
              <td className="text-right py-2 tabular-nums">{formatNumber(dynamic1YearTotal)}</td>
              <td className="text-right py-2 tabular-nums font-semibold text-blue-600 dark:text-blue-400">{formatNumber(dynamicLtTotal)}</td>
              <td className="text-right py-2 tabular-nums">{platformsWithActuals.length > 0 ? formatNumber(actualUnitsTotal) : "—"}</td>
              <td className={`text-right py-2 tabular-nums text-xs font-semibold ${totalDelta ? totalDelta.cls : "text-muted-foreground"}`}>
                {totalDelta ? totalDelta.text : "—"}
              </td>
            </tr>

            {/* ── Financial Forecast Rows ── */}
            {hasPrice && (
              <>
                {/* Gross Sales (GMV) */}
                <tr className="bg-emerald-50/50 dark:bg-emerald-950/10">
                  <td className="py-2 text-xs font-semibold text-emerald-700 dark:text-emerald-400">Gross Sales</td>
                  <td className="text-right py-2 tabular-nums font-semibold text-emerald-700 dark:text-emerald-400">{formatCurrency(dynamicGmv)}</td>
                  <td className="text-right py-2 tabular-nums font-semibold text-emerald-700 dark:text-emerald-400">{formatCurrency(dynamic1YearGmv)}</td>
                  <td className="text-right py-2 tabular-nums font-semibold text-emerald-700 dark:text-emerald-400">{formatCurrency(dynamicLtGmv)}</td>
                  <td className="text-right py-2 tabular-nums text-muted-foreground">—</td>
                  <td className="text-right py-2 tabular-nums text-muted-foreground">—</td>
                </tr>
                {/* Net Revenue */}
                <tr className="bg-emerald-50/30 dark:bg-emerald-950/5 border-b">
                  <td className="py-2 text-xs font-semibold text-emerald-600 dark:text-emerald-500">Net Revenue</td>
                  <td className="text-right py-2 tabular-nums font-semibold text-emerald-600 dark:text-emerald-500">{formatCurrency(dynamicNet)}</td>
                  <td className="text-right py-2 tabular-nums font-semibold text-emerald-600 dark:text-emerald-500">{formatCurrency(dynamic1YearNet)}</td>
                  <td className="text-right py-2 tabular-nums font-semibold text-emerald-600 dark:text-emerald-500">{formatCurrency(dynamicLtNet)}</td>
                  <td className="text-right py-2 tabular-nums text-muted-foreground">—</td>
                  <td className="text-right py-2 tabular-nums text-muted-foreground">—</td>
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>

      {/* Methodology — v3.26 (2026-08-19): manual forecast input removed;
          dynamic forecasting is now the only forecast on this table, and
          an actuals-vs-forecast delta is shown for platforms with a live
          actuals pipeline (Steam today; PS5 once a PSN feed exists). */}
      <div className="mt-2 flex gap-2 p-2 rounded-md bg-blue-50/50 dark:bg-blue-950/20 border border-blue-200/60 dark:border-blue-800/30">
        <Info className="h-3 w-3 text-blue-500 shrink-0 mt-0.5" />
        <p className="text-[10px] text-blue-700 dark:text-blue-400 leading-relaxed">
          <strong>Pre-Launch 1st Month</strong>, <strong>Pre-Launch 1 Year</strong>, and <strong>Pre-Launch Lifetime</strong> are all the same LOCKED wishlist/prepurchase-derived forecast family (1st Month × 2 = 1 Year, × 2 again = Lifetime), frozen the first time this title is observed as released — none of the three changes afterward{hasPreLaunchSnapshot ? ", which is why they're used as the fixed baseline below" : " (will populate once this title is observed post-release; until then these fall back to the live wishlist-driven estimate)"}.
          <strong className="ml-2">Actual (to date)</strong> and <strong>Δ vs Forecast</strong> compare cumulative units sold so far against the locked Pre-Launch Forecast, currently available for Steam only. To keep the comparison meaningful, the delta is hidden for the first 30 days post-release, then measured against the Pre-Launch 1 Year forecast through day 365, and against the Pre-Launch Lifetime forecast thereafter{daysSinceRelease != null && daysSinceRelease < 30 ? ` (this title is ${daysSinceRelease}d post-release -- Δ appears in ${30 - daysSinceRelease}d)` : ""}. The Total Units row only shows a Δ once every platform in this title has a live actuals feed reporting in — with Steam as the only live feed today, per-platform Δs show above but the Total stays "—" so a Steam-only actual is never measured against an all-platform forecast. PS5 will populate here once a PSN actuals feed is connected; Xbox, Switch, and Epic have no actuals pipeline yet.
        </p>
      </div>

      {/* Financial formula annotation */}
      {hasPrice && (
        <div className="mt-2 flex gap-2 p-2 rounded-md bg-emerald-50/50 dark:bg-emerald-950/20 border border-emerald-200/60 dark:border-emerald-800/30">
          <Info className="h-3 w-3 text-emerald-500 shrink-0 mt-0.5" />
          <p className="text-[10px] text-emerald-700 dark:text-emerald-400 leading-relaxed">
            <strong>Gross Sales</strong> = Units (all platforms) × ${price.toFixed(2)} × {gmvFactor.toFixed(3)} — {gmvFactor !== 0.66 ? "blended factor (50% observed Steam ASP ratio + 50% standard 0.66 regional/Pulse-pricing discount)" : "accounts for regional pricing and normal Pulse pricing"}.
            <strong className="ml-2">Net Revenue</strong> = Gross Sales × 0.70 — accounts for platform fees and distribution.
            {perPlatformPricing && " Per-platform pricing applied where set."}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Add Platform Button ──────────────────────────────────────────────────

function AddPlatformButton({
  productId,
  currentPlatforms,
}: {
  productId: number;
  currentPlatforms: string[];
}) {
  const availablePlatforms = ALL_PLATFORMS.filter(p => !currentPlatforms.includes(p));
  const [adding, setAdding] = useState(false);

  if (availablePlatforms.length === 0) return null;

  const handleAddPlatform = async (platform: string) => {
    setAdding(true);
    try {
      const newPlatforms = [...currentPlatforms, platform];
      await apiRequest("PATCH", `/api/products/${productId}`, {
        platforms: newPlatforms,
      });
      // Invalidate to refresh everything
      queryClient.invalidateQueries({ queryKey: ["/api/products", productId] });
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
    } catch (err) {
      console.error("Failed to add platform:", err);
    } finally {
      setAdding(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[10px] font-medium border border-dashed border-muted-foreground/40 text-muted-foreground hover:border-primary hover:text-primary transition-colors cursor-pointer"
          disabled={adding}
          data-testid="button-add-platform"
        >
          <Plus className="h-3 w-3" /> Add Platform
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {availablePlatforms.map(p => (
          <DropdownMenuItem key={p} onClick={() => handleAddPlatform(p)}>
            <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium border ${getPlatformClass(p)}`}>
              {p}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
