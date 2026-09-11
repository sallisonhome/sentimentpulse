/**
 * Console Title PDP.
 *
 * Route: /console-leaderboards/:platform/:titleId
 * Layout matches howmanyareplaying:
 *   - Header: cover art, title, IGDB summary, genres, developer, release date
 *   - Per-platform KPI tiles (LTD rating count, avg rating)
 *   - Timeseries chart with date-range picker (7d / 30d / 90d / 12m / LTD / custom)
 *   - Metric switcher: rating count / avg rating / owners_mid
 */

import { useQuery } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState, useMemo } from "react";
import { ArrowLeft } from "lucide-react";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { format, parseISO, subDays } from "date-fns";

type Platform = "steam" | "xbox" | "ps5";
type Metric = "rating_count" | "avg_rating" | "owners_mid";
type PresetRange = "7d" | "30d" | "90d" | "12m" | "ltd" | "custom";

interface Sku {
  platform: Platform;
  externalSku: string;
  conceptId: string | null;
  skuRole: string;
  businessModel: string;
  msrpUsdCents: number | null;
  refreshedAt: string;
}
interface IgdbData {
  igdbId: number | null;
  slug: string | null;
  name: string | null;
  summary: string | null;
  releaseDate: string | null;
  coverUrl: string | null;
  artworkUrl: string | null;
  screenshots: string[];
  genres: string[];
  themes: string[];
  platforms: string[];
  developers: string[];
  publishers: string[];
  rating: number | null;
  ratingCount: number | null;
}
interface TitleDetail {
  titleId: number;
  skus: Sku[];
  igdb: IgdbData | null;
  latestPerPlatform: Array<{ platform: Platform; captureDate: string; ratingCount: number | null; avgRating: number | null; windowLabel: string | null }>;
}

const PLATFORM_LABEL: Record<Platform, string> = { steam: "Steam", xbox: "Xbox", ps5: "PlayStation 5" };
const METRICS: Array<{ id: Metric; label: string }> = [
  { id: "rating_count", label: "Rating count" },
  { id: "avg_rating", label: "Avg rating" },
  { id: "owners_mid", label: "Est. owners" },
];
const PRESETS: Array<{ id: PresetRange; label: string; days?: number }> = [
  { id: "7d", label: "7d", days: 7 },
  { id: "30d", label: "30d", days: 30 },
  { id: "90d", label: "90d", days: 90 },
  { id: "12m", label: "12m", days: 365 },
  { id: "ltd", label: "LTD" },
  { id: "custom", label: "Custom" },
];

function isoToday(): string { return new Date().toISOString().slice(0, 10); }
function daysAgoIso(d: number): string { return subDays(new Date(), d).toISOString().slice(0, 10); }
function formatCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toLocaleString();
}

