import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, subDays } from "date-fns";
import type { DateRange as DayPickerRange } from "react-day-picker";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { CalendarIcon, Download, LineChart as LineChartIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatNumber } from "@/lib/utils";
import type { TimeSeriesDataPoint } from "./time-series-chart";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CompareCandidate {
  productId: number;
  title: string;
}

interface CompareChartModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  board: "wishlist" | "revenue";
  candidates: CompareCandidate[];
}

// v3.34: mirrors the shared PeriodPreset options; "7" is new here — the
// single-product TimeSeriesChart only offers 30/90/all, but this compare
// tool's spec explicitly calls for a 7-day preset too. Added here rather
// than retrofit the shared chart (scope discipline).
type Period = "7" | "30" | "90" | "all" | "custom";

type MergedRow = { date: string } & Record<string, number | undefined>;

const SLOT_COLORS = ["#20808D", "#A84B2F", "#1B474D"]; // design-system chart sequence, colorblind-safer than red/green

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getEndpoint(board: "wishlist" | "revenue", productId: number): string {
  return board === "wishlist"
    ? `/api/products/${productId}/steam/wishlists`
    : `/api/products/${productId}/steam/revenue-daily`;
}

function formatYAxis(value: number, board: "wishlist" | "revenue"): string {
  if (board === "revenue") {
    if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
    if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
    return `$${Math.round(value)}`;
  }
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return String(value);
}

