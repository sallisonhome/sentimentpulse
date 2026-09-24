/**
 * YouTube Pulse — Saber title leaderboard (cohort view).
 *
 * Route: /youtube
 *
 * Default: past 24 hours, ranked by aggregated views, descending.
 * Cohort definition: each window counts videos PUBLISHED in that window and
 * sums their current lifetime views/likes/comments from the YouTube Data API.
 * Short-form, likes % of views and all totals are SignalPulse calculations
 * from YouTube API data, labeled as such.
 */
import { useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { Link } from "wouter";

type WindowKey = "d1" | "d7" | "d30" | "d90" | "m12" | "ltd";
type SortKey = "views" | "videos" | "shortForm" | "comments" | "likes" | "likesPct" | "title";

const WINDOWS: Array<{ id: WindowKey; label: string }> = [
  { id: "d1", label: "24 hours" },
  { id: "d7", label: "7 days" },
  { id: "d30", label: "30 days" },
  { id: "d90", label: "90 days" },
  { id: "m12", label: "12 months" },
  { id: "ltd", label: "Lifetime" },
];

interface TopVideo { videoId: string; title: string; channelTitle: string | null; views: number; publishedAt: string; isShortForm: boolean }
interface Row {
  titleId: number; title: string; steamAppId: string | null; headerImageUrl: string | null; isSaber: boolean; parentTitle: string | null;
  views: number; videos: number; shortForm: number; comments: number; likes: number; likesPct: number | null;
  likesHiddenVideos: number; commentsDisabledVideos: number; topVideo: TopVideo | null;
  statsAsOf: string | null; trackingSince: string | null; backfillComplete: boolean; backfillOldest: string | null; backfillFloor: string;
}
interface LeaderboardResponse {
  definition: "cohort"; window: WindowKey; sort: SortKey; direction: "asc" | "desc"; generatedAt: string;
  apiKeyConfigured: boolean; lastRun: { status: string; finished_at: string | null; message: string | null } | null; rows: Row[];
}
interface VideoRow {
  videoId: string; url: string; title: string; channelTitle: string | null; publishedAt: string; durationS: number | null;
  isShortForm: boolean; views: number | null; likes: number | null; comments: number | null; commentsDisabled: boolean; matchReason: string;
}

const nf = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const fmt = (n: number | null | undefined) => (n == null ? "—" : nf.format(n));
const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
const fmtDuration = (s: number | null) => (s == null ? "—" : s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { const j = await r.json(); if (j?.error) msg = j.error; } catch { /* keep status text */ }
    throw new Error(msg);
  }
  return r.json();
}

interface LookupWindow { views: number; videos: number; shortForm: number; comments: number; likes: number; likesPct: number | null; likesHiddenVideos: number }
interface LookupResult {
  query: string; strict: boolean; searchQuery: string; days: number; createdAt: string; cached: boolean;
  windows: { d1: LookupWindow; d7: LookupWindow; d30: LookupWindow };
  topVideos: Array<{ videoId: string; url: string; title: string; channelTitle: string | null; publishedAt: string; durationS: number | null; isShortForm: boolean; views: number | null; likes: number | null; comments: number | null; matchReason: string }>;
  admitted: number; rejected: number; rejectedSamples: Array<{ videoId: string; title: string; channelTitle: string | null; reason: string }>;
  coverage: { searchPages: number; candidates: number; exhausted: boolean };
  quota: { searchCalls: number; units: number };
  trackedTitle: { titleId: number; title: string } | null;
}