export default function ConsoleTitleDetail() {
  const params = useParams<{ platform: Platform; titleId: string }>();
  const platform = params.platform;
  const titleId = parseInt(params.titleId!, 10);

  const { data: detail, isLoading } = useQuery<TitleDetail>({
    queryKey: [`/api/console/titles/${titleId}`],
    queryFn: async () => {
      const r = await fetch(`/signal/api/console/titles/${titleId}`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    enabled: Number.isFinite(titleId),
  });

  const [preset, setPreset] = useState<PresetRange>("30d");
  const [metric, setMetric] = useState<Metric>("rating_count");
  const [customFrom, setCustomFrom] = useState(daysAgoIso(30));
  const [customTo, setCustomTo] = useState(isoToday());

  const { from, to } = useMemo(() => {
    if (preset === "custom") return { from: customFrom, to: customTo };
    if (preset === "ltd") return { from: "2005-01-01", to: isoToday() };
    const days = PRESETS.find(p => p.id === preset)?.days ?? 30;
    return { from: daysAgoIso(days), to: isoToday() };
  }, [preset, customFrom, customTo]);

  const { data: ts, isLoading: tsLoading } = useQuery<{ points: Array<{ date: string; value: number | null }> }>({
    queryKey: [`/api/console/titles/${titleId}/timeseries`, { platform, metric, from, to }],
    queryFn: async () => {
      const q = new URLSearchParams({ platform, metric, from, to });
      const r = await fetch(`/signal/api/console/titles/${titleId}/timeseries?${q.toString()}`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    enabled: Number.isFinite(titleId),
  });

  if (isLoading) {
    return <div className="p-6 max-w-5xl mx-auto"><Skeleton className="h-8 w-64 mb-4" /><Skeleton className="h-48 w-full mb-4" /><Skeleton className="h-64 w-full" /></div>;
  }
  if (!detail) return <div className="p-6 text-center text-muted-foreground">Title not found.</div>;

  const igdb = detail.igdb;
  const currentPlatformLatest = detail.latestPerPlatform.find(l => l.platform === platform);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <Link href={`/console-leaderboards/${platform}`}>
        <button className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1" data-testid="link-back-list">
          <ArrowLeft className="h-3 w-3" /> Back to {PLATFORM_LABEL[platform]} leaderboard
        </button>
      </Link>

      {/* Header */}
      <div className="flex gap-4 items-start">
        {igdb?.coverUrl && (
          <img src={igdb.coverUrl} alt="" className="w-32 h-44 object-cover rounded-md shadow-md shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">{PLATFORM_LABEL[platform]}</div>
          <h1 className="text-2xl font-semibold mt-1 truncate">{igdb?.name || `Title #${titleId}`}</h1>
          {igdb?.releaseDate && <div className="text-xs text-muted-foreground mt-1">Released {igdb.releaseDate}</div>}
          {igdb?.developers && igdb.developers.length > 0 && (
            <div className="text-xs text-muted-foreground mt-1">by {igdb.developers.join(", ")}</div>
          )}
          {igdb?.genres && igdb.genres.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {igdb.genres.map(g => <Badge key={g} variant="secondary" className="text-xs">{g}</Badge>)}
            </div>
          )}
          {igdb?.summary && <p className="text-sm text-muted-foreground mt-3 line-clamp-4">{igdb.summary}</p>}
        </div>
      </div>

      {/* Screenshots */}
      {igdb?.screenshots && igdb.screenshots.length > 0 && (
        <div className="flex gap-2 overflow-x-auto">
          {igdb.screenshots.map((url, i) => (
            <img key={i} src={url} alt="" className="h-24 rounded-md shrink-0" />
          ))}
        </div>
      )}

      {/* KPI tiles per platform */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {detail.latestPerPlatform.map(l => (
          <Card key={l.platform} className={`p-4 ${l.platform === platform ? "border-primary/50" : ""}`}>
            <div className="text-xs text-muted-foreground uppercase">{PLATFORM_LABEL[l.platform]}</div>
            <div className="text-2xl font-mono mt-1">{formatCompact(l.ratingCount)}</div>
            <div className="text-xs text-muted-foreground">
              ratings · avg {
                // Steam's avg_rating is a 0-5 rescale of the up/(up+down) recommendation rate
                // (collector: (up/total)*5). Show it as the native percent on Steam rows so
                // "70%" doesn't display as 3.5 and read like a positive score; keep the 0-5
                // mean on PS5/Xbox where that's the native unit.
                l.avgRating != null
                  ? (l.platform === "steam"
                      ? `${Math.round(l.avgRating * 20)}%`
                      : l.avgRating.toFixed(2))
                  : "—"
              }
            </div>
            <div className="text-xs text-muted-foreground mt-1">captured {l.captureDate}</div>
          </Card>
        ))}
        {detail.latestPerPlatform.length === 0 && (
          <Card className="p-4 col-span-3 text-sm text-muted-foreground">No captured snapshots yet.</Card>
        )}
      </div>

      {/* Timeseries chart */}
      <Card className="p-4 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="text-sm font-medium">Signal timeseries · {PLATFORM_LABEL[platform]}</div>
          <div className="flex gap-1 flex-wrap items-center">
            {METRICS.map(m => (
              <Button key={m.id} variant={metric === m.id ? "default" : "outline"} size="sm" onClick={() => setMetric(m.id)} data-testid={`btn-metric-${m.id}`}>
                {m.label}
              </Button>
            ))}
            <div className="w-px h-4 bg-border mx-1" />
            {PRESETS.map(p => (
              <Button key={p.id} variant={preset === p.id ? "default" : "outline"} size="sm" onClick={() => setPreset(p.id)} data-testid={`btn-range-${p.id}`}>
                {p.label}
              </Button>
            ))}
          </div>
        </div>
        {preset === "custom" && (
          <div className="flex gap-2 items-center text-xs">
            <label>From</label>
            <Input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className="w-40 h-8" />
            <label>To</label>
            <Input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} className="w-40 h-8" />
          </div>
        )}
        {tsLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : ts && ts.points.length > 0 ? (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={ts.points}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={d => format(parseISO(d), "MMM d")} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={v => formatCompact(v)} />
                <Tooltip
                  labelFormatter={d => format(parseISO(String(d)), "PPP")}
                  formatter={(v: number) => [formatCompact(v), METRICS.find(m => m.id === metric)?.label]}
                />
                <Area type="monotone" dataKey="value" stroke="hsl(var(--primary))" fillOpacity={0.15} fill="hsl(var(--primary))" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">
            No data points in this range. Wait for a full day of collection or widen the range.
          </div>
        )}
      </Card>

      {/* SKU debug */}
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">Platform SKUs ({detail.skus.length})</summary>
        <div className="mt-2 space-y-1 font-mono">
          {detail.skus.map(s => (
            <div key={`${s.platform}-${s.externalSku}`}>
              {PLATFORM_LABEL[s.platform]} · {s.externalSku} · {s.businessModel} · {s.msrpUsdCents != null ? `$${(s.msrpUsdCents/100).toFixed(2)}` : "—"}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