// CSV field quoting — wrap in double quotes and escape any embedded quotes.
// Titles occasionally contain commas or apostrophes, so every header field
// is quoted defensively even though most won't need it.
function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function CompareChartModal({ open, onOpenChange, board, candidates }: CompareChartModalProps) {
  const [slots, setSlots] = useState<(number | null)[]>([null, null, null]);
  const [period, setPeriod] = useState<Period>("30");
  const [customRange, setCustomRange] = useState<DayPickerRange | undefined>(undefined);
  const [appliedCustomRange, setAppliedCustomRange] = useState<DayPickerRange | undefined>(undefined);
  const [customPickerOpen, setCustomPickerOpen] = useState(false);
  const [generated, setGenerated] = useState(false);

  const selectedIds = slots.filter((s): s is number => s != null);
  const label = board === "wishlist" ? "Wishlist Total" : "Cumulative Revenue";
  const metricNoun = board === "wishlist" ? "wishlist counts" : "revenue";

  const queries = [0, 1, 2].map((i) => {
    const id = slots[i];
    return useQuery<TimeSeriesDataPoint[]>({
      queryKey: [id != null ? getEndpoint(board, id) : `compare-empty-slot-${i}`],
      enabled: open && id != null,
    });
  });

  const isLoading = selectedIds.length > 0 && queries.some((q, i) => slots[i] != null && q.isLoading);

  // Union-by-date merge across up to 3 series, each keeping its own
  // cumulativeCount + dailyDelta under a per-slot key. Missing dates for a
  // given title are left undefined so the chart can connectNulls and the
  // CSV can emit an empty cell instead of a literal "null".
  const merged = useMemo(() => {
    const byDate = new Map<string, Record<string, number | undefined>>();
    for (let i = 0; i < 3; i++) {
      const id = slots[i];
      if (id == null) continue;
      const data = queries[i].data ?? [];
      for (const point of data) {
        const row = byDate.get(point.date) ?? {};
        row[`s${i}_cum`] = point.cumulativeCount;
        row[`s${i}_delta`] = point.dailyDelta;
        byDate.set(point.date, row);
      }
    }
    const dates = Array.from(byDate.keys()).sort();
    return dates.map((date) => ({ date, ...byDate.get(date) }) as MergedRow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots, queries[0].data, queries[1].data, queries[2].data]);

  const filtered = useMemo(() => {
    if (period === "all") return merged;
    if (period === "custom") {
      if (!appliedCustomRange?.from) return merged;
      const fromIso = format(appliedCustomRange.from, "yyyy-MM-dd");
      const toIso = format(appliedCustomRange.to ?? appliedCustomRange.from, "yyyy-MM-dd");
      return merged.filter((d) => d.date >= fromIso && d.date <= toIso);
    }
    const days = period === "7" ? 7 : period === "30" ? 30 : 90;
    const cutoff = format(subDays(new Date(), days), "yyyy-MM-dd");
    return merged.filter((d) => d.date >= cutoff);
  }, [merged, period, appliedCustomRange]);

  function titleFor(id: number | null): string {
    if (id == null) return "";
    return candidates.find((c) => c.productId === id)?.title ?? `#${id}`;
  }

  function setSlot(index: number, value: string) {
    setSlots((prev) => {
      const next = [...prev];
      next[index] = value === "none" ? null : Number(value);
      return next;
    });
    setGenerated(false);
  }

  function handleGenerate() {
    setGenerated(true);
  }

  function handleExportCsv() {
    const activeSlots = [0, 1, 2].filter((i) => slots[i] != null);
    const headerCells = [
      "Date",
      ...activeSlots.flatMap((i) => [
        csvField(`${titleFor(slots[i])} - ${label}`),
        csvField(`${titleFor(slots[i])} - Daily Change`),
      ]),
    ];
    const lines = [headerCells.join(",")];
    for (const row of filtered) {
      const cells = [
        row.date,
        ...activeSlots.flatMap((i) => {
          const cum = row[`s${i}_cum`];
          const delta = row[`s${i}_delta`];
          return [cum == null ? "" : String(cum), delta == null ? "" : String(delta)];
        }),
      ];
      lines.push(cells.join(","));
    }
    const csv = lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const rangeLabel = period === "custom" ? "custom" : period === "all" ? "lifetime" : `${period}d`;
    const titlesLabel = activeSlots.map((i) => titleFor(slots[i]).replace(/[^a-z0-9]/gi, "-")).join("_vs_");
    a.download = `signalpulse-compare-${board}-${rangeLabel}-${titlesLabel}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleClose(next: boolean) {
    if (!next) {
      setSlots([null, null, null]);
      setPeriod("30");
      setCustomRange(undefined);
      setAppliedCustomRange(undefined);
      setGenerated(false);
    }
    onOpenChange(next);
  }

  const canGenerate = selectedIds.length > 0;
  const chartLoading = generated && isLoading;
  const chartReady = generated && !isLoading && selectedIds.length > 0;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-5xl w-full p-0 overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between px-5 pt-5 pb-3 border-b">
          <div>
            <DialogTitle className="text-base font-semibold leading-snug flex items-center gap-2">
              <LineChartIcon className="h-4 w-4 text-muted-foreground" />
              Compare Titles — {board === "wishlist" ? "Wishlist" : "Revenue"}
            </DialogTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Choose up to three titles to overlay their {metricNoun} on one chart
            </p>
          </div>
          {chartReady && filtered.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[11px] gap-1.5 ml-4 shrink-0"
              onClick={handleExportCsv}
              data-testid="button-compare-export-csv"
            >
              <Download className="h-3 w-3" />
              Export CSV
            </Button>
          )}
        </div>

        <div className="px-5 py-4 max-h-[80vh] overflow-y-auto space-y-4">
          {/* Title selectors */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="space-y-1">
                <label className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: SLOT_COLORS[i] }}
                  />
                  Title {i + 1}
                </label>
                <Select value={slots[i] == null ? "none" : String(slots[i])} onValueChange={(v) => setSlot(i, v)}>
                  <SelectTrigger className="h-9 text-xs" data-testid={`select-compare-slot-${i}`}>
                    <SelectValue placeholder="Select a title…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">— None —</SelectItem>
                    {candidates
                      .filter((c) => !slots.includes(c.productId) || slots[i] === c.productId)
                      .map((c) => (
                        <SelectItem key={c.productId} value={String(c.productId)}>
                          {c.title}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>

          {/* Period selector + Generate */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-1">
              {(["7", "30", "90", "all"] as Period[]).map((r) => (
                <button
                  key={r}
                  onClick={() => {
                    setPeriod(r);
                    setGenerated(false);
                  }}
                  className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                    period === r
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                  }`}
                  data-testid={`button-compare-period-${r}`}
                >
                  {r === "all" ? "Lifetime" : `${r} Days`}
                </button>
              ))}
              <Popover open={customPickerOpen} onOpenChange={setCustomPickerOpen}>
                <PopoverTrigger asChild>
                  <button
                    onClick={() => setCustomRange(appliedCustomRange)}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                      period === "custom"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted"
                    }`}
                    data-testid="button-compare-period-custom"
                  >
                    <CalendarIcon className="h-3 w-3" />
                    {period === "custom" && appliedCustomRange?.from
                      ? `${format(appliedCustomRange.from, "MMM d")}${
                          appliedCustomRange.to ? ` – ${format(appliedCustomRange.to, "MMM d")}` : ""
                        }`
                      : "Custom"}
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
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
                        setPeriod("custom");
                        setGenerated(false);
                        setCustomPickerOpen(false);
                      }}
                    >
                      Apply
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
            </div>

            <Button
              size="sm"
              className="h-8 text-xs gap-1.5"
              disabled={!canGenerate}
              onClick={handleGenerate}
              data-testid="button-compare-generate"
            >
              <LineChartIcon className="h-3.5 w-3.5" />
              Generate Chart
            </Button>
          </div>

          {/* Chart */}
          {!generated ? (
            <div className="flex flex-col items-center justify-center py-16 text-center border border-dashed rounded-lg">
              <LineChartIcon className="h-8 w-8 text-muted-foreground/40 mb-3" />
              <p className="text-xs text-muted-foreground">
                {canGenerate
                  ? "Pick a time period and click Generate Chart"
                  : "Select at least one title to compare"}
              </p>
            </div>
          ) : chartLoading ? (
            <Skeleton className="h-[340px] w-full rounded-lg" />
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center border border-dashed rounded-lg">
              <p className="text-xs text-muted-foreground">No data in the selected period</p>
            </div>
          ) : (
            <div className="h-[340px] w-full" data-testid="chart-compare-result">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={filtered} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.3} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11 }}
                    tickFormatter={(d: string) => format(new Date(d + "T00:00:00"), "MMM d")}
                    minTickGap={30}
                  />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    tickFormatter={(v: number) => formatYAxis(v, board)}
                    width={48}
                  />
                  <Tooltip
                    labelFormatter={(d: string) => format(new Date(d + "T00:00:00"), "MMM d, yyyy")}
                    formatter={(value: number, name: string) => [
                      board === "revenue" ? formatCurrency(value) : formatNumber(value),
                      name,
                    ]}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {[0, 1, 2].map((i) =>
                    slots[i] == null ? null : (
                      <Line
                        key={i}
                        type="monotone"
                        dataKey={`s${i}_cum`}
                        name={titleFor(slots[i])}
                        stroke={SLOT_COLORS[i]}
                        strokeWidth={2}
                        dot={false}
                        connectNulls
                        isAnimationActive={false}
                      />
                    ),
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
