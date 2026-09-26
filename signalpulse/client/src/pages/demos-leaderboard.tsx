/**
 * Steam Demos Leaderboard (experimental).
 *
 * Route: /demos-leaderboard
 *
 * Default on open and period selection: downloads, descending.
 * Top Demos remains available in Steam's recent daily-active-user order.
 * New Releases preserves Steam's release order, even without reviews.
 * Estimated downloads and sampled CCU remain separate ranking modes.
 * Windows affect actual/estimated downloads only; source timestamps and failures are
 * visible rather than silently re-ranking a stale/truncated universe.
 */

import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { Link } from "wouter";
import { FriendsPassReference } from "@/components/friends-pass-reference";
import { PassScenarios } from "@/components/pass-scenarios";
import { PASS_PLAYER_GATES, PASS_PLAYER_STATUS_LABELS, type PassPlayerEstimate } from "@shared/pass-player-estimates";
import type { ActivityWindow, PassParentActivity } from "@shared/pass-parent-activity";
import { PassParentActivityCell } from "@/components/pass-parent-activity";

type WindowKey = "d7" | "d30" | "d90" | "m12" | "ltd";
type SortKey = "top" | "new" | "reviews" | "rating" | "downloads" | "ccu" | "peak" | "release" | "players" | "activity";
type SortDirection = "asc" | "desc";
type SkuKind = "demo" | "friends_pass";

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
  { id: "downloads", label: "Downloads" },
  { id: "ccu",       label: "Sampled CCU" },
];

interface DemoRow {
  id: number;
  steamAppId: string;
  name: string;
  genre: string | null;
  releaseDate: string | null;
  isSaberPublished: boolean;
  isArchived: boolean;
  isHybridPass: boolean;
  releaseDateUnverified: boolean;
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
  reviewEstimate: number | null;
  isObservedMinimum: boolean;
  lifetimeModelBelowPeak: boolean;
  downloadMultiplier: number | null;
  calibrationMode: "non_saber_trial" | "actual";
  actualsAsOf: string | null;
  actualsStartDate: string | null;
  actualsEndDate: string | null;
  actualsStale: boolean;
  actualsRefreshFailed: boolean;
  steamReviews: { positive: number; negative: number; total: number; positivePercent: number | null } | null;
  playerEstimate: PassPlayerEstimate | null;
  passParentActivity: PassParentActivity | null;
}

interface LeaderboardResponse {
  window: WindowKey;
  sort: SortKey;
  direction: SortDirection;
  genre: string | null;
  genres: string[];
  asOfDate: string | null;
  multiplier: { low: number; mid: number; high: number; nonSaberTrial: number; note: string };
  count: number;
  availableCount: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  coverage: {
    candidateLimitPerFeed: number;
    newReleaseCatchUpLimit: number;
    trackedCount: number;
    availableCount: number;
    archivedCount: number;
    completeSteamCatalog: false;
    feeds: Array<{ feed: string; lastAttemptAt: string; lastSuccessAt: string | null;
      error: string | null; candidateCount: number; eligibleCount: number; totalMatches: number;
      scannedSlots: number; stopReason: string | null }>;
  };
  demos: DemoRow[];
}

function formatNumberCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function useDemosLeaderboard(window: WindowKey, sort: SortKey, direction: SortDirection, genre: string, limit: number, offset: number, search: string, kind: SkuKind, activityWindow: ActivityWindow) {
  return useQuery<LeaderboardResponse>({
    queryKey: [`/signal/api/demos/leaderboard`, { window, sort, direction, genre, limit, offset, search, kind, activityWindow }],
    queryFn: async ({ signal }) => {
      const url = `/signal/api/demos/leaderboard?kind=${kind}&window=${window}&sort=${sort}&direction=${direction}&genre=${encodeURIComponent(genre)}&limit=${limit}&offset=${offset}&search=${encodeURIComponent(search)}&activityWindow=${activityWindow}`;
      const r = await fetch(url, { credentials: "include", signal });
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
  const [kind, setKind] = useState<SkuKind>("demo");
  const pass = kind === "friends_pass";
  const noun = pass ? "Friend’s Pass SKUs" : "demos";
  const [windowSel, setWindowSel] = useState<WindowKey>("d7");
  const [sortSel, setSortSel] = useState<SortKey>("downloads");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [genre, setGenre] = useState("");
  const [limit, setLimit] = useState(50);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [activityWindow, setActivityWindow] = useState<ActivityWindow>("latest");
  const { data, isLoading, isError, error } = useDemosLeaderboard(windowSel, sortSel, sortDirection, genre, limit, offset, search, kind, activityWindow);
  const sourceView = sortSel === "top" || sortSel === "new";
  const feed = data?.coverage?.feeds.find(item => item.feed === sortSel);
  const staleFeed = !!feed?.lastSuccessAt && Date.now() - Date.parse(feed.lastSuccessAt) > 36 * 60 * 60_000;
  const setSourceView = (sort: SortKey) => { setSortSel(sort); setSortDirection("desc"); setOffset(0); };
  const selectWindow = (window: WindowKey) => {
    setWindowSel(window);
    setSortSel("downloads");
    setSortDirection("desc");
    setOffset(0);
  };
  const setColumnSort = (sort: SortKey) => {
    setSortDirection(sortSel === sort ? (sortDirection === "desc" ? "asc" : "desc") : "desc");
    setSortSel(sort);
    setOffset(0);
  };
  const sortLabel = (sort: SortKey, label: string) => (
    <button type="button" onClick={() => setColumnSort(sort)}
      className="inline-flex items-center gap-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
      aria-label={`Sort by ${label}${sortSel === sort ? `, currently ${sortDirection}ending` : ""}`}>
      {label}<span aria-hidden="true">{sortSel === sort ? (sortDirection === "desc" ? "↓" : "↑") : "↕"}</span>
    </button>
  );

  return (
    <div className={`w-full min-w-0 p-4 md:p-6 ${pass ? "max-w-[2160px]" : "max-w-[1760px]"} mx-auto space-y-4`}>
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-semibold">Steam Demos & Friends Pass</h1>
            <Badge variant="outline" className="text-xs uppercase tracking-wide" style={{ color: "hsl(var(--foreground))" }}>experimental</Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {pass ? "Active Friend’s Pass clients, including hybrid demo/pass SKUs. Updated daily, separately from demos."
              : "Playable game demos from Steam's Top Demos, New Releases, and Trending feeds. Updated daily."}
          </p>
          {data?.asOfDate && (
            <p className="text-xs text-muted-foreground mt-1" data-testid="text-demos-refresh-note">
              Latest review estimate as of: {data.asOfDate}
            </p>
          )}
        </div>
        <div className="flex flex-col items-start md:items-end gap-2 w-full">
          <div className="flex gap-2 w-full" role="tablist" aria-label="SKU category">
            {(["demo","friends_pass"] as const).map(value=><Button key={value}
              role="tab" aria-selected={kind===value} variant={kind===value?"default":"outline"}
              data-testid={`btn-demos-kind-${value}`}
              onClick={()=>{setKind(value);setSortSel("downloads");setSortDirection("desc");setGenre("");setSearch("");setOffset(0);}}>
              {value==="demo"?"Demos":"Friends Pass"}
            </Button>)}
          </div>
          <div className="flex gap-1 flex-wrap" role="tablist" aria-label={pass ? "Metric window" : "Download window"}>
            <span className="text-xs text-muted-foreground self-center mr-1">{pass ? "Metric window" : "Download window"}</span>
            {WINDOWS.map(w => (
              <Button
                key={w.id}
                variant={windowSel === w.id ? "default" : "outline"}
                size="sm"
                onClick={() => selectWindow(w.id)}
                data-testid={`btn-demos-window-${w.id}`}
                role="tab"
                aria-selected={windowSel === w.id}
              >
                {w.label}
              </Button>
            ))}
          </div>
          <div className="grid grid-cols-2 md:flex gap-1 w-full md:w-auto" role="tablist" aria-label="Leaderboard view">
            {SORTS.filter(s=>!pass || !["top","new"].includes(s.id)).map(s => (
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

      <div className="flex flex-wrap items-center gap-4">
      <label className="flex items-center gap-2 text-sm">
        Search
        <input type="search" value={search} maxLength={120} placeholder="SKU name or App ID"
          onChange={event=>{setSearch(event.target.value);setOffset(0);}}
          className="h-9 w-48 max-w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
          data-testid="input-demos-search" />
      </label>
      <label className="flex items-center gap-2 text-sm">
        Genre
        <select value={genre} onChange={event => {setGenre(event.target.value);setOffset(0);}}
          className="h-9 max-w-[240px] rounded-md border border-input bg-background px-2 text-sm text-foreground"
          data-testid="select-demos-genre">
          <option value="">All genres</option>
          {Array.from(new Set([...(data?.genres ?? []), ...(genre ? [genre] : [])])).map(value => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">Show
        <select value={limit} onChange={event=>{setLimit(Number(event.target.value));setOffset(0);}}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
          data-testid="select-demos-limit">
          {[50,100,250].map(n=><option key={n} value={n}>{n} rows</option>)}
        </select>
      </label>
      </div>

      {data?.coverage && <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
        data-testid="text-demos-catalog-scope">
        {pass ? <>Tracked catalog: {data.coverage.availableCount} available Friend’s Pass SKUs. Discovery pages through Steam’s US/English name searches and verifies each free download offer.
          {" "}Unavailable and unreleased passes, paid games, software and DLC are excluded. Search coverage is not a guarantee of every Steam SKU worldwide.
          {" "}Hybrid clients remain here only; their activity cannot be split into demo play versus owner-hosted co-op.</> : <>
        Tracked catalog: {data.coverage.availableCount} available demos. Lifetime totals retained for {data.coverage.archivedCount} deactivated Saber demos.
        {" "}Top/Trending discovery checks up to {data.coverage.candidateLimitPerFeed} slots each. New Releases starts at that depth and catches up to the prior snapshot, with a {data.coverage.newReleaseCatchUpLimit}-slot safety cap. This is not a complete Steam catalog.
        {" "}Demos deactivated by publishers are not tracked. The only exception is Saber lifetime download actuals, shown in Lifetime and on dashboard cards.
        </>}
      </div>}

      {pass && <PassScenarios />}
      {pass && <FriendsPassReference />}
      {pass && <section className="rounded-md border border-border bg-muted/30 px-3 py-3 text-xs text-muted-foreground"
        aria-label="Pass / Parent Activity controls">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-medium text-foreground">Pass / Parent Activity</span>
          <label className="flex items-center gap-2">Comparison
            <select value={activityWindow} onChange={event => { setActivityWindow(event.target.value as ActivityWindow); setOffset(0); }}
              data-testid="select-pass-activity-window" className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground">
              <option value="latest">Latest paired sample</option>
              <option value="d7">7-day daily samples</option>
              <option value="d30">30-day daily samples</option>
            </select>
          </label>
          <span>Daily refresh · separate from the download window · not conversion</span>
        </div>
        <p className="mt-2 leading-5" data-testid="text-pass-activity-early-caveat">
          <span className="font-medium text-foreground">Early-data caveat:</span>{" "}
          Treat the first ratios as directional until 7-day paired history accumulates.
          Even then, these are sampled activity comparisons, not conversion rates.
        </p>
        <details className="mt-2" data-testid="details-pass-activity-method">
          <summary className="cursor-pointer">How this comparison works</summary>
          <p className="mt-2 leading-5">Pass CCU ÷ parent CCU, using requests launched together with no more than 10 seconds of request/receipt skew.
            Steam can cache responses, so this is a paired observation, not guaranteed simultaneous underlying measurement.
            Parent activity includes all users of that runtime, not verified paying customers. Cross-platform activity is excluded.
            Shared runtimes and unverified parent/runtime mappings are unavailable; hybrids include both demo and pass play.</p>
          <p className="mt-2 leading-5">The latest pair must be within 36 hours; parent CCU must be at least 10.
            Period views use one paired sample per complete UTC day from the 03:00–05:00 Eastern collection slot:
            at least 6 of 7 days or 24 of 30 days. We divide summed pass CCU by summed parent CCU, not average daily ratios.
            These are daily-sampled comparisons, not all-day activity or player-hours. Missing days are not zero.
            Combined activity share = pass ÷ (pass + parent); trend is percentage-point change in the pass/parent ratio
            versus the preceding equal period when both qualify. Safeguards are not a validation of representativeness.</p>
        </details>
      </section>}
      {pass && <details className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
        data-testid="details-pass-player-method">
        <summary className="cursor-pointer">Player estimates: own pass runtime only</summary>
        <p className="mt-2 leading-5">Estimated active players, not downloads or new users: own-pass player-hours divided by
          reviewed, pass-specific mean playtime for the same window. Main-game metrics and review multipliers never enter this calculation.
          Hybrid clients include both demo play and invited co-op. Shared runtimes cannot be separated.</p>
        <p className="mt-2 leading-5">Requires at least {PASS_PLAYER_GATES.minCompleteDays} complete UTC days,
          {" "}{PASS_PLAYER_GATES.minCoveragePercent}% time coverage overall and {PASS_PLAYER_GATES.minDailyCoveragePercent}% every day.
          Gaps longer than {PASS_PLAYER_GATES.maxIntervalMinutes} minutes are not bridged; missing time is not counted as zero activity.
          The selected window ends at 00:00 UTC today, excluding the current partial day.
          Lifetime also requires coverage from the verified release date. Sampling thresholds are safeguards, not proof of model accuracy.
          Missing runtime verification or playtime calibration keeps the estimate unavailable even with sufficient history.</p>
      </details>}

      {data?.coverage.feeds.some(f=>f.error) && <p role="status" className="text-xs text-amber-700 dark:text-amber-400"
        data-testid="text-demos-discovery-warning">
        {data.coverage.feeds.filter(f=>f.error).map(f=>`${f.feed}: ${f.error}`).join(" · ")}
      </p>}

      {data && <nav className="flex flex-wrap items-center justify-between gap-2 text-sm" aria-label="Demo pages">
        <span className="text-xs text-muted-foreground" data-testid="text-demos-page">
          {data.count ? `${data.offset+1}–${data.offset+data.count}` : "0"} of {data.availableCount} matching {noun}
        </span>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={data.offset===0 || isLoading}
            onClick={()=>setOffset(Math.max(0,data.offset-limit))} data-testid="btn-demos-previous">Previous</Button>
          <Button size="sm" variant="outline" disabled={!data.hasMore || isLoading}
            onClick={()=>setOffset(data.offset+limit)} data-testid="btn-demos-next">Next</Button>
        </div>
      </nav>}

      <div className="text-sm space-y-1" data-testid="text-demos-ranking-note">
        <p>{pass ? `Friend’s Pass SKUs ranked by ${sortSel === "activity" ? "Pass / Parent Activity in the separate comparison selector" : sortSel === "downloads" ? "provisional estimated downloads in the selected window" : sortSel === "players" ? "estimated active players from qualified own-App-ID history" : sortSel === "release" ? "their own release date" : sortSel === "reviews" ? "lifetime reviews" : sortSel === "rating" ? "positive review percentage" : sortSel === "peak" ? "peak observed CCU" : "latest sampled CCU"} (${sortDirection === "desc" ? "highest/newest first" : "lowest/oldest first"}).`
          : sortSel === "top"
          ? "Steam's Top Demos order: recent daily active users, not downloads or CCU."
          : sortSel === "new"
          ? "Steam's New Releases order, including demos with no reviews yet."
          : sortSel === "ccu"
          ? `Tracked demos ordered by latest sampled concurrent players (${sortDirection === "desc" ? "highest first" : "lowest first"}).`
          : sortSel === "release"
          ? `Tracked demos ordered by the demo's own release date (${sortDirection === "desc" ? "newest first" : "oldest first"}).`
          : sortSel === "reviews"
          ? `Tracked demos ordered by lifetime reviews (${sortDirection === "desc" ? "highest first" : "lowest first"}).`
          : sortSel === "rating"
          ? `Tracked demos ordered by the demo's own positive Steam review percentage (${sortDirection === "desc" ? "highest first" : "lowest first"}).`
          : sortSel === "peak"
          ? `Tracked demos ordered by peak observed CCU (${sortDirection === "desc" ? "highest first" : "lowest first"}).`
          : `Downloads for the selected window: Saber actuals and non-Saber estimates (${sortDirection === "desc" ? "highest first" : "lowest first"}).`}</p>
        {!sourceView && data && <p className="text-xs text-muted-foreground">Showing {data.count} of {data.availableCount} matching {noun}. Missing values sort last.</p>}
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
          Discovery checks Steam's US/English storefront, with bounded Top/Trending coverage and New Releases catch-up,
          plus Saber's roster, not every demo on Steam. Friends Pass clients have their own separate tab. Software demos and license-category counts are excluded.
          Steam rank gaps reflect filtered or duplicate entries.
          Genre uses broad Steam tags, falling back to parent-game tags when needed.
          Click a KPI or release-date header to sort all matching tracked SKUs; click again to reverse.
          Top Demos and New Releases restore Steam's source order.
          Steam review scores use the SKU's own all-language lifetime histogram,
          never its parent game's reviews. Counts and scores update with the daily collection,
          remain independent of the download window, and may lag the live store.
        </p>
        <ul className="mt-2 space-y-1">
          {data?.coverage.feeds.map(f=><li key={f.feed}>
            {f.feed}: {f.candidateCount} candidates, {f.eligibleCount} eligible; {f.scannedSlots || f.candidateCount} slots scanned.
            {" "}Stop: {f.stopReason ?? "previous-version snapshot"}. Last successful collection: {f.lastSuccessAt ? new Date(f.lastSuccessAt).toLocaleString() : "not yet collected"}.
          </li>)}
        </ul>
        <p className="mt-2" data-testid="text-demos-sampling-note">
          CCU is the latest collected sample, not a live feed. Peak observed CCU is the highest sample recorded
          since tracking began, not a historical all-time peak. Date filters apply to downloads{pass ? " and estimated active players" : ""},
          not Steam's rankings or CCU columns. Release dates belong to the SKU, not its parent game.
        </p>
      </details>

      {data?.multiplier && (
        <details className="text-xs text-muted-foreground bg-muted/40 rounded-md px-3 py-2" data-testid="details-demos-method">
          <summary className="cursor-pointer">{pass ? `Friend’s Pass downloads: provisional ${data.multiplier.nonSaberTrial}× review trial` : `Downloads: Saber actuals · Other demos ${data.multiplier.nonSaberTrial}× trial`}</summary>
          {pass ? <p className="mt-2">Estimates use this pass SKU’s own review additions in the selected window × {data.multiplier.nonSaberTrial}.
            This reuses the demo trial multiplier; it is not calibrated or validated for Friend’s Pass clients.
            Some passes share the paid game’s runtime and have no separate reviews or player-count feed. Missing values stay unavailable, never inherit the paid game’s metrics.
            Hybrid clients combine demo and co-op use. Historical reviews can be backfilled; CCU peaks begin with observed samples, not invented history.
            Passes offered only as licenses on the paid base-game App ID cannot be isolated and are excluded, rather than misrepresenting base-game activity as pass activity.
            Older window boundaries use Steam’s available weekly/monthly review buckets, not invented daily precision.</p> : <p className="mt-2">
          Saber demos use Steamworks “Total Downloads” for their own demo App IDs and selected
          date window. Valve defines this metric as users who recorded playtime or preloaded the demo;
          it excludes parent-game purchase preloads and is not free-license activations.
          Reports refresh daily and may lag; hover an actual for its exact reporting dates.
          Missing Saber actuals never fall back to estimates.
          Non-Saber estimated downloads = reviews added in the selected window × {data.multiplier.nonSaberTrial}.
          This is the user-selected trial, not a newly verified calibration.
          Values marked “≥” are minimums supported by observed concurrent players, not point estimates.
          This safeguard applies only to lifetime or windows covering the demo's entire released lifespan.
          It never treats returning players as new downloads in a shorter window.
          </p>}
        </details>
      )}

      <Card className="overflow-x-auto" role="region" aria-label="Demo leaderboard, scroll horizontally on smaller screens" tabIndex={0}>
        {isLoading && (
          <div className="p-4 space-y-2">
            {Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        )}
        {isError && (
          <div className="p-4 text-sm text-destructive">Failed to load leaderboard: {(error as Error)?.message}</div>
        )}
        {!isLoading && !isError && data && (
          <table className={`w-full ${pass ? "min-w-[1740px]" : "min-w-[1280px]"} table-fixed text-sm`}>
            <colgroup>
              <col style={{ width: pass ? "3%" : "4%" }} />
              <col style={{ width: pass ? "17%" : "23%" }} />
              <col style={{ width: pass ? "10%" : "14%" }} />
              <col style={{ width: pass ? "8%" : "11%" }} />
              <col style={{ width: pass ? "7%" : "8%" }} />
              <col style={{ width: pass ? "8%" : "12%" }} />
              <col style={{ width: pass ? "9%" : "12%" }} />
              {pass && <col style={{ width: "10%" }} />}
              {pass && <col style={{ width: "14%" }} />}
              <col style={{ width: pass ? "7%" : "8%" }} />
              <col style={{ width: pass ? "7%" : "8%" }} />
            </colgroup>
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium w-10">{sourceView ? "Steam rank" : "#"}</th>
                <th className="px-3 py-2 font-medium">{pass ? "Friend’s Pass SKU" : "Demo"}</th>
                <th className="px-3 py-2 font-medium">Genre</th>
                <th className="px-3 py-2 font-medium whitespace-nowrap" aria-sort={sortSel === "release" ? (sortDirection === "desc" ? "descending" : "ascending") : "none"}>{sortLabel("release", pass ? "SKU Released" : "Demo Released")}</th>
                <th className="px-3 py-2 font-medium text-right" aria-sort={sortSel === "reviews" ? (sortDirection === "desc" ? "descending" : "ascending") : "none"}>{sortLabel("reviews", "Reviews (LTD)")}</th>
                <th className="px-3 py-2 font-medium text-right" aria-sort={sortSel === "rating" ? (sortDirection === "desc" ? "descending" : "ascending") : "none"}>{sortLabel("rating", "Steam Reviews")}</th>
                <th className="px-3 py-2 font-medium text-right" aria-sort={sortSel === "downloads" ? (sortDirection === "desc" ? "descending" : "ascending") : "none"}>{sortLabel("downloads", "Downloads (window)")}</th>
                {pass && <th className="px-3 py-2 font-medium text-right" aria-sort={sortSel === "players" ? (sortDirection === "desc" ? "descending" : "ascending") : "none"}>
                  {sortLabel("players", "Est. Players (window)")}
                </th>}
                {pass && <th className="px-3 py-2 font-medium text-right" aria-sort={sortSel === "activity" ? (sortDirection === "desc" ? "descending" : "ascending") : "none"}>
                  {sortLabel("activity", "Pass / Parent Activity")}
                  <span className="block text-xs font-normal">{activityWindow === "latest" ? "Latest paired sample" : activityWindow === "d7" ? "7-day daily samples" : "30-day daily samples"}</span>
                </th>}
                <th className="px-3 py-2 font-medium text-right" aria-sort={sortSel === "ccu" ? (sortDirection === "desc" ? "descending" : "ascending") : "none"}>{sortLabel("ccu", "Latest Sampled CCU")}</th>
                <th className="px-3 py-2 font-medium text-right" aria-sort={sortSel === "peak" ? (sortDirection === "desc" ? "descending" : "ascending") : "none"}>{sortLabel("peak", "Peak Observed CCU")}</th>
              </tr>
            </thead>
            <tbody>
              {data.demos.map((d, i) => (
                <tr key={d.id} className="border-b border-border/50 hover:bg-muted/30" data-testid={`row-demo-${d.steamAppId}`}>
                  <td className="px-3 py-2 text-muted-foreground">{sourceView ? d.sourceRank : data.offset + i + 1}</td>
                  <td className="px-3 py-2">
                    {pass ? <a href={`https://store.steampowered.com/app/${d.steamAppId}`} target="_blank"
                      rel="noreferrer" className="font-medium hover:underline break-words">{d.name}</a>
                      : <Link href={`/demos-leaderboard/${d.steamAppId}`}
                        className="font-medium hover:underline break-words">{d.name}</Link>}
                    {d.isSaberPublished && (
                      <Badge className="ml-2 text-[10px]" variant="secondary" data-testid={`badge-saber-${d.steamAppId}`}>
                        Saber
                      </Badge>
                    )}
                    {d.isArchived && <Badge className="ml-2 text-xs" variant="outline"
                      data-testid={`badge-archived-${d.steamAppId}`}>Deactivated · lifetime only</Badge>}
                    {d.isHybridPass && <Badge className="ml-2 text-xs" variant="outline">Demo + Friend’s Pass</Badge>}
                  </td>
                  <td className="px-3 py-2 text-xs leading-5 text-muted-foreground">{d.genre ?? "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground whitespace-nowrap"
                    title={d.releaseDateUnverified ? "Demo download verified on Steam; conflicting release date not shown." : undefined}>
                    {d.releaseDateUnverified ? <span className="text-xs">Date unverified</span> : formatDate(d.releaseDate)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumberCompact(d.reviewCountTotal)}</td>
                  <td className="px-3 py-2 text-right tabular-nums" data-testid={`reviews-demo-${d.steamAppId}`}>
                    {d.steamReviews?.positivePercent != null ? (
                      <a href={`https://store.steampowered.com/app/${d.steamAppId}/#app_reviews_hash`}
                        target="_blank" rel="noreferrer" className="inline-block hover:underline"
                        aria-label={`${d.name}: ${d.steamReviews.positivePercent.toFixed(1)} percent positive Steam reviews`}
                        title={`${d.steamReviews.positive.toLocaleString()} positive / ${d.steamReviews.negative.toLocaleString()} negative (${d.steamReviews.total.toLocaleString()} total). Own-SKU reviews only; all languages, lifetime; daily snapshot.`}>
                        <span className="font-medium">{d.steamReviews.positivePercent.toFixed(1)}% positive</span>
                        <span className="block text-xs text-muted-foreground">View {pass ? "pass" : "demo"} reviews</span>
                      </a>
                    ) : <span className="text-xs text-muted-foreground">{d.steamReviews?.total === 0 ? "No reviews yet" : "Not available"}</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {d.unitsMid != null ? (
                      d.method === "steamworks_actual" ? (
                        <span title={`Steamworks demo Total Downloads: ${d.unitsMid.toLocaleString()}. Report ${d.actualsStartDate} through ${d.actualsEndDate}; retrieved ${d.actualsAsOf}. Not licenses or parent-game preloads.`}>
                          {formatNumberCompact(d.unitsMid)}
                          <span className="block text-xs text-muted-foreground" data-testid={`badge-confirmed-${d.steamAppId}`}>Steamworks actual</span>
                          {(d.actualsRefreshFailed || d.actualsStale) && <span className="block text-xs text-amber-600 dark:text-amber-400">
                            {d.actualsRefreshFailed ? "Refresh failed" : "Stale snapshot"}
                          </span>}
                        </span>
                      ) : d.isObservedMinimum ? (
                        <span title={`Observed minimum: ${d.unitsMid.toLocaleString()} concurrent players. Review-only estimate: ${d.reviewEstimate == null ? "unavailable" : d.reviewEstimate.toLocaleString()}. Actual downloads may be substantially higher; this is not a calibrated point estimate.`}>
                          ≥{d.unitsMid.toLocaleString()}
                          <span className="block text-[11px] text-muted-foreground">Observed minimum</span>
                        </span>
                      ) : (
                        <span title={`${d.downloadMultiplier} downloads per review added in this window. ${d.calibrationMode === "non_saber_trial" ? "User-selected non-Saber trial; not a verified calibration." : "Provisional Saber benchmark; not confirmed downloads."}`}>
                          {formatNumberCompact(d.unitsMid)}
                          {d.calibrationMode === "non_saber_trial" && <span className="block text-[11px] text-muted-foreground">130× trial</span>}
                        </span>
                      )
                    ) : d.isSaberPublished ? <span className="text-xs text-muted-foreground">Actuals unavailable</span> : "—"}
                    {d.lifetimeModelBelowPeak && !d.isObservedMinimum && (
                      <span className="block text-[11px] text-amber-600 dark:text-amber-400"
                        title="This title's lifetime review estimate is below observed concurrency. This shorter-window estimate remains review-based; lifetime players cannot be counted as new period downloads.">
                        Calibration warning
                      </span>
                    )}
                  </td>
                  {pass && <td className="px-3 py-2 text-right tabular-nums" data-testid={`players-pass-${d.steamAppId}`}>
                    {d.playerEstimate?.players != null ? <span
                      title={`Estimated active players from this pass App ID only, not downloads. ${d.playerEstimate.playerHours?.toLocaleString()} observed player-hours ÷ ${d.playerEstimate.meanHoursPerPlayer} mean hours/player. ${d.playerEstimate.sampleCount.toLocaleString()} samples; ${d.playerEstimate.coveragePercent}% coverage. Period ${d.playerEstimate.periodStart} to ${d.playerEstimate.periodEnd} (exclusive).`}>
                      {formatNumberCompact(d.playerEstimate.players)}
                      <span className="block text-xs text-muted-foreground">Active players · estimated</span>
                    </span> : <span className="text-xs text-muted-foreground"
                      title="Missing evidence is not treated as zero players.">
                      {d.playerEstimate ? PASS_PLAYER_STATUS_LABELS[d.playerEstimate.status] : "Not available"}
                    </span>}
                    {d.playerEstimate && d.playerEstimate.status !== "shared_runtime" &&
                      <span className="block text-xs text-muted-foreground"
                        title={`${d.playerEstimate.sampleCount.toLocaleString()} own-pass observations within the requested complete-day period.`}>
                        {d.playerEstimate.coveragePercent}% coverage
                      </span>}
                  </td>}
                  {pass && <td className="px-3 py-2 align-top" data-testid={`activity-pass-${d.steamAppId}`}>
                    <PassParentActivityCell activity={d.passParentActivity} hybrid={d.isHybridPass} />
                  </td>}
                  <td className="px-3 py-2 text-right tabular-nums" title={d.ccuAsOf ? `Sample collected: ${d.ccuAsOf}` : "No CCU sample collected"}>
                    {formatNumberCompact(d.ccuCurrent)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumberCompact(d.ccuAllTimePeak)}</td>
                </tr>
              ))}
              {data.demos.length === 0 && (
                <tr><td colSpan={pass ? 11 : 9} className="px-3 py-6 text-center text-muted-foreground">
                  {search || genre ? `No ${noun} match these filters.` : sourceView ? "No verified game demos in the latest successful feed snapshot." : `No ${noun} collected yet.`}
                </td></tr>
              )}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
