import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Game, PlatformTopic } from "@shared/schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SentimentBadge, SentimentBar } from "@/components/sentiment-badge";
import {
  Gamepad2, MessageSquare, Target, LayoutDashboard,
  ChevronRight, Calendar, Building2, MapPin, AlertCircle, Quote
} from "lucide-react";
import { format } from "date-fns";

type GameWithTP = Game & { touchpointCount: number; sentiments: string[]; events: string[] };
type TopicWithStats = PlatformTopic & { feedbackCount: number; posCount: number; neutCount: number; negCount: number };

interface TopicEntry {
  meetingTopicId: number;
  sentiment: string | null;
  feedbackSummary: string | null;
  requestOrBlocker: string | null;
  priority: string | null;
  meetingId: number;
  meetingDate: string | null;
  meetingLocation: string | null;
  companyName: string;
  eventId: number;
  eventName: string;
}

interface GameEntry {
  meetingGameId: number;
  gameSpecificSentiment: string | null;
  discussionSummary: string | null;
  dealStatus: string | null;
  projectedLaunchTiming: string | null;
  keyQuotes: string | null;
  meetingId: number;
  meetingDate: string | null;
  meetingLocation: string | null;
  companyName: string;
  eventId: number;
  eventName: string;
}

const priorityColors: Record<string, string> = {
  high: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  medium: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  low: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

const dealStatusLabels: Record<string, string> = {
  initial_outreach: "Initial Outreach",
  in_negotiation: "Negotiating",
  signed: "Signed",
  lost: "Lost",
};

function TopicDetailSheet({ topic, open, onClose }: { topic: TopicWithStats | null; open: boolean; onClose: () => void }) {
  const { data: entries, isLoading } = useQuery<TopicEntry[]>({
    queryKey: ["/api/platform-topics", topic?.id, "entries"],
    queryFn: async () => {
      const r = await fetch(`/api/platform-topics/${topic!.id}/entries`);
      return r.json();
    },
    enabled: !!topic && open,
  });

  return (
    <Sheet open={open} onOpenChange={v => !v && onClose()}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader className="mb-4">
          <SheetTitle className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-primary" />
            {topic?.name}
          </SheetTitle>
          {topic && (
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <span className="capitalize">{topic.category}</span>
              <span>· {topic.feedbackCount} feedback {topic.feedbackCount === 1 ? "entry" : "entries"}</span>
              <SentimentBar pos={topic.posCount} neu={topic.neutCount} neg={topic.negCount} />
            </div>
          )}
        </SheetHeader>
        {isLoading && (
          <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />)}</div>
        )}
        <div className="space-y-3">
          {entries?.map(entry => (
            <Card key={entry.meetingTopicId} className="border">
              <CardContent className="p-4 space-y-2">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Building2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className="text-sm font-semibold">{entry.companyName}</span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {entry.sentiment && <SentimentBadge sentiment={entry.sentiment as any} size="sm" />}
                    {entry.priority && (
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium capitalize ${priorityColors[entry.priority] ?? ""}`}>
                        {entry.priority}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                  <a href={`#/events/${entry.eventId}`} className="hover:underline font-medium text-primary">{entry.eventName}</a>
                  {entry.meetingDate && (
                    <span className="flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      {format(new Date(entry.meetingDate + "T12:00:00"), "MMM d, yyyy")}
                    </span>
                  )}
                  {entry.meetingLocation && (
                    <span className="flex items-center gap-1">
                      <MapPin className="w-3 h-3" />{entry.meetingLocation}
                    </span>
                  )}
                </div>
                {entry.feedbackSummary && (
                  <p className="text-sm text-foreground leading-relaxed">{entry.feedbackSummary}</p>
                )}
                {entry.requestOrBlocker && (
                  <div className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 rounded p-2 border border-amber-200 dark:border-amber-900">
                    <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                    <span><span className="font-semibold">Blocker/Request: </span>{entry.requestOrBlocker}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
          {entries?.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">No feedback entries found.</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function GameDetailSheet({ game, open, onClose }: { game: GameWithTP | null; open: boolean; onClose: () => void }) {
  const gameId = game?.id ?? null;
  const { data: entries, isLoading } = useQuery<GameEntry[]>({
    queryKey: ["/api/games", gameId, "entries"],
    queryFn: async () => {
      const r = await fetch(`/api/games/${gameId}/entries`);
      return r.json();
    },
    enabled: !!gameId && open,
    staleTime: 0,
  });

  return (
    <Sheet open={open} onOpenChange={v => !v && onClose()}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader className="mb-4">
          <SheetTitle className="flex items-center gap-2">
            <Gamepad2 className="w-4 h-4 text-primary" />
            {game?.title}
          </SheetTitle>
          {game && (
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <span>{game.touchpointCount} touchpoint{game.touchpointCount !== 1 ? "s" : ""}</span>
              <span>·</span>
              <span>{game.events.join(", ")}</span>
            </div>
          )}
        </SheetHeader>
        {isLoading && (
          <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />)}</div>
        )}
        <div className="space-y-3">
          {entries?.map(entry => (
            <Card key={entry.meetingGameId} className="border">
              <CardContent className="p-4 space-y-2">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Building2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className="text-sm font-semibold">{entry.companyName}</span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {entry.gameSpecificSentiment && <SentimentBadge sentiment={entry.gameSpecificSentiment as any} size="sm" />}
                    {entry.dealStatus && (
                      <Badge variant="outline" className="text-xs">{dealStatusLabels[entry.dealStatus] ?? entry.dealStatus}</Badge>
                    )}
                    {entry.projectedLaunchTiming && (
                      <Badge variant="secondary" className="text-xs">{entry.projectedLaunchTiming}</Badge>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                  <a href={`#/events/${entry.eventId}`} className="hover:underline font-medium text-primary">{entry.eventName}</a>
                  {entry.meetingDate && (
                    <span className="flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      {format(new Date(entry.meetingDate + "T12:00:00"), "MMM d, yyyy")}
                    </span>
                  )}
                  {entry.meetingLocation && (
                    <span className="flex items-center gap-1">
                      <MapPin className="w-3 h-3" />{entry.meetingLocation}
                    </span>
                  )}
                </div>
                {entry.discussionSummary && (
                  <p className="text-sm text-foreground leading-relaxed">{entry.discussionSummary}</p>
                )}
                {entry.keyQuotes && (
                  <div className="flex items-start gap-1.5 text-xs italic text-muted-foreground bg-muted/60 rounded p-2 border">
                    <Quote className="w-3 h-3 mt-0.5 shrink-0" />
                    <span>{entry.keyQuotes}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
          {entries?.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">No touchpoint entries found.</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

type DashboardData = {
  gamesWithTouchpoints: GameWithTP[];
  topicsWithStats: TopicWithStats[];
  events: { id: number; name: string; positiveCount: number; neutralCount: number; negativeCount: number; meetingCount: number }[];
};

const egsStatusColors: Record<string, string> = {
  launched: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800",
  announced: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300 border-blue-200 dark:border-blue-800",
  under_discussion: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-amber-200 dark:border-amber-800",
  not_coming: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300 border-red-200 dark:border-red-800",
  unknown: "bg-muted text-muted-foreground",
};
const egsStatusLabels: Record<string, string> = {
  launched: "Launched", announced: "Announced", under_discussion: "Under Discussion", not_coming: "Not Coming", unknown: "Unknown",
};
const categoryColors: Record<string, string> = {
  commercial: "text-emerald-600 dark:text-emerald-400",
  product: "text-blue-600 dark:text-blue-400",
  tech: "text-purple-600 dark:text-purple-400",
  marketing: "text-orange-600 dark:text-orange-400",
  operations: "text-slate-600 dark:text-slate-400",
};

function overallSentiment(sentiments: string[]): "positive" | "neutral" | "negative" {
  const pos = sentiments.filter(s => s === "positive").length;
  const neg = sentiments.filter(s => s === "negative").length;
  if (neg > pos) return "negative";
  if (pos >= neg + (sentiments.length - pos - neg) && pos > 0) return "positive";
  return "neutral";
}

export default function DashboardPage() {
  const [selectedTopic, setSelectedTopic] = useState<TopicWithStats | null>(null);
  const [selectedGame, setSelectedGame] = useState<GameWithTP | null>(null);

  const { data, isLoading } = useQuery<DashboardData>({
    queryKey: ["/api/dashboard"],
    queryFn: async () => {
      const r = await fetch("/api/dashboard");
      return r.json();
    },
    // Refresh every 8s so the dashboard updates after a parse completes
    refetchInterval: 8000,
    refetchIntervalInBackground: false,
  });

  const totalMeetings = (data?.events ?? []).reduce((s, e) => s + e.meetingCount, 0);
  const totalPos = (data?.events ?? []).reduce((s, e) => s + e.positiveCount, 0);
  const totalNeg = (data?.events ?? []).reduce((s, e) => s + e.negativeCount, 0);
  const totalNeu = (data?.events ?? []).reduce((s, e) => s + e.neutralCount, 0);

  // Only show games/topics that have actual data from ingested reports
  const activeGames = (data?.gamesWithTouchpoints ?? []).filter(g => g.touchpointCount > 0);
  const activeTopics = (data?.topicsWithStats ?? []).filter(t => t.feedbackCount > 0);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <LayoutDashboard className="w-5 h-5 text-primary" />
            Games & Topics Dashboard
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">Cross-event insights — recurring games, platform feedback trends</p>
        </div>
      </div>

      {/* Global stats */}
      {data && (
        <div className="grid grid-cols-4 gap-3 mb-6">
          {[
            { label: "Total Events", value: data.events.length },
            { label: "Total Meetings", value: totalMeetings },
            { label: "Tracked Games", value: activeGames.length },
            { label: "Platform Topics", value: activeTopics.length },
          ].map(s => (
            <Card key={s.label} className="py-0">
              <CardContent className="p-3">
                <p className="text-xs text-muted-foreground">{s.label}</p>
                <p className="text-xl font-bold tabular-nums mt-0.5">{s.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Overall sentiment */}
      {data && totalMeetings > 0 && (
        <Card className="mb-6">
          <CardContent className="p-4">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Portfolio Sentiment</p>
                <div className="flex items-center gap-3">
                  <SentimentBar pos={totalPos} neu={totalNeu} neg={totalNeg} />
                  <span className="text-xs text-muted-foreground">
                    {totalPos} positive · {totalNeu} neutral · {totalNeg} negative
                  </span>
                </div>
              </div>
              <div className="flex gap-2">
                {[
                  { label: `${Math.round((totalPos / totalMeetings) * 100)}% Positive`, color: "text-emerald-600 dark:text-emerald-400" },
                  { label: `${Math.round((totalNeg / totalMeetings) * 100)}% Negative`, color: "text-red-600 dark:text-red-400" },
                ].map(s => (
                  <span key={s.label} className={`text-sm font-semibold tabular-nums ${s.color}`}>{s.label}</span>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-5">
        {/* Games with touchpoints */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Gamepad2 className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Games — Multi-Event Touchpoints</h2>
          </div>
          {isLoading && <div className="space-y-2">{[1,2,3].map(i => <div key={i} className="h-20 bg-muted animate-pulse rounded-lg" />)}</div>}
          <div className="space-y-2.5" data-testid="games-touchpoints-list">
            {activeGames.map(game => {
              const sentiment = overallSentiment(game.sentiments);
              return (
                <Card key={game.id} data-testid={`game-card-${game.id}`} className="cursor-pointer hover:bg-accent/50 transition-colors" onClick={() => setSelectedGame(game)}>
                  <CardContent className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold truncate">{game.title}</span>
                          <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${egsStatusColors[game.currentEgsStatus]}`}>
                            {egsStatusLabels[game.currentEgsStatus]}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          <SentimentBadge sentiment={sentiment} size="sm" />
                          <span className="text-xs text-muted-foreground">
                            {game.touchpointCount} touch{game.touchpointCount !== 1 ? "points" : "point"}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {game.events.map(ev => (
                            <Badge key={ev} variant="outline" className="text-xs">{ev}</Badge>
                          ))}
                        </div>
                        {game.notes && (
                          <p className="text-xs text-muted-foreground mt-1.5 line-clamp-2">{game.notes}</p>
                        )}
                      </div>
                      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                    </div>
                  </CardContent>
                </Card>
              );
            })}
            {activeGames.length === 0 && (
              <div className="text-center py-8 text-muted-foreground text-sm">
                <Gamepad2 className="w-8 h-8 mx-auto mb-2 opacity-30" />No game data yet
              </div>
            )}
          </div>
        </div>

        {/* Platform topics */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <MessageSquare className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Platform Topics — Aggregated Feedback</h2>
          </div>
          {isLoading && <div className="space-y-2">{[1,2,3].map(i => <div key={i} className="h-20 bg-muted animate-pulse rounded-lg" />)}</div>}
          <div className="space-y-2.5" data-testid="platform-topics-list">
            {activeTopics.map(topic => {
              const sentiment = overallSentiment(
                Array(topic.posCount).fill("positive").concat(
                  Array(topic.neutCount).fill("neutral"),
                  Array(topic.negCount).fill("negative")
                )
              );
              return (
                <Card key={topic.id} data-testid={`topic-card-${topic.id}`} className="cursor-pointer hover:bg-accent/50 transition-colors" onClick={() => setSelectedTopic(topic)}>
                  <CardContent className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold">{topic.name}</span>
                          <span className={`text-xs font-medium capitalize ${categoryColors[topic.category]}`}>
                            {topic.category}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          <SentimentBadge sentiment={sentiment} size="sm" />
                          <span className="text-xs text-muted-foreground">{topic.feedbackCount} feedback entries</span>
                        </div>
                        <div className="mt-2">
                          <SentimentBar pos={topic.posCount} neu={topic.neutCount} neg={topic.negCount} />
                        </div>
                        {topic.description && (
                          <p className="text-xs text-muted-foreground mt-1.5 line-clamp-2">{topic.description}</p>
                        )}
                      </div>
                      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                    </div>
                  </CardContent>
                </Card>
              );
            })}
            {activeTopics.length === 0 && (
              <div className="text-center py-8 text-muted-foreground text-sm">
                <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-30" />No platform feedback yet
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Recommended focus areas */}
      {data && (
        <Card className="mt-5">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Target className="w-4 h-4 text-primary" />Recommended Focus Areas
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-4">
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">BD — Top Opportunities</p>
                {activeGames
                  .filter(g => g.currentEgsStatus !== "not_coming" && overallSentiment(g.sentiments) !== "negative")
                  .slice(0, 3)
                  .map(g => (
                    <div key={g.id} className="flex items-center gap-2 text-xs">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                      <span>{g.title}</span>
                    </div>
                  ))}
              </div>
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Product — Top Blockers</p>
                {activeTopics
                  .filter(t => t.negCount > 0)
                  .sort((a, b) => b.negCount - a.negCount)
                  .slice(0, 3)
                  .map(t => (
                    <div key={t.id} className="flex items-center gap-2 text-xs">
                      <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
                      <span>{t.name}</span>
                    </div>
                  ))}
              </div>
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">AM — Watch List</p>
                {activeGames
                  .filter(g => g.currentEgsStatus === "not_coming" || overallSentiment(g.sentiments) === "negative")
                  .slice(0, 3)
                  .map(g => (
                    <div key={g.id} className="flex items-center gap-2 text-xs">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                      <span>{g.title}</span>
                    </div>
                  ))}
              </div>
            </div>
          </CardContent>
        </Card>
      )}
      <TopicDetailSheet key={`topic-${selectedTopic?.id}`} topic={selectedTopic} open={!!selectedTopic} onClose={() => setSelectedTopic(null)} />
      <GameDetailSheet key={`game-${selectedGame?.id}`} game={selectedGame} open={!!selectedGame} onClose={() => setSelectedGame(null)} />
    </div>
  );
}
