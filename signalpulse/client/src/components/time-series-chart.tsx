import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { format, subDays, parseISO } from "date-fns";
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
  ReferenceLine,
} from "recharts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TimeSeriesDataPoint {
  date: string;
  cumulativeCount: number;
  dailyDelta: number;
}

export interface MilestoneAnnotation {
  name: string;
  actualDate: string | null;
  category: string;
}

interface TimeSeriesChartProps {
  data: TimeSeriesDataPoint[];
  milestones: MilestoneAnnotation[];
  title: string;
  color: string;
  releaseDate?: string | null;   // v3.3: draw a distinct 'Release' marker
  showsReleaseDate?: boolean;    // v3.3: gate the release marker (default false)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatYAxis(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return String(value);
}

function getMilestoneColor(category: string): string {
  switch (category) {
    case "videos": return "#3B82F6";
    case "press_coverage": return "#22C55E";
    case "demos_betas": return "#F97316";
    default: return "#6B7280";
  }
}

type DateRange = "30" | "90" | "all";

// ─── Custom Tooltip ──────────────────────────────────────────────────────────

function ChartTooltip({
  active,
  payload,
  label,
  valueLabel,
}: {
  active?: boolean;
  payload?: any[];
  label?: string;
  valueLabel: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-popover text-popover-foreground border border-border rounded-md shadow-md px-3 py-2 text-xs">
      <div className="font-medium mb-1">{label}</div>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <span style={{ color: p.color || p.fill }} className="font-semibold">
            {valueLabel}: {formatYAxis(p.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Milestone Label (small, non-interactive SVG text) ──────────────────────

function MilestoneLabel({
  viewBox,
  name,
  color,
}: {
  viewBox?: { x?: number; y?: number; height?: number };
  name: string;
  color: string;
}) {
  const x = viewBox?.x ?? 0;
  const y = viewBox?.y ?? 0;
  const shortName = name.length > 14 ? name.slice(0, 13) + "…" : name;
  return (
    <g>
      <text
        x={x}
        y={y + 4}
        fill={color}
        fontSize={9}
        fontWeight={500}
        textAnchor="start"
        transform={`rotate(-45, ${x}, ${y + 4})`}
        style={{ pointerEvents: "none" }}
      >
        {shortName}
      </text>
    </g>
  );
}

// ─── Milestone Hover Zones (HTML overlay on top of chart) ───────────────────

interface MilestoneHoverInfo {
  name: string;
  date: string;
  color: string;
  xPct: number; // percentage position across the chart
}

function MilestoneHoverOverlay({
  milestones,
  chartDataLength,
  visibleMilestones,
  chartData,
}: {
  milestones: MilestoneHoverInfo[];
  chartDataLength: number;
  visibleMilestones: MilestoneAnnotation[];
  chartData: { date: string; displayDate: string }[];
}) {
  const [hovered, setHovered] = useState<MilestoneHoverInfo | null>(null);

  if (milestones.length === 0) return null;

  return (
    <>
      {/* Invisible hover strips positioned over each milestone line */}
      {milestones.map((m) => (
        <div
          key={m.name}
          className="absolute top-0 h-full z-10 cursor-pointer"
          style={{
            left: `calc(${m.xPct}% - 8px)`,
            width: "16px",
          }}
          onMouseEnter={() => setHovered(m)}
          onMouseLeave={() => setHovered(null)}
        />
      ))}

      {/* Tooltip that appears above the hovered milestone */}
      {hovered && (
        <div
          className="absolute z-20 pointer-events-none"
          style={{
            left: `${hovered.xPct}%`,
            top: "-4px",
            transform: "translateX(-50%) translateY(-100%)",
          }}
        >
          <div className="bg-popover text-popover-foreground border border-border rounded-md shadow-lg px-3 py-2 text-[11px] whitespace-nowrap">
            <div className="font-semibold" style={{ color: hovered.color }}>
              {hovered.name}
            </div>
            <div className="text-muted-foreground text-[10px] mt-0.5">{hovered.date}</div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function TimeSeriesChart({
  data,
  milestones,
  title,
  color,
  releaseDate,
  showsReleaseDate = false,
}: TimeSeriesChartProps) {
  const [range, setRange] = useState<DateRange>("all");

  // Filter data by date range
  const filteredData = useMemo(() => {
    if (!data?.length) return [];
    if (range === "all") return data;
    const cutoff = subDays(new Date(), range === "30" ? 30 : 90);
    return data.filter((d) => parseISO(d.date) >= cutoff);
  }, [data, range]);

  // Format dates for display.
  // v3.3 (2026-08-11): when the visible range spans more than one year (very
  // common for post-launch titles + backfills), append the year so viewers
  // don't have to guess which year each label refers to. Two rules:
  //   - If the series crosses multiple calendar years — always show 'yy suffix
  //   - Otherwise — keep the short 'MMM d' format
  const spansMultipleYears = useMemo(() => {
    if (filteredData.length === 0) return false;
    const firstYear = filteredData[0].date.slice(0, 4);
    const lastYear = filteredData[filteredData.length - 1].date.slice(0, 4);
    return firstYear !== lastYear;
  }, [filteredData]);

  const chartData = useMemo(
    () =>
      filteredData.map((d) => ({
        ...d,
        displayDate: spansMultipleYears
          ? format(new Date(d.date + "T00:00:00"), "MMM ''yy")
          : format(new Date(d.date + "T00:00:00"), "MMM d"),
      })),
    [filteredData, spansMultipleYears]
  );

  // Only milestones with actualDate set
  const activeMilestones = useMemo(
    () => milestones.filter((m) => m.actualDate != null),
    [milestones]
  );

  // v3.3: find the chart-data point that matches (or is nearest to) the
  // release date, so we can draw a distinct release-date reference line.
  // Returns null when releaseDate is outside the currently-visible window.
  const releaseDatePoint = useMemo(() => {
    if (!showsReleaseDate || !releaseDate || chartData.length === 0) return null;
    // Exact match first
    const exact = chartData.find((d) => d.date === releaseDate);
    if (exact) return exact;
    // Nearest — useful when release day itself has no telemetry point
    // (e.g. Steamworks reports weekly, or a portal monthly rollup lands on
    // the last day of month rather than release day).
    const rdMs = new Date(releaseDate + "T00:00:00").getTime();
    let best: { date: string; displayDate: string } | null = null;
    let bestDelta = Infinity;
    for (const d of chartData) {
      const delta = Math.abs(new Date(d.date + "T00:00:00").getTime() - rdMs);
      if (delta < bestDelta) { bestDelta = delta; best = d; }
    }
    return best;
  }, [showsReleaseDate, releaseDate, chartData]);

  const RELEASE_COLOR = "#DC2626"; // red-600 — loud enough to stand out from milestone lines

  // Custom SVG label for the release marker (mirrors MilestoneLabel style).
  const ReleaseLabel = ({ viewBox }: { viewBox?: { x?: number; y?: number } }) => {
    const x = viewBox?.x ?? 0;
    const y = viewBox?.y ?? 0;
    return (
      <g>
        <text
          x={x}
          y={y + 4}
          fill={RELEASE_COLOR}
          fontSize={10}
          fontWeight={700}
          textAnchor="start"
          transform={`rotate(-45, ${x}, ${y + 4})`}
          style={{ pointerEvents: "none" }}
        >
          Release
        </text>
      </g>
    );
  };

  // Find milestones within date range
  const visibleMilestones = useMemo(() => {
    if (!chartData.length) return [];
    const dates = new Set(chartData.map((d) => d.date));
    return activeMilestones.filter((m) => m.actualDate && dates.has(m.actualDate));
  }, [activeMilestones, chartData]);

  // Calculate X percentage positions for hover overlay
  // Recharts uses evenly spaced data points, with margins for Y axis
  // The chart area starts after the Y axis (~42px) and has 8px right margin
  // We approximate: index / (totalPoints - 1) maps to the chart plot area
  const milestoneHoverInfos = useMemo(() => {
    if (!chartData.length) return [];
    const yAxisWidth = 42;
    const rightMargin = 8;
    // These percentages are relative to the container div that wraps the chart
    return visibleMilestones.map((m) => {
      const idx = chartData.findIndex((d) => d.date === m.actualDate);
      // Map index to percentage of the full container width
      // The plot area spans from yAxisWidth to (containerWidth - rightMargin)
      // As percentages of container: from (yAxisWidth/containerWidth) to (1 - rightMargin/containerWidth)
      // Approximate container width as 100%, yAxisWidth ~5%, rightMargin ~1%
      const plotStartPct = 5.5;
      const plotEndPct = 99;
      const plotRange = plotEndPct - plotStartPct;
      const posWithinPlot = chartData.length > 1 ? idx / (chartData.length - 1) : 0.5;
      const xPct = plotStartPct + posWithinPlot * plotRange;

      return {
        name: m.name,
        date: m.actualDate
          ? format(new Date(m.actualDate + "T00:00:00"), "MMM d, yyyy")
          : "",
        color: getMilestoneColor(m.category),
        xPct,
      };
    });
  }, [visibleMilestones, chartData]);

  const areaStroke = color;
  const gridStyle = { stroke: "currentColor", opacity: 0.08 };

  const xAxisProps = {
    dataKey: "displayDate",
    tick: { fontSize: 10, fill: "currentColor", opacity: 0.55 },
    tickLine: false,
    axisLine: false,
    interval: Math.max(0, Math.floor(chartData.length / 6) - 1),
  };

  const yAxisProps = {
    tickFormatter: formatYAxis,
    tick: { fontSize: 10, fill: "currentColor", opacity: 0.55 },
    tickLine: false,
    axisLine: false,
    width: 42,
  };

  return (
    <div className="space-y-4">
      {/* Header with range buttons */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <div className="flex items-center gap-1">
          {(["30", "90", "all"] as DateRange[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                range === r
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              }`}
            >
              {r === "all" ? "All Time" : `${r} Days`}
            </button>
          ))}
        </div>
      </div>

      {chartData.length === 0 ? (
        <div className="h-[200px] flex items-center justify-center text-muted-foreground text-xs">
          No data available
        </div>
      ) : (
        <>
          {/* ── Cumulative Area Chart ── */}
          <div className="relative">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 font-medium">
              Cumulative Total
            </div>
            <div className="relative">
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={chartData} margin={{ top: 20, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id={`grad-${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={color} stopOpacity={0.15} />
                      <stop offset="95%" stopColor={color} stopOpacity={0.01} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" {...gridStyle} />
                  <XAxis {...xAxisProps} />
                  <YAxis {...yAxisProps} />
                  <Tooltip
                    content={<ChartTooltip valueLabel="Count" />}
                    cursor={{ stroke: color, strokeWidth: 1, strokeOpacity: 0.4 }}
                  />
                  {visibleMilestones.map((m) => {
                    const point = chartData.find((d) => d.date === m.actualDate);
                    if (!point) return null;
                    const mColor = getMilestoneColor(m.category);
                    return (
                      <ReferenceLine
                        key={`${m.name}-cum`}
                        x={point.displayDate}
                        stroke={mColor}
                        strokeDasharray="4 3"
                        strokeWidth={1.5}
                        strokeOpacity={0.8}
                        label={<MilestoneLabel name={m.name} color={mColor} />}
                      />
                    );
                  })}
                  {releaseDatePoint && (
                    <ReferenceLine
                      key="release-cum"
                      x={releaseDatePoint.displayDate}
                      stroke={RELEASE_COLOR}
                      strokeWidth={2}
                      strokeOpacity={0.9}
                      label={<ReleaseLabel />}
                    />
                  )}
                  <Area
                    type="monotone"
                    dataKey="cumulativeCount"
                    stroke={areaStroke}
                    strokeWidth={2}
                    fill={`url(#grad-${color.replace("#", "")})`}
                    dot={false}
                    activeDot={{ r: 4, fill: color, strokeWidth: 0 }}
                  />
                </AreaChart>
              </ResponsiveContainer>

              {/* HTML hover overlay for milestone tooltips */}
              <MilestoneHoverOverlay
                milestones={milestoneHoverInfos}
                chartDataLength={chartData.length}
                visibleMilestones={visibleMilestones}
                chartData={chartData}
              />
            </div>
          </div>

          {/* ── Daily Delta Bar Chart ── */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 font-medium">
              Daily Change
            </div>
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" {...gridStyle} />
                <XAxis {...xAxisProps} />
                <YAxis {...yAxisProps} />
                <Tooltip
                  content={<ChartTooltip valueLabel="Daily" />}
                  cursor={{ fill: color, fillOpacity: 0.06 }}
                />
                {visibleMilestones.map((m) => {
                  const point = chartData.find((d) => d.date === m.actualDate);
                  if (!point) return null;
                  const mColor = getMilestoneColor(m.category);
                  return (
                    <ReferenceLine
                      key={`${m.name}-delta`}
                      x={point.displayDate}
                      stroke={mColor}
                      strokeDasharray="4 3"
                      strokeWidth={1.5}
                      strokeOpacity={0.8}
                    />
                  );
                })}
                {releaseDatePoint && (
                  <ReferenceLine
                    key="release-delta"
                    x={releaseDatePoint.displayDate}
                    stroke={RELEASE_COLOR}
                    strokeWidth={2}
                    strokeOpacity={0.9}
                  />
                )}
                <Bar
                  dataKey="dailyDelta"
                  fill={color}
                  fillOpacity={0.7}
                  radius={[2, 2, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* ── Milestone Legend ── */}
          {visibleMilestones.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 pt-1">
              {visibleMilestones.map((m) => (
                <div key={m.name} className="flex items-center gap-1.5">
                  <div
                    className="w-3 h-0.5 rounded"
                    style={{
                      background: getMilestoneColor(m.category),
                      borderTop: `1.5px dashed ${getMilestoneColor(m.category)}`,
                      height: 0,
                    }}
                  />
                  <span className="text-[10px] text-muted-foreground">
                    {m.name}{" "}
                    <span className="opacity-60">
                      ({m.actualDate
                        ? format(new Date(m.actualDate + "T00:00:00"), "MMM d")
                        : ""})
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Sparkline Component ─────────────────────────────────────────────────────

interface SparklineProps {
  data: TimeSeriesDataPoint[];
  color: string;
}

export function SparklineChart({ data, color }: SparklineProps) {
  const last30 = useMemo(() => {
    if (!data?.length) return [];
    return data.slice(-30).map((d) => ({
      v: d.cumulativeCount,
    }));
  }, [data]);

  if (last30.length < 2) return null;

  return (
    <ResponsiveContainer width="100%" height={60}>
      <AreaChart data={last30} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={`spark-${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.2} />
            <stop offset="95%" stopColor={color} stopOpacity={0.01} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="v"
          stroke={color}
          strokeWidth={1.5}
          fill={`url(#spark-${color.replace("#", "")})`}
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
