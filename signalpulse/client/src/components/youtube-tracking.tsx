import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Plus,
  Trash2,
  RefreshCw,
  ExternalLink,
  BarChart3,
  Eye,
  ChevronDown,
  ChevronUp,
  Loader2,
  Youtube,
} from "lucide-react";
import { useState, useMemo } from "react";
import { format, subDays, parseISO } from "date-fns";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";

// ─── Types ───────────────────────────────────────────────────────────────────

interface YoutubeLink {
  id: number;
  milestoneId: number;
  youtubeVideoId: string;
  youtubeUrl: string;
  channelName: string | null;
  videoTitle: string | null;
  isOfficial: boolean;
  createdAt: string;
}

interface YoutubeVideoDaily {
  id: number;
  youtubeLinkId: number;
  date: string;
  cumulativeViews: number;
  dailyDelta: number;
}

interface AggregateData {
  totalViews: number;
  officialViews: number;
  reuploadViews: number;
  videos: Array<{
    link: YoutubeLink;
    latestViews: number;
    dailyData: YoutubeVideoDaily[];
  }>;
  aggregateTimeSeries: Array<{
    date: string;
    cumulativeViews: number;
    dailyDelta: number;
  }>;
}

interface FetchInfoResult {
  videoId: string;
  title: string;
  channelName: string;
  viewCount: number | null;
  thumbnailUrl: string;
}

