/**
 * Amazon Retail — Charts sub-app.
 *
 * Three side-by-side columns (PS5 / Xbox / Switch). Each column shows the
 * top-50 software-only chart with a compact row (rank, cover, title, price,
 * rating, 1d/7d/30d deltas). "(Amazon #{rawRank})" subtitle when the
 * software filter has shifted the rank vs. Amazon's raw position.
 *
 * Toggle at the top: All / Tracked only. Clicking a row navigates to
 * /amazon/product/{asin}.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, TrendingDown, Gamepad2 } from "lucide-react";

const SABER_ACCENT = "#C0553A";
const RANK_DOWN = "#7A9E7E";
const PLATFORMS = [
  { slug: "ps5", label: "PlayStation 5" },
  { slug: "xbox", label: "Xbox Series X|S" },
  { slug: "switch", label: "Nintendo Switch" },
] as const;

interface ChartRow {
  rank: number;
  rawRank: number | null;
  asin: string;
  title: string;
  price: number | null;
  rating: number | null;
  ratingsTotal: number | null;
  imageUrl: string | null;
  delta1d: number | null;
  delta7d: number | null;
  delta30d: number | null;
  isTracked: boolean;
  trackedProductId: number | null;
}

interface ChartsResponse {
  snapshotDate: string | null;
  platform: string;
  rows: ChartRow[];
}

function DeltaChip({ value }: { value: number | null }) {
  if (value == null) return <span className="text-muted-foreground text-[10px]">—</span>;
  if (value === 0) return <span className="text-muted-foreground text-[10px] tabular-nums">·</span>;
  const isUp = value > 0;
  return (
    <span className="inline-flex items-center gap-0.5 text-[10px] tabular-nums font-medium" style={{ color: isUp ? SABER_ACCENT : RANK_DOWN }}>
      {isUp ? <TrendingUp className="h-2.5 w-2.5" /> : <TrendingDown className="h-2.5 w-2.5" />}
      {Math.abs(value)}
    </span>
  );
}

function Cover({ src, title }: { src: string | null; title: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className="h-10 w-10 rounded bg-muted flex items-center justify-center shrink-0">
        <Gamepad2 className="h-4 w-4 text-muted-foreground/50" />
      </div>
    );
  }
  return <img src={src} alt={title} className="h-10 w-10 rounded object-cover shrink-0" onError={() => setFailed(true)} />;
}

function PlatformColumn({ platform, label, trackedOnly }: { platform: string; label: string; trackedOnly: boolean }) {
  const { data, isLoading } = useQuery<ChartsResponse>({
    queryKey: [`/api/amazon/charts/${platform}`],
  });

  const rows = (data?.rows ?? []).filter((r) => (trackedOnly ? r.isTracked : true));

  return (
    <Card className="overflow-hidden">
      <div className="px-3 py-2 border-b bg-card flex items-baseline justify-between">
        <div className="text-xs font-semibold">{label}</div>
        <div className="text-[10px] text-muted-foreground tabular-nums">
          {data?.snapshotDate ?? "—"}
        </div>
      </div>
      {isLoading ? (
        <div className="p-3 space-y-2">
          {Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
        </div>
      ) : rows.length === 0 ? (
        <div className="p-6 text-center text-[11px] text-muted-foreground">
          {trackedOnly ? "No tracked titles in this chart yet." : "No chart data yet — ingestion may not have run."}
        </div>
      ) : (
        <div className="divide-y max-h-[720px] overflow-y-auto">
          {rows.map((r) => (
            <a
              key={r.asin}
              href={`#/amazon/product/${r.asin}`}
              className="flex items-center gap-2 px-3 py-2 hover:bg-accent/50 transition-colors cursor-pointer"
              data-testid={`row-amazon-chart-${platform}-${r.asin}`}
            >
              <div className="w-6 text-right shrink-0">
                <div className="text-xs font-bold tabular-nums">{r.rank}</div>
                {r.rawRank != null && r.rawRank !== r.rank && (
                  <div className="text-[9px] text-muted-foreground tabular-nums">(A#{r.rawRank})</div>
                )}
              </div>
              <Cover src={r.imageUrl} title={r.title} />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate flex items-center gap-1.5">
                  {r.title}
                  {r.isTracked && (
                    <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: SABER_ACCENT }} title="Tracked" />
                  )}
                </div>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground tabular-nums mt-0.5">
                  {r.price != null && <span>${r.price.toFixed(2)}</span>}
                  {r.rating != null && <span>★ {r.rating.toFixed(1)}</span>}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <div className="w-8 text-right"><DeltaChip value={r.delta1d} /></div>
                <div className="w-8 text-right"><DeltaChip value={r.delta7d} /></div>
                <div className="w-8 text-right"><DeltaChip value={r.delta30d} /></div>
              </div>
            </a>
          ))}
        </div>
      )}
    </Card>
  );
}

export default function AmazonCharts() {
  const [trackedOnly, setTrackedOnly] = useState(false);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          Top 50 software-only bestsellers per platform. Ranks are contiguous 1..50 after the hardware/peripheral filter;
          "(A#…)" shows Amazon's original rank when the filter has shifted the position.
        </div>
        <div className="inline-flex rounded-md border border-border p-0.5">
          <button
            onClick={() => setTrackedOnly(false)}
            className={`px-3 py-1 text-xs rounded-md transition-colors ${!trackedOnly ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground hover:text-foreground"}`}
            data-testid="button-charts-all"
          >
            All
          </button>
          <button
            onClick={() => setTrackedOnly(true)}
            className={`px-3 py-1 text-xs rounded-md transition-colors ${trackedOnly ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground hover:text-foreground"}`}
            data-testid="button-charts-tracked"
          >
            Tracked only
          </button>
        </div>
      </div>
      <div className="text-[10px] text-muted-foreground text-right pr-2">
        <span className="inline-block w-8 text-right">1d</span>
        <span className="inline-block w-8 text-right ml-1.5">7d</span>
        <span className="inline-block w-8 text-right ml-1.5">30d</span>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {PLATFORMS.map((p) => (
          <PlatformColumn key={p.slug} platform={p.slug} label={p.label} trackedOnly={trackedOnly} />
        ))}
      </div>
    </div>
  );
}
