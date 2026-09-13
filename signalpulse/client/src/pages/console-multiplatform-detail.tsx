/**
 * Multiplatform PDP (Cross-Platform Title Detail).
 *
 * Route: /console-leaderboards/multiplatform/:key
 *
 * :key is a URL-encoded editionGroupKey. The page shows IGDB metadata
 * (cover, artwork, summary, genres, developers) from the Steam SKU where
 * present, and KPI tiles COMBINED across every base SKU (Steam + PS5 +
 * Xbox) that maps to the same edition family, with the same window pill
 * controls as the leaderboard hub.
 *
 * Revenue math mirrors the leaderboard endpoint 1:1 (immutable ratio, IP
 * overrides, PS5-exclusive fallback), so numbers here match what the row
 * on the hub showed you.
 *
 * API path convention: fetches use `/signal/api/...` (same as the rest
 * of this app).
 */

import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";

type Platform = "steam" | "xbox" | "ps5";
type WindowKey = "d7" | "d30" | "d90" | "m12" | "ltd";

const WINDOWS: Array<{ id: WindowKey; label: string }> = [
  { id: "d7",  label: "7 days"    },
  { id: "d30", label: "30 days"   },
  { id: "d90", label: "90 days"   },
  { id: "m12", label: "12 months" },
  { id: "ltd", label: "Lifetime"  },
];

const PLATFORM_META: Record<Platform, { label: string; accent: string }> = {
  steam: { label: "Steam",         accent: "#66c0f4" },
  ps5:   { label: "PlayStation 5", accent: "#0070d1" },
  xbox:  { label: "Xbox",          accent: "#107c10" },
};

interface PerPlatformKpi {
  titleId: number;
  revenueUsd: number;
  unitsMid: number;
  windowUsed: string | null;
  msrpUsdCents: number | null;
  source: "anchor" | "overlay" | "raw";
}

interface MultiplatformDetailResponse {
  editionGroupKey: string;
  name: string;
  coverUrl: string | null;
  artworkUrl: string | null;
  screenshots: string[] | null;
  genres: string[] | null;
  themes: string[] | null;
  developers: string[] | null;
  publishers: string[] | null;
  summary: string | null;
  releaseDate: string | null;
  platforms: Platform[];
  perPlatform: Partial<Record<Platform, PerPlatformKpi>>;
  combinedRevenueUsd: number;
  combinedUnits: number;
  window: WindowKey;
  cascade: WindowKey[];
  skus: Array<{ titleId: number; platform: Platform; name: string | null; coverUrl: string | null }>;
}

function formatUsdCompact(dollars: number | null | undefined): string {
  if (dollars == null || !Number.isFinite(dollars)) return "—";
  const n = Math.abs(dollars);
  const sign = dollars < 0 ? "-" : "";
  if (n >= 1_000_000_000) return `${sign}$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000)     return `${sign}$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)         return `${sign}$${(n / 1_000).toFixed(0)}K`;
  return `${sign}$${n.toFixed(0)}`;
}

function formatNumberCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)         return `${(n / 1_000).toFixed(0)}K`;
  return `${n}`;
}

