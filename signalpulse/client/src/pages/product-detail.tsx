import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useState } from "react";
import {
  ArrowLeft, Edit2, ChevronDown, ChevronRight, Info, AlertTriangle, BarChart3, Plus, RefreshCw, Clock
} from "lucide-react";
import { formatNumber, formatCurrency, formatDate, getPlatformClass, getPlayerFormatLabel } from "@/lib/utils";
import { AddProductDialog } from "@/components/add-product-dialog";
import { PLSSection } from "@/components/pls-section";
import { DataInputDialog } from "@/components/data-input-dialog";
import { ChartDetailModal, type ChartDataType } from "@/components/chart-detail-modal";
import { SparklineChart, type TimeSeriesDataPoint } from "@/components/time-series-chart";
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
          // forecast (locked to pre-launch × 0.27 once released).
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
                      Pre-Release Wishlist Count
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
                      Current Wishlist Count
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
                    className="h-7 text-[10px] gap-1"
                    data-testid="button-chart-steam-wl"
                  >
                    <BarChart3 className="h-3 w-3" /> View Charts
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setInputDialog({ type: "steamWishlist", open: true })}
                    className="h-7 text-[10px]"
                    data-testid="button-input-steam-wl"
                  >
                    + Input Data
                  </Button>
                </div>
              </div>

              {/* First Month Forecast — always based on pre-release count */}
              <div className="flex items-center justify-between border-t pt-3">
                <div>
                  <div className="text-xs text-muted-foreground">
                    First Month Forecast
                    <span className="ml-1 text-[10px]">
                      (Pre-Release WL × 0.27{hasReleased ? " — locked" : ""})
                    </span>
                  </div>
                  <div className="text-lg font-semibold tabular-nums mt-0.5" data-testid="text-steam-first-month">
                    {formatNumber(product.steamFirstMonthForecast)}{" "}
                    <span className="text-xs font-normal text-muted-foreground">units</span>
                  </div>
                </div>
              </div>

              {/* Sparkline */}
              <SectionSparkline productId={productId} endpoint={`/api/products/${productId}/steam/wishlists`} color="#2563EB" />
              <InfoMessage>
                Wishlist counts update daily via the Steamworks Partner API. Dynamic
                forecasts (first-month = 27% of pre-release count) are calculated ONLY
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
        {hasSteam && (
          <CollapsibleSection
            title="Steam Pre-Purchase Count"
            sectionKey="steamPrepurchase"
            open={openSections.steamPrepurchase}
            onToggle={toggleSection}
            rightContent={
              isSaber && prepurchaseActive ? (
                <span className="text-sm font-semibold tabular-nums">
                  LTD: {formatNumber(product.latestSteamPrepurchaseCount)}
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
                  <div className="text-xs text-muted-foreground">
                    Updated daily via Steamworks API · Pre-purchase started {formatDate(prepurchaseStartDate)}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setChartModal({ type: "steamPrepurchase", open: true })}
                      className="h-7 text-[10px] gap-1"
                      data-testid="button-chart-steam-pre"
                    >
                      <BarChart3 className="h-3 w-3" /> View Charts
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setInputDialog({ type: "steamPrepurchase", open: true })}
                      className="h-7 text-[10px]"
                      data-testid="button-input-steam-pre"
                    >
                      + Input Data
                    </Button>
                  </div>
                </div>
                {/* Sparkline */}
                <SectionSparkline productId={productId} endpoint={`/api/products/${productId}/steam/prepurchases`} color="#2563EB" />
              </div>
            )}
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
                <SectionSparkline productId={productId} endpoint={`/api/products/${productId}/ps5/wishlists`} color="#6366F1" />
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
                <SectionSparkline productId={productId} endpoint={`/api/products/${productId}/ps5/prepurchases`} color="#6366F1" />
                <InfoMessage>
                  PS5 Pre-Purchase counts updated daily. Dynamic LT Forecast = 8× PS5 Prepurchase Count. Dynamic 1 Year = LT ÷ 2. Dynamic 1st Month = 1 Year ÷ 2. Other console platforms (Xbox, Switch) are proportioned from PS5 based on platform mix. This number is not relevant for forecasting until 8 weeks prior to launch. Prior to 8 weeks this information is for reference only.
                </InfoMessage>
              </div>
            )}
          </CollapsibleSection>
        )}

        {/* ─── Dynamic Forecasts ─────────────────────────────────────── */}
        <CollapsibleSection
          title="Forecasts (All Platforms)"
          sectionKey="dynamicForecasts"
          open={openSections.dynamicForecasts}
          onToggle={toggleSection}
        >
          <ForecastTable
            compsForecasts={product.compsForecasts}
            dynamicForecasts={product.dynamicForecasts}
            dynamicFullForecasts={product.dynamicFullForecasts}
            platforms={platforms}
            forecastRevisions={product.forecastRevisions || []}
            productId={productId}
            targetRetailPriceUsd={product.targetRetailPriceUsd}
            perPlatformPricing={product.perPlatformPricing}
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
        />
      )}
    </div>
  );
}

