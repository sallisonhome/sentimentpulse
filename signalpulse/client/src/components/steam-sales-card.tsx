// ─── Steam Sales card (v3.0, 2026-08-11) ──────────────────────────────────
//
// Renders the Steam sales section on a product's detail page. Two states:
//   1. Empty state (no sales rows yet) — shows a CSV drop zone with
//      guidance on how to export from Steamworks.
//   2. Populated state — headline "Base Game Units" + "Base Game Revenue"
//      (main SKU rollup) with a secondary "DLC Revenue" line, plus an
//      upload history list at the bottom.
//
// User-locked rule 2026-08-11: base SKUs (game + Deluxe/Anniversary) are
// the primary metric; DLC revenue is shown as a secondary line; retail
// activations (CD-key redemptions) are excluded entirely at parse time.

import { useState, useRef, DragEvent } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Upload, DollarSign, Trash2, AlertTriangle } from "lucide-react";
import { formatNumber, formatCurrency } from "@/lib/utils";

interface Props {
  productId: number;
}

interface SalesSummary {
  baseNetUnits: number;
  baseGrossUnits: number;
  baseReturns: number;
  baseNetRevenueUsd: number;
  dlcNetUnits: number;
  dlcNetRevenueUsd: number;
  otherNetUnits: number;
  otherNetRevenueUsd: number;
  firstDate: string | null;
  latestDate: string | null;
  rowCount: number;
  sourceMix: Record<string, number>;
}

interface UploadBatch {
  id: string;
  filename: string;
  fileBytes: number;
  reportDateStart: string | null;
  reportDateEnd: string | null;
  publisherName: string | null;
  rowsParsed: number;
  rowsIngested: number;
  rowsSkipped: number;
  createdAt: string;
}

interface SummaryResponse {
  summary: SalesSummary;
  recentBatches: UploadBatch[];
}

interface UploadResponse {
  batchId: string;
  publisherName: string | null;
  reportDateStart: string | null;
  reportDateEnd: string | null;
  rowsParsed: number;
  rowsIngested: number;
  rowsInserted: number;
  rowsUpdated: number;
  skipped: { retail: number; zeroUnits: number; unclassified: number };
  errors: string[];
  perSkuBreakdown: Array<{
    productId: string;
    productName: string;
    skuGroup: "base" | "dlc" | "other";
    netUnits: number;
    netRevenueUsd: number;
  }>;
}

