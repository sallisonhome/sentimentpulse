import { useQuery } from "@tanstack/react-query";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TimeSeriesChart, type TimeSeriesDataPoint, type MilestoneAnnotation } from "./time-series-chart";
import { Skeleton } from "@/components/ui/skeleton";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ChartDataType =
  | "steamWishlist"
  | "steamPrepurchase"
  | "steamRevenueDaily"
  | "ps5Wishlist"
  | "ps5Prepurchase"
  | "steamFollowers";

interface ChartDetailModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: number;
  productTitle: string;
  dataType: ChartDataType;
  releaseDate?: string | null; // v3.3: passed through to draw release marker
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getEndpointForType(productId: number, dataType: ChartDataType): string {
  switch (dataType) {
    case "steamWishlist":
      return `/api/products/${productId}/steam/wishlists`;
    case "steamPrepurchase":
      return `/api/products/${productId}/steam/prepurchases`;
    case "steamRevenueDaily":
      // v3.10 (2026-08-12): daily Steam base+dlc USD revenue time-series
      return `/api/products/${productId}/steam/revenue-daily`;
    case "ps5Wishlist":
      return `/api/products/${productId}/ps5/wishlists`;
    case "ps5Prepurchase":
      return `/api/products/${productId}/ps5/prepurchases`;
    case "steamFollowers":
      return `/api/products/${productId}/steam/followers`;
  }
}

function getLabelForType(dataType: ChartDataType): { section: string; platform: string; color: string; valueUnit?: "usd" | "units" } {
  switch (dataType) {
    case "steamWishlist":
      return { section: "Wishlist", platform: "Steam", color: "#2563EB" };
    case "steamPrepurchase":
      // v3.4 (2026-08-11): renamed to 'Purchases' since the series now spans
      // pre-purchase (before release) and post-release sales as one continuous
      // timeline with the release date as the boundary marker.
      return { section: "Purchases", platform: "Steam", color: "#2563EB" };
    case "steamRevenueDaily":
      // v3.10 (2026-08-12): green to mirror the revenue tiles' color scheme
      return { section: "Revenue", platform: "Steam", color: "#10B981", valueUnit: "usd" };
    case "ps5Wishlist":
      return { section: "Wishlist", platform: "PS5", color: "#6366F1" };
    case "ps5Prepurchase":
      return { section: "Pre-Purchase", platform: "PS5", color: "#6366F1" };
    case "steamFollowers":
      return { section: "Followers", platform: "Steam", color: "#2563EB" };
  }
}

function exportCSV(data: TimeSeriesDataPoint[], filename: string) {
  const header = "date,cumulativeCount,dailyDelta\n";
  const rows = data
    .map((d) => `${d.date},${d.cumulativeCount},${d.dailyDelta}`)
    .join("\n");
  const blob = new Blob([header + rows], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ChartDetailModal({
  open,
  onOpenChange,
  productId,
  productTitle,
  dataType,
  releaseDate,
}: ChartDetailModalProps) {
  const label = getLabelForType(dataType);
  const endpoint = getEndpointForType(productId, dataType);

  const { data: tsData, isLoading: tsLoading } = useQuery<TimeSeriesDataPoint[]>({
    queryKey: [endpoint],
    enabled: open,
  });

  const { data: plsData, isLoading: plsLoading } = useQuery<any[]>({
    queryKey: [`/api/products/${productId}/pls`],
    enabled: open,
  });

  const milestones: MilestoneAnnotation[] = (plsData ?? []).map((m: any) => ({
    name: m.name,
    actualDate: m.actualDate ?? null,
    category: m.category ?? "core",
  }));

  const isLoading = tsLoading || plsLoading;
  const chartTitle = `${label.platform} ${label.section}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl w-full p-0 overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between px-5 pt-5 pb-3 border-b">
          <div>
            <DialogTitle className="text-base font-semibold leading-snug">
              {chartTitle} — {productTitle}
            </DialogTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Time-series data with PLS milestone annotations
            </p>
          </div>
          <div className="flex items-center gap-2 ml-4 shrink-0">
            {tsData && tsData.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[11px] gap-1.5"
                onClick={() =>
                  exportCSV(
                    tsData,
                    `${productTitle.replace(/[^a-z0-9]/gi, "-")}-${dataType}.csv`
                  )
                }
              >
                <Download className="h-3 w-3" />
                Export CSV
              </Button>
            )}
          </div>
        </div>

        {/* Chart Body */}
        <div className="px-5 py-4 max-h-[80vh] overflow-y-auto">
          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-[180px] w-full rounded-lg" />
              <Skeleton className="h-[140px] w-full rounded-lg" />
            </div>
          ) : (
            <TimeSeriesChart
              data={tsData ?? []}
              milestones={milestones}
              title={chartTitle}
              color={label.color}
              releaseDate={releaseDate ?? null}
              showsReleaseDate={true}
              valueUnit={label.valueUnit ?? "units"}
            />
          )}
        </div>

        {/* Milestone legend note */}
        {!isLoading && milestones.filter((m) => m.actualDate).length > 0 && (
          <div className="px-5 pb-4">
            <div className="flex flex-wrap gap-3 pt-2 border-t">
              <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
                Annotation colors:
              </span>
              {[
                { label: "Videos", color: "#3B82F6" },
                { label: "Press Coverage", color: "#22C55E" },
                { label: "Demos / Betas", color: "#F97316" },
                { label: "Core Milestones", color: "#6B7280" },
                { label: "Promotions", color: "#EAB308" },
              ].map((item) => (
                <span key={item.label} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <span
                    className="inline-block w-3 rounded-sm"
                    style={{ height: 2, background: item.color }}
                  />
                  {item.label}
                </span>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
