/**
 * SignalPulse Inbox (v3.21, 2026-08-15).
 *
 * Admin view for inbound email received via Resend webhook.
 * Left panel: thread list (latest message per thread_key).
 * Right panel: thread detail with all messages, plus a reply composer.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { Loader2, RefreshCw, Archive, MailOpen, Send, Reply, Inbox as InboxIcon, ExternalLink } from "lucide-react";

interface InboundMessage {
  id: number;
  resend_email_id: string;
  message_id: string;
  thread_key: string;
  subject: string;
  from_addr: string;
  from_email: string;
  to_addrs: string;
  cc_addrs: string;
  body_text: string;
  body_html: string;
  snippet: string;
  is_read: number;
  is_archived: number;
  direction: string;
  outbound_status: string | null;
  outbound_error: string | null;
  received_at: string;
}

interface ThreadListResponse {
  items: InboundMessage[];
  unread: number;
}

interface ThreadDetailResponse {
  thread_key: string;
  messages: (InboundMessage & { attachments: Attachment[] })[];
}

interface Attachment {
  id: number;
  filename: string;
  content_type: string | null;
  size_bytes: number | null;
  download_url: string | null;
}

function parseAddrs(json: string): string[] {
  try {
    return JSON.parse(json) as string[];
  } catch {
    return [];
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

export default function InboxPage() {
  const [selectedThread, setSelectedThread] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [replySubject, setReplySubject] = useState("");
  const { toast } = useToast();
  const qc = useQueryClient();

  // List of threads (latest message per thread_key)
  const listQ = useQuery<ThreadListResponse>({
    queryKey: ["inbox-list", showArchived],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (showArchived) params.set("include_archived", "true");
      const r = await fetch(`/api/inbound/messages?${params.toString()}`);
      if (!r.ok) throw new Error(`list failed: ${r.status}`);
      return r.json();
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  // Selected thread detail
  const threadQ = useQuery<ThreadDetailResponse>({
    queryKey: ["inbox-thread", selectedThread],
    enabled: !!selectedThread,
    queryFn: async () => {
      const r = await fetch(`/api/inbound/thread/${encodeURIComponent(selectedThread!)}`);
      if (!r.ok) throw new Error(`thread failed: ${r.status}`);
      return r.json();
    },
  });

  // Auto-mark-read on thread open
  useEffect(() => {
    if (!threadQ.data) return;
    const unread = threadQ.data.messages.filter(
      (m) => m.direction === "inbound" && !m.is_read,
    );
    if (unread.length === 0) return;
    Promise.all(
      unread.map((m) =>
        fetch(`/api/inbound/messages/${m.id}/read`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ read: true }),
        }),
      ),
    ).then(() => {
      qc.invalidateQueries({ queryKey: ["inbox-list"] });
      qc.invalidateQueries({ queryKey: ["inbox-unread-count"] });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadQ.data?.thread_key]);

  // Reset reply composer when thread changes
  useEffect(() => {
    if (!threadQ.data) return;
    const latestInbound = [...threadQ.data.messages]
      .reverse()
      .find((m) => m.direction === "inbound");
    if (latestInbound) {
      setReplyTo(latestInbound.from_email);
      setReplySubject(
        latestInbound.subject.toLowerCase().startsWith("re:")
          ? latestInbound.subject
          : `Re: ${latestInbound.subject}`,
      );
    }
    setReplyBody("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadQ.data?.thread_key]);

  const archiveMut = useMutation({
    mutationFn: async ({ id, archived }: { id: number; archived: boolean }) => {
      const r = await fetch(`/api/inbound/messages/${id}/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived }),
      });
      if (!r.ok) throw new Error(`archive failed: ${r.status}`);
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inbox-list"] });
      qc.invalidateQueries({ queryKey: ["inbox-unread-count"] });
      setSelectedThread(null);
    },
  });

  const replyMut = useMutation({
    mutationFn: async ({ id, body, to, subject }: { id: number; body: string; to: string; subject: string }) => {
      const r = await fetch(`/api/inbound/messages/${id}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, to, subject }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || `reply failed: ${r.status}`);
      return j;
    },
    onSuccess: () => {
      toast({ title: "Reply sent", description: "Message threaded correctly with the original." });
      setReplyBody("");
      qc.invalidateQueries({ queryKey: ["inbox-thread"] });
      qc.invalidateQueries({ queryKey: ["inbox-list"] });
    },
    onError: (err) =>
      toast({
        title: "Reply failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      }),
  });

  const threads = listQ.data?.items || [];
  const unread = listQ.data?.unread ?? 0;
  const selectedMessages = threadQ.data?.messages || [];
  const latestInboundInThread = useMemo(() => {
    return [...selectedMessages].reverse().find((m) => m.direction === "inbound");
  }, [selectedMessages]);

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-3">
        <InboxIcon className="h-5 w-5" />
        <h1 className="text-2xl font-bold">Inbox</h1>
        {unread > 0 && (
          <Badge variant="destructive" data-testid="unread-badge">
            {unread} unread
          </Badge>
        )}
        <div className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowArchived((s) => !s)}
          data-testid="toggle-archived"
        >
          {showArchived ? "Hide archived" : "Show archived"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => listQ.refetch()}
          data-testid="refresh-inbox"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid grid-cols-[minmax(280px,380px)_1fr] gap-4 h-[calc(100vh-200px)]">
        {/* Thread list */}
        <Card className="overflow-hidden flex flex-col">
          <ScrollArea className="flex-1">
            <ul className="divide-y">
              {listQ.isLoading && (
                <li className="p-6 text-center text-muted-foreground">
                  <Loader2 className="h-4 w-4 mx-auto animate-spin" />
                </li>
              )}
              {!listQ.isLoading && threads.length === 0 && (
                <li className="p-6 text-center text-muted-foreground text-sm">
                  Inbox is empty.
                  <br />
                  <span className="text-xs">Configure Resend inbound in Settings to receive messages.</span>
                </li>
              )}
              {threads.map((t) => {
                const isUnread = !t.is_read && t.direction === "inbound";
                const isSelected = t.thread_key === selectedThread;
                return (
                  <li
                    key={t.thread_key}
                    className={`p-3 cursor-pointer hover:bg-accent transition-colors ${
                      isSelected ? "bg-accent" : ""
                    }`}
                    onClick={() => setSelectedThread(t.thread_key)}
                    data-testid={`thread-${t.id}`}
                  >
                    <div className="flex items-baseline gap-2">
                      <span
                        className={`text-sm truncate flex-1 ${
                          isUnread ? "font-bold" : "font-normal"
                        }`}
                      >
                        {t.from_addr || t.from_email}
                      </span>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {formatDate(t.received_at)}
                      </span>
                    </div>
                    <div
                      className={`text-sm truncate ${
                        isUnread ? "font-medium" : "text-muted-foreground"
                      }`}
                    >
                      {t.subject || "(no subject)"}
                    </div>
                    <div className="text-xs text-muted-foreground truncate mt-0.5">
                      {t.snippet}
                    </div>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        </Card>

        {/* Thread detail */}
        <Card className="overflow-hidden flex flex-col">
          {!selectedThread && (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
              Select a thread to view.
            </div>
          )}
          {selectedThread && threadQ.isLoading && (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          )}
          {selectedThread && threadQ.data && (
            <>
              <div className="p-4 border-b flex items-baseline gap-2">
                <h2 className="text-lg font-semibold truncate flex-1">
                  {selectedMessages[0]?.subject || "(no subject)"}
                </h2>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    latestInboundInThread &&
                    archiveMut.mutate({
                      id: latestInboundInThread.id,
                      archived: latestInboundInThread.is_archived === 0,
                    })
                  }
                  data-testid="archive-thread"
                >
                  <Archive className="h-4 w-4 mr-1" />
                  {latestInboundInThread?.is_archived
                    ? "Unarchive"
                    : "Archive"}
                </Button>
              </div>
              <ScrollArea className="flex-1">
                <div className="p-4 space-y-4">
                  {selectedMessages.map((m) => {
                    const isOutbound = m.direction === "outbound";
                    return (
                      <div
                        key={m.id}
                        className={`rounded-lg border p-3 ${
                          isOutbound ? "bg-primary/5 border-primary/20" : "bg-card"
                        }`}
                        data-testid={`message-${m.id}`}
                      >
                        <div className="flex items-baseline gap-2 text-sm">
                          <span className="font-medium">
                            {isOutbound ? "You" : m.from_addr || m.from_email}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {isOutbound ? "sent" : "to"} {parseAddrs(m.to_addrs).join(", ") || "?"}
                          </span>
                          <div className="flex-1" />
                          <span className="text-xs text-muted-foreground">
                            {new Date(m.received_at).toLocaleString()}
                          </span>
                          {isOutbound && m.outbound_status === "failed" && (
                            <Badge variant="destructive" className="ml-2 text-xs">
                              send failed
                            </Badge>
                          )}
                        </div>
                        {m.outbound_error && (
                          <div className="mt-1 text-xs text-destructive">
                            {m.outbound_error}
                          </div>
                        )}
                        <Separator className="my-2" />
                        <div className="prose prose-sm max-w-none text-sm whitespace-pre-wrap">
                          {m.body_text ||
                            (m.body_html ? "(HTML-only body — see original)" : "(empty)")}
                        </div>
                        {m.attachments && m.attachments.length > 0 && (
                          <div className="mt-3 pt-3 border-t space-y-1">
                            <div className="text-xs font-medium text-muted-foreground">
                              Attachments
                            </div>
                            {m.attachments.map((a) => (
                              <a
                                key={a.id}
                                href={a.download_url || "#"}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-1 text-xs text-primary hover:underline"
                              >
                                <ExternalLink className="h-3 w-3" />
                                {a.filename}
                                {a.size_bytes && (
                                  <span className="text-muted-foreground">
                                    ({Math.round(a.size_bytes / 1024)} KB)
                                  </span>
                                )}
                              </a>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>

              {/* Reply composer */}
              {latestInboundInThread && (
                <div className="border-t p-4 space-y-2 bg-muted/20">
                  <div className="flex items-center gap-2 text-xs">
                    <Reply className="h-3 w-3" />
                    <span className="text-muted-foreground">Reply to</span>
                    <Input
                      value={replyTo}
                      onChange={(e) => setReplyTo(e.target.value)}
                      className="h-7 text-xs flex-1"
                      data-testid="reply-to"
                    />
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground w-8">Subj</span>
                    <Input
                      value={replySubject}
                      onChange={(e) => setReplySubject(e.target.value)}
                      className="h-7 text-xs flex-1"
                      data-testid="reply-subject"
                    />
                  </div>
                  <Textarea
                    value={replyBody}
                    onChange={(e) => setReplyBody(e.target.value)}
                    placeholder="Type your reply…"
                    rows={4}
                    className="text-sm"
                    data-testid="reply-body"
                  />
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      disabled={!replyBody.trim() || replyMut.isPending}
                      onClick={() =>
                        replyMut.mutate({
                          id: latestInboundInThread.id,
                          body: replyBody,
                          to: replyTo,
                          subject: replySubject,
                        })
                      }
                      data-testid="reply-send"
                    >
                      {replyMut.isPending ? (
                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      ) : (
                        <Send className="h-3 w-3 mr-1" />
                      )}
                      Send reply
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
