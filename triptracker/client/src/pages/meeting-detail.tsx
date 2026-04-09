import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import type { MeetingWithDetails } from "@shared/schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SentimentBadge } from "@/components/sentiment-badge";
import {
  ArrowLeft, MapPin, Clock, User, Building2, Gamepad2,
  MessageSquare, Zap, Calendar, Phone, Mail
} from "lucide-react";
import { format } from "date-fns";

const formatLabels: Record<string, string> = { in_person: "In-Person", virtual: "Virtual", hybrid: "Hybrid" };
const dealStatusColors: Record<string, string> = {
  initial_outreach: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  in_negotiation: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  signed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  lost: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};
const dealStatusLabels: Record<string, string> = {
  initial_outreach: "Initial Outreach", in_negotiation: "Negotiating", signed: "Signed", lost: "Lost",
};
const egsStatusLabels: Record<string, string> = {
  launched: "Launched", announced: "Announced", under_discussion: "Under Discussion", not_coming: "Not Coming", unknown: "Unknown",
};
const egsStatusColors: Record<string, string> = {
  launched: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  announced: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  under_discussion: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  not_coming: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  unknown: "bg-muted text-muted-foreground",
};
const priorityColors: Record<string, string> = {
  low: "text-muted-foreground", medium: "text-amber-600 dark:text-amber-400", high: "text-red-600 dark:text-red-400",
};
const categoryLabels: Record<string, string> = {
  commercial: "Commercial", product: "Product", tech: "Tech", marketing: "Marketing", operations: "Ops",
};

