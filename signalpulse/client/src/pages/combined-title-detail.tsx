import { useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download, RefreshCw } from "lucide-react";
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, Legend } from "recharts";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

// Shared shape — both apps use title_id = primary Steam App ID.
interface TikTokSeriesPoint {
  date: string; publishedVideos: number; collectedComments: number;
  snapshotVideos: number | null; snapshotComments: number | null; snapshotViews: number | null;
  matchedVideos: number | null; netViews: number | null; netComments: number | null;
}
interface TikTokSeries {
  titleId: number; title: string; isSaber: boolean; parentTitle: string | null;
  start: string; end: string; bucket: "day" | "week" | "month"; includeArchived: boolean;
  generatedAt: string; firstSnapshot: string | null; lastSnapshot: string | null;
  retainedVideos: number; archivedVideos: number; retainedComments: number;
  rows: TikTokSeriesPoint[];
}
interface YoutubeSeriesPoint {
  date: string; endDate: string; publishedVideos: number; collectedComments: number;
  snapshotVideos: number | null; snapshotComments: number | null; snapshotViews: number | null;
  netViews: number | null; netComments: number | null;
}
interface YoutubeSeries {
  titleId: number; title: string; isSaber: boolean; parentTitle: string | null;
  start: string; end: string; bucket: "day" | "week" | "month"; includeArchived: boolean;
  generatedAt: string; firstSnapshot: string | null; lastSnapshot: string | null;
  retainedVideos: number; archivedVideos: number; retainedComments: number;
  rows: YoutubeSeriesPoint[];
}

const day = 86400000;
const today = () => new Date().toISOString().slice(0, 10);
const before = (days: number) => new Date(Date.parse(today()) - (days - 1) * day).toISOString().slice(0, 10);
const format = (n: number | null | undefined) => n == null ? "Not observed" : n.toLocaleString("en-US");
type Mode = "combined" | "youtube" | "tiktok" | "activity" | "velocity";
const MODES: Array<{ key: Mode; label: string }> = [
  { key: "combined", label: "Combined views (stacked)" },
  { key: "youtube", label: "YouTube views" },
  { key: "tiktok", label: "TikTok views" },
  { key: "activity", label: "Publication & comments" },
  { key: "velocity", label: "Velocity" },
];

const YOUTUBE_COLOR = "#38a8c9";
const TIKTOK_COLOR = "#7c3aed";

