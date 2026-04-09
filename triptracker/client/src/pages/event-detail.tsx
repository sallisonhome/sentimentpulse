import { useState } from "react";
import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import type { EventWithStats, MeetingWithDetails, EventExecutiveSummary } from "@shared/schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SentimentBadge, SentimentBar } from "@/components/sentiment-badge";
import { SourceDocumentsPanel } from "@/components/source-documents-panel";
import { IngestModal } from "@/components/ingest-modal";
import {
  ArrowLeft, MapPin, Calendar, Users, FileText, Plus,
  Sparkles, AlertTriangle, TrendingUp, Zap, ChevronRight, Clock, Building2
} from "lucide-react";
import { format } from "date-fns";

const eventTypeLabels: Record<string, string> = {
  conference: "Conference", roadshow: "Roadshow", virtual: "Virtual", other: "Other",
};

const dealStatusLabels: Record<string, string> = {
  initial_outreach: "Initial Outreach",
  in_negotiation: "Negotiating",
  signed: "Signed",
  lost: "Lost",
};

function ExecSummaryPanel({ eventId }: { eventId: number }) {
  const { data: summary } = useQuery<EventExecutiveSummary>({
    queryKey: ["/api/events", eventId, "executive-summary"],
    queryFn: async () => {
      const r = await fetch(`/api/events/${eventId}/executive-summary`);
      if (!r.ok) return null;
      return r.json();
    },
    // Poll until exec summary appears after parsing
    refetchInterval: 7000,
    refetchIntervalInBackground: false,
  });

  if (!summary) {
    return (
      <Card className="border-dashed">
        <CardContent className="p-5 text-center">
          <Sparkles className="w-8 h-8 mx-auto mb-2 text-muted-foreground opacity-40" />
          <p className="text-sm text-muted-foreground">No executive summary yet</p>
          <p className="text-xs text-muted-foreground mt-1">Ingest a report to auto-generate one</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="panel-exec-summary">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" />
          Executive Summary
          <Badge variant="secondary" className="text-xs ml-auto">
            {format(new Date(summary.lastRefreshedAt!), "MMM d")}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 pb-4">
        {summary.macroThemes && (
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Macro Themes</p>
            <p className="text-sm leading-relaxed">{summary.macroThemes}</p>
          </div>
        )}
        {summary.highlights && (
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1">
              <TrendingUp className="w-3 h-3 text-emerald-500" />Highlights
            </p>
            <p className="text-sm leading-relaxed text-emerald-800 dark:text-emerald-200 bg-emerald-50 dark:bg-emerald-950/40 rounded-md p-2.5 border border-emerald-200 dark:border-emerald-900">{summary.highlights}</p>
          </div>
        )}
        {summary.negatives && (
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3 text-red-500" />Key Risks / Negatives
            </p>
            <p className="text-sm leading-relaxed text-red-800 dark:text-red-200 bg-red-50 dark:bg-red-950/40 rounded-md p-2.5 border border-red-200 dark:border-red-900">{summary.negatives}</p>
          </div>
        )}
        {summary.recommendations && (
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1">
              <Zap className="w-3 h-3 text-amber-500" />Recommendations
            </p>
            <p className="text-sm leading-relaxed">{summary.recommendations}</p>
          </div>
        )}

        {/* Chips: Top Opportunities / Risks / Actions */}
        {(summary.topOpportunities || summary.topRisks || summary.topActions) && (
          <div className="grid grid-cols-1 gap-3 pt-1">
            {summary.topOpportunities && (
              <div>
                <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 mb-1.5">Top Opportunities</p>
                <div className="space-y-1">
                  {(summary.topOpportunities as string[]).map((o, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs">
                      <span className="w-4 h-4 rounded-full bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300 flex items-center justify-center shrink-0 font-bold text-[10px]">{i + 1}</span>
                      <span>{o}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {summary.topRisks && (
              <div>
                <p className="text-xs font-semibold text-red-600 dark:text-red-400 mb-1.5">Top Risks</p>
                <div className="space-y-1">
                  {(summary.topRisks as string[]).map((r, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs">
                      <span className="w-4 h-4 rounded-full bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300 flex items-center justify-center shrink-0 font-bold text-[10px]">{i + 1}</span>
                      <span>{r}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {summary.topActions && (
              <div>
                <p className="text-xs font-semibold text-amber-600 dark:text-amber-400 mb-1.5">Action Items</p>
                <div className="space-y-1.5">
                  {(summary.topActions as { action: string; owner: string; dueDate?: string }[]).map((a, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs p-2 bg-amber-50 dark:bg-amber-950/30 rounded border border-amber-200 dark:border-amber-900">
                      <Zap className="w-3 h-3 text-amber-500 mt-0.5 shrink-0" />
                      <div>
                        <span className="font-medium">{a.action}</span>
                        <span className="text-muted-foreground ml-1">→ {a.owner}</span>
                        {a.dueDate && <span className="text-muted-foreground ml-1">· Due {a.dueDate}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function EventDetailPage() {
  const { id } = useParams<{ id: string }>();
  const eventId = parseInt(id ?? "0");
  const [ingestOpen, setIngestOpen] = useState(false);

  const { data: event, isLoading: eventLoading } = useQuery<EventWithStats>({
    queryKey: ["/api/events", eventId],
    queryFn: async () => {
      const r = await fetch(`/api/events/${eventId}`);
      return r.json();
    },
    // Refetch stats and exec summary availability while parsing is in progress
    refetchInterval: 6000,
    refetchIntervalInBackground: false,
  });

  const { data: meetings, isLoading: meetingsLoading } = useQuery<MeetingWithDetails[]>({
    queryKey: ["/api/events", eventId, "meetings"],
    queryFn: async () => {
      const r = await fetch(`/api/events/${eventId}/meetings`);
      return r.json();
    },
    // Refetch meetings periodically while source docs are being parsed
    refetchInterval: 6000,
    refetchIntervalInBackground: false,
  });

  if (eventLoading) {
    return (
      <div className="p-6 max-w-6xl mx-auto space-y-4">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="h-32 bg-muted animate-pulse rounded-lg" />
      </div>
    );
  }

  if (!event) return <div className="p-6">Event not found.</div>;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Back + header */}
      <div className="flex items-center gap-2 mb-4">
        <a href="#/events">
          <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" data-testid="button-back">
            <ArrowLeft className="w-3.5 h-3.5" />Back
          </Button>
        </a>
      </div>

      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-bold tracking-tight">{event.name}</h1>
            <Badge variant="outline" className="capitalize text-xs">{eventTypeLabels[event.eventType]}</Badge>
          </div>
          <div className="flex items-center gap-4 mt-2 flex-wrap">
            {(event.city || event.country) && (
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <MapPin className="w-3.5 h-3.5" />
                {[event.city, event.country].filter(Boolean).join(", ")}
              </span>
            )}
            {event.startDate && (
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Calendar className="w-3.5 h-3.5" />
                {format(new Date(event.startDate + "T12:00:00"), "MMM d")}
                {event.endDate && ` – ${format(new Date(event.endDate + "T12:00:00"), "MMM d, yyyy")}`}
              </span>
            )}
            {event.primaryOwner && (
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Users className="w-3.5 h-3.5" />{event.primaryOwner.name}
              </span>
            )}
          </div>
        </div>
        <Button onClick={() => setIngestOpen(true)} data-testid="button-ingest-report">
          <FileText className="w-4 h-4 mr-1.5" />Ingest Report
        </Button>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        {[
          { label: "Meetings", value: event.meetingCount },
          { label: "Positive", value: event.positiveCount, color: "text-emerald-600 dark:text-emerald-400" },
          { label: "Neutral", value: event.neutralCount, color: "text-amber-600 dark:text-amber-400" },
          { label: "Negative", value: event.negativeCount, color: "text-red-600 dark:text-red-400" },
        ].map(s => (
          <Card key={s.label} className="py-0">
            <CardContent className="p-3">
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <p className={`text-xl font-bold tabular-nums mt-0.5 ${s.color ?? ""}`}>{s.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-3 gap-5">
        {/* Left column: exec summary + source docs */}
        <div className="space-y-4">
          <ExecSummaryPanel eventId={eventId} />
          <SourceDocumentsPanel eventId={eventId} onIngestClick={() => setIngestOpen(true)} />
        </div>

        {/* Right: meetings table */}
        <div className="col-span-2">
          <Card data-testid="panel-meetings">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center justify-between">
                <span>Meetings</span>
                {meetings && <Badge variant="secondary" className="text-xs">{meetings.length}</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {meetingsLoading && <div className="p-4 text-sm text-muted-foreground">Loading...</div>}
              {meetings?.length === 0 && (
                <div className="p-6 text-center text-muted-foreground text-sm">
                  <Building2 className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  No meetings yet. Ingest a report to auto-populate.
                </div>
              )}
              <div className="divide-y">
                {meetings?.map(meeting => (
                  <a key={meeting.id} href={`#/meetings/${meeting.id}`}>
                    <div
                      className="flex items-start gap-3 px-4 py-3 hover:bg-muted/40 transition-colors cursor-pointer"
                      data-testid={`meeting-row-${meeting.id}`}
                    >
                      {/* Sentiment dot */}
                      <div className="pt-1 shrink-0">
                        <SentimentBadge sentiment={meeting.overallSentiment} size="sm" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium truncate">
                            {meeting.company?.name ?? "Internal Meeting"}
                          </span>
                          {meeting.games?.slice(0, 2).map(mg => (
                            <Badge key={mg.id} variant="outline" className="text-xs shrink-0">{mg.game.title}</Badge>
                          ))}
                          {(meeting.games?.length ?? 0) > 2 && (
                            <Badge variant="outline" className="text-xs">+{(meeting.games?.length ?? 0) - 2}</Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-1 flex-wrap">
                          {meeting.meetingDate && (
                            <span className="text-xs text-muted-foreground flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              {format(new Date(meeting.meetingDate + "T12:00:00"), "MMM d")}
                              {meeting.startTime && ` · ${meeting.startTime}`}
                            </span>
                          )}
                          {meeting.location && (
                            <span className="text-xs text-muted-foreground truncate max-w-[180px]">{meeting.location}</span>
                          )}
                        </div>
                        {meeting.summary && (
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-2 leading-relaxed">{meeting.summary}</p>
                        )}
                      </div>
                      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 mt-1" />
                    </div>
                  </a>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <IngestModal
        open={ingestOpen}
        onOpenChange={setIngestOpen}
        eventId={eventId}
        eventName={event.name}
      />
    </div>
  );
}