export function SteamSalesCard({ productId }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [lastUpload, setLastUpload] = useState<UploadResponse | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const { data, isLoading } = useQuery<SummaryResponse>({
    queryKey: [`/api/products/${productId}/steam/sales-summary`],
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const csv = await file.text();
      // POST as text/csv so express.text() picks it up. apiRequest defaults
      // to JSON — we need a hand-rolled fetch for raw body.
      const url = `/api/products/${productId}/steam/sales-upload?filename=${encodeURIComponent(file.name)}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/csv" },
        body: csv,
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 200)}`);
      }
      return (await resp.json()) as UploadResponse;
    },
    onSuccess: (data) => {
      setLastUpload(data);
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}/steam/sales-summary`] });
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}/steam/sales-daily`] });
    },
  });

  const deleteBatchMutation = useMutation({
    mutationFn: async (batchId: string) => {
      const resp = await fetch(`/api/steam/sales-batch/${batchId}`, { method: "DELETE" });
      if (!resp.ok) throw new Error(`Failed to delete batch: ${resp.status}`);
      return (await resp.json()) as { batchId: string; rowsDeleted: number };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}/steam/sales-summary`] });
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}/steam/sales-daily`] });
    },
  });

  const onFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!file.name.toLowerCase().endsWith(".csv")) {
      alert("Please upload a .csv file");
      return;
    }
    setLastUpload(null);
    uploadMutation.mutate(file);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    onFiles(e.dataTransfer.files);
  };

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading sales data...</div>;
  }

  const summary = data?.summary;
  const hasSales = !!summary && summary.rowCount > 0 && summary.baseNetUnits > 0;

  return (
    <div className="space-y-3">
      {/* Headline metrics: base game units + revenue */}
      {hasSales && summary && (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-wide">
              Steam Base Game Units
            </div>
            <div className="text-2xl font-semibold tabular-nums mt-0.5" data-testid="text-steam-sales-base-units">
              {formatNumber(summary.baseNetUnits)}
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              Net (gross {formatNumber(summary.baseGrossUnits)}, returns {formatNumber(summary.baseReturns)})
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-wide">
              Steam Base Game Revenue
            </div>
            <div className="text-2xl font-semibold tabular-nums mt-0.5 text-emerald-600 dark:text-emerald-400" data-testid="text-steam-sales-base-revenue">
              {formatCurrency(summary.baseNetRevenueUsd)}
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              Net USD (main SKUs cumulative)
            </div>
          </div>
        </div>
      )}

      {/* DLC secondary line */}
      {hasSales && summary && summary.dlcNetUnits > 0 && (
        <div className="flex items-center justify-between border-t pt-3">
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-wide">DLC Revenue</div>
            <div className="text-base font-medium tabular-nums text-emerald-600/80 dark:text-emerald-500 mt-0.5" data-testid="text-steam-sales-dlc-revenue">
              {formatCurrency(summary.dlcNetRevenueUsd)}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                ({formatNumber(summary.dlcNetUnits)} units across DLC SKUs)
              </span>
            </div>
          </div>
        </div>
      )}

      {hasSales && summary && summary.otherNetRevenueUsd > 0 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Soundtrack / Artbook / other:</span>
          <span className="tabular-nums">
            {formatCurrency(summary.otherNetRevenueUsd)} ({formatNumber(summary.otherNetUnits)} units)
          </span>
        </div>
      )}

      {/* Coverage window */}
      {hasSales && summary && (
        <div className="text-[10px] text-muted-foreground">
          Coverage: {summary.firstDate} → {summary.latestDate} · {summary.rowCount} daily rows ingested
        </div>
      )}

      {/* Upload dropzone */}
      <div
        onDrop={onDrop}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onClick={() => fileInputRef.current?.click()}
        className={`border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors ${
          dragOver
            ? "border-blue-500 bg-blue-500/5"
            : "border-muted-foreground/30 hover:border-muted-foreground/50"
        }`}
        data-testid="dropzone-sales-csv"
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => onFiles(e.target.files)}
        />
        <Upload className="w-6 h-6 mx-auto mb-2 text-muted-foreground" />
        <div className="text-sm font-medium">
          {uploadMutation.isPending ? "Uploading..." : "Drop Steamworks Sales CSV here"}
        </div>
        <div className="text-[10px] text-muted-foreground mt-1">
          Steamworks → App Details → "view as .csv" → drag file here.
          Retail activations excluded automatically.
        </div>
      </div>

      {/* Upload result banner */}
      {uploadMutation.isError && (
        <div className="border border-red-500/50 bg-red-500/5 rounded p-3 text-sm">
          <div className="flex items-center gap-2 font-medium text-red-600 dark:text-red-400">
            <AlertTriangle className="w-4 h-4" /> Upload failed
          </div>
          <div className="text-xs mt-1">{String((uploadMutation.error as any)?.message ?? uploadMutation.error)}</div>
        </div>
      )}

      {lastUpload && !uploadMutation.isPending && (
        <div className="border border-emerald-500/50 bg-emerald-500/5 rounded p-3 text-xs space-y-1">
          <div className="font-medium text-emerald-700 dark:text-emerald-400">
            Upload OK · {lastUpload.rowsInserted} inserted, {lastUpload.rowsUpdated} updated
          </div>
          <div className="text-muted-foreground">
            {lastUpload.publisherName} · {lastUpload.reportDateStart} → {lastUpload.reportDateEnd} ·
            skipped {lastUpload.skipped.retail} retail rows
          </div>
          {lastUpload.perSkuBreakdown.length > 0 && (
            <div className="mt-2 space-y-0.5">
              {lastUpload.perSkuBreakdown.slice(0, 8).map((sku) => (
                <div key={sku.productId} className="flex justify-between tabular-nums">
                  <span className="truncate mr-2">
                    <span className={`inline-block px-1 mr-1 rounded text-[9px] ${
                      sku.skuGroup === "base" ? "bg-blue-500/20 text-blue-700 dark:text-blue-300" :
                      sku.skuGroup === "dlc" ? "bg-purple-500/20 text-purple-700 dark:text-purple-300" :
                      "bg-muted text-muted-foreground"
                    }`}>{sku.skuGroup}</span>
                    {sku.productName}
                  </span>
                  <span>{formatNumber(sku.netUnits)} · {formatCurrency(sku.netRevenueUsd)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Upload history */}
      {data && data.recentBatches.length > 0 && (
        <div className="border-t pt-3">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">
            Upload history
          </div>
          <div className="space-y-1">
            {data.recentBatches.map((b) => (
              <div key={b.id} className="flex items-center justify-between text-xs" data-testid={`batch-row-${b.id}`}>
                <div className="min-w-0 flex-1">
                  <span className="truncate block">
                    {b.filename} · {b.reportDateStart ?? "?"} → {b.reportDateEnd ?? "?"} ·
                    {" "}{b.rowsIngested} ingested / {b.rowsSkipped} skipped
                  </span>
                  <span className="text-[9px] text-muted-foreground">
                    {new Date(b.createdAt).toLocaleString()} · {b.publisherName ?? "unknown publisher"}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0 text-muted-foreground hover:text-red-600"
                  onClick={() => {
                    if (confirm(`Undo upload "${b.filename}"? This deletes the sales rows it ingested.`)) {
                      deleteBatchMutation.mutate(b.id);
                    }
                  }}
                  title="Undo this upload"
                  data-testid={`button-delete-batch-${b.id}`}
                >
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {!hasSales && !uploadMutation.isPending && (!lastUpload || lastUpload.rowsIngested === 0) && (
        <div className="text-xs text-muted-foreground text-center border-t pt-3">
          <DollarSign className="w-4 h-4 mx-auto mb-1 opacity-50" />
          No sales data yet. Upload a Steamworks CSV export to populate this section.
        </div>
      )}
    </div>
  );
}