// ─── Section Sparkline ───────────────────────────────────────────────────────

function SectionSparkline({
  productId,
  endpoint,
  color,
}: {
  productId: number;
  endpoint: string;
  color: string;
}) {
  const { data } = useChartQuery<TimeSeriesDataPoint[]>({
    queryKey: [endpoint],
    staleTime: 60_000,
  });

  if (!data || data.length < 3) return null;

  return (
    <div className="h-[60px] w-full -mx-0">
      <SparklineChart data={data} color={color} />
    </div>
  );
}

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

type RevisionGroup = {
  date: string;
  label: string;
  forecasts: Record<string, number>;
};

function ForecastTable({
  compsForecasts,
  dynamicForecasts,
  dynamicFullForecasts,
  platforms,
  forecastRevisions,
  productId,
  targetRetailPriceUsd,
  perPlatformPricing,
}: {
  compsForecasts: any[];
  dynamicForecasts: any[];
  dynamicFullForecasts?: any[];
  platforms: string[];
  forecastRevisions: RevisionGroup[];
  productId: number;
  targetRetailPriceUsd: number | null;
  perPlatformPricing: Record<string, number> | null;
}) {
  const [reviseOpen, setReviseOpen] = useState(false);

  const compsMap: Record<string, number> = {};
  compsForecasts?.forEach((c: any) => { compsMap[c.platform] = c.forecastUnits; });

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

  const compsTotal = Object.values(compsMap).reduce((a, b) => a + b, 0);
  const dynamicTotal = Object.values(dynamicMap).reduce((a, b) => a + b, 0);
  const dynamic1YearTotal = Object.values(dynamic1YearMap).reduce((a, b) => a + b, 0);
  const dynamicLtTotal = Object.values(dynamicLtMap).reduce((a, b) => a + b, 0);

  const revisions = forecastRevisions || [];
  const hasRevisions = revisions.length > 0;

  // ─── Financial Calculations ─────────────────────────────────────────────────
  // GMV (Gross Sales) = Units × Full USD Price × 0.66
  // Net Revenue       = Units × Full USD Price × 0.66 × 0.70
  const price = targetRetailPriceUsd ?? 0;

  // Helper: calculate weighted GMV across platforms using per-platform pricing if available
  function calcGmv(unitsByPlatform: Record<string, number>): number {
    let gmv = 0;
    for (const p of platforms) {
      const units = unitsByPlatform[p] ?? 0;
      const pPrice = perPlatformPricing?.[p] ?? price;
      gmv += units * pPrice * 0.66;
    }
    return Math.round(gmv);
  }

  function calcGmvFromTotal(totalUnits: number): number {
    // When we only have a total (e.g. revision totals), use the base price
    return Math.round(totalUnits * price * 0.66);
  }

  function calcNetFromGmv(gmv: number): number {
    return Math.round(gmv * 0.70);
  }

  // Pre-calculate financials for each column
  const dynamicGmv = calcGmv(dynamicMap);
  const dynamic1YearGmv = calcGmv(dynamic1YearMap);
  const dynamicLtGmv = calcGmv(dynamicLtMap);
  const compsGmv = calcGmv(compsMap);
  const dynamicNet = calcNetFromGmv(dynamicGmv);
  const dynamic1YearNet = calcNetFromGmv(dynamic1YearGmv);
  const dynamicLtNet = calcNetFromGmv(dynamicLtGmv);
  const compsNet = calcNetFromGmv(compsGmv);

  const revisionGmvs = revisions.map((rev) => calcGmv(rev.forecasts));
  const revisionNets = revisionGmvs.map((g) => calcNetFromGmv(g));

  const hasPrice = price > 0;

  // % delta helper: (dynamic - original) / original * 100
  function pctDelta(dynamicVal: number, originalVal: number): string {
    if (originalVal === 0) return dynamicVal > 0 ? "+∞" : "—";
    const pct = ((dynamicVal - originalVal) / originalVal) * 100;
    const sign = pct >= 0 ? "+" : "";
    return `${sign}${pct.toFixed(1)}%`;
  }
  function deltaColor(dynamicVal: number, originalVal: number): string {
    if (originalVal === 0) return "text-muted-foreground";
    const pct = ((dynamicVal - originalVal) / originalVal) * 100;
    if (pct > 0) return "text-emerald-600 dark:text-emerald-400";
    if (pct < 0) return "text-red-500 dark:text-red-400";
    return "text-muted-foreground";
  }

  // Sticky column styles
  const stickyBase = "sticky bg-background z-10";
  const stickyPlatformCol = `${stickyBase} left-0`;
  const stickyDynFirstCol = `${stickyBase} left-[120px]`;
  const stickyDyn1YearCol = `${stickyBase} left-[250px]`;

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="table-forecasts" style={{ minWidth: hasRevisions ? "700px" : undefined }}>
          <thead>
            <tr className="border-b">
              <th className={`text-left py-2 text-xs font-medium text-muted-foreground min-w-[120px] ${hasRevisions ? stickyPlatformCol : ""}`}>Platform</th>
              <th className={`text-right py-2 text-xs font-medium text-muted-foreground min-w-[130px] ${hasRevisions ? stickyDynFirstCol : ""}`}>Dynamic First Month</th>
              <th className={`text-right py-2 text-xs font-medium text-muted-foreground min-w-[130px] ${hasRevisions ? stickyDyn1YearCol : ""}`}>Dynamic 1 Year</th>
              <th className="text-right py-2 text-xs font-medium text-blue-600 dark:text-blue-400 min-w-[150px]">Dynamic LT Biz Forecast</th>
              <th className="text-right py-2 text-xs font-medium text-muted-foreground min-w-[150px]">Original LT Biz Forecast</th>
              {revisions.map((rev, idx) => (
                <th
                  key={rev.date}
                  className={`text-right py-2 text-xs font-medium min-w-[140px] ${
                    idx === revisions.length - 1
                      ? "text-primary font-semibold"
                      : "text-muted-foreground"
                  }`}
                >
                  {rev.label}
                </th>
              ))}
              {/* v1.1 (2026-07-22): delta moved to FAR RIGHT and now compares
                  DYNAMIC LT vs REVISED (latest revision) rather than Dynamic
                  vs Original. When no revision exists, we fall back to
                  comparing Dynamic vs Original so the column still shows
                  something useful. */}
              <th className="text-right py-2 text-xs font-medium text-muted-foreground min-w-[90px]">
                {hasRevisions ? "Dyn LT vs Revised" : "Dyn LT vs Original"}
              </th>
            </tr>
          </thead>
          <tbody>
            {platforms.map((p) => (
              <tr key={p} className="border-b border-border/50">
                <td className={`py-2 ${hasRevisions ? stickyPlatformCol : ""}`}>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium border ${getPlatformClass(p)}`}>
                    {p}
                  </span>
                </td>
                <td className={`text-right py-2 tabular-nums font-medium ${hasRevisions ? stickyDynFirstCol : ""}`}>{formatNumber(dynamicMap[p] ?? 0)}</td>
                <td className={`text-right py-2 tabular-nums font-medium ${hasRevisions ? stickyDyn1YearCol : ""}`}>{formatNumber(dynamic1YearMap[p] ?? 0)}</td>
                <td className="text-right py-2 tabular-nums font-semibold text-blue-600 dark:text-blue-400">{formatNumber(dynamicLtMap[p] ?? 0)}</td>
                <td className="text-right py-2 tabular-nums font-medium">{formatNumber(compsMap[p] ?? 0)}</td>
                {revisions.map((rev, idx) => (
                  <td
                    key={rev.date}
                    className={`text-right py-2 tabular-nums font-medium ${
                      idx === revisions.length - 1 ? "text-primary font-semibold" : ""
                    }`}
                  >
                    {formatNumber(rev.forecasts[p] ?? 0)}
                  </td>
                ))}
                {/* v1.1: delta cell (far right). Compares Dynamic LT to
                    latest revision when one exists, else to Original. */}
                {(() => {
                  const dynLt = dynamicLtMap[p] ?? 0;
                  const compareTo = hasRevisions
                    ? (revisions[revisions.length - 1].forecasts[p] ?? 0)
                    : (compsMap[p] ?? 0);
                  return (
                    <td className={`text-right py-2 tabular-nums text-xs font-semibold ${deltaColor(dynLt, compareTo)}`}>
                      {pctDelta(dynLt, compareTo)}
                    </td>
                  );
                })()}
              </tr>
            ))}
            {/* ── Unit Totals Row ── */}
            <tr className="font-semibold border-b">
              <td className={`py-2 text-xs uppercase tracking-wide text-muted-foreground ${hasRevisions ? stickyPlatformCol : ""}`}>Total Units</td>
              <td className={`text-right py-2 tabular-nums ${hasRevisions ? stickyDynFirstCol : ""}`}>{formatNumber(dynamicTotal)}</td>
              <td className={`text-right py-2 tabular-nums ${hasRevisions ? stickyDyn1YearCol : ""}`}>{formatNumber(dynamic1YearTotal)}</td>
              <td className="text-right py-2 tabular-nums font-semibold text-blue-600 dark:text-blue-400">{formatNumber(dynamicLtTotal)}</td>
              <td className="text-right py-2 tabular-nums">{formatNumber(compsTotal)}</td>
              {revisions.map((rev, idx) => {
                const total = Object.values(rev.forecasts).reduce((a, b) => a + b, 0);
                return (
                  <td
                    key={rev.date}
                    className={`text-right py-2 tabular-nums ${
                      idx === revisions.length - 1 ? "text-primary" : ""
                    }`}
                  >
                    {formatNumber(total)}
                  </td>
                );
              })}
              {/* v1.1: total-row delta (far right). Dynamic LT vs Revised total, else vs Original. */}
              {(() => {
                const compareTo = hasRevisions
                  ? Object.values(revisions[revisions.length - 1].forecasts).reduce((a: number, b: any) => a + (b as number), 0)
                  : compsTotal;
                return (
                  <td className={`text-right py-2 tabular-nums text-xs font-semibold ${deltaColor(dynamicLtTotal, compareTo)}`}>
                    {pctDelta(dynamicLtTotal, compareTo)}
                  </td>
                );
              })()}
            </tr>

            {/* ── Financial Forecast Rows ── */}
            {hasPrice && (
              <>
                {/* Gross Sales (GMV) */}
                <tr className="bg-emerald-50/50 dark:bg-emerald-950/10">
                  <td className={`py-2 text-xs font-semibold text-emerald-700 dark:text-emerald-400 ${hasRevisions ? stickyPlatformCol + " bg-emerald-50/50 dark:bg-emerald-950/10" : ""}`}>Gross Sales</td>
                  <td className={`text-right py-2 tabular-nums font-semibold text-emerald-700 dark:text-emerald-400 ${hasRevisions ? stickyDynFirstCol + " bg-emerald-50/50 dark:bg-emerald-950/10" : ""}`}>{formatCurrency(dynamicGmv)}</td>
                  <td className={`text-right py-2 tabular-nums font-semibold text-emerald-700 dark:text-emerald-400 ${hasRevisions ? stickyDyn1YearCol + " bg-emerald-50/50 dark:bg-emerald-950/10" : ""}`}>{formatCurrency(dynamic1YearGmv)}</td>
                  <td className="text-right py-2 tabular-nums font-semibold text-emerald-700 dark:text-emerald-400">{formatCurrency(dynamicLtGmv)}</td>
                  <td className="text-right py-2 tabular-nums font-semibold text-emerald-700 dark:text-emerald-400">{formatCurrency(compsGmv)}</td>
                  {revisionGmvs.map((gmv, idx) => (
                    <td
                      key={revisions[idx].date}
                      className={`text-right py-2 tabular-nums font-semibold text-emerald-700 dark:text-emerald-400 ${
                        idx === revisions.length - 1 ? "!text-emerald-600 dark:!text-emerald-300" : ""
                      }`}
                    >
                      {formatCurrency(gmv)}
                    </td>
                  ))}
                  {/* v1.1: GMV delta (far right). */}
                  {(() => {
                    const compareTo = hasRevisions ? revisionGmvs[revisionGmvs.length - 1] : compsGmv;
                    return (
                      <td className={`text-right py-2 tabular-nums text-xs font-semibold ${deltaColor(dynamicLtGmv, compareTo)}`}>
                        {pctDelta(dynamicLtGmv, compareTo)}
                      </td>
                    );
                  })()}
                </tr>
                {/* Net Revenue */}
                <tr className="bg-emerald-50/30 dark:bg-emerald-950/5 border-b">
                  <td className={`py-2 text-xs font-semibold text-emerald-600 dark:text-emerald-500 ${hasRevisions ? stickyPlatformCol + " bg-emerald-50/30 dark:bg-emerald-950/5" : ""}`}>Net Revenue</td>
                  <td className={`text-right py-2 tabular-nums font-semibold text-emerald-600 dark:text-emerald-500 ${hasRevisions ? stickyDynFirstCol + " bg-emerald-50/30 dark:bg-emerald-950/5" : ""}`}>{formatCurrency(dynamicNet)}</td>
                  <td className={`text-right py-2 tabular-nums font-semibold text-emerald-600 dark:text-emerald-500 ${hasRevisions ? stickyDyn1YearCol + " bg-emerald-50/30 dark:bg-emerald-950/5" : ""}`}>{formatCurrency(dynamic1YearNet)}</td>
                  <td className="text-right py-2 tabular-nums font-semibold text-emerald-600 dark:text-emerald-500">{formatCurrency(dynamicLtNet)}</td>
                  <td className="text-right py-2 tabular-nums font-semibold text-emerald-600 dark:text-emerald-500">{formatCurrency(compsNet)}</td>
                  {revisionNets.map((net, idx) => (
                    <td
                      key={revisions[idx].date}
                      className={`text-right py-2 tabular-nums font-semibold text-emerald-600 dark:text-emerald-500 ${
                        idx === revisions.length - 1 ? "!text-emerald-500 dark:!text-emerald-400" : ""
                      }`}
                    >
                      {formatCurrency(net)}
                    </td>
                  ))}
                  {/* v1.1: Net delta (far right). */}
                  {(() => {
                    const compareTo = hasRevisions ? revisionNets[revisionNets.length - 1] : compsNet;
                    return (
                      <td className={`text-right py-2 tabular-nums text-xs font-semibold ${deltaColor(dynamicLtNet, compareTo)}`}>
                        {pctDelta(dynamicLtNet, compareTo)}
                      </td>
                    );
                  })()}
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>

      {/* Financial formula annotation */}
      {hasPrice && (
        <div className="mt-2 flex gap-2 p-2 rounded-md bg-emerald-50/50 dark:bg-emerald-950/20 border border-emerald-200/60 dark:border-emerald-800/30">
          <Info className="h-3 w-3 text-emerald-500 shrink-0 mt-0.5" />
          <p className="text-[10px] text-emerald-700 dark:text-emerald-400 leading-relaxed">
            <strong>Gross Sales</strong> = Units × ${price.toFixed(2)} × 0.66 — accounts for regional pricing and normal Pulse pricing.
            <strong className="ml-2">Net Revenue</strong> = Gross Sales × 0.70 — accounts for platform fees and distribution.
            {perPlatformPricing && " Per-platform pricing applied where set."}
          </p>
        </div>
      )}

      {/* Revise Forecast Button */}
      <div className="mt-3 flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setReviseOpen(true)}
          className="h-8 text-xs gap-1.5"
          data-testid="button-revise-forecast"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Revise Forecast
        </Button>
      </div>

      {/* Revise Forecast Dialog */}
      {reviseOpen && (
        <ReviseForecastDialog
          open={reviseOpen}
          onOpenChange={setReviseOpen}
          productId={productId}
          platforms={platforms}
          compsMap={compsMap}
          revisions={revisions}
        />
      )}
    </div>
  );
}

// ─── Revise Forecast Dialog ───────────────────────────────────────────────

function ReviseForecastDialog({
  open,
  onOpenChange,
  productId,
  platforms,
  compsMap,
  revisions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: number;
  platforms: string[];
  compsMap: Record<string, number>;
  revisions: RevisionGroup[];
}) {
  // Pre-fill with latest revision values, or original comps
  const latestRevision = revisions.length > 0 ? revisions[revisions.length - 1] : null;
  const initialValues: Record<string, string> = {};
  for (const p of platforms) {
    const val = latestRevision ? (latestRevision.forecasts[p] ?? 0) : (compsMap[p] ?? 0);
    initialValues[p] = String(val);
  }

  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const forecasts = platforms.map(p => ({
        platform: p,
        forecastUnits: parseInt(values[p] || "0", 10) || 0,
      }));

      await apiRequest("POST", `/api/products/${productId}/forecasts/revisions`, {
        forecasts,
      });

      // Invalidate queries to refresh data
      queryClient.invalidateQueries({ queryKey: ["/api/products", productId] });
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to save revision:", err);
    } finally {
      setSaving(false);
    }
  };

  const total = platforms.reduce((sum, p) => sum + (parseInt(values[p] || "0", 10) || 0), 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Revise Forecast</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-xs text-muted-foreground">
            Enter updated lifetime forecast units per platform. This creates a new revision snapshot dated today.
          </p>
          {platforms.map(p => (
            <div key={p} className="flex items-center gap-3">
              <Label className="w-32 text-xs shrink-0">
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium border ${getPlatformClass(p)}`}>
                  {p}
                </span>
              </Label>
              <Input
                type="number"
                min={0}
                value={values[p]}
                onChange={(e) => setValues(prev => ({ ...prev, [p]: e.target.value }))}
                className="h-8 text-sm tabular-nums"
              />
            </div>
          ))}
          <div className="flex items-center gap-3 pt-2 border-t">
            <div className="w-32 text-xs font-semibold text-muted-foreground uppercase tracking-wide shrink-0">Total</div>
            <div className="text-sm font-semibold tabular-nums">{formatNumber(total)}</div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save Revision"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
