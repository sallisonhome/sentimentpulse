// ─── TikTok Pulse Manual Ingestion Controls (2026-10-13) ─────────────────────
//
// ONE button: "Backfill TikTok comments (90d)". Clicking it triggers
// POST /api/tiktok/ops/backfill, which server-side runs discovery + stats
// + backfill in a single pipeline pass (see routes-tiktok.ts
// triggerTikTokBackfill). No separate "Run discovery now" step — that was
// an artifact of an earlier bug where the backfill didn't bootstrap the
// video pool itself.
//
// Authenticated by the operator's existing SignalPulse browser session.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Database, Loader2, Music2 } from "lucide-react";

// The six Saber title IDs tracked by the TikTok Pulse pipeline (Steam App IDs)
const SABER_TITLE_IDS = [2183900, 1551980, 1967610, 2947860, 675010, 1465360];

interface TikTokStatus {
  apiKeyConfigured: boolean;
  counts: {
    titles: number;
    videos: number;
    comments: number;
    oldestCommentFetch: string | null;
  };
  runs: Array<{
    id: number;
    trigger: string;
    started_at: string;
    finished_at: string | null;
    status: string;
    message: string | null;
  }>;
}

interface TikTokBackfillControlsProps {
  /** default 90; call sites can pass a different window */
  windowDays?: number;
}

export function TikTokBackfillControls({ windowDays = 90 }: TikTokBackfillControlsProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [lastAccepted, setLastAccepted] = useState<string | null>(null);

  const { data: status } = useQuery<TikTokStatus>({
    queryKey: ["./api/tiktok/status"],
    queryFn: async () => {
      const resp = await fetch("./api/tiktok/status");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.json();
    },
    refetchInterval: 10_000, // poll while a run/backfill is in flight
  });

  const mutation = useMutation({
    mutationFn: async () => {
      const resp = await fetch("./api/tiktok/ops/backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ titleIds: SABER_TITLE_IDS, windowDays }),
      });
      if (!resp.ok) {
        let detail = "";
        try {
          const body = await resp.clone().json();
          if (body?.error) detail = ` — ${body.error}`;
        } catch {
          /* ignore parse failure */
        }
        throw new Error(`HTTP ${resp.status}${detail}`);
      }
      return resp.json();
    },
    onSuccess: (data: any) => {
      setLastAccepted(new Date().toLocaleString());
      toast({
        title: "TikTok backfill started",
        description: `titleIds=${(data.titleIds || []).join(",")} · windowDays=${data.windowDays ?? windowDays}. Runs discovery + stats + backfill server-side in one pass. Ground truth is tt_comments row counts, not the log line.`,
      });
      qc.invalidateQueries({ queryKey: ["./api/tiktok/status"] });
    },
    onError: (err: any) => {
      toast({
        title: "TikTok backfill failed to start",
        description: err?.message || "Unknown error — check server logs.",
        variant: "destructive",
      });
    },
  });

  // The status route doesn't expose in-flight flags; use the latest run's
  // status field ("running") as the busy indicator.
  const latestRun = status?.runs?.[0];
  const busy = !!latestRun && latestRun.status === "running";
  const tokenConfigured = !!status?.apiKeyConfigured;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Music2 className="h-5 w-5" />
          TikTok Pulse — 90-Day Comment Backfill
        </CardTitle>
        <CardDescription>
          One-shot trigger that runs the full pipeline for the last {windowDays} days:
          discovery (hashtags/keywords), stats (fresh view counts), then the 90-day
          comment backfill with the game-relevance filter. Fire-and-forget — comments
          accumulate in the background and the row counts in tt_comments are the ground
          truth, not the "backfill saved" log line.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!tokenConfigured && (
          <div className="text-xs text-amber-600">
            EnsembleData token not set — backfill will no-op. Set tiktok_ensemble_token
            in the TikTok Pulse (EnsembleData) card above first.
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium flex items-center gap-2">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Database className="w-4 h-4" />}
            {busy ? "A TikTok run/backfill is in progress…" : "Ready to backfill"}
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs gap-1.5"
            disabled={mutation.isPending || busy || !tokenConfigured}
            onClick={() => mutation.mutate()}
            data-testid="button-tiktok-backfill"
          >
            {mutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Music2 className="w-3.5 h-3.5" />}
            Backfill TikTok comments ({windowDays}d)
          </Button>
        </div>
        {lastAccepted && (
          <div className="text-xs text-muted-foreground">
            Backfill accepted at {lastAccepted}. Polling status…
          </div>
        )}
        {status?.counts && (
          <div className="rounded border p-2 bg-muted/30 space-y-1 text-xs text-muted-foreground">
            <div>Titles tracked: {status.counts.titles}</div>
            <div>Videos: {status.counts.videos}</div>
            <div>Comments: {status.counts.comments}</div>
            <div>Oldest comment fetched: {status.counts.oldestCommentFetch ?? "—"}</div>
          </div>
        )}
        {latestRun && (
          <div className="rounded border p-2 bg-muted/30 space-y-1 text-xs text-muted-foreground">
            <div>
              Last run (trigger={latestRun.trigger}): {latestRun.finished_at
                ? new Date(latestRun.finished_at).toLocaleString()
                : "in progress"}
            </div>
            {latestRun.message && <div>Message: {latestRun.message}</div>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
