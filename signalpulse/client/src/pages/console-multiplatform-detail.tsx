/**
 * Multiplatform PDP (Cross-Platform Title Detail).
 *
 * Route: /console-leaderboards/multiplatform/:key
 *
 * :key is a URL-encoded editionGroupKey. Header uses the same IGDB fields as
 * the per-platform parent PDP (cover, release, developers, publishers, genres,
 * summary, screenshots). KPI tiles below are COMBINED across every base SKU
 * (Steam + PS5 + Xbox) in the edition family, with per-platform cards under
 * that combined row. Revenue math mirrors the leaderboard overlay 1:1.
 *
 * API path convention: fetches use `/signal/api/...` (same as the rest
 * of this app).
 */

import { useQuery } from "@tanstack/react-query";
import { PortraitCover } from "@/components/portrait-cover";
import { Link, useParams } from "wouter";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { RevenueShare, type RevenueSummary } from "@/components/console-revenue-share";
import { ReviewsRatingsSection } from "@/components/reviews-ratings";

type Platform = "steam" | "xbox" | "ps5";
type WindowKey = "d7" | "d30" | "d90" | "m12" | "ltd";

const WINDOWS: Array<{ id: WindowKey; label: string }> = [
  { id: "d7",  label: "7d"  },
  { id: "d30", label: "30d" },
  { id: "d90", label: "90d" },
  { id: "m12", label: "12m" },
  { id: "ltd", label: "LTD" },
];

const PLATFORM_META: Record<Platform, { label: string; accent: string }> = {
  steam: { label: "Steam",         accent: "#66c0f4" },
  ps5:   { label: "PlayStation 5", accent: "#0070d1" },
  xbox:  { label: "Xbox",          accent: "#107c10" },
};

interface PerPlatformKpi {
  revenueCaveat?: string;
  titleId: number;
  revenueUsd: number | null;
  unitsMid: number | null;
  windowUsed: string | null;
  msrpUsdCents: number | null;
  source: "anchor" | "overlay" | "raw";
  dataSource?: string;
  estimateMethod?: string;
}

interface IgdbBlob {
  name: string | null;
  summary: string | null;
  releaseDate: string | null;
  coverUrl: string | null;
  artworkUrl: string | null;
  screenshots: string[];
  genres: string[];
  developers: string[];
  publishers: string[];
}

interface MultiplatformDetailResponse {
  portraitCandidates?: string[];
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
  igdb: IgdbBlob | null;
  platforms: Platform[];
  perPlatform: Partial<Record<Platform, PerPlatformKpi>>;
  combinedRevenueUsd: number;
  combinedUnits: number | null;
  revenueSummary?: RevenueSummary;
  window: WindowKey;
  cascade: WindowKey[];
  skus: Array<{ titleId: number; platform: Platform; name: string | null; coverUrl: string | null }>;
}

function formatUsdCompact(dollars: number | null | undefined): string {
  if (dollars == null || !Number.isFinite(dollars)) return "\u2014";
  const n = Math.abs(dollars);
  const sign = dollars < 0 ? "-" : "";
  if (n >= 1_000_000_000) return `${sign}$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000)     return `${sign}$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)         return `${sign}$${(n / 1_000).toFixed(0)}K`;
  return `${sign}$${n.toFixed(0)}`;
}

function formatNumberCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "\u2014";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)         return `${(n / 1_000).toFixed(0)}K`;
  return `${Math.round(n).toLocaleString()}`;
}

