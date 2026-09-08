// ─── Concurrent Players (CCU) — Product Detail Page section ────────────────
//
// Ported/adapted from howmanyareplaying's GameMedia.jsx (screenshot strip +
// trailer tile + lightbox) and StatBadge.jsx (KPI badges), restyled with
// Tailwind to match SignalPulse's existing card/section conventions, and
// charted with Recharts (the library already used across this app's
// time-series-chart.tsx) rather than introducing a new charting dependency.
//
// Field names below mirror the backend response shapes exactly:
//   - CcuKpiCard        <- GET /api/products/:id/ccu/kpi      (leaderboards.ts)
//   - IgdbMediaResult   <- GET /api/products/:id/ccu/media    (igdb.ts)
//   - CcuHistoryResult  <- GET /api/products/:id/ccu/history  (ccu-history.ts)
//   - CcuHourlyResult   <- GET /api/products/:id/ccu/hourly   (ccu-history.ts)
//   - RelatedGame[]     <- GET /api/products/:id/ccu/related  (ccu-related.ts)

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { Gamepad2, Play, X, Users } from "lucide-react";
import { formatNumber, formatDate } from "@/lib/utils";

// ─── Types ───────────────────────────────────────────────────────────────────

interface CcuKpiCard {
  productId: number;
  liveRank: number | null;
  currentPlayers: number | null;
  peak24h: number | null;
  allTimePeak: number | null;
  allTimePeakDate: string | null;
  vsLastMonthPct: number | null;
}

interface IgdbMediaResult {
  igdbId: number;
  summary: string | null;
  screenshotIds: string[];
  videoIds: string[];
}

type CcuHistoryRange = "day" | "week" | "month" | "3m" | "6m" | "1y" | "all";

interface CcuHistoryPoint {
  ccu: number;
  time: string;
}

interface CcuHistoryResult {
  productId: number;
  range: CcuHistoryRange;
  data: CcuHistoryPoint[];
  allTimePeak: number | null;
  allTimePeakDate: string | null;
}

interface CcuHourlyPoint {
  hour: number;
  avgCcu: number;
}

interface CcuHourlyResult {
  productId: number;
  data: CcuHourlyPoint[];
}

interface RelatedGame {
  position: number;
  appid: number;
  name: string;
  headerImage: string;
  playerCount: number | null;
  tags: string[];
}

const RANGE_OPTIONS: Array<{ key: CcuHistoryRange; label: string }> = [
  { key: "day", label: "24H" },
  { key: "week", label: "1W" },
  { key: "month", label: "1M" },
  { key: "3m", label: "3M" },
  { key: "6m", label: "6M" },
  { key: "1y", label: "1Y" },
  { key: "all", label: "All" },
];

// ─── Small helpers ───────────────────────────────────────────────────────────

