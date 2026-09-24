import { useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download, RefreshCw } from "lucide-react";
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip } from "recharts";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { youtubeSeriesCsv, type YoutubeSeries, type YoutubeSeriesPoint, type YoutubeBucket } from "../../../shared/youtube-series";

const day = 86400000;
const today = () => new Date().toISOString().slice(0, 10);
const before = (days: number) => new Date(Date.parse(today()) - (days - 1) * day).toISOString().slice(0, 10);
const format = (n: number | null | undefined) => n == null ? "Not observed" : n.toLocaleString("en-US");
type Mode = "activity" | "snapshots" | "velocity";
const MODES: Array<{ key: Mode; label: string }> = [
  { key: "activity", label: "Publication & comments" },
  { key: "snapshots", label: "Daily snapshots" },
  { key: "velocity", label: "Velocity" },
];

function HistoryChart({ rows, metric, title, note, color, bars = false }: {
  rows: YoutubeSeriesPoint[]; metric: keyof YoutubeSeriesPoint; title: string; note: string; color: string; bars?: boolean;
}) {
  const observed = rows.some(r => typeof r[metric] === "number");
  const Chart = bars ? BarChart : LineChart;
  return <Card className="p-4 min-w-0" aria-label={title}>
    <h2 className="text-sm font-semibold">{title}</h2>
    <p className="text-xs text-muted-foreground mt-1 min-h-8">{note}</p>
    {!observed ? <div className="h-60 flex items-center justify-center text-sm text-muted-foreground text-center px-4">
      No comparable observations in this range. Missing history is not zero.
    </div> : <div className="h-60 mt-3" data-testid={`chart-${metric}`}>
      <ResponsiveContainer width="100%" height="100%">
        <Chart data={rows} margin={{ top: 8, right: 12, bottom: 6, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.15} vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} minTickGap={35} tickFormatter={d => d.slice(5)} />
          <YAxis width={54} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickFormatter={n => Intl.NumberFormat("en", { notation: "compact" }).format(n)} allowDecimals={false} />
          <Tooltip labelFormatter={d => `${d} (UTC)`} formatter={(v: number) => [format(v), title]}
            contentStyle={{ background: "hsl(var(--card))", borderColor: "hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
          {bars ? <Bar dataKey={metric} fill={color} maxBarSize={28} isAnimationActive={false} />
            : <Line type="linear" dataKey={metric} stroke={color} strokeWidth={2} connectNulls={false}
              dot={{ r: 2 }} activeDot={{ r: 4 }} isAnimationActive={false} />}
        </Chart>
      </ResponsiveContainer>
    </div>}
  </Card>;
}

export default function YoutubeTitleDetail() {
  const { titleId } = useParams<{ titleId: string }>();
  const [range, setRange] = useState({ start: before(30), end: today(), bucket: "day" as YoutubeBucket, includeArchived: false });
  const [draft, setDraft] = useState(range);
  const [mode, setMode] = useState<Mode>("activity");
  const [validation, setValidation] = useState("");
  const { data, isFetching, error, refetch } = useQuery<YoutubeSeries>({
    queryKey: ["/api/youtube/titles", titleId, "timeseries", range],
    retry: false,
    queryFn: async () => {
      const params = new URLSearchParams({ start: range.start, end: range.end, bucket: range.bucket, includeArchived: range.includeArchived ? "1" : "0" });
      const response = await fetch(`api/youtube/titles/${titleId}/timeseries?${params}`, { credentials: "include" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not load title history");
      return result;
    },
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
    if (!data) return;
    const url = URL.createObjectURL(new Blob([youtubeSeriesCsv(data)], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `youtube-${data.titleId}-${data.start}-${data.end}-${data.bucket}.csv`;
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(range);
  const sum = (key: "publishedVideos" | "collectedComments") => data?.rows.reduce((n, r) => n + r[key], 0);
  const last = data?.rows[data.rows.length - 1];
  return <div className="p-4 md:p-6 space-y-4 max-w-[1600px] mx-auto" data-testid="page-youtube-title">
    <Link href="/youtube" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-3.5 w-3.5" />YouTube Pulse
    </Link>
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">{data?.title ?? "YouTube title history"}</h1>
          {data && <Badge variant="outline" className="text-foreground">{data.isSaber ? "Saber title" : "Competitor"}</Badge>}
        </div>
        <p className="text-sm text-muted-foreground mt-1">Video coverage and comment volume over time{data?.parentTitle ? ` · compared with ${data.parentTitle}` : ""}.</p>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={isFetching} onClick={() => refetch()} aria-label="Refresh history"><RefreshCw className="h-4 w-4" /></Button>
        <Button size="sm" onClick={download} disabled={!data || isFetching || dirty || !!error} data-testid="download-youtube-csv"><Download className="h-4 w-4 mr-2" />Download CSV</Button>
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
        <label className="text-xs space-y-1">Group by<select aria-label="Group by" className="block h-9 rounded-md border border-input bg-background px-3 text-sm" value={draft.bucket} onChange={e => setDraft({ ...draft, bucket: e.target.value as YoutubeBucket })}>
          <option value="day">Day</option><option value="week">Week</option><option value="month">Month</option>
        </select></label>
        <label className="flex items-center gap-2 text-xs h-9"><input type="checkbox" checked={draft.includeArchived} onChange={e => setDraft({ ...draft, includeArchived: e.target.checked })} />Include archived / excluded</label>
        <Button type="submit" size="sm" disabled={isFetching}>Apply range</Button>
      </form>
      {dirty && <p className="text-xs text-amber-700 dark:text-amber-400">Apply the edited range before downloading. Charts still show the last applied range.</p>}
      {validation && <p role="alert" className="text-sm text-destructive">{validation}</p>}
    </Card>
    {error && <p role="alert" className="text-sm text-destructive">{(error as Error).message}</p>}
    {isFetching && !data && <Skeleton className="h-80 w-full" />}
    {data && <>
      <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
        <span data-testid="youtube-applied-range">{data.start} through {data.end} · {data.bucket} buckets · UTC · {data.includeArchived ? "Includes archived records" : "Currently relevant videos only"}</span>
        <span>{data.firstSnapshot ? `Snapshots observed ${data.firstSnapshot} to ${data.lastSnapshot}` : "Daily snapshots have not started"}</span>
      </div>
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        {[
          ["Videos published in range", sum("publishedVideos")],
          ["Collected comments authored in range", sum("collectedComments")],
          ["Videos observed on range end", last?.snapshotVideos],
          ["API comment total on range end", last?.snapshotComments],
        ].map(([label, value]) => <Card key={String(label)} className="p-4">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="mt-2 text-xl font-semibold tabular-nums">{format(value as number | null)}</p>
        </Card>)}
      </div>
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Time series measure">
        {MODES.map(m => <Button key={m.key} role="tab" aria-selected={mode === m.key} variant={mode === m.key ? "default" : "outline"} size="sm" onClick={() => setMode(m.key)}>{m.label}</Button>)}
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {mode === "activity" ? <>
          <HistoryChart rows={data.rows} metric="publishedVideos" title="Videos published" note="Discovered videos by original publication date. Historical discovery can add to past buckets." color="#38a8c9" bars />
          <HistoryChart rows={data.rows} metric="collectedComments" title="Collected comment volume" note="Stored top-level comments and replies by original publication date. Partial collection, not every YouTube comment." color="#e7665c" bars />
        </> : mode === "snapshots" ? <>
          <HistoryChart rows={data.rows} metric="snapshotVideos" title="Videos observed" note="Number of videos with a snapshot on the bucket's final date. Not cumulative publications." color="#38a8c9" />
          <HistoryChart rows={data.rows} metric="snapshotComments" title="YouTube API comment total" note="Lifetime comment counts reported for those videos on the bucket's final date. Missing counts excluded." color="#e7665c" />
          <HistoryChart rows={data.rows} metric="snapshotViews" title="YouTube API view total" note="Lifetime views on the bucket's final date. Changes in video coverage affect this total." color="#9c88db" />
        </> : <>
          <HistoryChart rows={data.rows} metric="netViews" title="Net views change" note="Same-video changes between consecutive daily snapshots. No inferred baselines; negative corrections preserved." color="#38a8c9" bars />
          <HistoryChart rows={data.rows} metric="netComments" title="Net comments change" note="Net change in API counts, not newly authored comments. A bucket with a missing daily comparison is blank." color="#e7665c" bars />
        </>}
      </div>
      <p className="text-xs text-muted-foreground">
        Coverage is limited to discovered videos. Publication/comment counts are known records, not proof of complete coverage.
        Snapshot gaps are not filled or interpolated. Weekly buckets start Monday; edge buckets include only selected dates.
        Historical views use current relevance unless archived records are included. CSV exports all three measures for this exact applied range.
        Records have no automatic age-based purge: {format(data.retainedVideos)} videos ({format(data.archivedVideos)} archived) and {format(data.retainedComments)} comments retained.
      </p>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground py-2">View exact data ({data.rows.length} rows)</summary>
        <div className="overflow-x-auto max-h-96 border rounded-md">
          <table className="w-full min-w-[780px] text-xs" data-testid="youtube-series-table"><thead className="bg-muted"><tr>
            {["Period start", "Period end", "Published videos", "Collected comments", "Observed videos", "API comments", "Net views", "Net comments"].map(h => <th key={h} className="p-2 text-left whitespace-nowrap">{h}</th>)}
          </tr></thead><tbody>{data.rows.map(r => <tr key={r.date} className="border-t border-border/50">
            {[r.date, r.endDate, r.publishedVideos, r.collectedComments, r.snapshotVideos, r.snapshotComments, r.netViews, r.netComments].map((v, i) => <td key={i} className="p-2 tabular-nums whitespace-nowrap">{typeof v === "string" ? v : format(v)}</td>)}
          </tr>)}</tbody></table>
        </div>
      </details>
    </>}
  </div>;
}