export default function MeetingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const meetingId = parseInt(id ?? "0");

  const { data: meeting, isLoading } = useQuery<MeetingWithDetails>({
    queryKey: ["/api/meetings", meetingId],
    queryFn: async () => {
      const r = await fetch(`/api/meetings/${meetingId}`);
      return r.json();
    },
  });

  if (isLoading) {
    return (
      <div className="p-6 max-w-5xl mx-auto space-y-4">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="h-64 bg-muted animate-pulse rounded-lg" />
      </div>
    );
  }
  if (!meeting) return <div className="p-6">Meeting not found.</div>;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Back */}
      <div className="flex items-center gap-2 mb-4">
        <a href={`#/events/${meeting.eventId}`}>
          <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" data-testid="button-back">
            <ArrowLeft className="w-3.5 h-3.5" />Back to Event
          </Button>
        </a>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-bold tracking-tight">
              {meeting.company?.name ?? "Internal Meeting"}
            </h1>
            <SentimentBadge sentiment={meeting.overallSentiment} />
            <Badge variant="outline" className="text-xs">{formatLabels[meeting.format]}</Badge>
          </div>
          <div className="flex items-center gap-4 mt-1.5 flex-wrap text-sm text-muted-foreground">
            {meeting.meetingDate && (
              <span className="flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5" />
                {format(new Date(meeting.meetingDate + "T12:00:00"), "MMMM d, yyyy")}
                {meeting.startTime && ` · ${meeting.startTime}`}
                {meeting.endTime && ` – ${meeting.endTime}`}
              </span>
            )}
            {meeting.location && (
              <span className="flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5" />{meeting.location}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-5">
        {/* Left column */}
        <div className="space-y-4">
          {/* Company & Contacts */}
          {meeting.company && (
            <Card data-testid="panel-company">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Building2 className="w-4 h-4 text-muted-foreground" />Company
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 pb-3">
                <p className="font-semibold text-sm">{meeting.company.name}</p>
                <p className="text-xs text-muted-foreground capitalize">{meeting.company.companyType}</p>
                {meeting.company.region && <p className="text-xs text-muted-foreground">{meeting.company.region}</p>}
              </CardContent>
            </Card>
          )}

          {/* Contacts */}
          {meeting.contacts && meeting.contacts.length > 0 && (
            <Card data-testid="panel-contacts">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <User className="w-4 h-4 text-muted-foreground" />Contacts
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 pb-3">
                {meeting.contacts.map(mc => (
                  <div key={mc.id} className="space-y-0.5">
                    <p className="text-sm font-medium">{mc.contact.name}</p>
                    {mc.contact.title && <p className="text-xs text-muted-foreground">{mc.contact.title}</p>}
                    {mc.contact.email && (
                      <p className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Mail className="w-3 h-3" />{mc.contact.email}
                      </p>
                    )}
                    {mc.roleInMeeting && (
                      <Badge variant="secondary" className="text-xs">{mc.roleInMeeting}</Badge>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Follow-up */}
          {(meeting.followUpActions || meeting.followUpOwner) && (
            <Card data-testid="panel-followup">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Zap className="w-4 h-4 text-amber-500" />Follow-up
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 pb-3">
                {meeting.followUpActions && <p className="text-sm">{meeting.followUpActions}</p>}
                {meeting.followUpOwner && (
                  <p className="text-xs text-muted-foreground">Owner: {meeting.followUpOwner.name}</p>
                )}
                {meeting.followUpDueDate && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Clock className="w-3 h-3" />Due: {meeting.followUpDueDate}
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right: notes + games + topics */}
        <div className="col-span-2 space-y-4">
          {/* Summary */}
          {meeting.summary && (
            <Card data-testid="panel-summary">
              <CardContent className="p-4">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Summary</p>
                <p className="text-sm leading-relaxed">{meeting.summary}</p>
              </CardContent>
            </Card>
          )}

          {/* Detailed notes */}
          {meeting.detailedNotes && (
            <Card data-testid="panel-detailed-notes">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-muted-foreground" />Detailed Notes
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-4">
                <p className="text-sm leading-relaxed whitespace-pre-line">{meeting.detailedNotes}</p>
              </CardContent>
            </Card>
          )}

          {/* Games */}
          {meeting.games && meeting.games.length > 0 && (
            <Card data-testid="panel-games">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Gamepad2 className="w-4 h-4 text-muted-foreground" />Games Discussed
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 pb-3">
                {meeting.games.map(mg => (
                  <div key={mg.id} className="border rounded-md p-3 space-y-2" data-testid={`game-item-${mg.game.id}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold">{mg.game.title}</p>
                        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${egsStatusColors[mg.game.currentEgsStatus]}`}>
                            {egsStatusLabels[mg.game.currentEgsStatus]}
                          </span>
                          {mg.dealStatus && (
                            <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${dealStatusColors[mg.dealStatus]}`}>
                              {dealStatusLabels[mg.dealStatus]}
                            </span>
                          )}
                          {mg.gameSpecificSentiment && (
                            <SentimentBadge sentiment={mg.gameSpecificSentiment} size="sm" />
                          )}
                        </div>
                      </div>
                      {mg.projectedLaunchTiming && (
                        <span className="text-xs text-muted-foreground shrink-0">{mg.projectedLaunchTiming}</span>
                      )}
                    </div>
                    {mg.discussionSummary && <p className="text-xs text-muted-foreground">{mg.discussionSummary}</p>}
                    {mg.keyQuotes && (
                      <blockquote className="border-l-2 border-muted pl-3 text-xs italic text-muted-foreground">
                        {mg.keyQuotes}
                      </blockquote>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Platform Topics */}
          {meeting.topics && meeting.topics.length > 0 && (
            <Card data-testid="panel-topics">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-muted-foreground" />Platform Feedback
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2.5 pb-3">
                {meeting.topics.map(mt => (
                  <div key={mt.id} className="border rounded-md p-3" data-testid={`topic-item-${mt.topic.id}`}>
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium">{mt.topic.name}</p>
                        <Badge variant="outline" className="text-xs capitalize">{categoryLabels[mt.topic.category]}</Badge>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <SentimentBadge sentiment={mt.sentiment} size="sm" />
                        <span className={`text-xs font-semibold uppercase ${priorityColors[mt.priority]}`}>{mt.priority}</span>
                      </div>
                    </div>
                    {mt.feedbackSummary && <p className="text-xs text-muted-foreground mt-1.5">{mt.feedbackSummary}</p>}
                    {mt.requestOrBlocker && (
                      <p className="text-xs mt-1 text-amber-700 dark:text-amber-300 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" />Blocker: {mt.requestOrBlocker}
                      </p>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function AlertTriangle({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  );
}