export default function ConsoleMultiplatformDetail() {
  const params = useParams<{ key: string }>();
  const key = decodeURIComponent(params.key);
  const [window, setWindow] = useState<WindowKey>("ltd");

  const { data, isLoading, isError, error } = useQuery<MultiplatformDetailResponse>({
    queryKey: [`/signal/api/console/multiplatform-title/${key}`, { window }],
    queryFn: async () => {
      const r = await fetch(`/signal/api/console/multiplatform-title/${encodeURIComponent(key)}?window=${window}`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60_000,
  });

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-4">
        <Link href="/console-leaderboards">
          <a className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
            <ArrowLeft className="h-4 w-4" /> Back to leaderboards
          </a>
        </Link>
        <div className="flex gap-1 flex-wrap" role="tablist" aria-label="Window">
          {WINDOWS.map(w => (
            <Button
              key={w.id}
              variant={window === w.id ? "default" : "outline"}
              size="sm"
              onClick={() => setWindow(w.id)}
              data-testid={`btn-window-${w.id}`}
              role="tab"
              aria-selected={window === w.id}
            >
              {w.label}
            </Button>
          ))}
        </div>
      </div>

      {isLoading && (
        <div className="grid md:grid-cols-[220px_1fr] gap-4">
          <Skeleton className="h-72 w-full rounded" />
          <div className="space-y-3">
            <Skeleton className="h-8 w-2/3 rounded" />
            <Skeleton className="h-24 w-full rounded" />
            <Skeleton className="h-32 w-full rounded" />
          </div>
        </div>
      )}

      {isError && (
        <Card className="p-6 text-sm text-destructive">
          Failed to load: {(error as Error)?.message || "unknown error"}
        </Card>
      )}

      {data && (
        <>
          <div className="grid md:grid-cols-[220px_1fr] gap-4 items-start">
            <div>
              {data.coverUrl ? (
                <img src={data.coverUrl} alt={data.name} className="w-full rounded shadow" />
              ) : (
                <div className="w-full aspect-[3/4] rounded bg-muted" />
              )}
            </div>
            <div className="space-y-3">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-2xl font-semibold">{data.name}</h1>
                  <Badge variant="outline" className="text-[10px] uppercase tracking-wide">multiplatform</Badge>
                </div>
                <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                  {data.releaseDate ? <span>Released {data.releaseDate}</span> : null}
                  {data.developers?.length ? <span>· {data.developers.join(", ")}</span> : null}
                  {data.publishers?.length ? <span>· {data.publishers.join(", ")}</span> : null}
                </div>
                <div className="flex items-center gap-1 mt-2 flex-wrap">
                  {data.platforms.map(p => (
                    <Link key={p} href={`/console-leaderboards/${p}/${data.perPlatform[p]?.titleId ?? ""}`}>
                      <span
                        className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border cursor-pointer hover:opacity-80"
                        style={{ color: PLATFORM_META[p].accent, borderColor: PLATFORM_META[p].accent + "66" }}
                        title={`Open ${PLATFORM_META[p].label} PDP`}
                      >
                        {PLATFORM_META[p].label}
                      </span>
                    </Link>
                  ))}
                  {data.genres?.slice(0, 3).map(g => (
                    <Badge key={g} variant="secondary" className="text-[10px]">{g}</Badge>
                  ))}
                </div>
              </div>

              {/* Combined KPI tiles */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <Card className="p-3">
                  <div className="text-[10px] uppercase text-muted-foreground tracking-wide">Combined revenue</div>
                  <div className="font-mono text-lg font-semibold tabular-nums">{formatUsdCompact(data.combinedRevenueUsd)}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">{window} · {data.platforms.length} SKU{data.platforms.length === 1 ? "" : "s"}</div>
                </Card>
                <Card className="p-3">
                  <div className="text-[10px] uppercase text-muted-foreground tracking-wide">Combined units (est.)</div>
                  <div className="font-mono text-lg font-semibold tabular-nums">{formatNumberCompact(data.combinedUnits)}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">Sum of window unit estimates</div>
                </Card>
                {data.perPlatform.steam ? (
                  <Card className="p-3">
                    <div className="text-[10px] uppercase tracking-wide" style={{ color: PLATFORM_META.steam.accent }}>Steam</div>
                    <div className="font-mono text-sm tabular-nums">{formatUsdCompact(data.perPlatform.steam.revenueUsd)}</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">{formatNumberCompact(data.perPlatform.steam.unitsMid)}u · {data.perPlatform.steam.source}</div>
                  </Card>
                ) : null}
                {data.perPlatform.ps5 ? (
                  <Card className="p-3">
                    <div className="text-[10px] uppercase tracking-wide" style={{ color: PLATFORM_META.ps5.accent }}>PS5</div>
                    <div className="font-mono text-sm tabular-nums">{formatUsdCompact(data.perPlatform.ps5.revenueUsd)}</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">{formatNumberCompact(data.perPlatform.ps5.unitsMid)}u · {data.perPlatform.ps5.source}</div>
                  </Card>
                ) : null}
                {data.perPlatform.xbox ? (
                  <Card className="p-3">
                    <div className="text-[10px] uppercase tracking-wide" style={{ color: PLATFORM_META.xbox.accent }}>Xbox</div>
                    <div className="font-mono text-sm tabular-nums">{formatUsdCompact(data.perPlatform.xbox.revenueUsd)}</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">{formatNumberCompact(data.perPlatform.xbox.unitsMid)}u · {data.perPlatform.xbox.source}</div>
                  </Card>
                ) : null}
              </div>

              {data.summary ? (
                <Card className="p-3 text-sm text-muted-foreground">
                  {data.summary}
                </Card>
              ) : null}
            </div>
          </div>

          {/* Per-SKU roster: shows every base SKU under the edition group. */}
          <Card className="overflow-hidden">
            <div className="p-3 border-b border-border text-xs text-muted-foreground uppercase tracking-wide">Included SKUs</div>
            <ul className="divide-y divide-border">
              {data.skus.map(s => (
                <li key={`${s.platform}-${s.titleId}`}>
                  <Link href={`/console-leaderboards/${s.platform}/${s.titleId}`}>
                    <a className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/40 transition-colors cursor-pointer">
                      {s.coverUrl ? (
                        <img src={s.coverUrl} alt="" loading="lazy" className="h-8 w-6 object-cover rounded-sm shrink-0" />
                      ) : (
                        <div className="h-8 w-6 rounded-sm bg-muted shrink-0" />
                      )}
                      <span className="flex-1 text-sm truncate">{s.name || "—"}</span>
                      <span
                        className="text-[10px] uppercase tracking-wide px-1.5 py-[1px] rounded border"
                        style={{ color: PLATFORM_META[s.platform].accent, borderColor: PLATFORM_META[s.platform].accent + "66" }}
                      >
                        {PLATFORM_META[s.platform].label}
                      </span>
                    </a>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