export default function ConsoleMultiplatformDetail() {
  const params = useParams<{ key: string }>();
  const key = decodeURIComponent(params.key ?? "");
  const [window, setWindow] = useState<WindowKey>(() => {
    const value = new URLSearchParams(globalThis.location.search).get("window");
    return WINDOWS.some(w => w.id === value) ? value as WindowKey : "d7";
  });

  const { data, isLoading, isError, error } = useQuery<MultiplatformDetailResponse>({
    queryKey: [`/signal/api/console/multiplatform-title/${key}`, { window }],
    queryFn: async () => {
      const r = await fetch(`/signal/api/console/multiplatform-title/${encodeURIComponent(key)}?window=${window}`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60_000,
    enabled: key.length > 0,
  });

  const igdb = data?.igdb ?? null;
  const displayName = igdb?.name || data?.name || key;
  const displayCover = igdb?.coverUrl || data?.coverUrl || null;
  const releaseDate = igdb?.releaseDate || data?.releaseDate || null;
  const developers = igdb?.developers?.length ? igdb.developers : (data?.developers ?? []);
  const publishers = igdb?.publishers?.length ? igdb.publishers : (data?.publishers ?? []);
  const genres = igdb?.genres?.length ? igdb.genres : (data?.genres ?? []);
  const summary = igdb?.summary || data?.summary || null;
  const screenshots = (igdb?.screenshots?.length ? igdb.screenshots : (data?.screenshots ?? [])) as string[];

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4">
        <Link href="/console-leaderboards">
          <button className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1" data-testid="link-back-list">
            <ArrowLeft className="h-3 w-3" /> Back to leaderboards
          </button>
        </Link>
        <div className="flex items-center gap-2 flex-wrap" role="tablist" aria-label="Window">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">Window</div>
          {WINDOWS.map(w => (
            <Button
              key={w.id}
              variant={window === w.id ? "default" : "outline"}
              size="sm"
              onClick={() => setWindow(w.id)}
              data-testid={`btn-kpi-window-${w.id}`}
              role="tab"
              aria-selected={window === w.id}
            >
              {w.label}
            </Button>
          ))}
        </div>
      </div>

      {isLoading && (
        <div className="space-y-4">
          <Skeleton className="h-44 w-32 rounded" />
          <Skeleton className="h-8 w-2/3 rounded" />
          <Skeleton className="h-32 w-full rounded" />
        </div>
      )}

      {isError && (
        <Card className="p-6 text-sm text-destructive">
          Failed to load: {(error as Error)?.message || "unknown error"}
        </Card>
      )}

      {data && (
        <>
          {/* Header — same IGDB block as per-platform parent PDP */}
          <div className="flex gap-4 items-start">
            {displayCover && (
              <PortraitCover candidates={data?.portraitCandidates ?? [displayCover]} className="w-32 h-44 rounded-md shadow-md shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <div className="text-xs text-muted-foreground uppercase tracking-wide">Cross-platform</div>
              <h1 className="text-2xl font-semibold mt-1 truncate">{displayName}</h1>
              {releaseDate && <div className="text-xs text-muted-foreground mt-1">Released {releaseDate}</div>}
              {developers.length > 0 && (
                <div className="text-xs text-muted-foreground mt-1">by {developers.join(", ")}</div>
              )}
              {publishers.length > 0 && (
                <div className="text-xs text-muted-foreground mt-1">Published by {publishers.join(", ")}</div>
              )}
              {genres.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {genres.map(g => <Badge key={g} variant="secondary" className="text-xs">{g}</Badge>)}
                </div>
              )}
              {summary && <p className="text-sm text-muted-foreground mt-3 line-clamp-4">{summary}</p>}
            </div>
          </div>

          {screenshots.length > 0 && (
            <div className="flex gap-2 overflow-x-auto">
              {screenshots.map((url, i) => (
                <img key={i} src={url} alt="" className="h-24 rounded-md shrink-0" />
              ))}
            </div>
          )}

          {/* Combined KPIs — summed across every base SKU in the family */}
          <ReviewsRatingsSection kind="family" id={data.editionGroupKey} />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3" data-testid="combined-kpi-row">
            <Card className="p-4 border-violet-500/40">
              <div className="text-[10px] uppercase text-muted-foreground tracking-wide">{data.revenueSummary?.incomplete ? "Available est. revenue subtotal" : "Combined est. revenue"}</div>
              <div className="font-mono text-2xl font-semibold tabular-nums mt-1">{formatUsdCompact(data.combinedRevenueUsd)}</div>
              <div className="text-xs text-muted-foreground mt-1">{window} · overlay-final · {data.platforms.length} platform{data.platforms.length === 1 ? "" : "s"}</div>
            </Card>
            <Card className="p-4 border-violet-500/40">
              <div className="text-[10px] uppercase text-muted-foreground tracking-wide">Combined units (est.)</div>
              <div className="font-mono text-2xl font-semibold tabular-nums mt-1">{formatNumberCompact(data.combinedUnits)}</div>
              <div className="text-xs text-muted-foreground mt-1">Sum of window unit estimates</div>
            </Card>
          </div>

          <RevenueShare summary={data.revenueSummary} pie />
          {/* Per-platform cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {(["steam", "ps5", "xbox"] as Platform[]).map(p => {
              const k = data.perPlatform[p];
              if (!k) return null;
              return (
                <Link key={p} href={`/console-leaderboards/${p}/${k.titleId}`}>
                  <a className="block h-full">
                  <Card className="p-4 h-full hover:bg-muted/40 transition-colors cursor-pointer">
                    <div className="text-[10px] uppercase tracking-wide" style={{ color: PLATFORM_META[p].accent }}>{PLATFORM_META[p].label}</div>
                    <div className="font-mono text-xl font-semibold tabular-nums mt-1">{formatUsdCompact(k.revenueUsd)}</div>
                    {k.revenueUsd == null && <div className="text-xs text-muted-foreground mt-1">Estimate unavailable for this period</div>}
                    <div className="text-xs text-muted-foreground mt-1">est. revenue · {k.dataSource === "derived_from_steam_daily_mix" ? "daily adjusted" : k.source}</div>
                    {k.revenueCaveat && <div className="text-xs text-muted-foreground mt-2" data-testid="recent-family-note">{k.revenueCaveat}</div>}
                    {k.estimateMethod?.includes("steam_review_shock_guard_v1") && <div className="text-xs text-muted-foreground mt-2" data-testid="review-shock-note">Review-burst adjusted estimate. Raw review activity is preserved, not counted directly as purchases.</div>}
                    <div className="text-xs text-muted-foreground mt-2">
                      {formatNumberCompact(k.unitsMid)} units
                    </div>
                    {k.windowUsed && k.windowUsed !== window ? (
                      <div className="text-[10px] text-muted-foreground mt-1">est. via {k.windowUsed}</div>
                    ) : null}
                  </Card>
                  </a>
                </Link>
              );
            })}
          </div>

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
                      <span className="flex-1 text-sm truncate">{s.name || "\u2014"}</span>
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
