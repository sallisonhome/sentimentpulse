/**
 * Steam & Console Sales Leaderboards (experimental).
 *
 * Route: /console-leaderboards
 * Sub-routes: /console-leaderboards/:platform (per-platform full list)
 *             /console-leaderboards/:platform/:titleId (PDP)
 *
 * Hub layout follows the howmanyareplaying CombinedLeaderboards pattern:
 *   - Three columns side-by-side on desktop (Steam / Xbox / PS5)
 *   - Mobile: platform tabs switch between the three columns
 *   - Each column shows Top 20 rows ranked by rating count (the sales
 *     proxy signal), with a footer "View Top 100 →" link to the
 *     per-platform full list
 * Only paid/premium titles surface here (business_model = 'paid' at API layer).
 *
 * API path convention: the app is served under /signal/ by nginx, so
 * fetches MUST use the /signal/api/... prefix. Bare /api/... resolves
 * to the launcher root and 404s. See sales-by-country.tsx for the same
 * pattern.
 */

import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ArrowRight, ChevronRight } from "lucide-react";
import { useState } from "react";

type Platform = "steam" | "xbox" | "ps5";
type WindowKey = "d7" | "d30" | "d90" | "m12" | "ltd";

const PLATFORMS: Array<{ id: Platform; label: string; accent: string; sourceLabel: string; sourceUrl: string }> = [
  { id: "steam", label: "Steam",         accent: "#66c0f4", sourceLabel: "Steam storefront",     sourceUrl: "https://store.steampowered.com" },
  { id: "xbox",  label: "Xbox",          accent: "#107c10", sourceLabel: "Xbox display catalog", sourceUrl: "https://displaycatalog.mp.microsoft.com" },
  { id: "ps5",   label: "PlayStation 5", accent: "#0070d1", sourceLabel: "PlayStation Store",    sourceUrl: "https://store.playstation.com" },
];

const WINDOWS: Array<{ id: WindowKey; label: string }> = [
  { id: "d7",  label: "7 days"    },
  { id: "d30", label: "30 days"   },
  { id: "d90", label: "90 days"   },
  { id: "m12", label: "12 months" },
  { id: "ltd", label: "Lifetime"  },
];

const HUB_TOP_N = 20; // Rows per column on the hub — matches howmanyareplaying Top 20.

interface LeaderboardRow {
  titleId: number;
  externalSku: string;
  msrpUsdCents: number | null;
  businessModel: string;
  name: string | null;
  coverUrl: string | null;
  releaseDate: string | null;
  ratingCount: number | null;
  avgRating: number | null;
  ratingCapturedAt: string | null;
  ownersMid: number | null;
  unitsMid: number | null;
  gatedReason: string | null;
}

interface LeaderboardResponse {
  platform: Platform;
  window: WindowKey;
  count: number;
  titles: LeaderboardRow[];
}

function formatNumberCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function formatUsd(cents: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

function usePlatformLeaderboard(platform: Platform, window: WindowKey) {
  return useQuery<LeaderboardResponse>({
    queryKey: [`/signal/api/console/leaderboards/${platform}`, { window }],
    queryFn: async () => {
      const r = await fetch(`/signal/api/console/leaderboards/${platform}?window=${window}`, {
        credentials: "include",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60_000, // 5 min — the underlying capture_date grain is daily.
  });
}

// ─── Hub: 3 columns side-by-side ─────────────────────────────────────────────

export default function ConsoleLeaderboardsHub() {
  // Single window applies to all three columns on the hub to keep the
  // comparison honest. The per-platform full page can override it.
  const [window, setWindow] = useState<WindowKey>("d30");
  const [mobileTab, setMobileTab] = useState<Platform>("steam");

  const steamQ = usePlatformLeaderboard("steam", window);
  const xboxQ  = usePlatformLeaderboard("xbox",  window);
  const ps5Q   = usePlatformLeaderboard("ps5",   window);

  const queries: Record<Platform, ReturnType<typeof usePlatformLeaderboard>> = {
    steam: steamQ, xbox: xboxQ, ps5: ps5Q,
  };

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-semibold">Steam &amp; Console Sales Leaderboards</h1>
            <Badge variant="outline" className="text-[10px] uppercase tracking-wide">experimental</Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Top premium paid titles across Steam, Xbox, and PlayStation, ranked by daily rating-count signal — a public proxy for sales momentum. Free-to-play titles are excluded.
          </p>
        </div>
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

      {/* Mobile platform tabs — visible only below md */}
      <div className="flex gap-1 md:hidden" role="tablist" aria-label="Platform">
        {PLATFORMS.map(p => (
          <button
            key={p.id}
            role="tab"
            aria-selected={mobileTab === p.id}
            className={`flex-1 px-3 py-2 text-sm rounded-md border transition-colors ${
              mobileTab === p.id
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-foreground hover:bg-muted border-border"
            }`}
            onClick={() => setMobileTab(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Desktop: 3 columns; Mobile: 1 column (active tab only) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {PLATFORMS.map(p => (
          <div
            key={p.id}
            className={mobileTab === p.id ? "block" : "hidden md:block"}
          >
            <PlatformColumn
              platform={p.id}
              label={p.label}
              accent={p.accent}
              sourceLabel={p.sourceLabel}
              sourceUrl={p.sourceUrl}
              window={window}
              query={queries[p.id]}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function PlatformColumn({
  platform, label, accent, sourceLabel, sourceUrl, window, query,
}: {
  platform: Platform;
  label: string;
  accent: string;
  sourceLabel: string;
  sourceUrl: string;
  window: WindowKey;
  query: ReturnType<typeof usePlatformLeaderboard>;
}) {
  const rows = query.data?.titles ?? [];
  const top20 = rows.slice(0, HUB_TOP_N);
  const totalCount = query.data?.count ?? 0;

  return (
    <Card
      className="overflow-hidden flex flex-col border-t-4"
      style={{ borderTopColor: accent }}
      data-testid={`column-${platform}`}
    >
      {/* Column header */}
      <div className="p-4 border-b border-border">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold text-base" style={{ color: accent }}>{label}</h2>
          <Link href={`/console-leaderboards/${platform}`}>
            <span
              className="text-xs text-muted-foreground hover:text-foreground cursor-pointer inline-flex items-center gap-0.5"
              data-testid={`link-viewall-${platform}`}
            >
              View top 100
              <ChevronRight className="h-3 w-3" />
            </span>
          </Link>
        </div>
        <div className="text-xs text-muted-foreground mt-1">
          {totalCount > 0 ? `${totalCount} paid titles` : "—"} · Source:{" "}
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground underline decoration-dotted"
          >
            {sourceLabel}
          </a>
        </div>
      </div>

      {/* Column body */}
      <div className="flex-1">
        {query.isLoading && (
          <div className="p-3 space-y-2">
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full rounded" />
            ))}
          </div>
        )}

        {query.isError && (
          <div className="p-6 text-sm text-destructive text-center">
            Failed to load: {(query.error as Error)?.message || "unknown error"}
          </div>
        )}

        {!query.isLoading && !query.isError && top20.length === 0 && (
          <div className="p-6 text-sm text-muted-foreground text-center">
            No data yet — collector hasn't populated {label} snapshots.
          </div>
        )}

        {!query.isLoading && !query.isError && top20.length > 0 && (
          <ol className="divide-y divide-border" data-testid={`list-${platform}`}>
            {top20.map((t, i) => (
              <li key={t.titleId}>
                <Link href={`/console-leaderboards/${platform}/${t.titleId}`}>
                  <a
                    className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/40 transition-colors cursor-pointer"
                    data-testid={`row-${platform}-${t.titleId}`}
                  >
                    <span
                      className="text-xs font-mono text-muted-foreground w-6 text-right tabular-nums shrink-0"
                    >
                      {i + 1}
                    </span>
                    {t.coverUrl ? (
                      <img
                        src={t.coverUrl}
                        alt=""
                        loading="lazy"
                        className="h-8 w-6 object-cover rounded-sm shrink-0"
                      />
                    ) : (
                      <div className="h-8 w-6 rounded-sm bg-muted shrink-0" />
                    )}
                    <span className="flex-1 min-w-0 truncate text-sm">
                      {t.name || t.externalSku}
                    </span>
                    <span className="font-mono text-xs tabular-nums shrink-0" title="Rating count (sales proxy)">
                      {formatNumberCompact(t.ratingCount)}
                    </span>
                  </a>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* Column footer */}
      {top20.length > 0 && (
        <div className="p-3 border-t border-border">
          <Link href={`/console-leaderboards/${platform}`}>
            <span
              className="text-xs cursor-pointer inline-flex items-center gap-0.5 hover:underline"
              style={{ color: accent }}
              data-testid={`link-viewall-footer-${platform}`}
            >
              See top 100 <ChevronRight className="h-3 w-3" />
            </span>
          </Link>
        </div>
      )}
    </Card>
  );
}

// ─── Per-platform full list (unchanged layout, just fixes the fetch URL) ────

export function ConsoleLeaderboardsPlatform() {
  const params = useParams<{ platform: Platform }>();
  const platform = params.platform;
  const [window, setWindow] = useState<WindowKey>("d30");
  const { data, isLoading, isError, error } = usePlatformLeaderboard(platform, window);
  const platformLabel = PLATFORMS.find(p => p.id === platform)?.label || platform;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <Link href="/console-leaderboards">
            <button className="text-xs text-muted-foreground hover:text-foreground" data-testid="link-back-hub">← All platforms</button>
          </Link>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <h1 className="text-2xl font-semibold">{platformLabel} · Top Paid Titles</h1>
            <Badge variant="outline" className="text-[10px] uppercase tracking-wide">experimental</Badge>
          </div>
        </div>
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
        <div className="space-y-2">
          {[1,2,3,4,5].map(i => <Skeleton key={i} className="h-16 w-full rounded-md" />)}
        </div>
      )}

      {isError && (
        <Card className="p-6 text-sm text-destructive">
          Failed to load leaderboard: {(error as Error)?.message || "unknown error"}
        </Card>
      )}

      {!isLoading && !isError && data && (
        <>
          <Card className="p-3 bg-muted/40 border-dashed">
            <p className="text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">Ranking signal:</span> daily rating-count delta from the storefront review API — a public proxy for sales velocity.
              Estimated units are pending the Phase 4 demand-model rollout; rows show <span className="font-mono">pending</span> until that ships.
            </p>
          </Card>
          <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr className="text-xs text-muted-foreground">
                <th className="text-left px-3 py-2 font-medium">#</th>
                <th className="text-left px-3 py-2 font-medium">Title</th>
                <th className="text-right px-3 py-2 font-medium">Rating count</th>
                <th className="text-right px-3 py-2 font-medium">Avg rating</th>
                <th className="text-right px-3 py-2 font-medium" title="Estimated units sold in this window — pending Phase 4 estimator rollout">Est. units ({window})</th>
                <th className="text-right px-3 py-2 font-medium">MSRP</th>
              </tr>
            </thead>
            <tbody>
              {data.titles.length === 0 && (
                <tr><td className="p-6 text-center text-muted-foreground text-sm" colSpan={6}>No titles yet — run discovery + signal collectors.</td></tr>
              )}
              {data.titles.map((t, i) => (
                <tr key={t.titleId} className="border-t border-border hover:bg-muted/30">
                  <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                  <td className="px-3 py-2">
                    <Link href={`/console-leaderboards/${platform}/${t.titleId}`}>
                      <span className="cursor-pointer hover:underline flex items-center gap-2" data-testid={`link-title-${t.titleId}`}>
                        {t.coverUrl && <img src={t.coverUrl} alt="" className="h-8 w-6 object-cover rounded-sm" />}
                        <span>{t.name || t.externalSku}</span>
                      </span>
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{formatNumberCompact(t.ratingCount)}</td>
                  <td className="px-3 py-2 text-right font-mono">{t.avgRating != null ? t.avgRating.toFixed(2) : "—"}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {t.unitsMid != null ? formatNumberCompact(t.unitsMid) : (
                      <span className="text-muted-foreground" title={t.gatedReason || "Phase 4 estimator not yet deployed"}>pending</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{formatUsd(t.msrpUsdCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        </>
      )}
    </div>
  );
}
