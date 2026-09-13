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
  // Order (2026-09-12): PS5 before Xbox to match the immutable platform
  // revenue-mix ordering (Steam 49.5% → PS5 37.9% → Xbox 12.6%). See
  // lessons.md "Platform revenue-share ratio is immutable".
  { id: "ps5",   label: "PlayStation 5", accent: "#0070d1", sourceLabel: "PlayStation Store",    sourceUrl: "https://store.playstation.com" },
  { id: "xbox",  label: "Xbox",          accent: "#107c10", sourceLabel: "Xbox display catalog", sourceUrl: "https://displaycatalog.mp.microsoft.com" },
];

const WINDOWS: Array<{ id: WindowKey; label: string }> = [
  { id: "d7",  label: "7 days"    },
  { id: "d30", label: "30 days"   },
  { id: "d90", label: "90 days"   },
  { id: "m12", label: "12 months" },
  { id: "ltd", label: "Lifetime"  },
];

const HUB_TOP_N = 20;  // Rows per column on the hub (top-level presentation).
const FULL_TOP_N = 40; // Rows shown on the per-platform full-page view.
// The backend still returns up to LIMIT 250 and the daily discovery cron still
// walks the full ~150-title corpus per platform; we just cap what's rendered.

interface LeaderboardRow {
  titleId: number;
  externalSku: string;
  msrpUsdCents: number | null;
  aspUsdCents: number | null;
  businessModel: string;
  name: string | null;
  coverUrl: string | null;
  releaseDate: string | null;
  ratingCount: number | null;
  avgRating: number | null;
  // Steam only. Native percent-of-positive (e.g. 87) and Steam's own bucket
  // label (e.g. "Very Positive"). Null for PS5/Xbox, which use the 0-5 mean.
  avgRatingPercent: number | null;
  avgRatingLabel: string | null;
  ratingCapturedAt: string | null;
  ownersMid: number | null;
  unitsMid: number | null;
  revenueMidUsd: number | null;
  gatedReason: string | null;
  // Fields added when discovery widened to sales7 / new-releases and the
  // route began cascading windows. windowUsed reports which window actually
  // produced the estimate ("d7" – the requested one – or a wider fallback
  // like "d30" / "d90"). isRecentHot is 1 when the title released in the
  // last 30 days AND has a real d7 estimate — the client badges those rows
  // as "Recent hot" so users can spot new launches at a glance.
  windowUsed?: WindowKey | null;
  isRecentHot?: 0 | 1 | boolean | null;
  nameSource?: "igdb" | "store" | null;
  matchConfidence?: "high" | "low" | null;
  // Edition rollup (Push 2, Change 10). editionCount is the number of
  // sibling SKUs (Deluxe/Ultimate/Digital Deluxe/Standard/PS4 & PS5/...)
  // that were collapsed into this display row. 0 = standalone.
  // editionTitles lists the original SKU names for the tooltip.
  editionCount?: number;
  editionTitles?: string[];
  editionGroupKey?: string;
}

interface LeaderboardResponse {
  platform: Platform;
  window: WindowKey;
  count: number;
  aspFactor?: number;
  titles: LeaderboardRow[];
}

function formatNumberCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function gatedTooltip(reason: string | null | undefined): string {
  switch (reason) {
    case "signal_too_small": return "Rating count below the noise gate (50) — signal too small to estimate reliably";
    case "insufficient_history": return "This window needs more days of forward-only collection than we have yet";
    case "no_signal": return "No rating snapshot available for this title today";
    case "no_multiplier": return "No calibration multiplier configured for this platform";
    default: return reason || "Estimate unavailable";
  }
}

function formatUsd(cents: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

// Compact USD for dollar amounts already in dollars (not cents). Used for the
// estimated in-window revenue column, which can range from thousands to hundreds
// of millions across the top-100.
function formatUsdCompact(dollars: number | null | undefined): string {
  if (dollars == null || !Number.isFinite(dollars)) return "—";
  if (dollars >= 1_000_000_000) return `$${(dollars / 1_000_000_000).toFixed(2)}B`;
  if (dollars >= 1_000_000)     return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000)         return `$${(dollars / 1_000).toFixed(1)}K`;
  return `$${dollars.toFixed(0)}`;
}

