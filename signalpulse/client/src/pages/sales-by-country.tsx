// Sales by Country — SignalPulse top-nav page (v3.31, 2026-09-05).
//
// Cross-portfolio view of every product with a steamAppId, summed together.
// Data source: /api/sales-by-country/aggregate — prefers day-level rows over
// month-level when they overlap, so filters stay honest during the backfill
// transition.
//
// UI: shared SalesByCountry component (see components/SalesByCountry.tsx).
// This page only wires the fetch + range state and delegates rendering.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Globe2 } from "lucide-react";
import {
  SalesByCountry,
  RangeChips,
  KpiStrip,
  rangeFor,
  type RangeKey,
  type SalesByCountryData,
} from "@/components/SalesByCountry";

interface AggregateResponse extends SalesByCountryData {
  since: string | null;
  until: string | null;
  products_included: number;
  per_product: Array<{ product_id: number; product_title: string; total_revenue_usd: number; total_units: number }>;
}

export default function SalesByCountryPage() {
  const [rangeKey, setRangeKey] = useState<RangeKey>("30d");
  const [customSince, setCustomSince] = useState<string>("");
  const [customUntil, setCustomUntil] = useState<string>("");

  const range = rangeFor(rangeKey, customSince, customUntil);
  const queryEnabled = rangeKey !== "custom" || (!!customSince && !!customUntil);

  const { data, isLoading, error } = useQuery<AggregateResponse>({
    queryKey: ["sales-by-country-aggregate", range.since ?? "", range.until ?? ""],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (range.since) p.set("since", range.since);
      if (range.until) p.set("until", range.until);
      const res = await fetch(`/signal/api/sales-by-country/aggregate?${p.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: queryEnabled,
    staleTime: 5 * 60 * 1000,
  });

  return (
    <div className="p-6 max-w-[1200px] mx-auto space-y-4">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Globe2 className="h-4 w-4 text-primary" />
          <h1 className="text-xl font-semibold">Sales by Country</h1>
        </div>
        <div className="text-xs text-muted-foreground">
          {range.label}
          {data && (
            <> · {data.countries_count} countries · {data.total_units.toLocaleString()} units · {data.products_included} products</>
          )}
        </div>
      </div>

      <RangeChips
        value={rangeKey}
        onChange={setRangeKey}
        customSince={customSince}
        customUntil={customUntil}
        onCustomChange={(s, u) => { setCustomSince(s); setCustomUntil(u); }}
      />

      {error && (
        <Card className="p-4 border-destructive/50 text-destructive text-xs">
          Failed to load sales data: {(error as Error).message}
        </Card>
      )}

      <KpiStrip data={data} isLoading={isLoading} />

      <Card className="p-0 overflow-hidden">
        <div className="px-4 py-2 border-b text-xs text-muted-foreground flex items-center justify-between">
          <span>Global distribution — hover any country</span>
          {isLoading && <span className="text-[10px]">loading…</span>}
        </div>
        <div className="p-4">
          <SalesByCountry
            data={data}
            isLoading={isLoading}
            worldAtlasUrl={`${import.meta.env.BASE_URL}world-atlas-110m.json`}
            emptyMessage="No country data ingested for this range yet. If the monthly backfill hasn't run for these dates, try widening to LTD or check the ingestion status in Settings."
            mapHeight={420}
            showKpis={false}
          />
        </div>
      </Card>
    </div>
  );
}
