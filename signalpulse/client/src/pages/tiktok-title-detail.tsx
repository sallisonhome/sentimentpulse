import { useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download, RefreshCw } from "lucide-react";
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip } from "recharts";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

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

function HistoryChart({ rows, metric, title, note, color, bars = false, featured = false }: {
  rows: TikTokSeriesPoint[]; metric: keyof TikTokSeriesPoint; title: string; note: string; color: string; bars?: boolean; featured?: boolean;
}) {
  const observations = rows.filter(r => typeof r[metric] === "number");
  const latest = observations.at(-1);
  const Chart = bars ? BarChart : LineChart;
  return <Card className="p-4 min-w-0" aria-label={title}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <h2 className={featured ? "text-base font-semibold" : "text-sm font-semibold"}>{title}</h2>
      {featured && <div className="sm:text-right">
        <p className="text-2xl font-semibold tabular-nums" data-testid="tiktok-daily-views">{format(latest?.[metric] as number | undefined)}</p>
        <p className="text-xs text-muted-foreground">{latest
          ? `Latest measured period · ${latest.date} (UTC)`
          : "No daily view changes measured in this range"}</p>
      </div>}
    </div>
    <p className="text-xs text-muted-foreground mt-1 min-h-8">{note}</p>
    {featured && observations.length === 1 && <p className="text-xs text-muted-foreground mt-2" role="status">One observed point in this range. A trend will appear as more daily snapshots accumulate.</p>}
    {!observations.length ? <div className="h-60 flex items-center justify-center text-sm text-muted-foreground text-center px-4">
      {featured ? "Daily views need snapshots of the same videos on consecutive UTC dates. First observations and missing days are not zero." : "No comparable observations in this range. Missing history is not zero."}
    </div> : <div className={`${featured ? "h-72 sm:h-80" : "h-60"} mt-3`} data-testid={`chart-${metric}`}>
      <ResponsiveContainer width="100%" height="100%">
        <Chart data={rows} margin={{ top: 8, right: 12, bottom: 6, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.15} vertical={false} />
          <XAxis dataKey="date" padding={{ left: 8, right: 18 }} tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} minTickGap={35} tickFormatter={d => d.slice(5)} />
          <YAxis width={54} tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} tickFormatter={n => Intl.NumberFormat("en", { notation: "compact" }).format(n)} allowDecimals={false} />
          <Tooltip labelFormatter={(d: string) => `${d} (UTC)`} formatter={(v: number) => [format(v), title]}
            contentStyle={{ background: "hsl(var(--card))", borderColor: "hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
          {bars ? <Bar dataKey={String(metric)} fill={color} maxBarSize={28} isAnimationActive={false} />
            : <Line type="linear" dataKey={String(metric)} stroke={color} strokeWidth={2} connectNulls={false}
              dot={{ r: featured && observations.length === 1 ? 5 : 2 }} activeDot={{ r: 4 }} isAnimationActive={false} />}
        </Chart>
      </ResponsiveContainer>
    </div>}
  </Card>;
}

function csvOf(data: TikTokSeries): string {
  const head = ["date", "publishedVideos", "collectedComments", "snapshotVideos", "snapshotComments", "snapshotViews", "matchedVideos", "netViews", "netComments"];
  const lines = [head.join(",")];
  for (const r of data.rows) {
    lines.push([r.date, r.publishedVideos, r.collectedComments, r.snapshotVideos ?? "", r.snapshotComments ?? "",
      r.snapshotViews ?? "", r.matchedVideos ?? "", r.netViews ?? "", r.netComments ?? ""].join(","));
  }
  return lines.join("\n") + "\n";
}

export default function TikTokTitleDetail() {
  const { titleId } = useParams<{ titleId: string }>();
  const [range, setRange] = useState({ start: before(30), end: today(), bucket: "day", includeArchived: false });
  const [draft, setDraft] = useState(range);
  const [mode, setMode] = useState<Mode>("activity");
  const { data, isFetching, error, refetch } = useQuery<TikTokSeries>({
    queryKey: ["/api/tiktok/titles", titleId, "timeseries", range],
    retry: false,
    queryFn: async () => {
      const params = new URLSearchParams({ start: range.start, end: range.end, bucket: range.bucket, includeArchived: range.includeArchived ? "1" : "0" });
      const response = await fetch(`api/tiktok/titles/${titleId}/timeseries?${params}`, { credentials: "include" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not load title history");
      return result;
    },
  });
  const download = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([csvOf(data)], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `tiktok-${data.titleId}-${data.start}-${data.end}-${data.bucket}.csv`;
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const viewsLabel = data?.bucket === "week" ? "Weekly views" : data?.bucket === "month" ? "Monthly views" : "Daily views";
  return <div className="p-4 md:p-6 space-y-4 min-w-0 max-w-[1600px] mx-auto" data-testid="page-tiktok-title">
    <Link href="/tiktok" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-3.5 w-3.5" />TikTok Pulse
    </Link>
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">{data?.title ?? "TikTok title history"}</h1>
          {data && <Badge variant="outline" className="text-foreground">{data.isSaber ? "Saber title" : "Competitor"}</Badge>}
        </div>
        <p className="text-sm text-muted-foreground mt-1">Daily views, video coverage and comment volume over time{data?.parentTitle ? ` · compared with ${data.parentTitle}` : ""}.</p>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={isFetching} onClick={() => refetch()} aria-label="Refresh history"><RefreshCw className="h-4 w-4" /></Button>
        <Button size="sm" onClick={download} disabled={!data || isFetching || !!error} data-testid="download-tiktok-csv"><Download className="h-4 w-4 mr-2" />Download CSV</Button>
      </div>
    </header>

    {error ? <Card className="p-4 text-sm text-red-600">{(error as Error).message}</Card>
      : !data ? <Skeleton className="h-64 w-full" /> : <div className="grid gap-4">
        <HistoryChart rows={data.rows} metric="netViews" title={viewsLabel}
          note={`View gains from recorded daily snapshots of the same videos${data.includeArchived ? " (archived included)" : ""}. Newly discovered videos need a comparable earlier observation. Negative platform corrections remain negative.`}
          color="#0891b2" featured />
        <HistoryChart rows={data.rows} metric="publishedVideos" title={mode === "activity" ? "New videos" : "Videos"}
          note="Videos discovered (by publication date) in the period. Discovery lag can revise earlier dates." color="#334155" bars />
        <HistoryChart rows={data.rows} metric="collectedComments" title="Comments"
          note="Comments collected per period by their publication date. A collected comment is not a new comment row." color="#7c3aed" bars />
      </div>}
  </div>;
}
