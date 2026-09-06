/**
 * Amazon Retail — Search Share of Voice (scaffold).
 *
 * For each tracked keyword, latest snapshot's top organic results are
 * displayed as a compact list. Tracked ASINs are highlighted with the
 * Saber terracotta chip so competitive share is obvious at a glance.
 */
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

interface KeywordSnapshot {
  keyword: string;
  snapshotDate: string | null;
  results: Array<{
    position?: number;
    asin?: string;
    title?: string;
    brand?: string;
    isSponsored?: boolean;
    isTracked?: boolean;
  }> | null;
}

export default function AmazonSearchSov() {
  const { data, isLoading } = useQuery<{ rows: KeywordSnapshot[] }>({
    queryKey: ["/api/amazon/search-sov"],
  });
  if (isLoading) return <Skeleton className="h-64 w-full rounded-xl" />;
  const rows = data?.rows ?? [];
  if (rows.length === 0) {
    return <Card className="p-8 text-center text-xs text-muted-foreground">No keyword snapshots yet. Configure tracked keywords for the daily search-SOV ingest job.</Card>;
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {rows.map((kw) => (
        <Card key={kw.keyword} className="overflow-hidden" data-testid={`card-keyword-${kw.keyword}`}>
          <div className="px-4 py-2 border-b bg-card flex items-baseline justify-between">
            <div className="text-xs font-semibold">"{kw.keyword}"</div>
            <div className="text-[10px] text-muted-foreground tabular-nums">{kw.snapshotDate ?? "—"}</div>
          </div>
          {!kw.results || kw.results.length === 0 ? (
            <div className="p-4 text-[11px] text-muted-foreground text-center">No results.</div>
          ) : (
            <div className="divide-y">
              {kw.results.slice(0, 20).map((r, i) => (
                <div key={`${r.asin ?? i}`} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                  <div className="w-6 text-right tabular-nums text-muted-foreground">{r.position ?? i + 1}</div>
                  <div className="flex-1 min-w-0 truncate">
                    {r.asin ? <a href={`#/amazon/product/${r.asin}`} className="hover:underline">{r.title ?? r.asin}</a> : r.title}
                  </div>
                  {r.isSponsored && <Badge variant="secondary" className="text-[9px]">Ad</Badge>}
                  {r.isTracked && <Badge variant="outline" style={{ borderColor: "#C0553A", color: "#C0553A" }} className="text-[9px]">Saber</Badge>}
                </div>
              ))}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
