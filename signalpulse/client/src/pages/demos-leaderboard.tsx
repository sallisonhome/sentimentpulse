/**
 * Steam Demos Leaderboard (experimental).
 *
 * Route: /demos-leaderboard
 *
 * Default: Steam's Top Demos source order (recent daily active users).
 * New Releases preserves Steam's release order, even without reviews.
 * Estimated downloads and sampled CCU remain separate ranking modes.
 * Windows affect estimates only; source timestamps and failures are
 * visible rather than silently re-ranking a stale/truncated universe.
 */

import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useState } from "react";

type WindowKey = "d7" | "d30" | "d90" | "m12" | "ltd";
type SortKey = "top" | "new" | "reviews" | "downloads" | "ccu" | "peak" | "release";
type SortDirection = "asc" | "desc";

const WINDOWS: Array<{ id: WindowKey; label: string }> = [
  { id: "d7",  label: "7 days"    },
  { id: "d30", label: "30 days"   },
  { id: "d90", label: "90 days"   },
  { id: "m12", label: "12 months" },
  { id: "ltd", label: "Lifetime"  },
];

const SORTS: Array<{ id: SortKey; label: string }> = [
  { id: "top", label: "Top Demos" },
  { id: "new", label: "New Releases" },
  { id: "downloads", label: "Estimated Downloads" },
  { id: "ccu",       label: "Sampled CCU" },
];

interface DemoRow {
  id: number;
  steamAppId: string;
  name: string;
  genre: string | null;
  releaseDate: string | null;
  isSaberPublished: boolean;
  reviewCountTotal: number | null;
  reviewDelta: number | null;
  unitsLow: number | null;
  unitsMid: number | null;
  unitsHigh: number | null;
  method: string | null;
  ccuCurrent: number | null;
  ccuAllTimePeak: number | null;
  ccuAsOf: string | null;
  sourceRank: number | null;
}

interface LeaderboardResponse {
  window: WindowKey;
  sort: SortKey;
  direction: SortDirection;
  genre: string | null;
  genres: string[];
  asOfDate: string | null;
  multiplier: { low: number; mid: number; high: number; note: string };
  count: number;
  availableCount: number;
  coverage: {
    candidateLimitPerFeed: number;
    feeds: Array<{ feed: string; lastAttemptAt: string; lastSuccessAt: string | null;
      error: string | null; candidateCount: number; eligibleCount: number; totalMatches: number }>;
  };
  demos: DemoRow[];
}

function formatNumberCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function useDemosLeaderboard(window: WindowKey, sort: SortKey, direction: SortDirection, genre: string, limit = 50) {
  return useQuery<LeaderboardResponse>({
    queryKey: [`/signal/api/demos/leaderboard`, { window, sort, direction, genre, limit }],
    queryFn: async () => {
      const url = `/signal/api/demos/leaderboard?window=${window}&sort=${sort}&direction=${direction}&genre=${encodeURIComponent(genre)}&limit=${limit}`;
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60_000,
  });
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
    .format(new Date(`${value}T00:00:00Z`));
}

export default function DemosLeaderboard() {
  const [windowSel, setWindowSel] = useState<WindowKey>("d7");
  const [sortSel, setSortSel] = useState<SortKey>("top");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [genre, setGenre] = useState("");
  const { data, isLoading, isError, error } = useDemosLeaderboard(windowSel, sortSel, sortDirection, genre);
  const sourceView = sortSel === "top" || sortSel === "new";
  const feed = data?.coverage?.feeds.find(item => item.feed === sortSel);
  const staleFeed = !!feed?.lastSuccessAt && Date.now() - Date.parse(feed.lastSuccessAt) > 36 * 60 * 60_000;
  const setSourceView = (sort: SortKey) => { setSortSel(sort); setSortDirection("desc"); };
  const setColumnSort = (sort: SortKey) => {
    setSortDirection(sortSel === sort ? (sortDirection === "desc" ? "asc" : "desc") : "desc");
    setSortSel(sort);
  };
  const sortLabel = (sort: SortKey, label: string) => (
    <button type="button" onClick={() => setColumnSort(sort)}
      className="inline-flex items-center gap-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
      aria-label={`Sort by ${label}${sortSel === sort ? `, currently ${sortDirection}ending` : ""}`}>
      {label}<span aria-hidden="true">{sortSel === sort ? (sortDirection === "desc" ? "↓" : "↑") : "↕"}</span>
    </button>
  );

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-semibold">Steam Demos Leaderboard</h1>
            <Badge variant="outline" className="text-xs uppercase tracking-wide" style={{ color: "hsl(var(--foreground))" }}>experimental</Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Playable game demos from Steam's Top Demos, New Releases, and Trending feeds. Updated daily.
          </p>
          {data?.asOfDate && (
            <p className="text-xs text-muted-foreground mt-1" data-testid="text-demos-refresh-note">
              Latest estimate as of: {data.asOfDate}
            </p>
          )}
        </div>
        <div className="flex flex-col items-start md:items-end gap-2 w-full">
          <div className="flex gap-1 flex-wrap" role="tablist" aria-label="Estimate window">
            <span className="text-xs text-muted-foreground self-center mr-1">Estimate window</span>
            {WINDOWS.map(w => (
              <Button
                key={w.id}
                variant={windowSel === w.id ? "default" : "outline"}
                size="sm"
                onClick={() => setWindowSel(w.id)}
                data-testid={`btn-demos-window-${w.id}`}
                role="tab"
                aria-selected={windowSel === w.id}
              >
                {w.label}
              </Button>
            ))}
          </div>
          <div className="grid grid-cols-2 md:flex gap-1 order-first w-full md:w-auto" role="tablist" aria-label="Leaderboard view">
            {SORTS.map(s => (
              <Button
                key={s.id}
                variant={sortSel === s.id ? "secondary" : "ghost"}
                size="sm"
                className="text-xs"
                onClick={() => setSourceView(s.id)}
                data-testid={`btn-demos-sort-${s.id}`}
                role="tab"
                aria-selected={sortSel === s.id}
              >
                {s.label}
              </Button>
            ))}
          </div>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        Genre
        <select value={genre} onChange={event => setGenre(event.target.value)}
          className="h-9 max-w-[240px] rounded-md border border-input bg-background px-2 text-sm text-foreground"
          data-testid="select-demos-genre">
          <option value="">All genres</option>
          {Array.from(new Set([...(data?.genres ?? []), ...(genre ? [genre] : [])])).map(value => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>

      <div className="text-sm space-y-1" data-testid="text-demos-ranking-note">
        <p>{sortSel === "top"
          ? "Steam's Top Demos order: recent daily active users, not downloads or CCU."
          : sortSel === "new"
          ? "Steam's New Releases order, including demos with no reviews yet."
          : sortSel === "ccu"
          ? `Tracked demos ordered by latest sampled concurrent players (${sortDirection === "desc" ? "highest first" : "lowest first"}).`
          : sortSel === "release"
          ? `Tracked demos ordered by the demo's own release date (${sortDirection === "desc" ? "newest first" : "oldest first"}).`
          : sortSel === "reviews"
          ? `Tracked demos ordered by lifetime reviews (${sortDirection === "desc" ? "highest first" : "lowest first"}).`
          : sortSel === "peak"
          ? `Tracked demos ordered by peak observed CCU (${sortDirection === "desc" ? "highest first" : "lowest first"}).`
          : `Tracked demos ordered by estimated downloads for the selected window (${sortDirection === "desc" ? "highest first" : "lowest first"}).`}</p>
        {!sourceView && data && <p className="text-xs text-muted-foreground">Showing {data.count} of {data.availableCount} matching demos. Missing values sort last.</p>}
        {sourceView && feed?.lastSuccessAt && (
          <p className="text-xs text-muted-foreground" data-testid="text-demos-source-time">
            Source refreshed: {new Date(feed.lastSuccessAt).toLocaleString()}.
            {" "}Showing {data?.count} of {data?.availableCount} matching demos.
          </p>
        )}
        {sourceView && (feed?.error || staleFeed || (data && !feed?.lastSuccessAt)) && (
          <p role="status" className="text-sm text-amber-700 dark:text-amber-400" data-testid="text-demos-feed-warning">
            {!feed?.lastSuccessAt
              ? "This Steam ranking has not been collected successfully yet."
              : "This ranking is from an earlier collection. The latest refresh failed or is overdue."}
            {feed?.error ? ` ${feed.error}` : ""}
          </p>
        )}
      </div>

      <details className="text-xs text-muted-foreground" data-testid="details-demos-coverage">
        <summary className="cursor-pointer py-1">Coverage, genre and sorting notes</summary>
        <p className="mt-2">
          Discovery checks Steam's US/English storefront, up to {data?.coverage?.candidateLimitPerFeed ?? 100} candidate slots per feed,
          plus Saber's roster, not every demo on Steam. Software demos and license-category counts are excluded.
          Steam rank gaps reflect filtered or duplicate entries.
          Genre uses broad Steam tags, falling back to parent-game tags when needed.
          Click a KPI or release-date header to sort all matching tracked demos; click again to reverse.
          Top Demos and New Releases restore Steam's source order.
        </p>
        <p className="mt-2" data-testid="text-demos-sampling-note">
          CCU is the latest collected sample, not a live feed. Peak observed CCU is the highest sample recorded
          since tracking began, not a historical all-time peak. Date filters apply to download estimates only,
          not Steam's rankings or CCU columns. Release dates belong to the demo, not its parent game.
        </p>
      </details>

      {data?.multiplier && (
        <details className="text-xs text-muted-foreground bg-muted/40 rounded-md px-3 py-2" data-testid="details-demos-method">
          <summary className="cursor-pointer">Download estimates: reviews × {data.multiplier.mid}x</summary>
          <p className="mt-2">
          Estimated downloads = reviews added in the selected window × a downloads-per-review
          multiplier ({data.multiplier.mid}x). Provisional: calibrated on a single
          anchor (Hellraiser Revival demo: 100,000 downloads / 1,527 reviews). Hover a figure for its
          low ({data.multiplier.low}x) / high ({data.multiplier.high}x) sensitivity range.
          These are estimates, not confirmed Steamworks downloads.
          </p>
        </details>
      )}

      <Card className="overflow-x-auto">
        {isLoading && (
          <div className="p-4 space-y-2">
            {Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        )}
        {isError && (
          <div className="p-4 text-sm text-destructive">Failed to load leaderboard: {(error as Error)?.message}</div>
        )}
        {!isLoading && !isError && data && (
          <table className="w-full min-w-[960px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium w-10">{sourceView ? "Steam rank" : "#"}</th>
                <th className="px-3 py-2 font-medium">Demo</th>
                <th className="px-3 py-2 font-medium">Genre</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap" aria-sort={sortSel === "release" ? (sortDirection === "desc" ? "descending" : "ascending") : "none"}>{sortLabel("release", "Demo Release Date")}</th>
                <th className="px-3 py-2 font-medium text-right" aria-sort={sortSel === "reviews" ? (sortDirection === "desc" ? "descending" : "ascending") : "none"}>{sortLabel("reviews", "Reviews (LTD)")}</th>
                <th className="px-3 py-2 font-medium text-right" aria-sort={sortSel === "downloads" ? (sortDirection === "desc" ? "descending" : "ascending") : "none"}>{sortLabel("downloads", "Est. Downloads (window)")}</th>
                <th className="px-3 py-2 font-medium text-right" aria-sort={sortSel === "ccu" ? (sortDirection === "desc" ? "descending" : "ascending") : "none"}>{sortLabel("ccu", "Latest Sampled CCU")}</th>
                <th className="px-3 py-2 font-medium text-right" aria-sort={sortSel === "peak" ? (sortDirection === "desc" ? "descending" : "ascending") : "none"}>{sortLabel("peak", "Peak Observed CCU")}</th>
              </tr>
            </thead>
            <tbody>
              {data.demos.map((d, i) => (
                <tr key={d.id} className="border-b border-border/50 hover:bg-muted/30" data-testid={`row-demo-${d.steamAppId}`}>
                  <td className="px-3 py-2 text-muted-foreground">{sourceView ? d.sourceRank : i + 1}</td>
                  <td className="px-3 py-2">
                    <a
                      href={`https://store.steampowered.com/app/${d.steamAppId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium hover:underline"
                    >
                      {d.name}
                    </a>
                    {d.isSaberPublished && (
                      <Badge className="ml-2 text-[10px]" variant="secondary" data-testid={`badge-saber-${d.steamAppId}`}>
                        Saber
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{d.genre ?? "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{formatDate(d.releaseDate)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumberCompact(d.reviewCountTotal)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {d.unitsMid != null ? (
                      d.method === "steamworks_actual" ? (
                        <span title="Confirmed via Saber's own Steamworks Sales & Activations report -- not an estimate">
                          {formatNumberCompact(d.unitsMid)}
                          <Badge className="ml-1.5 text-[9px] align-middle" variant="outline" data-testid={`badge-confirmed-${d.steamAppId}`}>
                            Confirmed
                          </Badge>
                        </span>
                      ) : (
                        <span title={`Estimate range: ${formatNumberCompact(d.unitsLow)} – ${formatNumberCompact(d.unitsHigh)} (low/high multiplier sensitivity)`}>
                          {formatNumberCompact(d.unitsMid)}
                        </span>
                      )
                    ) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums" title={d.ccuAsOf ? `Sample collected: ${d.ccuAsOf}` : "No CCU sample collected"}>
                    {formatNumberCompact(d.ccuCurrent)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumberCompact(d.ccuAllTimePeak)}</td>
                </tr>
              ))}
              {data.demos.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">
                  {sourceView ? "No verified game demos in the latest successful feed snapshot." : "No demo data yet."}
                </td></tr>
              )}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