interface YouTubeTrackingPanelProps {
  milestoneId: number;
  milestoneName: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatViewCount(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return n.toLocaleString("en-US");
}

function formatYAxis(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return String(value);
}

const VIDEO_COLORS = [
  "#FF0000", // YouTube red for first (official)
  "#3B82F6", // Blue
  "#22C55E", // Green
  "#F59E0B", // Amber
  "#8B5CF6", // Purple
  "#EC4899", // Pink
];

// ─── Chart Tooltip ───────────────────────────────────────────────────────────

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: any[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-popover text-popover-foreground border border-border rounded-md shadow-md px-3 py-2 text-xs">
      <div className="font-medium mb-1">{label}</div>
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-2">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: p.color || p.stroke }}
          />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-semibold">{formatViewCount(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

// ─── YouTube Charts Modal ─────────────────────────────────────────────────────

function YouTubeChartsModal({
  open,
  onOpenChange,
  milestoneName,
  aggregate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  milestoneName: string;
  aggregate: AggregateData;
}) {
  const [range, setRange] = useState<"30" | "90" | "all">("all");

  const filteredAggData = useMemo(() => {
    if (!aggregate?.aggregateTimeSeries?.length) return [];
    const data = aggregate.aggregateTimeSeries;
    if (range === "all") return data;
    const cutoff = subDays(new Date(), range === "30" ? 30 : 90);
    return data.filter((d) => parseISO(d.date) >= cutoff);
  }, [aggregate, range]);

  const chartData = useMemo(
    () =>
      filteredAggData.map((d) => ({
        ...d,
        displayDate: format(new Date(d.date + "T00:00:00"), "MMM d"),
      })),
    [filteredAggData]
  );

  // Build per-video chart data (multi-line)
  const perVideoChartData = useMemo(() => {
    if (!aggregate?.videos?.length) return [];

    // Collect all dates
    const allDates = new Set<string>();
    for (const v of aggregate.videos) {
      for (const d of v.dailyData) allDates.add(d.date);
    }
    const sortedDates = Array.from(allDates).sort();

    // Filter by range
    const cutoff =
      range === "all"
        ? null
        : subDays(new Date(), range === "30" ? 30 : 90);
    const filteredDates = cutoff
      ? sortedDates.filter((d) => parseISO(d) >= cutoff)
      : sortedDates;

    return filteredDates.map((date) => {
      const point: any = {
        date,
        displayDate: format(new Date(date + "T00:00:00"), "MMM d"),
      };
      for (const v of aggregate.videos) {
        const entry = v.dailyData.find((d) => d.date === date);
        point[`video_${v.link.id}`] = entry?.cumulativeViews ?? null;
      }
      return point;
    });
  }, [aggregate, range]);

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
    width: 48,
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl w-full p-0 overflow-hidden">
        <div className="flex items-start justify-between px-5 pt-5 pb-3 border-b">
          <div>
            <DialogTitle className="text-base font-semibold leading-snug flex items-center gap-2">
              <Youtube className="h-4 w-4 text-red-500" />
              YouTube Views — {milestoneName}
            </DialogTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Aggregate and per-video view tracking
            </p>
          </div>
        </div>

        <div className="px-5 py-4 max-h-[80vh] overflow-y-auto space-y-6">
          {/* Range buttons */}
          <div className="flex items-center justify-end gap-1">
            {(["30", "90", "all"] as const).map((r) => (
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

          {chartData.length === 0 ? (
            <div className="h-[200px] flex items-center justify-center text-muted-foreground text-xs">
              No view data available yet
            </div>
          ) : (
            <>
              {/* Aggregate Cumulative Chart */}
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 font-medium">
                  Aggregate Cumulative Views
                </div>
                <ResponsiveContainer width="100%" height={180}>
                  <AreaChart
                    data={chartData}
                    margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient
                        id="ytAggGrad"
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop offset="5%" stopColor="#FF0000" stopOpacity={0.15} />
                        <stop offset="95%" stopColor="#FF0000" stopOpacity={0.01} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid
                      vertical={false}
                      strokeDasharray="3 3"
                      {...gridStyle}
                    />
                    <XAxis {...xAxisProps} />
                    <YAxis {...yAxisProps} />
                    <Tooltip content={<ChartTooltip />} />
                    <Area
                      type="monotone"
                      dataKey="cumulativeViews"
                      name="Total Views"
                      stroke="#FF0000"
                      strokeWidth={2}
                      fill="url(#ytAggGrad)"
                      dot={false}
                      activeDot={{ r: 4, fill: "#FF0000", strokeWidth: 0 }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              {/* Aggregate Daily Delta Chart */}
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 font-medium">
                  Aggregate Daily View Changes
                </div>
                <ResponsiveContainer width="100%" height={140}>
                  <BarChart
                    data={chartData}
                    margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid
                      vertical={false}
                      strokeDasharray="3 3"
                      {...gridStyle}
                    />
                    <XAxis {...xAxisProps} />
                    <YAxis {...yAxisProps} />
                    <Tooltip content={<ChartTooltip />} />
                    <Bar
                      dataKey="dailyDelta"
                      name="Daily Views"
                      fill="#FF0000"
                      fillOpacity={0.7}
                      radius={[2, 2, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Per-video lines */}
              {aggregate.videos.length > 1 && perVideoChartData.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 font-medium">
                    Per-Video Cumulative Views
                  </div>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart
                      data={perVideoChartData}
                      margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                    >
                      <CartesianGrid
                        vertical={false}
                        strokeDasharray="3 3"
                        {...gridStyle}
                      />
                      <XAxis {...xAxisProps} />
                      <YAxis {...yAxisProps} />
                      <Tooltip content={<ChartTooltip />} />
                      <Legend
                        wrapperStyle={{ fontSize: "11px" }}
                        iconType="circle"
                        iconSize={8}
                      />
                      {aggregate.videos.map((v, idx) => (
                        <Line
                          key={v.link.id}
                          type="monotone"
                          dataKey={`video_${v.link.id}`}
                          name={v.link.channelName || `Video ${idx + 1}`}
                          stroke={VIDEO_COLORS[idx % VIDEO_COLORS.length]}
                          strokeWidth={1.5}
                          dot={false}
                          activeDot={{ r: 3 }}
                          connectNulls
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function YouTubeTrackingPanel({
  milestoneId,
  milestoneName,
}: YouTubeTrackingPanelProps) {
  const { toast } = useToast();
  const [showAddForm, setShowAddForm] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [fetchedInfo, setFetchedInfo] = useState<FetchInfoResult | null>(null);
  const [isOfficial, setIsOfficial] = useState(true);
  const [showCharts, setShowCharts] = useState(false);

  // ─── Queries ────────────────────────────────────────────────────────────────

  const {
    data: aggregate,
    isLoading: aggLoading,
  } = useQuery<AggregateData>({
    queryKey: ["/api/pls", milestoneId, "/youtube/aggregate"],
  });

  // ─── Mutations ──────────────────────────────────────────────────────────────

  const fetchInfoMutation = useMutation({
    mutationFn: async (url: string) => {
      const res = await apiRequest(
        "POST",
        `/api/pls/${milestoneId}/youtube/fetch-info`,
        { youtubeUrl: url }
      );
      return res.json() as Promise<FetchInfoResult>;
    },
    onSuccess: (data) => {
      setFetchedInfo(data);
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to fetch video info",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const addVideoMutation = useMutation({
    mutationFn: async (data: {
      youtubeVideoId: string;
      youtubeUrl: string;
      channelName: string;
      videoTitle: string;
      isOfficial: boolean;
      viewCount: number | null;
    }) => {
      const res = await apiRequest(
        "POST",
        `/api/pls/${milestoneId}/youtube`,
        data
      );
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/pls", milestoneId, "/youtube/aggregate"],
      });
      setShowAddForm(false);
      setUrlInput("");
      setFetchedInfo(null);
      setIsOfficial(true);
      toast({ title: "Video added to tracking" });
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to add video",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const deleteVideoMutation = useMutation({
    mutationFn: async (linkId: number) => {
      await apiRequest(
        "DELETE",
        `/api/pls/${milestoneId}/youtube/${linkId}`,
        undefined
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/pls", milestoneId, "/youtube/aggregate"],
      });
      toast({ title: "Video removed from tracking" });
    },
  });

  const refreshViewsMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/youtube/refresh-views`, {
        milestoneId,
      });
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({
        queryKey: ["/api/pls", milestoneId, "/youtube/aggregate"],
      });
      toast({
        title: "Views refreshed",
        description: `Updated ${data.updated} video(s)`,
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to refresh views",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // ─── Handlers ───────────────────────────────────────────────────────────────

  const handleFetchInfo = () => {
    if (!urlInput.trim()) return;
    setFetchedInfo(null);
    fetchInfoMutation.mutate(urlInput.trim());
  };

  const handleAddVideo = () => {
    if (!fetchedInfo) return;
    addVideoMutation.mutate({
      youtubeVideoId: fetchedInfo.videoId,
      youtubeUrl: urlInput.trim(),
      channelName: fetchedInfo.channelName,
      videoTitle: fetchedInfo.title,
      isOfficial,
      viewCount: fetchedInfo.viewCount,
    });
  };

  const handleCancelAdd = () => {
    setShowAddForm(false);
    setUrlInput("");
    setFetchedInfo(null);
    setIsOfficial(true);
  };

  // Check if this milestone already has no videos (for first-video default)
  const hasExistingVideos = (aggregate?.videos?.length ?? 0) > 0;

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (aggLoading) {
    return (
      <div className="p-3 space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  return (
    <div className="border-t border-border/50 bg-muted/15 px-3 py-3 space-y-3">
      {/* Header Row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Youtube className="h-3.5 w-3.5 text-red-500" />
          <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
            YouTube Tracking
          </span>
          {aggregate && aggregate.totalViews > 0 && (
            <Badge
              variant="secondary"
              className="text-[10px] px-1.5 py-0 h-4 font-semibold tabular-nums"
            >
              <Eye className="h-2.5 w-2.5 mr-0.5" />
              {formatViewCount(aggregate.totalViews)} total views
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {hasExistingVideos && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowCharts(true)}
                className="h-6 text-[10px] gap-1 px-2"
              >
                <BarChart3 className="h-3 w-3" />
                View Charts
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => refreshViewsMutation.mutate()}
                disabled={refreshViewsMutation.isPending}
                className="h-6 text-[10px] gap-1 px-2"
              >
                <RefreshCw
                  className={`h-3 w-3 ${refreshViewsMutation.isPending ? "animate-spin" : ""}`}
                />
                Refresh
              </Button>
            </>
          )}
          {!showAddForm && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setShowAddForm(true);
                // Default first video as official
                if (!hasExistingVideos) setIsOfficial(true);
              }}
              className="h-6 text-[10px] gap-1 px-2"
            >
              <Plus className="h-3 w-3" />
              Add Video
            </Button>
          )}
        </div>
      </div>

      {/* Aggregate Stats */}
      {aggregate && aggregate.totalViews > 0 && (
        <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
          <span>
            Official:{" "}
            <span className="font-semibold text-foreground">
              {formatViewCount(aggregate.officialViews)}
            </span>
          </span>
          <span>
            Re-uploads / Commentary:{" "}
            <span className="font-semibold text-foreground">
              {formatViewCount(aggregate.reuploadViews)}
            </span>
          </span>
        </div>
      )}

      {/* Video Cards */}
      {aggregate?.videos && aggregate.videos.length > 0 && (
        <div className="space-y-1.5">
          {aggregate.videos.map((v, idx) => (
            <div
              key={v.link.id}
              className="flex items-center gap-3 px-2.5 py-2 rounded-md bg-background/60 border border-border/40 group"
            >
              {/* Thumbnail */}
              <div className="shrink-0 w-[72px] h-[40px] rounded overflow-hidden bg-muted">
                <img
                  src={`https://img.youtube.com/vi/${v.link.youtubeVideoId}/default.jpg`}
                  alt=""
                  className="w-full h-full object-cover"
                />
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <a
                    href={v.link.youtubeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-medium truncate hover:text-primary transition-colors"
                    title={v.link.videoTitle || ""}
                  >
                    {v.link.videoTitle || "Untitled Video"}
                  </a>
                  <ExternalLink className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[10px] text-muted-foreground">
                    {v.link.channelName || "Unknown Channel"}
                  </span>
                  {v.link.isOfficial && (
                    <Badge
                      variant="default"
                      className="text-[8px] px-1 py-0 h-3 bg-red-500/90 hover:bg-red-500"
                    >
                      Official
                    </Badge>
                  )}
                </div>
              </div>

              {/* View count */}
              <div className="shrink-0 text-right">
                <div className="text-xs font-semibold tabular-nums">
                  {formatViewCount(v.latestViews)}
                </div>
                <div className="text-[9px] text-muted-foreground">views</div>
              </div>

              {/* Delete */}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => deleteVideoMutation.mutate(v.link.id)}
                className="h-6 w-6 text-muted-foreground hover:text-destructive shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {(!aggregate?.videos || aggregate.videos.length === 0) && !showAddForm && (
        <p className="text-[10px] text-muted-foreground/50 py-1">
          No YouTube videos tracked yet. Click "Add Video" to start.
        </p>
      )}

      {/* Add Video Form */}
      {showAddForm && (
        <div className="border border-border/60 rounded-md bg-background/80 p-3 space-y-3">
          <div className="text-xs font-medium">Add YouTube Video</div>

          {/* URL input + fetch */}
          <div className="flex items-center gap-2">
            <Input
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="Paste YouTube URL (e.g., https://youtube.com/watch?v=...)"
              className="h-8 text-xs flex-1"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleFetchInfo();
              }}
            />
            <Button
              size="sm"
              onClick={handleFetchInfo}
              disabled={!urlInput.trim() || fetchInfoMutation.isPending}
              className="h-8 text-xs px-3"
            >
              {fetchInfoMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                "Fetch Info"
              )}
            </Button>
          </div>

          {/* Preview */}
          {fetchedInfo && (
            <div className="flex items-start gap-3 p-2.5 rounded bg-muted/40 border border-border/30">
              <div className="shrink-0 w-[100px] h-[56px] rounded overflow-hidden bg-muted">
                <img
                  src={fetchedInfo.thumbnailUrl}
                  alt=""
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="flex-1 min-w-0 space-y-1">
                <div className="text-xs font-medium leading-tight truncate">
                  {fetchedInfo.title}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {fetchedInfo.channelName}
                </div>
                {fetchedInfo.viewCount != null && (
                  <div className="text-[10px] text-muted-foreground">
                    {formatViewCount(fetchedInfo.viewCount)} views
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Official checkbox + actions */}
          {fetchedInfo && (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`official-${milestoneId}`}
                  checked={isOfficial}
                  onCheckedChange={(checked) => setIsOfficial(checked === true)}
                />
                <label
                  htmlFor={`official-${milestoneId}`}
                  className="text-xs text-muted-foreground cursor-pointer"
                >
                  This is the official upload
                </label>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCancelAdd}
                  className="h-7 text-xs"
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleAddVideo}
                  disabled={addVideoMutation.isPending}
                  className="h-7 text-xs"
                >
                  {addVideoMutation.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin mr-1" />
                  ) : (
                    <Plus className="h-3 w-3 mr-1" />
                  )}
                  Add Video
                </Button>
              </div>
            </div>
          )}

          {/* Cancel when no preview yet */}
          {!fetchedInfo && (
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={handleCancelAdd}
                className="h-7 text-xs"
              >
                Cancel
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Charts Modal */}
      {aggregate && (
        <YouTubeChartsModal
          open={showCharts}
          onOpenChange={setShowCharts}
          milestoneName={milestoneName}
          aggregate={aggregate}
        />
      )}
    </div>
  );
}
