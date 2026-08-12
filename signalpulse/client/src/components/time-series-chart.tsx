import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { format, subDays, parseISO } from "date-fns";
import type { DateRange as DayPickerRange } from "react-day-picker";
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
import { CalendarIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Button } from "@/components/ui/button";

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
  /** v3.10 (2026-08-12): 'usd' formats Y-axis + tooltip with $ prefix. Default 'units'. */
  valueUnit?: "usd" | "units";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatYAxis(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return String(value);
}

// v3.10 (2026-08-12): currency-aware formatter. Same K/M/B scale as units
// but with a $ prefix. Used when TimeSeriesChart's valueUnit prop === 'usd'.
function formatYAxisCurrency(value: number): string {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${Math.round(value)}`;
}

function getMilestoneColor(category: string): string {
  switch (category) {
    case "videos": return "#3B82F6";
    case "press_coverage": return "#22C55E";
    case "demos_betas": return "#F97316";
    // v3.13 (2026-08-12): Steam Sales / promo events get their own color so
    // they're visually distinct from core/video/press/demo reference lines.
    case "promotion": return "#EAB308";
    default: return "#6B7280";
  }
}

// v3.12 (2026-08-12): added "custom" alongside the fixed presets so any
// PDP chart (this component is shared across every product) can filter to
// an arbitrary date window.
type DateRange = "30" | "90" | "all" | "custom";

// ─── Custom Tooltip ──────────────────────────────────────────────────────────

function ChartTooltip({
  active,
  payload,
  label,
  valueLabel,
  valueUnit,
}: {
  active?: boolean;
  payload?: any[];
  label?: string;
  valueLabel: string;
  /** v3.10: 'usd' formats the number as currency. Default 'units'. */
  valueUnit?: "usd" | "units";
}) {
  if (!active || !payload?.length) return null;
  const fmt = valueUnit === "usd" ? formatYAxisCurrency : formatYAxis;
  // v3.12 (2026-08-12): `label` is now the raw ISO date (XAxis dataKey is
  // "date", not the collision-prone formatted "displayDate" — see bug fix
  // note below). Always show the full unambiguous date here regardless of
  // the axis tick's abbreviated format.
  const displayLabel = label ? format(new Date(label + "T00:00:00"), "MMM d, yyyy") : label;
  return (
    <div className="bg-popover text-popover-foreground border border-border rounded-md shadow-md px-3 py-2 text-xs">
      <div className="font-medium mb-1">{displayLabel}</div>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <span style={{ color: p.color || p.fill }} className="font-semibold">
            {valueLabel}: {fmt(p.value)}
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
  chartData: { date: string }[];
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
  valueUnit = "units",
}: TimeSeriesChartProps) {
  // v3.10 (2026-08-12): pick formatter once so Y-axis + tooltip agree.
  const yFormatter = valueUnit === "usd" ? formatYAxisCurrency : formatYAxis;
  const [range, setRange] = useState<DateRange>("all");

  // v3.12 (2026-08-12): custom date-range picker state. `customRange` holds
  // the in-progress/selected picker value; `appliedCustomRange` is what the
  // chart actually filters by (only set once the user has picked both ends).
  const [customRange, setCustomRange] = useState<DayPickerRange | undefined>(undefined);
  const [appliedCustomRange, setAppliedCustomRange] = useState<DayPickerRange | undefined>(undefined);
  const [customPickerOpen, setCustomPickerOpen] = useState(false);

  // Filter data by date range
  const filteredData = useMemo(() => {
    if (!data?.length) return [];
    if (range === "custom") {
      if (!appliedCustomRange?.from) return data;
      const fromIso = format(appliedCustomRange.from, "yyyy-MM-dd");
      const toIso = format(appliedCustomRange.to ?? appliedCustomRange.from, "yyyy-MM-dd");
      return data.filter((d) => d.date >= fromIso && d.date <= toIso);
    }
    if (range === "all") return data;
    const cutoff = subDays(new Date(), range === "30" ? 30 : 90);
    return data.filter((d) => parseISO(d.date) >= cutoff);
  }, [data, range, appliedCustomRange]);

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

  // v3.3.1 (2026-08-11): inject a synthetic datapoint at the release date if
  // one doesn't already exist. This lets ReferenceLine anchor the marker at
  // the true release day (e.g. Sept 9) even when the underlying series has
  // gaps around that day (weekly telemetry, monthly rollups, etc.).
  //
  // The synthetic point has null values (so it doesn't affect the area/bar
  // shapes when connectNulls is set to false — which is the default). It
  // gets a real, always-unique ISO `date` (the release date itself, which by
  // construction never collides with an existing row — see the `exact`
  // check below), so no separate sentinel key is needed.
  //
  // v3.12 (2026-08-12) BUG FIX: XAxis/ReferenceLine used to key off a
  // formatted `displayDate` string (e.g. "May '24") instead of the raw ISO
  // `date`. When a range spans multiple years, `displayDate` intentionally
  // drops the day ("MMM ''yy") for readability — which means every day in
  // the same month collapsed onto the same category value. Recharts'
  // categorical axis can't disambiguate duplicate category values, so on
  // "All Time" (which always spans multiple years for a title this old)
  // every `ReferenceLine x={displayDate}` silently failed to render. Fix:
  // the chart now keys XAxis/ReferenceLine off the always-unique raw `date`,
  // and only uses the formatted string for tick labels / tooltip (see
  // `dateTickFmt` below and the labelFormatter usage in ChartTooltip).
  const chartData = useMemo(() => {
    const base = filteredData.map((d) => ({
      ...d,
      isReleaseMarker: false as boolean,
    }));

    if (!showsReleaseDate || !releaseDate || base.length === 0) return base;

    // If any existing point already sits on the release date, don't inject.
    const exact = base.find((d) => d.date === releaseDate);
    if (exact) return base;

    // Release date outside the visible window — leave the array alone.
    if (releaseDate < base[0].date || releaseDate > base[base.length - 1].date) return base;

    // Inject synthetic marker at the release date; sort by date so it lands
    // in the right slot. Use `null as any` values so Recharts renders a gap
    // rather than plotting a 0-value point that would drag the line down.
    const marker = {
      date: releaseDate,
      cumulativeCount: null as any,
      dailyDelta: null as any,
      isReleaseMarker: true,
    };
    const merged = [...base, marker].sort((a, b) => a.date.localeCompare(b.date));
    return merged;
  }, [filteredData, showsReleaseDate, releaseDate]);

  // Tick/tooltip-only formatter (NOT used as an axis/ReferenceLine key —
  // see bug-fix note above). Same abbreviation rule as before: drop the day
  // when the visible range spans multiple years, to keep tick labels short.
  const dateTickFmt = useCallback(
    (isoDate: string) =>
      spansMultipleYears
        ? format(new Date(isoDate + "T00:00:00"), "MMM ''yy")
        : format(new Date(isoDate + "T00:00:00"), "MMM d"),
    [spansMultipleYears]
  );

  // Only milestones with actualDate set
  const activeMilestones = useMemo(
    () => milestones.filter((m) => m.actualDate != null),
    [milestones]
  );

  // v3.3.1 (2026-08-11): resolve the ReferenceLine anchor — either the real
  // datapoint's date (if release day has telemetry) or the synthetic
  // marker's date (if we injected one above). v3.12: anchor on the raw ISO
  // date, not the formatted display string (see bug-fix note above).
  const releaseDatePoint = useMemo(() => {
    if (!showsReleaseDate || !releaseDate || chartData.length === 0) return null;
    const target = chartData.find((d) => d.date === releaseDate);
    if (!target) return null;
    return { date: target.date };
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
    // v3.12: raw ISO date — always unique, so ReferenceLine matching works
    // regardless of range. Display formatting happens only in tickFormatter.
    dataKey: "date",
    tick: { fontSize: 10, fill: "currentColor", opacity: 0.55 },
    tickLine: false,
    axisLine: false,
    interval: Math.max(0, Math.floor(chartData.length / 6) - 1),
    tickFormatter: (val: string) => dateTickFmt(val),
  };

  const yAxisProps = {
    tickFormatter: yFormatter,
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
          {/* v3.12 (2026-08-12): custom date-range filter, shared across every
              PDP chart (this component is used for every product's Steam
              wishlist/prepurchase/revenue and PS5 charts). */}
          <Popover open={customPickerOpen} onOpenChange={setCustomPickerOpen}>
            <PopoverTrigger asChild>
              <button
                onClick={() => setCustomRange(appliedCustomRange)}
                className={`flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                  range === "custom"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
              >
                <CalendarIcon className="h-3 w-3" />
                {range === "custom" && appliedCustomRange?.from
                  ? `${format(appliedCustomRange.from, "MMM d")}${
                      appliedCustomRange.to ? ` – ${format(appliedCustomRange.to, "MMM d")}` : ""
                    }`
                  : "Custom"}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="end">
              <Calendar
                mode="range"
                selected={customRange}
                onSelect={setCustomRange}
                numberOfMonths={2}
                defaultMonth={customRange?.from ?? subDays(new Date(), 60)}
                disabled={{ after: new Date() }}
                initialFocus
              />
              <div className="flex items-center justify-end gap-2 border-t border-border p-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={() => setCustomPickerOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="h-7 text-[11px]"
                  disabled={!customRange?.from}
                  onClick={() => {
                    setAppliedCustomRange(customRange);
                    setRange("custom");
                    setCustomPickerOpen(false);
                  }}
                >
                  Apply
                </Button>
              </div>
            </PopoverContent>
          </Popover>
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
              Cumulative Units
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
                    content={<ChartTooltip valueLabel={valueUnit === "usd" ? "Cumulative" : "Count"} valueUnit={valueUnit} />}
                    cursor={{ stroke: color, strokeWidth: 1, strokeOpacity: 0.4 }}
                  />
                  {visibleMilestones.map((m) => {
                    const point = chartData.find((d) => d.date === m.actualDate);
                    if (!point) return null;
                    const mColor = getMilestoneColor(m.category);
                    return (
                      <ReferenceLine
                        key={`${m.name}-cum`}
                        x={point.date}
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
                      x={releaseDatePoint.date}
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
                    connectNulls  // bridge across the synthetic release-marker gap
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
              Daily Units
            </div>
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" {...gridStyle} />
                <XAxis {...xAxisProps} />
                <YAxis {...yAxisProps} />
                <Tooltip
                  content={<ChartTooltip valueLabel="Daily" valueUnit={valueUnit} />}
                  cursor={{ fill: color, fillOpacity: 0.06 }}
                />
                {visibleMilestones.map((m) => {
                  const point = chartData.find((d) => d.date === m.actualDate);
                  if (!point) return null;
                  const mColor = getMilestoneColor(m.category);
                  return (
                    <ReferenceLine
                      key={`${m.name}-delta`}
                      x={point.date}
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
                    x={releaseDatePoint.date}
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
  /**
   * v3.12 (2026-08-12): 'cumulative' (default) plots the running total, which
   * over a 30-day slice reads as a smooth all-time-style ramp. 'delta' plots
   * day-over-day movement so the preview actually looks like a fluctuating
   * chart — used on the Steam Sales by Units/Revenue cards so the sparkline
   * signals "click for a real chart" rather than looking like a static ramp.
   */
  mode?: "cumulative" | "delta";
}

export function SparklineChart({ data, color, mode = "cumulative" }: SparklineProps) {
  const last30 = useMemo(() => {
    if (!data?.length) return [];
    return data.slice(-30).map((d) => ({
      v: mode === "delta" ? d.dailyDelta : d.cumulativeCount,
    }));
  }, [data, mode]);

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

// ─── SectionSparkline (v3.10, 2026-08-12) ─────────────────────────────────
//
// Wraps SparklineChart with a react-query fetch so it can be dropped into
// any collapsible section on a product card. Was previously defined inline
// in product-detail.tsx; moved here so steam-sales-card.tsx can reuse it.

import { useQuery as useSectionQuery } from "@tanstack/react-query";

export function SectionSparkline({
  productId: _productId,
  endpoint,
  color,
  mode = "cumulative",
}: {
  productId: number;
  endpoint: string;
  color: string;
  mode?: "cumulative" | "delta";
}) {
  const { data } = useSectionQuery<TimeSeriesDataPoint[]>({
    queryKey: [endpoint],
    staleTime: 60_000,
  });
  if (!data || data.length < 3) return null;
  return (
    <div className="h-[60px] w-full -mx-0">
      <SparklineChart data={data} color={color} mode={mode} />
    </div>
  );
}