function StatBadge({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-1" data-testid={`stat-${label.replace(/\s+/g, "-").toLowerCase()}`}>
      <div className="text-xs text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function igdbScreenshotUrl(id: string): string {
  return `https://images.igdb.com/igdb/image/upload/t_screenshot_big/${id}.jpg`;
}

function youtubeThumbUrl(videoId: string): string {
  return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
}

// ─── Media carousel + lightbox ───────────────────────────────────────────────

type LightboxItem = { kind: "image"; url: string } | { kind: "video"; videoId: string };

function GameMediaCarousel({ media }: { media: IgdbMediaResult | undefined }) {
  const [lightbox, setLightbox] = useState<LightboxItem | null>(null);
  const screenshots = media?.screenshotIds ?? [];
  const videos = media?.videoIds ?? [];

  if (screenshots.length === 0 && videos.length === 0) {
    return <p className="text-sm text-muted-foreground">No screenshots or trailers available for this title yet.</p>;
  }

  return (
    <>
      <div className="flex gap-2 overflow-x-auto pb-1" data-testid="ccu-media-carousel">
        {videos.map((videoId) => (
          <button
            key={`video-${videoId}`}
            onClick={() => setLightbox({ kind: "video", videoId })}
            className="relative shrink-0 h-24 w-40 rounded-md overflow-hidden bg-muted group"
            data-testid={`ccu-media-video-${videoId}`}
          >
            <img src={youtubeThumbUrl(videoId)} alt="Trailer" className="h-full w-full object-cover" />
            <div className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 transition-colors">
              <Play className="h-8 w-8 text-white fill-white" />
            </div>
          </button>
        ))}
        {screenshots.map((id) => (
          <button
            key={`shot-${id}`}
            onClick={() => setLightbox({ kind: "image", url: igdbScreenshotUrl(id) })}
            className="shrink-0 h-24 w-40 rounded-md overflow-hidden bg-muted"
            data-testid={`ccu-media-screenshot-${id}`}
          >
            <img src={igdbScreenshotUrl(id)} alt="Screenshot" className="h-full w-full object-cover hover:opacity-90 transition-opacity" />
          </button>
        ))}
      </div>

      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
          onClick={() => setLightbox(null)}
          data-testid="ccu-media-lightbox"
        >
          <button
            className="absolute top-4 right-4 text-white/80 hover:text-white"
            onClick={() => setLightbox(null)}
            aria-label="Close"
            data-testid="button-close-lightbox"
          >
            <X className="h-6 w-6" />
          </button>
          {lightbox.kind === "image" ? (
            <img
              src={lightbox.url.replace("t_screenshot_big", "t_1080p")}
              alt="Screenshot"
              className="max-h-[85vh] max-w-[90vw] rounded-md"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <div className="w-full max-w-3xl aspect-video" onClick={(e) => e.stopPropagation()}>
              <iframe
                className="h-full w-full rounded-md"
                src={`https://www.youtube.com/embed/${lightbox.videoId}?autoplay=1`}
                title="Trailer"
                allow="autoplay; encrypted-media"
                allowFullScreen
              />
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ─── Related games grid ──────────────────────────────────────────────────────

function RelatedGamesGrid({ games }: { games: RelatedGame[] | undefined }) {
  if (!games || games.length === 0) {
    return <p className="text-sm text-muted-foreground">No related Steam titles found yet.</p>;
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3" data-testid="ccu-related-games-grid">
      {games.slice(0, 5).map((g) => (
        <a
          key={g.appid}
          href={`https://store.steampowered.com/app/${g.appid}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex flex-col gap-1.5 group"
          data-testid={`ccu-related-game-${g.appid}`}
        >
          <div className="relative rounded-md overflow-hidden bg-muted aspect-[460/215]">
            {g.headerImage ? (
              <img src={g.headerImage} alt={g.name} className="h-full w-full object-cover group-hover:opacity-90 transition-opacity" />
            ) : (
              <div className="h-full w-full flex items-center justify-center">
                <Gamepad2 className="h-6 w-6 text-muted-foreground/40" />
              </div>
            )}
            <span className="absolute top-1.5 left-1.5 h-5 min-w-5 px-1 rounded bg-black/70 text-white text-[11px] font-bold flex items-center justify-center">
              #{g.position}
            </span>
          </div>
          <span className="text-xs font-medium truncate group-hover:underline">{g.name}</span>
          {g.playerCount != null && (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground tabular-nums">
              <Users className="h-3 w-3" />
              {formatNumber(g.playerCount)} playing
            </span>
          )}
        </a>
      ))}
    </div>
  );
}

// ─── History chart with range chips ─────────────────────────────────────────

function CcuHistoryChart({ productId }: { productId: number }) {
  const [range, setRange] = useState<CcuHistoryRange>("month");

  const { data, isLoading } = useQuery<CcuHistoryResult>({
    queryKey: ["ccu-history", productId, range],
    queryFn: async () => {
      const res = await fetch(`/signal/api/products/${productId}/ccu/history?range=${range}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const chartData = (data?.data ?? []).map((p) => ({
    label: range === "day" ? new Date(p.time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : formatDate(p.time.slice(0, 10)),
    ccu: p.ccu,
  }));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex gap-1">
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => setRange(opt.key)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                range === opt.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
              }`}
              data-testid={`button-ccu-range-${opt.key}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {data?.allTimePeak != null && (
          <span className="text-xs text-muted-foreground">
            All-time peak: <span className="font-medium tabular-nums text-foreground">{formatNumber(data.allTimePeak)}</span>
            {data.allTimePeakDate && ` on ${formatDate(data.allTimePeakDate)}`}
          </span>
        )}
      </div>

      <div className="h-56">
        {isLoading ? (
          <div className="h-full w-full rounded-md bg-muted animate-pulse" />
        ) : chartData.length === 0 ? (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
            No CCU data captured for this range yet
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="ccuHistoryFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={30} />
              <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(v) => formatNumber(v)} width={56} />
              <Tooltip formatter={(value: number) => [formatNumber(value), "CCU"]} />
              <Area type="monotone" dataKey="ccu" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#ccuHistoryFill)" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

// ─── Hourly (peak hours of day) chart ────────────────────────────────────────

function CcuHourlyChart({ productId }: { productId: number }) {
  const { data, isLoading } = useQuery<CcuHourlyResult>({
    queryKey: ["/api/products", productId, "ccu", "hourly"],
  });

  const chartData = (data?.data ?? []).map((p) => ({
    hour: `${p.hour === 0 ? 12 : p.hour > 12 ? p.hour - 12 : p.hour}${p.hour < 12 ? "a" : "p"}`,
    avgCcu: p.avgCcu,
  }));

  return (
    <div className="h-48">
      {isLoading ? (
        <div className="h-full w-full rounded-md bg-muted animate-pulse" />
      ) : chartData.length === 0 ? (
        <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
          Not enough snapshots yet to chart hour-of-day patterns
        </div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border" />
            <XAxis dataKey="hour" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} interval={0} />
            <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(v) => formatNumber(v)} width={56} />
            <Tooltip formatter={(value: number) => [formatNumber(value), "Avg CCU"]} labelFormatter={(l) => `${l} (America/New_York)`} />
            <Bar dataKey="avgCcu" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ─── Top-level section ───────────────────────────────────────────────────────

export function CcuPdpSection({ productId }: { productId: number }) {
  const { data: kpi } = useQuery<CcuKpiCard>({
    queryKey: ["/api/products", productId, "ccu", "kpi"],
  });
  const { data: media } = useQuery<IgdbMediaResult>({
    queryKey: ["/api/products", productId, "ccu", "media"],
  });
  const { data: related } = useQuery<RelatedGame[]>({
    queryKey: ["/api/products", productId, "ccu", "related"],
  });

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4" data-testid="ccu-kpi-row">
        <StatBadge label="Live Rank" value={kpi?.liveRank == null ? "—" : `#${formatNumber(kpi.liveRank)}`} />
        <StatBadge label="Current Players" value={formatNumber(kpi?.currentPlayers ?? null)} />
        <StatBadge label="24H Peak" value={formatNumber(kpi?.peak24h ?? null)} />
        <StatBadge
          label="All-Time Peak"
          value={formatNumber(kpi?.allTimePeak ?? null)}
          sub={
            kpi?.allTimePeakDate
              ? `${formatDate(kpi.allTimePeakDate)}${kpi.vsLastMonthPct != null ? ` · ${kpi.vsLastMonthPct > 0 ? "+" : ""}${kpi.vsLastMonthPct}% vs last month` : ""}`
              : undefined
          }
        />
      </div>

      <div>
        <div className="text-sm font-medium mb-2">Screenshots &amp; Trailers</div>
        <GameMediaCarousel media={media} />
      </div>

      <div>
        <div className="text-sm font-medium mb-2">Concurrent Players Over Time</div>
        <CcuHistoryChart productId={productId} />
      </div>

      <div>
        <div className="text-sm font-medium mb-2">Peak Hours of Day (Trailing 30 Days, ET)</div>
        <CcuHourlyChart productId={productId} />
      </div>

      <div>
        <div className="text-sm font-medium mb-2">Top 5 Steam Crossover Games</div>
        <RelatedGamesGrid games={related} />
      </div>
    </div>
  );
}
