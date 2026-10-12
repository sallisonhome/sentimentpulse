/**
 * TikTok Pulse — Saber title leaderboard (cohort view).
 *
 * Route: /tiktok
 *
 * Default: past 24 hours, ranked by aggregated views, descending.
 * Cohort definition: each window counts videos PUBLISHED (create_time) in
 * that window and sums their current lifetime views/likes/comments from the
 * EnsembleData API. Likes % of views is a SignalPulse calculation from
 * EnsembleData data, labeled as such.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Link } from "wouter";

type WindowKey = "d1" | "d7" | "d30" | "d90" | "m12" | "ltd";
type SortKey = "views" | "videos" | "comments" | "likes" | "likesPct" | "reposts" | "title";

const WINDOWS: Array<{ id: WindowKey; label: string }> = [
  { id: "d1", label: "24 hours" },
  { id: "d7", label: "7 days" },
  { id: "d30", label: "30 days" },
  { id: "d90", label: "90 days" },
  { id: "m12", label: "12 months" },
  { id: "ltd", label: "Lifetime" },
];

interface TopVideo { awemeId: string; desc: string; authorUniqueId: string | null; views: number; createTime: number; url: string }
interface Row {
  titleId: number; title: string; steamAppId: string | null; headerImageUrl: string | null;
  isSaber: boolean; parentTitle: string | null;
  views: number; videos: number; comments: number; likes: number; reposts: number; likesPct: number | null;
  topVideo: TopVideo | null; statsAsOf: string | null; trackingSince: string | null;
  backfillComplete: boolean; backfillOldest: string | null; backfillFloor: string;
}
interface LeaderboardResponse {
  definition: "cohort"; window: WindowKey; sort: SortKey; direction: "asc" | "desc";
  generatedAt: string; apiKeyConfigured: boolean;
  lastRun: { status: string; finished_at: string | null; message: string | null } | null;
  rows: Row[];
}

const nf = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const fmt = (n: number | null | undefined) => (n == null ? "—" : nf.format(n));
const fmtC = (n: number | null | undefined) => (n == null ? "—" : compact.format(n));
const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");

const SORTS: Array<{ id: SortKey; label: string; align?: string }> = [
  { id: "views", label: "Views" },
  { id: "videos", label: "Videos" },
  { id: "comments", label: "Comments" },
  { id: "likes", label: "Likes" },
  { id: "likesPct", label: "Likes %" },
  { id: "reposts", label: "Reposts" },
  { id: "title", label: "Title" },
];

export default function TikTokLeaderboard() {
  const [window, setWindow] = useState<WindowKey>("d1");
  const [sort, setSort] = useState<SortKey>("views");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const [scope, setScope] = useState<"saber" | "all">("saber");

  const { data, isLoading, error } = useQuery<LeaderboardResponse>({
    queryKey: ["/api/tiktok/leaderboard", window, sort, direction, scope],
    refetchInterval: 60_000,
  });

  const rows = data?.rows ?? [];

  return (
    <div className="p-4 md:p-6 space-y-4" data-testid="page-tiktok-leaderboard">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">TikTok Pulse</h1>
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground">Saber</span>
          <Switch checked={scope === "all"} onCheckedChange={(c) => setScope(c ? "all" : "saber")}
            aria-label="Toggle competitor titles" />
          <span className="text-xs text-muted-foreground">All</span>
        </div>
        <div className="ml-auto flex items-center gap-1 flex-wrap">
          {WINDOWS.map((w) => (
            <Button key={w.id} variant={window === w.id ? "default" : "ghost"} size="sm"
              onClick={() => setWindow(w.id)}>{w.label}</Button>
          ))}
        </div>
      </div>

      {error ? (
        <Card className="p-4 text-sm text-red-600">Error loading TikTok leaderboard: {(error as Error).message}</Card>
      ) : isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
        </div>
      ) : !data?.apiKeyConfigured ? (
        <Card className="p-4 text-sm text-muted-foreground">
          EnsembleData token is not configured. Set the <code>tiktok_ensemble_token</code> setting or the <code>ED_TOKEN</code> env var.
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="tiktok-leaderboard-table">
              <thead>
                <tr className="border-b bg-muted/50">
                  {SORTS.map((s) => (
                    <th key={s.id} className="px-3 py-2 text-left font-medium">
                      <button className="inline-flex items-center gap-1 hover:text-foreground"
                        onClick={() => { setSort(s.id); setDirection(sort === s.id && direction === "desc" ? "asc" : "desc"); }}>
                        {s.label}
                        {sort === s.id ? (direction === "desc" ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : null}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.titleId} className="border-b hover:bg-muted/30" data-testid={`tiktok-row-${r.titleId}`}>
                    <td className="px-3 py-2">
                      <Link href={`/titles/${r.titleId}`} className="flex items-center gap-2">
                        <img src={r.headerImageUrl ?? ""} alt="" className="w-16 h-8 object-cover rounded" loading="lazy" />
                        <div className="flex flex-col">
                          <span className="font-medium">{r.title}</span>
                          {r.parentTitle && !r.isSaber ? (
                            <span className="text-xs text-muted-foreground">competitor · under {r.parentTitle}</span>
                          ) : null}
                        </div>
                      </Link>
                    </td>
                    <td className="px-3 py-2 tabular-nums" data-testid={`tiktok-views-${r.titleId}`}>{fmt(r.views)}</td>
                    <td className="px-3 py-2 tabular-nums">{fmt(r.videos)}</td>
                    <td className="px-3 py-2 tabular-nums">{fmt(r.comments)}</td>
                    <td className="px-3 py-2 tabular-nums">{fmt(r.likes)}</td>
                    <td className="px-3 py-2 tabular-nums">{r.likesPct == null ? "—" : `${r.likesPct.toFixed(1)}%`}</td>
                    <td className="px-3 py-2 tabular-nums">{fmt(r.reposts)}</td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr><td colSpan={SORTS.length} className="px-3 py-6 text-center text-muted-foreground">
                    No TikTok videos yet. Trigger a collection run from Settings.
                  </td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between px-3 py-2 text-xs text-muted-foreground">
            <span>
              Cohort: videos published in window, current lifetime stats · {fmtC(rows.length)} titles
            </span>
            <span>
              {data?.lastRun ? `Last run: ${data.lastRun.status} ${fmtDate(data.lastRun.finished_at)}` : "No runs yet"}
            </span>
          </div>
        </Card>
      )}
    </div>
  );
}