function SourceHistoryChart({ rows, metric, title, note, color, bars = false, featured = false, source }: {
  rows: (TikTokSeriesPoint | YoutubeSeriesPoint)[]; metric: string; title: string; note: string; color: string; bars?: boolean; featured?: boolean; source?: "youtube" | "tiktok";
}) {
  const observations = rows.filter((r: any) => typeof r[metric] === "number");
  const latest = observations.at(-1) as any;
  const Chart = bars ? BarChart : LineChart;
  return <Card className="p-4 min-w-0" aria-label={title}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <h2 className={featured ? "text-base font-semibold" : "text-sm font-semibold"}>{title}</h2>
      {featured && <div className="sm:text-right">
        <p className="text-2xl font-semibold tabular-nums" data-testid={source === "youtube" ? "youtube-daily-views" : "tiktok-daily-views"}>{format(latest?.[metric])}</p>
        <p className="text-xs text-muted-foreground">{latest
          ? `Latest measured period · ${latest.date}${latest.endDate && latest.endDate !== latest.date ? ` to ${latest.endDate}` : ""} (UTC)`
          : "No daily view changes measured in this range"}</p>
      </div>}
    </div>
    <p className="text-xs text-muted-foreground mt-1 min-h-8">{note}</p>
    {featured && observations.length === 1 && <p className="text-xs text-muted-foreground mt-2" role="status">One observed point in this range. A trend will appear as more daily snapshots accumulate.</p>}
    {!observations.length ? <div className="h-60 flex items-center justify-center text-sm text-muted-foreground text-center px-4">
      {featured ? "Daily views need snapshots of the same videos on consecutive UTC dates. First observations and missing days are not zero." : "No comparable observations in this range. Missing history is not zero."}
    </div> : <div className={`${featured ? "h-72 sm:h-80" : "h-60"} mt-3`} data-testid={`chart-${source ?? "combined"}-${metric}`}>
      <ResponsiveContainer width="100%" height="100%">
        <Chart data={rows as any} margin={{ top: 8, right: 12, bottom: 6, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.15} vertical={false} />
          <XAxis dataKey="date" padding={{ left: 8, right: 18 }} tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} minTickGap={35} tickFormatter={(d: string) => d.slice(5)} />
          <YAxis width={54} tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} tickFormatter={(n: number) => Intl.NumberFormat("en", { notation: "compact" }).format(n)} allowDecimals={false} />
          <Tooltip labelFormatter={(d: string, payload: any) => payload?.[0]?.payload?.endDate && payload[0].payload.endDate !== d
            ? `${d} to ${payload[0].payload.endDate} (UTC)` : `${d} (UTC)`}
            formatter={(v: number) => [format(v), title]}
            contentStyle={{ background: "hsl(var(--card))", borderColor: "hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
          {bars ? <Bar dataKey={metric} fill={color} maxBarSize={28} isAnimationActive={false} />
            : <Line type="linear" dataKey={metric} stroke={color} strokeWidth={2} connectNulls={false}
              dot={{ r: featured && observations.length === 1 ? 5 : 2 }} activeDot={{ r: 4 }} isAnimationActive={false} />}
        </Chart>
      </ResponsiveContainer>
    </div>}
  </Card>;
}

function CombinedStackedChart({ youtubeRows, tiktokRows, viewsLabel }: {
  youtubeRows: YoutubeSeriesPoint[]; tiktokRows: TikTokSeriesPoint[]; viewsLabel: string;
}) {
  const byDate = new Map<string, { date: string; youtube: number | null; tiktok: number | null }>();
  for (const r of youtubeRows) byDate.set(r.date, { date: r.date, youtube: typeof r.netViews === "number" ? r.netViews : null, tiktok: null });
  for (const r of tiktokRows) {
    const existing = byDate.get(r.date);
    if (existing) existing.tiktok = typeof r.netViews === "number" ? r.netViews : null;
    else byDate.set(r.date, { date: r.date, youtube: null, tiktok: typeof r.netViews === "number" ? r.netViews : null });
  }
  const rows = Array.from(byDate.values()).sort((a, b) => a.date < b.date ? -1 : 1);
  const hasData = rows.some(r => (r.youtube ?? 0) > 0 || (r.tiktok ?? 0) > 0);
  const total = rows.reduce((n, r) => n + (r.youtube ?? 0) + (r.tiktok ?? 0), 0);
  const yTotal = rows.reduce((n, r) => n + (r.youtube ?? 0), 0);
  const tTotal = rows.reduce((n, r) => n + (r.tiktok ?? 0), 0);
  return <Card className="p-4 min-w-0" aria-label={`${viewsLabel} across YouTube and TikTok`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <h2 className="text-base font-semibold">{viewsLabel} — combined, by source</h2>
      <div className="sm:text-right">
        <p className="text-2xl font-semibold tabular-nums" data-testid="combined-total-views">{format(total)}</p>
        <p className="text-xs text-muted-foreground">YouTube {format(yTotal)} · TikTok {format(tTotal)} across the applied range</p>
      </div>
    </div>
    <p className="text-xs text-muted-foreground mt-1 min-h-8">
      Same-video view gains from daily snapshots, stacked so you can see where activation lands. YouTube bars show the week/month's net view gain; TikTok bars likewise. A missing source on a day leaves that stack shorter, not zero — it means no comparable snapshot existed for that source.
    </p>
    {!hasData ? <div className="h-72 sm:h-80 flex items-center justify-center text-sm text-muted-foreground text-center px-4" role="status">
      No comparable daily view observations in this range. Missing history is not zero.
    </div> : <div className="h-72 sm:h-80 mt-3" data-testid="chart-combined-netViews">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 6, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.15} vertical={false} />
          <XAxis dataKey="date" padding={{ left: 8, right: 18 }} tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} minTickGap={35} tickFormatter={(d: string) => d.slice(5)} />
          <YAxis width={54} tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} tickFormatter={(n: number) => Intl.NumberFormat("en", { notation: "compact" }).format(n)} allowDecimals={false} />
          <Tooltip labelFormatter={(d: string) => `${d} (UTC)`}
            formatter={(v: number, name: string) => [format(v), name === "youtube" ? "YouTube" : "TikTok"]}
            contentStyle={{ background: "hsl(var(--card))", borderColor: "hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
          <Legend formatter={(v: string) => v === "youtube" ? "YouTube" : "TikTok"}
            wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="youtube" stackId="views" fill={YOUTUBE_COLOR} maxBarSize={28} isAnimationActive={false} />
          <Bar dataKey="tiktok" stackId="views" fill={TIKTOK_COLOR} maxBarSize={28} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>}
  </Card>;
}

function csvOf(titleId: number, start: string, end: string, bucket: string, youtube: YoutubeSeries | undefined, tiktok: TikTokSeries | undefined): string {
  const head = ["date", "youtube_netViews", "tiktok_netViews", "youtube_publishedVideos", "tiktok_publishedVideos", "youtube_collectedComments", "tiktok_collectedComments"];
  const rows = new Map<string, any>();
  for (const r of youtube?.rows ?? []) rows.set(r.date, { date: r.date, y: r.netViews, yp: r.publishedVideos, yc: r.collectedComments });
  for (const r of tiktok?.rows ?? []) {
    const existing = rows.get(r.date) ?? { date: r.date, y: null, yp: 0, yc: 0 };
    existing.t = r.netViews; existing.tp = r.publishedVideos; existing.tc = r.collectedComments;
    rows.set(r.date, existing);
  }
  const lines = [head.join(",")];
  for (const [date, r] of Array.from(rows.entries()).sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    lines.push([date, r.y ?? "", r.t ?? "", r.yp ?? "", r.tp ?? 0, r.yc ?? "", r.tc ?? 0].join(","));
  }
  return lines.join("\n") + "\n";
}

async function fetchSeries(path: string, range: { start: string; end: string; bucket: string; includeArchived: boolean }) {
  const params = new URLSearchParams({ start: range.start, end: range.end, bucket: range.bucket, includeArchived: range.includeArchived ? "1" : "0" });
  const response = await fetch(`api/${path}?${params}`, { credentials: "include" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Could not load ${path}`);
  return result;
}

export default function CombinedTitleDetail() {
  const { titleId } = useParams<{ titleId: string }>();
  const [range, setRange] = useState({ start: before(30), end: today(), bucket: "day", includeArchived: false });
  const [draft, setDraft] = useState(range);
  const [mode, setMode] = useState<Mode>("combined");
  const [validation, setValidation] = useState("");

  const youtube = useQuery<YoutubeSeries>({
    queryKey: ["/api/youtube/titles", titleId, "timeseries", range],
    retry: false,
    queryFn: () => fetchSeries(`youtube/titles/${titleId}/timeseries`, range),
  });
  const tiktok = useQuery<TikTokSeries>({
    queryKey: ["/api/tiktok/titles", titleId, "timeseries", range],
    retry: false,
    queryFn: () => fetchSeries(`tiktok/titles/${titleId}/timeseries`, range),
  });

  const preset = (days: number) => {
    const next = { ...range, start: before(days), end: today() };
    setDraft(next); setRange(next); setValidation("");
  };
  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.start || !draft.end || draft.start > draft.end || draft.end > today()) {
      setValidation("Select a valid start and end date, ending no later than today."); return;
    }
    setValidation(""); setRange({ ...draft });
  };
  const download = () => {
    if (!youtube.data && !tiktok.data) return;
    const url = URL.createObjectURL(new Blob([csvOf(Number(titleId), range.start, range.end, range.bucket, youtube.data, tiktok.data)], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `combined-${titleId}-${range.start}-${range.end}-${range.bucket}.csv`;
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(range);
  const title = youtube.data?.title ?? tiktok.data?.title;
  const isSaber = youtube.data?.isSaber ?? tiktok.data?.isSaber;
  const parentTitle = youtube.data?.parentTitle ?? tiktok.data?.parentTitle;
  const viewsLabel = range.bucket === "week" ? "Weekly views" : range.bucket === "month" ? "Monthly views" : "Daily views";
  const isFetching = youtube.isFetching || tiktok.isFetching;
  const error = (youtube.error as Error) && (tiktok.error as Error) ? (youtube.error as Error) : null;

  return <div className="p-4 md:p-6 space-y-4 min-w-0 max-w-[1600px] mx-auto" data-testid="page-combined-title">
    <Link href="/youtube" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-3.5 w-3.5" />YouTube Pulse
    </Link>
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">{title ?? "YouTube + TikTok title history"}</h1>
          {isSaber != null && <Badge variant="outline" className="text-foreground">{isSaber ? "Saber title" : "Competitor"}</Badge>}
        </div>
        <p className="text-sm text-muted-foreground mt-1">Daily views, video coverage and comment volume over time{parentTitle ? ` · compared with ${parentTitle}` : ""}. YouTube and TikTok side by side.</p>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={isFetching} onClick={() => { youtube.refetch(); tiktok.refetch(); }} aria-label="Refresh history"><RefreshCw className="h-4 w-4" /></Button>
        <Button size="sm" onClick={download} disabled={(!youtube.data && !tiktok.data) || isFetching || dirty || !!(youtube.error && tiktok.error)} data-testid="download-combined-csv"><Download className="h-4 w-4 mr-2" />Download CSV</Button>
      </div>
    </header>

    <Card className="p-4 space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-xs text-muted-foreground mr-1">Date range</span>
        {[7, 30, 90, 365].map(days => <Button key={days} size="sm" variant={range.start === before(days) && range.end === today() ? "secondary" : "outline"} onClick={() => preset(days)}>
          {days === 365 ? "12 months" : `${days} days`}
        </Button>)}
      </div>
      <form onSubmit={apply} className="flex flex-wrap gap-3 items-end">
        <label className="text-xs space-y-1">Start date (UTC)<Input type="date" aria-label="Start date" value={draft.start} max={today()} required onChange={e => setDraft({ ...draft, start: e.target.value })} className="w-40 [color-scheme:light] dark:[color-scheme:dark]" /></label>
        <label className="text-xs space-y-1">End date (UTC)<Input type="date" aria-label="End date" value={draft.end} max={today()} required onChange={e => setDraft({ ...draft, end: e.target.value })} className="w-40 [color-scheme:light] dark:[color-scheme:dark]" /></label>
        <label className="text-xs space-y-1">Group by<select aria-label="Group by" className="block h-9 rounded-md border border-input bg-background px-3 text-sm" value={draft.bucket} onChange={e => setDraft({ ...draft, bucket: e.target.value as any })}>
          <option value="day">Day</option><option value="week">Week</option><option value="month">Month</option>
        </select></label>
        <label className="flex items-center gap-2 text-xs h-9"><input type="checkbox" checked={draft.includeArchived} onChange={e => setDraft({ ...draft, includeArchived: e.target.checked })} />Include archived / excluded</label>
        <Button type="submit" size="sm" disabled={isFetching}>Apply range</Button>
      </form>
      {dirty && <p className="text-xs text-amber-700 dark:text-amber-400">Apply the edited range before downloading. Charts still show the last applied range.</p>}
      {validation && <p role="alert" className="text-sm text-destructive">{validation}</p>}
    </Card>

    {(youtube.error || tiktok.error) && <p role="status" className="text-xs text-muted-foreground">
      {youtube.error ? `YouTube: ${(youtube.error as Error).message} ` : ""}
      {tiktok.error ? `TikTok: ${(tiktok.error as Error).message}` : ""}
    </p>}

    {youtube.isLoading && tiktok.isLoading && <Skeleton className="h-80 w-full" />}

    <div className="flex flex-wrap gap-2" role="tablist" aria-label="Time series measure">
      {MODES.map(m => <Button key={m.key} role="tab" aria-selected={mode === m.key} variant={mode === m.key ? "default" : "outline"} size="sm" onClick={() => setMode(m.key)}>{m.label}</Button>)}
    </div>

    {(youtube.data || tiktok.data) && <div className="grid gap-4">
      {mode === "combined" && <CombinedStackedChart
        youtubeRows={youtube.data?.rows ?? []} tiktokRows={tiktok.data?.rows ?? []} viewsLabel={viewsLabel} />}

      {mode === "youtube" && youtube.data && <SourceHistoryChart rows={youtube.data.rows} metric="netViews" title={`${viewsLabel} over time`}
        note="Net views gained between consecutive UTC daily snapshots of the same YouTube videos, not lifetime totals. Newly discovered videos count only after a comparable prior snapshot exists. Weekly/monthly bars sum daily changes; a missing daily comparison leaves the period blank. Negative corrections are preserved."
        color={YOUTUBE_COLOR} featured bars source="youtube" />}
      {mode === "youtube" && !youtube.data && <p role="status" className="text-sm text-muted-foreground">No YouTube series for this title in the applied range.</p>}

      {mode === "tiktok" && tiktok.data && <SourceHistoryChart rows={tiktok.data.rows} metric="netViews" title={`${viewsLabel} over time`}
        note="View gains from recorded daily snapshots of the same TikTok videos. Newly discovered videos need a comparable earlier observation. Negative platform corrections remain negative."
        color={TIKTOK_COLOR} featured bars source="tiktok" />}
      {mode === "tiktok" && !tiktok.data && <p role="status" className="text-sm text-muted-foreground">No TikTok series for this title in the applied range.</p>}

      {mode === "activity" && <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <SourceHistoryChart rows={youtube.data?.rows ?? []} metric="publishedVideos" title="YouTube videos published" note="Discovered videos by original publication date. Historical discovery can add to past buckets." color={YOUTUBE_COLOR} bars source="youtube" />
        <SourceHistoryChart rows={tiktok.data?.rows ?? []} metric="publishedVideos" title="TikTok videos published" note="Videos discovered (by publication date) in the period. Discovery lag can revise earlier dates." color={TIKTOK_COLOR} bars source="tiktok" />
        <SourceHistoryChart rows={youtube.data?.rows ?? []} metric="collectedComments" title="YouTube collected comment volume" note="Stored top-level comments and replies by original publication date. Partial collection, not every YouTube comment." color={YOUTUBE_COLOR} bars source="youtube" />
        <SourceHistoryChart rows={tiktok.data?.rows ?? []} metric="collectedComments" title="TikTok collected comments" note="Comments collected per period by their publication date. A collected comment is not a new comment row." color={TIKTOK_COLOR} bars source="tiktok" />
      </div>}

      {mode === "velocity" && <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <SourceHistoryChart rows={youtube.data?.rows ?? []} metric="netComments" title="YouTube net comments change" note="Net change in API counts, not newly authored comments. A bucket with a missing daily comparison is blank." color={YOUTUBE_COLOR} bars source="youtube" />
        <SourceHistoryChart rows={tiktok.data?.rows ?? []} metric="netComments" title="TikTok net comments change" note="Net change in API counts, not newly authored comments. A bucket with a missing daily comparison is blank." color={TIKTOK_COLOR} bars source="tiktok" />
      </div>}
    </div>}

    <p className="text-xs text-muted-foreground">
      Coverage is limited to discovered videos on each platform. A source with no snapshots in a range shows "Not observed", not zero.
      Snapshot gaps are not filled or interpolated. Weekly buckets start Monday; edge buckets include only selected dates.
      The combined chart requires comparable daily snapshots on both platforms; a day with only one source contributes only that source's bar height.
    </p>
  </div>;
}