// Sort keys accepted by the server — must stay in sync with SORT_EXPR in
// routes-console-leaderboards.ts. `title` is client-side only (locale sort).
type SortKey = "revenue" | "units" | "ratings" | "score" | "asp" | "title";
type SortDir = "asc" | "desc";

function usePlatformLeaderboard(
  platform: Platform,
  window: WindowKey,
  sort: SortKey = "revenue",
  dir: SortDir = "desc",
) {
  // The server doesn't understand sort=title; it always returns default-sorted
  // rows in that case and we sort locally by name.
  const serverSort: string = sort === "title" ? "revenue" : sort;
  const serverDir: string = sort === "title" ? "desc" : dir;
  return useQuery<LeaderboardResponse>({
    queryKey: [`/signal/api/console/leaderboards/${platform}`, { window, serverSort, serverDir }],
    queryFn: async () => {
      const url = `/signal/api/console/leaderboards/${platform}?window=${window}&sort=${serverSort}&dir=${serverDir}`;
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60_000, // 5 min — the underlying capture_date grain is daily.
  });
}

// ─── Multiplatform (Steam + ≥1 console) top-20 hook ───────────────────────
// Matches the response shape of /api/console/leaderboards-multiplatform in
// server/routes-console-leaderboards.ts. Every field is derived from the
// SAME overlay pipeline as the per-platform boards, so the combined revenue
// value is the sum of the same per-platform revenues you see in each column.
interface MultiplatformRow {
  editionGroupKey: string;
  name: string;
  coverUrl: string | null;
  releaseDate: string | null;
  steamTitleId: number;
  ps5TitleId?: number;
  xboxTitleId?: number;
  platforms: Platform[];
  revenueSteam: number;
  revenuePs5: number;
  revenueXbox: number;
  revenueCombined: number;
  revenueSource: "overlay-ratio" | "overlay-ip-override" | "ps5-exclusive-fallback" | "mixed";
}
interface MultiplatformResponse {
  window: WindowKey;
  cascade: WindowKey[];
  count: number;
  candidatesCount: number;
  titles: MultiplatformRow[];
}

function useMultiplatformLeaderboard(window: WindowKey, limit = 20) {
  return useQuery<MultiplatformResponse>({
    queryKey: [`/signal/api/console/leaderboards-multiplatform`, { window, limit }],
    queryFn: async () => {
      const url = `/signal/api/console/leaderboards-multiplatform?window=${window}&limit=${limit}`;
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60_000,
  });
}

interface CalibrationStatus {
  calibrated: boolean;
  platform: string;
  lastCalibratedDate?: string;
  anchorCount?: number;
  windowUsed?: string;
  weightMethod?: string;
  observedRatio?: number;
  multiplierBefore?: number;
  multiplierAfter?: number;
  method?: string;
  overlayCount?: number;
}

function useCalibrationStatus(platform: string) {
  return useQuery<CalibrationStatus>({
    queryKey: [`/signal/api/console/leaderboards/${platform}/calibration`],
    queryFn: async () => {
      const r = await fetch(`/signal/api/console/leaderboards/${platform}/calibration`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 30 * 60_000,
  });
}

// ─── Hub: 3 columns side-by-side ─────────────────────────────────────────────

export default function ConsoleLeaderboardsHub() {
  // Single window applies to all three columns on the hub to keep the
  // comparison honest. The per-platform full page can override it.
  //
  // Default is d7 so fresh launches with a real 7-day estimate surface
  // first — rows without a real d7 estimate cascade internally to d30/d90/
  // m12/ltd on the server, and the client uses windowUsed + isRecentHot to
  // badge the difference.
  const [window, setWindow] = useState<WindowKey>("d7");
  const [mobileTab, setMobileTab] = useState<Platform>("steam");

  const steamQ = usePlatformLeaderboard("steam", window);
  const xboxQ  = usePlatformLeaderboard("xbox",  window);
  const ps5Q   = usePlatformLeaderboard("ps5",   window);
  const multiQ = useMultiplatformLeaderboard(window, 20);

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
            Top premium paid titles across Steam, Xbox, and PlayStation, ranked by estimated in-window revenue (units × ASP). Free-to-play titles are excluded. Rating count is the underlying sales-momentum signal that feeds the estimator.
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

      {/* Full-width multiplatform section below the 3-column grid. Same
          `window` state as the columns — flipping the window pill filters
          all four surfaces together. Positioned BELOW per operator direction:
          the 3-column presentation stays the primary read; combined-revenue
          is a secondary, deeper look. */}
      <MultiplatformSection window={window} query={multiQ} />
    </div>
  );
}

// ─── Multiplatform section ──────────────────────────────────────────
// Full-width card. Rows show title + SKU badges (Steam / PS5 / Xbox) + the
// per-platform revenue split + a large combined-revenue value on the right.
// Click a row → multiplatform PDP. Click a platform badge → that platform's
// per-title PDP (existing route).
function MultiplatformSection({
  window: windowKey,
  query,
}: {
  window: WindowKey;
  query: ReturnType<typeof useMultiplatformLeaderboard>;
}) {
  const rows = query.data?.titles ?? [];
  const candidatesCount = query.data?.candidatesCount ?? 0;

  return (
    <Card
      className="overflow-hidden flex flex-col border-t-4"
      style={{ borderTopColor: "#a855f7" /* purple: distinct from steam/ps5/xbox accents */ }}
      data-testid="multiplatform-section"
    >
      <div className="p-4 border-b border-border flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="font-semibold text-base" style={{ color: "#a855f7" }}>
              Cross-Platform Leaders — Combined Revenue
            </h2>
            <Badge variant="outline" className="text-[10px] uppercase tracking-wide">top 20</Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Titles shipping on Steam AND at least one console, ranked by summed in-window revenue across the platforms that carry a base SKU. Per-platform figures use the same overlay math (immutable revenue-share ratio, IP overrides, PS5-exclusive fallback) as the three columns above.
          </p>
        </div>
        {candidatesCount > 0 ? (
          <div className="text-xs text-muted-foreground shrink-0">
            {candidatesCount} qualifying titles
          </div>
        ) : null}
      </div>

      <div className="flex-1">
        {query.isLoading && (
          <div className="p-3 space-y-2">
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded" />
            ))}
          </div>
        )}

        {query.isError && (
          <div className="p-6 text-sm text-destructive text-center">
            Failed to load multiplatform leaderboard: {(query.error as Error)?.message || "unknown error"}
          </div>
        )}

        {!query.isLoading && !query.isError && rows.length === 0 && (
          <div className="p-6 text-sm text-muted-foreground text-center">
            No cross-platform titles for this window yet.
          </div>
        )}

        {!query.isLoading && !query.isError && rows.length > 0 && (
          <ol className="divide-y divide-border" data-testid="list-multiplatform">
            {rows.map((t, i) => (
              <li key={t.editionGroupKey}>
                <Link href={`/console-leaderboards/multiplatform/${encodeURIComponent(t.editionGroupKey)}`}>
                  <a
                    className="grid grid-cols-[2rem_2rem_1fr_auto] md:grid-cols-[2rem_2rem_1fr_10rem_auto] items-center gap-2 md:gap-3 px-3 py-2 hover:bg-muted/40 transition-colors cursor-pointer"
                    data-testid={`row-multiplatform-${t.editionGroupKey}`}
                  >
                    <span className="text-xs font-mono text-muted-foreground text-right tabular-nums shrink-0">
                      {i + 1}
                    </span>
                    {t.coverUrl ? (
                      <img src={t.coverUrl} alt="" loading="lazy" className="h-8 w-6 object-cover rounded-sm shrink-0" />
                    ) : (
                      <div className="h-8 w-6 rounded-sm bg-muted shrink-0" />
                    )}
                    <div className="min-w-0 flex flex-col">
                      <span className="truncate text-sm">{t.name}</span>
                      <div className="flex items-center gap-1 mt-0.5">
                        {t.platforms.includes("steam") && (
                          <PlatformChip label="Steam" color="#66c0f4" />
                        )}
                        {t.platforms.includes("ps5") && (
                          <PlatformChip label="PS5" color="#0070d1" />
                        )}
                        {t.platforms.includes("xbox") && (
                          <PlatformChip label="Xbox" color="#107c10" />
                        )}
                        {t.revenueSource !== "overlay-ratio" ? (
                          <span
                            className="text-[9px] uppercase tracking-wide text-muted-foreground ml-1"
                            title={revenueSourceTooltip(t.revenueSource)}
                          >
                            {revenueSourceShortLabel(t.revenueSource)}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {/* Per-platform split — hidden on mobile to keep row height sane. */}
                    <div className="hidden md:flex flex-col items-end leading-tight text-[10px] font-mono tabular-nums text-muted-foreground">
                      {t.platforms.includes("steam") && (
                        <span title="Steam revenue (overlay-final)">S {formatUsdCompact(t.revenueSteam)}</span>
                      )}
                      {t.platforms.includes("ps5") && (
                        <span title="PS5 revenue (overlay-final)">P {formatUsdCompact(t.revenuePs5)}</span>
                      )}
                      {t.platforms.includes("xbox") && (
                        <span title="Xbox revenue (overlay-final)">X {formatUsdCompact(t.revenueXbox)}</span>
                      )}
                    </div>
                    <div className="flex flex-col items-end shrink-0 leading-tight">
                      <span
                        className="font-mono text-sm tabular-nums font-semibold"
                        title={`Combined revenue (${windowKey}) = Steam + PS5 + Xbox overlay-final`}
                      >
                        {formatUsdCompact(t.revenueCombined)}
                      </span>
                      <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
                        combined
                      </span>
                    </div>
                  </a>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Card>
  );
}

function PlatformChip({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="text-[9px] uppercase tracking-wide px-1.5 py-[1px] rounded border"
      style={{ color, borderColor: color + "66" /* ~40% alpha */ }}
      title={label}
    >
      {label}
    </span>
  );
}

function revenueSourceShortLabel(src: MultiplatformRow["revenueSource"]): string {
  switch (src) {
    case "overlay-ip-override":     return "ip mix";
    case "ps5-exclusive-fallback":  return "exclusive";
    case "mixed":                    return "mixed";
    default:                         return "";
  }
}
function revenueSourceTooltip(src: MultiplatformRow["revenueSource"]): string {
  switch (src) {
    case "overlay-ip-override":     return "Console revenue derived using the per-IP mix override (e.g. sports, Sony first-party) rather than the general 47/36/12 mix.";
    case "ps5-exclusive-fallback":  return "Steam signal was below the meaningful-revenue floor — console revenue kept from its own estimator instead of derived from Steam.";
    case "mixed":                    return "One platform used an IP override; another fell back to its own estimator.";
    default:                         return "General immutable revenue-share ratio";
  }
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
              View top 40
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
                    <span className="flex-1 min-w-0 flex items-center gap-1.5 text-sm">
                      {/*
                        2026-09-12: server-side integrity gate on the Xbox
                        route (xbox_title_cache LEFT JOIN + WHERE xtc.name
                        IS NOT NULL for platform='xbox') guarantees `name`
                        is set for every row that reaches the client, so
                        the 12-char bigId is never rendered as a title. If
                        an old client ever received a row without a name,
                        we prefer an empty cell over exposing the raw SKU.
                      */}
                      <span className="truncate">{t.name || ""}</span>
                      {t.isRecentHot ? (
                        <Badge
                          variant="secondary"
                          className="text-[9px] uppercase tracking-wide bg-orange-500/15 text-orange-600 border border-orange-500/30 shrink-0"
                          title="Released in the last 30 days with a real 7-day sales estimate"
                          data-testid={`badge-hot-${t.titleId}`}
                        >
                          Recent hot
                        </Badge>
                      ) : t.windowUsed && t.windowUsed !== window ? (
                        <Badge
                          variant="outline"
                          className="text-[9px] uppercase tracking-wide text-muted-foreground shrink-0"
                          title={`No ${window} signal yet — estimate uses ${t.windowUsed} data as fallback`}
                          data-testid={`badge-cascade-${t.titleId}`}
                        >
                          est. via {t.windowUsed}
                        </Badge>
                      ) : null}
                      {t.editionCount && t.editionCount > 0 ? (
                        <Badge
                          variant="outline"
                          className="text-[9px] uppercase tracking-wide text-muted-foreground shrink-0"
                          title={`Includes ${t.editionCount + 1} SKUs: ${(t.editionTitles ?? []).join(", ")}`}
                          data-testid={`badge-editions-${t.titleId}`}
                        >
                          +{t.editionCount} edition{t.editionCount === 1 ? "" : "s"}
                        </Badge>
                      ) : null}
                    </span>
                    <div className="flex flex-col items-end shrink-0 leading-tight">
                      {/* Primary: estimated revenue. Rating-count is our
                          algorithm's input signal but not the leaderboard's
                          point — revenue leads, rating count is muted below. */}
                      <span
                        className="font-mono text-xs tabular-nums"
                        title={
                          t.revenueMidUsd != null
                            ? `Est. revenue (${window}) = est. units × ASP — v0, ±30–50%`
                            : t.unitsMid != null
                              ? `Est. units (${window}) — v0, ±30–50% (ASP or MSRP missing)`
                              : gatedTooltip(t.gatedReason)
                        }
                      >
                        {t.revenueMidUsd != null
                          ? formatUsdCompact(t.revenueMidUsd)
                          : t.unitsMid != null
                            ? `~${formatNumberCompact(t.unitsMid)}u`
                            : "—"}
                      </span>
                      <span
                        className="font-mono text-[10px] tabular-nums text-muted-foreground"
                        title="Rating count — public sales-momentum proxy that feeds the estimator"
                      >
                        {formatNumberCompact(t.ratingCount)} ratings
                      </span>
                    </div>
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
              See top 40 <ChevronRight className="h-3 w-3" />
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
  const [window, setWindow] = useState<WindowKey>("d7");
  const [sort, setSort] = useState<SortKey>("revenue");
  const [dir, setDir] = useState<SortDir>("desc");
  const { data, isLoading, isError, error } = usePlatformLeaderboard(platform, window, sort, dir);
  const { data: calibration } = useCalibrationStatus(platform);
  const platformLabel = PLATFORMS.find(p => p.id === platform)?.label || platform;

  // Header click: same column toggles asc/desc; new column jumps to that
  // column's natural default direction (desc for numeric, asc for title).
  const NATURAL_DESC: SortKey[] = ["revenue", "units", "ratings", "score", "asp"];
  function onHeaderClick(key: SortKey) {
    if (key === sort) {
      setDir(d => (d === "asc" ? "desc" : "asc"));
    } else {
      setSort(key);
      setDir(NATURAL_DESC.includes(key) ? "desc" : "asc");
    }
  }
  function sortArrow(key: SortKey): string {
    if (key !== sort) return "";
    return dir === "asc" ? " ↑" : " ↓";
  }

  // Client-side sort for the `title` column (server doesn't know how). All
  // other keys arrive already sorted from the server, so we pass them through.
  // Cap at FULL_TOP_N so the full-page view stays a curated top-40 rather than
  // exposing the noisy long-tail from the server's LIMIT 250 fetch.
  const displayRows = data ? (
    sort === "title"
      ? [...data.titles].sort((a, b) => {
          // 2026-09-12: prefer null-name rows to sort last rather than
          // by their raw SKU, which is meaningless to the user.
          const av = (a.name || "").toLocaleLowerCase();
          const bv = (b.name || "").toLocaleLowerCase();
          const cmp = av.localeCompare(bv);
          return dir === "asc" ? cmp : -cmp;
        }).slice(0, FULL_TOP_N)
      : data.titles.slice(0, FULL_TOP_N)
  ) : [];

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
              <span className="ml-1 font-semibold text-foreground">Est. units</span> use v0 public-benchmark multipliers (±30–50%) with digital-share adjustments per platform (Steam 100%, PS5 76%, Xbox 90% modelled).
              <span className="ml-1 font-semibold text-foreground">Est. revenue</span> = est. units × <span className="font-mono">ASP</span>, where ASP = MSRP × platform realization factor (Steam 66%, PS5 80%, Xbox 80%){data.aspFactor != null ? ` — this platform: ${(data.aspFactor * 100).toFixed(0)}%` : ""}.
              Cells reading <span className="font-mono">—</span> mean the signal is below the noise gate (50) or that window lacks the required forward history.
            </p>
          </Card>
          {calibration?.calibrated && (
            <Card className="p-3 bg-amber-50/40 dark:bg-amber-950/20 border-amber-500/30">
              <p className="text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">Calibration active.</span>{" "}
                Revenue estimates on this leaderboard have been calibrated against a small sample of verified sales data. The model's realized ratio was <span className="font-mono">{calibration.observedRatio?.toFixed(2)}×</span> the pre-calibration estimate, and the platform ownership multiplier was adjusted from <span className="font-mono">{calibration.multiplierBefore?.toFixed(2)}</span> to <span className="font-mono">{calibration.multiplierAfter?.toFixed(2)}</span> as of <span className="font-mono">{calibration.lastCalibratedDate}</span> (n={calibration.anchorCount} anchor rows; windows: {calibration.windowUsed}).{" "}
                Rows shown as <span className="font-mono">actual</span> in the data-source cell come directly from verified sales; all other rows remain model estimates. Use these numbers for relative ranking rather than absolute revenue claims — individual-title accuracy varies at this sample size.
              </p>
            </Card>
          )}
          <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr className="text-xs text-muted-foreground">
                <th className="text-left px-3 py-2 font-medium">#</th>
                <th
                  className="text-left px-3 py-2 font-medium cursor-pointer select-none hover:text-foreground"
                  role="button"
                  aria-sort={sort === "title" ? (dir === "asc" ? "ascending" : "descending") : "none"}
                  onClick={() => onHeaderClick("title")}
                  data-testid="th-title"
                >
                  Title{sortArrow("title")}
                </th>
                <th
                  className="text-right px-3 py-2 font-medium cursor-pointer select-none hover:text-foreground"
                  role="button"
                  aria-sort={sort === "ratings" ? (dir === "asc" ? "ascending" : "descending") : "none"}
                  onClick={() => onHeaderClick("ratings")}
                  data-testid="th-ratings"
                >
                  Rating count{sortArrow("ratings")}
                </th>
                <th
                  className="text-right px-3 py-2 font-medium cursor-pointer select-none hover:text-foreground"
                  role="button"
                  aria-sort={sort === "score" ? (dir === "asc" ? "ascending" : "descending") : "none"}
                  onClick={() => onHeaderClick("score")}
                  data-testid="th-score"
                  title={platform === "steam"
                    ? "Percent of ratings that are positive (Steam's native metric). Hover a cell to see Steam's bucket label: Overwhelmingly Positive (≥95%), Very Positive (80–94%), Mostly Positive (70–79%), Mixed (40–69%), Mostly Negative (20–39%), Overwhelmingly Negative (<20%)."
                    : "Average of user ratings on a 0–5 scale (storefront native)."}
                >
                  {platform === "steam" ? "Rating %" : "Avg rating"}{sortArrow("score")}
                </th>
                <th
                  className="text-right px-3 py-2 font-medium cursor-pointer select-none hover:text-foreground"
                  role="button"
                  aria-sort={sort === "units" ? (dir === "asc" ? "ascending" : "descending") : "none"}
                  onClick={() => onHeaderClick("units")}
                  title="Estimated units sold in this window — v0 estimator, ±30–50% per title"
                  data-testid="th-units"
                >
                  Est. units ({window}){sortArrow("units")} <span className="ml-1 px-1 text-[10px] rounded bg-amber-500/20 text-amber-700 dark:text-amber-300">v0</span>
                </th>
                <th
                  className="text-right px-3 py-2 font-medium cursor-pointer select-none hover:text-foreground"
                  role="button"
                  aria-sort={sort === "revenue" ? (dir === "asc" ? "ascending" : "descending") : "none"}
                  onClick={() => onHeaderClick("revenue")}
                  title="Estimated in-window revenue = est. units × ASP, USD — v0 estimator, ±30–50% per title"
                  data-testid="th-revenue"
                >
                  Est. revenue ({window}){sortArrow("revenue")} <span className="ml-1 px-1 text-[10px] rounded bg-amber-500/20 text-amber-700 dark:text-amber-300">v0</span>
                </th>
                <th
                  className="text-right px-3 py-2 font-medium cursor-pointer select-none hover:text-foreground"
                  role="button"
                  aria-sort={sort === "asp" ? (dir === "asc" ? "ascending" : "descending") : "none"}
                  onClick={() => onHeaderClick("asp")}
                  title="Average Selling Price = MSRP × platform realization (Steam 66%, PS5 80%, Xbox 80%)"
                  data-testid="th-asp"
                >
                  ASP{sortArrow("asp")}
                </th>
              </tr>
            </thead>
            <tbody>
              {displayRows.length === 0 && (
                <tr><td className="p-6 text-center text-muted-foreground text-sm" colSpan={7}>No titles yet — run discovery + signal collectors.</td></tr>
              )}
              {displayRows.map((t, i) => (
                <tr key={t.titleId} className="border-t border-border hover:bg-muted/30">
                  <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                  <td className="px-3 py-2">
                    <Link href={`/console-leaderboards/${platform}/${t.titleId}`}>
                      <span className="cursor-pointer hover:underline flex items-center gap-2" data-testid={`link-title-${t.titleId}`}>
                        {t.coverUrl && <img src={t.coverUrl} alt="" className="h-8 w-6 object-cover rounded-sm" />}
                        <span>{t.name || ""}</span>
                        {t.isRecentHot ? (
                          <Badge
                            variant="secondary"
                            className="text-[9px] uppercase tracking-wide bg-orange-500/15 text-orange-600 border border-orange-500/30"
                            title="Released in the last 30 days with a real 7-day sales estimate"
                            data-testid={`badge-hot-${t.titleId}`}
                          >
                            Recent hot
                          </Badge>
                        ) : t.windowUsed && t.windowUsed !== window ? (
                          <Badge
                            variant="outline"
                            className="text-[9px] uppercase tracking-wide text-muted-foreground"
                            title={`No ${window} signal yet — estimate uses ${t.windowUsed} data as fallback`}
                            data-testid={`badge-cascade-${t.titleId}`}
                          >
                            est. via {t.windowUsed}
                          </Badge>
                        ) : null}
                        {t.editionCount && t.editionCount > 0 ? (
                          <Badge
                            variant="outline"
                            className="text-[9px] uppercase tracking-wide text-muted-foreground"
                            title={`Includes ${t.editionCount + 1} SKUs: ${(t.editionTitles ?? []).join(", ")}`}
                            data-testid={`badge-editions-${t.titleId}`}
                          >
                            +{t.editionCount} edition{t.editionCount === 1 ? "" : "s"}
                          </Badge>
                        ) : null}
                      </span>
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{formatNumberCompact(t.ratingCount)}</td>
                  <td className="px-3 py-2 text-right font-mono" title={t.avgRatingLabel ?? (t.avgRating != null ? `${t.avgRating.toFixed(2)} / 5` : undefined)}>
                    {t.avgRatingPercent != null
                      ? `${t.avgRatingPercent}%`
                      : (t.avgRating != null ? t.avgRating.toFixed(2) : "—")}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {t.unitsMid != null ? formatNumberCompact(t.unitsMid) : (
                      <span className="text-muted-foreground" title={gatedTooltip(t.gatedReason)}>—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {t.revenueMidUsd != null ? formatUsdCompact(t.revenueMidUsd) : (
                      <span className="text-muted-foreground" title={gatedTooltip(t.gatedReason)}>—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono" title={t.msrpUsdCents != null ? `MSRP ${formatUsd(t.msrpUsdCents)} × platform realization = ASP ${formatUsd(t.aspUsdCents)}` : undefined}>{formatUsd(t.aspUsdCents ?? t.msrpUsdCents)}</td>
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