function GameLookup() {
  const [text, setText] = useState("");
  const [strict, setStrict] = useState(false);
  const [req, setReq] = useState<{ q: string; strict: boolean; refresh: boolean; n: number } | null>(null);
  const { data, isFetching, isError, error } = useQuery<LookupResult>({
    queryKey: ["/api/youtube/lookup", req],
    enabled: !!req,
    staleTime: Infinity,
    retry: false,
    queryFn: () => getJson(`api/youtube/lookup?q=${encodeURIComponent(req!.q)}&strict=${req!.strict ? 1 : 0}${req!.refresh ? "&refresh=1" : ""}`),
  });
  const submit = (refresh = false) => {
    const q = text.trim();
    if (q.length < 3) return;
    setReq({ q, strict, refresh, n: Date.now() });
  };
  const cols: Array<{ id: "d1" | "d7" | "d30"; label: string }> = [{ id: "d1", label: "24 hours" }, { id: "d7", label: "7 days" }, { id: "d30", label: "30 days" }];
  const metrics: Array<{ key: keyof LookupWindow; label: string; f: (w: LookupWindow) => string }> = [
    { key: "views", label: "Views", f: (w) => fmt(w.views) },
    { key: "videos", label: "Videos", f: (w) => fmt(w.videos) },
    { key: "shortForm", label: "Short-form (≤3 min)", f: (w) => fmt(w.shortForm) },
    { key: "comments", label: "Comments", f: (w) => fmt(w.comments) },
    { key: "likes", label: "Likes", f: (w) => fmt(w.likes) },
    { key: "likesPct", label: "Likes % of views", f: (w) => (w.likesPct == null ? "—" : `${w.likesPct.toFixed(2)}%`) },
  ];
  return (
    <Card className="p-4 space-y-3" role="region" aria-label="Game lookup" data-testid="card-yt-lookup">
      <div className="flex flex-col md:flex-row md:items-center gap-2">
        <div className="md:mr-2">
          <h2 className="text-sm font-semibold">Look up any game</h2>
          <p className="text-xs text-muted-foreground">One-off, last 30 days, same metrics as the leaderboard. Not added to tracking.</p>
        </div>
        <form className="flex flex-1 flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); submit(false); }}>
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Game name, e.g. Helldivers 2" className="pl-8"
              aria-label="Game name" maxLength={120} data-testid="input-yt-lookup" />
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground" title="Require the Gaming category AND a game word. Use for names shared with films or common words.">
            <Switch checked={strict} onCheckedChange={setStrict} data-testid="switch-yt-lookup-strict" />
            Strict matching
          </label>
          <Button type="submit" size="sm" disabled={text.trim().length < 3 || isFetching} data-testid="btn-yt-lookup">{isFetching ? "Searching…" : "Look up"}</Button>
        </form>
      </div>
      {isError && <p role="alert" className="text-sm text-destructive" data-testid="text-yt-lookup-error">Lookup failed: {(error as Error)?.message}</p>}
      {isFetching && !data && <Skeleton className="h-28 w-full" />}
      {data && (
        <div className="space-y-3" data-testid="result-yt-lookup">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="text-sm font-medium text-foreground">"{data.query}"</span>
            <span>{fmt(data.admitted)} matching videos of {fmt(data.coverage.candidates)} search results{data.strict ? " (strict)" : ""}</span>
            <span>{data.cached ? `Cached from ${new Date(data.createdAt).toLocaleString()}` : `Fetched ${new Date(data.createdAt).toLocaleString()} · ${data.quota.searchCalls} search call(s)`}</span>
            {data.cached && <button type="button" className="underline hover:text-foreground" onClick={() => submit(true)} data-testid="btn-yt-lookup-refresh">Refresh</button>}
            {data.trackedTitle && <span>{data.trackedTitle.title} is already tracked; the leaderboard has its full history.</span>}
          </div>
          {!data.coverage.exhausted && (
            <p className="text-xs text-amber-700 dark:text-amber-400">More search results exist than one lookup reads ({data.coverage.searchPages * 50} max), so these totals are a lower bound.</p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm" data-testid="table-yt-lookup">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Videos published in the last…</th>
                  {cols.map((c) => <th key={c.id} className="px-3 py-2 font-medium text-right">{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {metrics.map((m) => (
                  <tr key={m.key} className="border-b border-border/50">
                    <td className="px-3 py-1.5">{m.label}</td>
                    {cols.map((c) => <td key={c.id} className="px-3 py-1.5 text-right tabular-nums">{m.f(data.windows[c.id])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.topVideos.length > 0 && (
            <details className="text-xs" open>
              <summary className="cursor-pointer py-1 text-muted-foreground">Top videos (30 days)</summary>
              <table className="w-full text-xs mt-1">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="px-3 py-1.5 font-medium">Video</th>
                    <th className="px-3 py-1.5 font-medium">Channel</th>
                    <th className="px-3 py-1.5 font-medium whitespace-nowrap">Published</th>
                    <th className="px-3 py-1.5 font-medium text-right">Views</th>
                    <th className="px-3 py-1.5 font-medium text-right">Likes</th>
                    <th className="px-3 py-1.5 font-medium text-right">Comments</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topVideos.slice(0, 10).map((v) => (
                    <tr key={v.videoId} className="border-t border-border/40">
                      <td className="px-3 py-1.5">
                        <a href={v.url} target="_blank" rel="noreferrer" className="hover:underline break-words" title={`Matched: ${v.matchReason}`}>{v.title}</a>
                        {v.isShortForm && <Badge variant="outline" className="ml-2 text-[10px]">Short-form</Badge>}
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">{v.channelTitle ?? "—"}</td>
                      <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">{fmtDate(v.publishedAt)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmt(v.views)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{v.likes == null ? "Hidden" : fmt(v.likes)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{v.comments == null ? "Off" : fmt(v.comments)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
          {data.rejected > 0 && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer py-1">{fmt(data.rejected)} search results excluded (sample)</summary>
              <ul className="mt-1 space-y-0.5 pl-5 list-disc">
                {data.rejectedSamples.map((r) => <li key={r.videoId}><a className="hover:underline" href={`https://www.youtube.com/watch?v=${r.videoId}`} target="_blank" rel="noreferrer">{r.title}</a> — {r.reason}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}
    </Card>
  );
}

function TitleVideos({ titleId, window }: { titleId: number; window: WindowKey }) {
  const { data, isLoading, isError } = useQuery<{ videos: VideoRow[] }>({
    queryKey: ["/api/youtube/titles", titleId, window],
    queryFn: () => getJson(`api/youtube/titles/${titleId}/videos?window=${window}&limit=25`),
  });
  if (isLoading) return <div className="p-3"><Skeleton className="h-16 w-full" /></div>;
  if (isError || !data) return <p className="p-3 text-sm text-destructive">Could not load videos.</p>;
  if (!data.videos.length) return <p className="p-3 text-sm text-muted-foreground">No tracked videos were published in this window.</p>;
  return (
    <table className="w-full text-xs" data-testid={`table-yt-videos-${titleId}`}>
      <thead>
        <tr className="text-left text-muted-foreground">
          <th className="px-3 py-1.5 font-medium">Video (top 25 by views)</th>
          <th className="px-3 py-1.5 font-medium">Channel</th>
          <th className="px-3 py-1.5 font-medium whitespace-nowrap">Published</th>
          <th className="px-3 py-1.5 font-medium text-right">Length</th>
          <th className="px-3 py-1.5 font-medium text-right">Views</th>
          <th className="px-3 py-1.5 font-medium text-right">Likes</th>
          <th className="px-3 py-1.5 font-medium text-right">Comments</th>
        </tr>
      </thead>
      <tbody>
        {data.videos.map((v) => (
          <tr key={v.videoId} className="border-t border-border/40">
            <td className="px-3 py-1.5">
              <a href={v.url} target="_blank" rel="noreferrer" className="hover:underline break-words" title={`Matched: ${v.matchReason}`}>{v.title}</a>
              {v.isShortForm && <Badge variant="outline" className="ml-2 text-[10px]">Short-form</Badge>}
            </td>
            <td className="px-3 py-1.5 text-muted-foreground">{v.channelTitle ?? "—"}</td>
            <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">{fmtDate(v.publishedAt)}</td>
            <td className="px-3 py-1.5 text-right tabular-nums">{fmtDuration(v.durationS)}</td>
            <td className="px-3 py-1.5 text-right tabular-nums">{fmt(v.views)}</td>
            <td className="px-3 py-1.5 text-right tabular-nums">{v.likes == null ? <span title="Likes hidden by uploader">Hidden</span> : fmt(v.likes)}</td>
            <td className="px-3 py-1.5 text-right tabular-nums">{v.commentsDisabled ? <span title="Comments disabled">Off</span> : fmt(v.comments)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function YoutubeLeaderboard() {
  const [windowSel, setWindowSel] = useState<WindowKey>("d1");
  const [sort, setSort] = useState<SortKey>("views");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const [open, setOpen] = useState<number | null>(null);
  const [scope, setScope] = useState<"saber" | "all">("saber");

  const { data, isLoading, isError, error } = useQuery<LeaderboardResponse>({
    queryKey: ["/api/youtube/leaderboard", windowSel, sort, direction, scope],
    queryFn: () => getJson(`api/youtube/leaderboard?window=${windowSel}&sort=${sort}&direction=${direction}&scope=${scope}`),
  });

  const clickSort = (k: SortKey) => {
    if (sort === k) setDirection(direction === "desc" ? "asc" : "desc");
    else { setSort(k); setDirection(k === "title" ? "asc" : "desc"); }
  };
  const header = (k: SortKey, label: string, right = true) => (
    <th className={`px-3 py-2 font-medium ${right ? "text-right" : ""} whitespace-nowrap`}
      aria-sort={sort === k ? (direction === "desc" ? "descending" : "ascending") : "none"}>
      <button type="button" onClick={() => clickSort(k)} className="hover:text-foreground" data-testid={`btn-yt-sort-${k}`}>
        {label}{sort === k ? (direction === "desc" ? " ↓" : " ↑") : ""}
      </button>
    </th>
  );
  const windowLabel = WINDOWS.find((w) => w.id === windowSel)?.label.toLowerCase();
  const totals = data?.rows.reduce((a, r) => ({ views: a.views + r.views, videos: a.videos + r.videos, shortForm: a.shortForm + r.shortForm }), { views: 0, videos: 0, shortForm: 0 });

  return (
    <div className="p-4 md:p-6 space-y-4" data-testid="page-youtube-leaderboard">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">YouTube Pulse <span className="text-sm font-normal text-muted-foreground">(experimental)</span></h1>
          <p className="text-sm text-muted-foreground">Saber titles ranked by aggregated views of videos published in the selected window.</p>
        </div>
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Time window">
          {WINDOWS.map((w) => (
            <Button key={w.id} size="sm" variant={windowSel === w.id ? "default" : "outline"} role="tab" aria-selected={windowSel === w.id}
              onClick={() => { setWindowSel(w.id); setOpen(null); }} data-testid={`btn-yt-window-${w.id}`}>{w.label}</Button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">View:</span>
        <Badge variant="secondary" data-testid="badge-yt-definition">Cohort: videos published in window</Badge>
        <Badge variant="outline" className="text-muted-foreground" title="Click a title for time series, daily snapshots, velocity and CSV export.">
          Title charts, velocity &amp; CSV: click a title
        </Badge>
        <label className="ml-auto flex items-center gap-2 text-muted-foreground" title="Competitor titles set up under a Saber title in SentimentPulse. Their videos and comments are collected either way.">
          <Switch checked={scope === "all"} onCheckedChange={(v) => { setScope(v ? "all" : "saber"); setOpen(null); }} data-testid="switch-yt-scope" />
          Include competitor titles
        </label>
      </div>

      <GameLookup />

      {data && !data.apiKeyConfigured && (
        <p role="status" className="text-sm text-amber-700 dark:text-amber-400" data-testid="text-yt-no-key">
          The YouTube Data API key is not set. Add it under Settings → API keys; collection starts on the next daily run.
        </p>
      )}
      {data?.lastRun && data.lastRun.status !== "success" && (
        <p role="status" className="text-xs text-amber-700 dark:text-amber-400" data-testid="text-yt-run-warning">
          Last collection: {data.lastRun.status}{data.lastRun.finished_at ? ` at ${new Date(data.lastRun.finished_at).toLocaleString()}` : ""}.
        </p>
      )}

      <Card className="overflow-x-auto" role="region" aria-label="YouTube leaderboard" tabIndex={0}>
        {isLoading && <div className="p-4 space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>}
        {isError && <div className="p-4 text-sm text-destructive">Failed to load leaderboard: {(error as Error)?.message}</div>}
        {!isLoading && !isError && data && (
          <table className="w-full min-w-[1100px] text-sm" data-testid="table-yt-leaderboard">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium w-10">#</th>
                {header("title", "Title", false)}
                {header("views", "Views")}
                {header("videos", "Videos")}
                {header("shortForm", "Short-form (≤3 min)")}
                {header("comments", "Comments")}
                {header("likes", "Likes")}
                {header("likesPct", "Likes % of views")}
                <th className="px-3 py-2 font-medium">Top video</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r, i) => (
                <Fragment key={r.titleId}>
                  <tr className="border-b border-border/50 hover:bg-muted/30" data-testid={`row-yt-${r.titleId}`}>
                    <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                      <button type="button" className="shrink-0 p-1 rounded hover:bg-muted"
                        onClick={() => setOpen(open === r.titleId ? null : r.titleId)} aria-expanded={open === r.titleId}
                        aria-label={`Show videos for ${r.title}`} data-testid={`btn-yt-expand-${r.titleId}`}>
                        {open === r.titleId ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                      </button>
                      <Link href={`/youtube/titles/${r.titleId}`} className="flex items-center gap-2 text-left font-medium hover:underline" data-testid={`link-yt-title-${r.titleId}`}>
                        {r.headerImageUrl && <img src={r.headerImageUrl} alt="" className="h-6 w-[52px] rounded object-cover shrink-0" loading="lazy"
                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }} />}
                        <span className="break-words">{r.title}</span>
                      </Link>
                      </div>
                      {!r.isSaber && (
                        <span className="ml-6 block text-[11px] text-muted-foreground" data-testid={`text-yt-competitor-${r.titleId}`}>
                          Competitor{r.parentTitle ? ` · vs ${r.parentTitle}` : ""}
                        </span>
                      )}
                      {!r.backfillComplete && windowSel !== "d1" && windowSel !== "d7" && (
                        <span className="ml-6 block text-[11px] text-muted-foreground"
                          title={`Historical search has reached ${fmtDate(r.backfillOldest)}; it continues daily back to ${fmtDate(r.backfillFloor)}.`}>
                          {r.backfillOldest ? `Backfill in progress (to ${fmtDate(r.backfillOldest)})` : "Collection starts on the next daily run"}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium" title={fmt(r.views)}>{compact.format(r.views)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt(r.videos)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt(r.shortForm)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt(r.comments)}</td>
                    <td className="px-3 py-2 text-right tabular-nums" title={r.likesHiddenVideos ? `${r.likesHiddenVideos} video(s) hide likes` : undefined}>{fmt(r.likes)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.likesPct == null ? "—" : `${r.likesPct.toFixed(2)}%`}</td>
                    <td className="px-3 py-2 text-xs">
                      {r.topVideo ? (
                        <a href={`https://www.youtube.com/watch?v=${r.topVideo.videoId}`} target="_blank" rel="noreferrer" className="hover:underline line-clamp-2"
                          title={`${r.topVideo.title} · ${r.topVideo.channelTitle ?? ""} · ${fmt(r.topVideo.views)} views`}>
                          {r.topVideo.title}
                          <span className="block text-muted-foreground">{r.topVideo.channelTitle} · {compact.format(r.topVideo.views)} views</span>
                        </a>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                  </tr>
                  {open === r.titleId && (
                    <tr key={`${r.titleId}-videos`} className="border-b border-border/50 bg-muted/20">
                      <td colSpan={9}><TitleVideos titleId={r.titleId} window={windowSel} /></td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {totals && (
        <p className="text-xs text-muted-foreground" data-testid="text-yt-totals">
          {scope === "all" ? "All tracked titles" : "Saber portfolio"}, {windowLabel}: {fmt(totals.views)} views across {fmt(totals.videos)} videos ({fmt(totals.shortForm)} short-form).
        </p>
      )}

      <details className="text-xs text-muted-foreground" data-testid="details-yt-method">
        <summary className="cursor-pointer py-1">How these numbers are built</summary>
        <ul className="mt-2 space-y-1 list-disc pl-5">
          <li>Cohort view: a window includes videos published in that window. Views, likes and comments are each video's current lifetime totals from the YouTube Data API, summed by SignalPulse.</li>
          <li>Videos are found by daily YouTube search for each title and admitted only when a distinctive title phrase appears in the video title; ambiguous names also need the Gaming category and a game-context word. Lifetime covers discovered videos, not every video on YouTube.</li>
          <li>Tracked titles are every active SentimentPulse title, including competitor titles set up under a Saber title, plus every SignalPulse product. Videos, stats and comments are collected for all of them; comments feed SentimentPulse. Competitors are hidden here unless "Include competitor titles" is on.</li>
          <li>Each video counts once. When names overlap (for example MudRunner and Expeditions: A MudRunner Game), the video goes to the more specific title.</li>
          <li>Short-form (≤3 min) is a SignalPulse classification from video length, not YouTube's own Shorts label, which the API does not provide.</li>
          <li>Likes % of views is calculated by SignalPulse from videos with public like counts. Videos that hide likes are left out of that ratio.</li>
          <li>Since 2026-08-24, YouTube counts a view from the first frame of playback.</li>
          <li>Stats refresh once a day{data?.rows[0]?.statsAsOf ? `; oldest stats in this view from ${new Date(data.rows.reduce((m, r) => (r.statsAsOf && (!m || r.statsAsOf < m) ? r.statsAsOf : m), "" as string) || data.rows[0].statsAsOf!).toLocaleString()}` : ""}.</li>
        </ul>
      </details>
    </div>
  );
}
