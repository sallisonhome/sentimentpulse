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
type KpiWindow = "d7" | "d30" | "d90" | "m12" | "ltd";
interface WindowKpi {
  platform: Platform;
  window: KpiWindow;
  windowUsed: KpiWindow | null;
  cascade: KpiWindow[];
  unitsMid: number | null;
  ownersMid: number | null;
  revenueMidUsd: number | null;
  aspUsdCents: number | null;
  msrpUsdCents: number | null;
  method: string | null;
  asOfDate: string | null;
  gatedReason: "ltd_only_signal" | "no_estimate" | "no_msrp" | null;
  ratingCountStart: number | null;
  ratingCountEnd: number | null;
  ratingDelta: number | null;
  avgRatingLatest: number | null;
  captureLatestDate: string | null;
}
interface TitleDetail {
  titleId: number;
  window: KpiWindow;
  cascade: KpiWindow[];
  skus: Sku[];
  igdb: IgdbData | null;
  latestPerPlatform: Array<{ platform: Platform; captureDate: string; ratingCount: number | null; avgRating: number | null; windowLabel: string | null }>;
  windowKpisPerPlatform: WindowKpi[];
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
// The tile-window switcher scopes the KPI cards to the same window the leaderboard
// filter uses. Keep this list in sync with CASCADE_BY_WINDOW_PDP on the server.
const KPI_WINDOWS: Array<{ id: KpiWindow; label: string }> = [
  { id: "d7", label: "7d" },
  { id: "d30", label: "30d" },
  { id: "d90", label: "90d" },
  { id: "m12", label: "12m" },
  { id: "ltd", label: "LTD" },
];
function formatMoney(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  const dollars = cents; // Endpoint returns whole USD dollars already.
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${(dollars / 1_000).toFixed(1)}K`;
  return `$${Math.round(dollars).toLocaleString()}`;
}
function formatSignedCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${abs.toLocaleString()}`;
}

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

  const [kpiWindow, setKpiWindow] = useState<KpiWindow>("d30");

  const { data: detail, isLoading } = useQuery<TitleDetail>({
    queryKey: [`/api/console/titles/${titleId}`, { kpiWindow }],
    queryFn: async () => {
      const q = new URLSearchParams({ window: kpiWindow });
      const r = await fetch(`/signal/api/console/titles/${titleId}?${q.toString()}`, { credentials: "include" });
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

      {/* KPI window switcher */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="text-xs text-muted-foreground uppercase tracking-wide">Window</div>
        {KPI_WINDOWS.map(w => (
          <Button
            key={w.id}
            variant={kpiWindow === w.id ? "default" : "outline"}
            size="sm"
            onClick={() => setKpiWindow(w.id)}
            data-testid={`btn-kpi-window-${w.id}`}
          >
            {w.label}
          </Button>
        ))}
      </div>

      {/* KPI tiles per platform — window-scoped */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {detail.windowKpisPerPlatform.map(k => {
          const latest = detail.latestPerPlatform.find(l => l.platform === k.platform);
          const isLtd = k.window === "ltd";
          const primary = isLtd
            ? formatCompact(latest?.ratingCount ?? k.ratingCountEnd)
            : formatMoney(k.revenueMidUsd);
          const primaryLabel = isLtd ? "ratings (LTD)" : "est. revenue";
          const secondary = isLtd
            ? `avg ${
                latest?.avgRating != null
                  ? (k.platform === "steam"
                      ? `${Math.round(latest.avgRating * 20)}%`
                      : latest.avgRating.toFixed(2))
                  : "—"
              }`
            : `${formatCompact(k.unitsMid)} units · ${formatCompact(k.ownersMid)} owners`;
          const badge = !isLtd && k.windowUsed && k.windowUsed !== k.window
            ? `est. via ${k.windowUsed}`
            : null;
          const gated = !isLtd && k.gatedReason;
          return (
            <Card key={k.platform} className={`p-4 ${k.platform === platform ? "border-primary/50" : ""}`}>
              <div className="flex items-center justify-between">
                <div className="text-xs text-muted-foreground uppercase">{PLATFORM_LABEL[k.platform]}</div>
                {badge && <Badge variant="outline" className="text-[10px]">{badge}</Badge>}
              </div>
              <div className="text-2xl font-mono mt-1">{primary}</div>
              <div className="text-xs text-muted-foreground">{primaryLabel}</div>
              <div className="text-xs text-muted-foreground mt-2">{secondary}</div>
              {!isLtd && (
                <div className="text-xs text-muted-foreground mt-1">
                  ratings Δ {formatSignedCount(k.ratingDelta)} over {k.window}
                </div>
              )}
              {gated && (
                <div className="text-[10px] text-amber-500 mt-1">
                  gated: {gated.replace(/_/g, " ")}
                </div>
              )}
              {isLtd && latest && (
                <div className="text-xs text-muted-foreground mt-1">captured {latest.captureDate}</div>
              )}
            </Card>
          );
        })}
        {detail.windowKpisPerPlatform.length === 0 && (
          <Card className="p-4 col-span-3 text-sm text-muted-foreground">No SKUs.</Card>
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
