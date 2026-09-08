// ─── Manual CCU Leaderboard Refresh (Phase 6, 2026-09-08) ───────────────────
//
// One "run now" button that forces the same pollSaberSteamCcu() the hourly
// scheduler calls (Steam's live top-100 + per-title GetNumberOfCurrentPlayers),
// so an operator doesn't have to wait up to 60 minutes to see a fresh CCU
// snapshot land for a title that just released or just got wired up. Mirrors
// ManualIngestionControls' pattern one section down.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Activity, Loader2, CheckCircle2, XCircle } from "lucide-react";

interface CcuPollStateSummary {
  lastPolledAt: string | null;
  lastPollResult: string | null;
  titlesPolled: number | null;
  nextPollAt: string | null;
}

interface CcuRefreshResponse {
  message: string;
  pollState: CcuPollStateSummary;
  leaderboardRowCount: number;
}

export function CcuRefreshControl() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [lastRun, setLastRun] = useState<CcuRefreshResponse | null>(null);

  const { data: pollState } = useQuery<CcuPollStateSummary>({
    queryKey: ["./api/leaderboards/ccu/poll-state"],
    queryFn: async () => {
      const resp = await fetch("./api/leaderboards/ccu/poll-state");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.json();
    },
  });

  const effective = lastRun?.pollState ?? pollState ?? null;
  const hasError = !!effective?.lastPollResult?.startsWith("error");

  const mutation = useMutation({
    mutationFn: async () => {
      const resp = await fetch("./api/leaderboards/ccu/refresh", { method: "POST" });
      let body: CcuRefreshResponse | { error?: string; message?: string } | null = null;
      try {
        body = await resp.clone().json();
      } catch {
        /* ignore parse failure */
      }
      if (!resp.ok) {
        const detail = (body as any)?.message || (body as any)?.error || "";
        throw new Error(`HTTP ${resp.status}${detail ? ` — ${detail}` : ""}`);
      }
      return body as CcuRefreshResponse;
    },
    onSuccess: (data) => {
      setLastRun(data);
      const err = data.pollState.lastPollResult?.startsWith("error");
      toast({
        title: err ? "CCU refresh completed with errors" : "CCU leaderboard refreshed",
        description: data.message,
        variant: err ? "destructive" : undefined,
      });
      qc.invalidateQueries({ queryKey: ["./api/leaderboards/ccu/poll-state"] });
      qc.invalidateQueries({ queryKey: ["./api/leaderboards/ccu"] });
    },
    onError: (err: any) => {
      toast({
        title: "CCU refresh failed",
        description: err?.message || "Unknown error — check server logs.",
        variant: "destructive",
      });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-5 w-5" />
          Saber Steam CCU Leaderboard
        </CardTitle>
        <CardDescription>
          Force a fresh concurrent-players poll right now instead of waiting for the top-of-hour
          cron. Pulls Steam's live top-100 chart for global rank plus a per-title current-player
          reading for every released Saber title with a Steam App ID. History only accumulates
          forward from each title's first poll — Steam's APIs have no way to backfill past CCU.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium">Live CCU poll</div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs gap-1.5"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
            data-testid="button-refresh-ccu-leaderboard"
          >
            {mutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
            Refresh CCU leaderboard now
          </Button>
        </div>

        {!effective || (!effective.lastPolledAt && !lastRun) ? (
          <div className="text-xs text-muted-foreground">Never polled yet.</div>
        ) : (
          <div className="rounded border p-2 bg-muted/30 space-y-1">
            <div className="text-xs font-medium flex items-center gap-2">
              {hasError ? (
                <XCircle className="w-4 h-4 text-red-600" />
              ) : (
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              )}
              Last poll: {effective.lastPolledAt ? new Date(effective.lastPolledAt).toLocaleString() : "—"}
            </div>
            <div className="text-xs text-muted-foreground pl-6">
              {hasError ? effective.lastPollResult : `${effective.titlesPolled ?? 0} title(s) polled successfully`}
            </div>
            {effective.nextPollAt && (
              <div className="text-xs text-muted-foreground pl-6">
                Next scheduled poll: {new Date(effective.nextPollAt).toLocaleString()}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
