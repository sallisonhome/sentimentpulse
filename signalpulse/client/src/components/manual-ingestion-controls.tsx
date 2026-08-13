// ─── Manual Per-Source Ingestion Controls (v1.0, 2026-08-13) ────────────────
//
// Three independent "run now" buttons, one per Steamworks auth path feeding
// the Wishlist + Sales Leaderboards. Mirrors the full-pipeline trigger at
// POST /api/ingestion/run, but scoped to a single source so an operator can
// force a refresh of just the piece that's stale without waiting on (or
// re-running) everything else:
//
//   1. Sales Leaderboard          — Steamworks Partner PORTAL SESSION COOKIE
//   2. Wishlist Leaderboard (public) — no auth, public Steam endpoints
//      (followers, "Popular Upcoming" chart rank, header art)
//   3. Wishlist Leaderboard (actual counts) — Steamworks Partner API KEY
//      (real daily wishlist adds/deletes/purchases for Saber/Mad Dog titles)

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Database, Loader2, CheckCircle2, XCircle, MinusCircle } from "lucide-react";

interface ManualIngestionResult {
  source: string;
  status: "success" | "skipped" | "error";
  message: string;
  productsProcessed?: number;
  dataPointsAdded?: number;
}

interface ManualIngestionRun {
  startedAt: string;
  completedAt: string;
  results: ManualIngestionResult[];
  totalProductsProcessed: number;
  totalDataPointsAdded: number;
}

interface ManualStatus {
  inFlight: boolean;
  sales: ManualIngestionRun | null;
  public: ManualIngestionRun | null;
  partner: ManualIngestionRun | null;
}

function StatusIcon({ results }: { results: ManualIngestionResult[] }) {
  const hasError = results.some((r) => r.status === "error");
  const allSkipped = results.every((r) => r.status === "skipped");
  if (hasError) return <XCircle className="w-4 h-4 text-red-600" />;
  if (allSkipped) return <MinusCircle className="w-4 h-4 text-muted-foreground" />;
  return <CheckCircle2 className="w-4 h-4 text-emerald-600" />;
}

function LastRunSummary({ run }: { run: ManualIngestionRun | null }) {
  if (!run) {
    return <div className="text-xs text-muted-foreground">Never run manually yet.</div>;
  }
  return (
    <div className="rounded border p-2 bg-muted/30 space-y-1">
      <div className="text-xs font-medium flex items-center gap-2">
        <StatusIcon results={run.results} />
        Last manual run: {new Date(run.completedAt).toLocaleString()}
      </div>
      {run.results.map((r, i) => (
        <div key={i} className="text-xs text-muted-foreground pl-6">
          {r.source}: {r.message}
        </div>
      ))}
    </div>
  );
}

function IngestButton({
  endpoint,
  label,
  disabledReason,
  onDone,
}: {
  endpoint: string;
  label: string;
  disabledReason?: string;
  onDone: (run: ManualIngestionRun) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: async () => {
      const resp = await fetch(`./api/ingestion/${endpoint}`, { method: "POST" });
      if (!resp.ok) {
        let detail = "";
        try {
          const body = await resp.clone().json();
          if (body?.message) detail = ` — ${body.message}`;
          else if (body?.error) detail = ` — ${body.error}`;
        } catch {
          /* ignore parse failure, fall through to generic message */
        }
        throw new Error(`HTTP ${resp.status}${detail}`);
      }
      return (await resp.json()) as ManualIngestionRun & { message: string };
    },
    onSuccess: (data) => {
      const hasError = data.results.some((r) => r.status === "error");
      toast({
        title: hasError ? "Completed with errors" : "Ingestion complete",
        description: data.results.map((r) => r.message).join(" | "),
        variant: hasError ? "destructive" : undefined,
      });
      onDone(data);
      qc.invalidateQueries({ queryKey: ["./api/ingestion/manual-status"] });
    },
    onError: (err: any) => {
      toast({
        title: "Ingestion failed",
        description: err?.message || "Unknown error — check server logs.",
        variant: "destructive",
      });
    },
  });

  return (
    <Button
      size="sm"
      variant="outline"
      className="h-8 text-xs gap-1.5"
      disabled={mutation.isPending || !!disabledReason}
      title={disabledReason}
      onClick={() => mutation.mutate()}
      data-testid={`button-ingest-${endpoint}`}
    >
      {mutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Database className="w-3.5 h-3.5" />}
      {label}
    </Button>
  );
}

export function ManualIngestionControls() {
  // Local echo of the last mutation response for each source, so the summary
  // updates immediately without waiting on the status refetch.
  const [salesRun, setSalesRun] = useState<ManualIngestionRun | null>(null);
  const [publicRun, setPublicRun] = useState<ManualIngestionRun | null>(null);
  const [partnerRun, setPartnerRun] = useState<ManualIngestionRun | null>(null);

  const { data: status } = useQuery<ManualStatus>({
    queryKey: ["./api/ingestion/manual-status"],
    queryFn: async () => {
      const resp = await fetch("./api/ingestion/manual-status");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.json();
    },
  });

  const effectiveSales = salesRun ?? status?.sales ?? null;
  const effectivePublic = publicRun ?? status?.public ?? null;
  const effectivePartner = partnerRun ?? status?.partner ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="h-5 w-5" />
          Manual Ingestion — Wishlist &amp; Sales Leaderboards
        </CardTitle>
        <CardDescription>
          Force a refresh of one data source right now instead of waiting for the daily 3:00 AM
          ET cron. Each button below hits a different Steamworks auth path — see which credential
          each one depends on in Settings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-medium">Sales Leaderboard</div>
            <IngestButton
              endpoint="run-sales"
              label="Run sales ingestion now"
              onDone={setSalesRun}
            />
          </div>
          <div className="text-xs text-muted-foreground">
            Steamworks Partner portal session cookie — daily unit sales for revenue-eligible
            titles (Steamworks Session Cookie card below).
          </div>
          <LastRunSummary run={effectiveSales} />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-medium">Wishlist Leaderboard — public data</div>
            <IngestButton
              endpoint="run-public-wishlist"
              label="Run public API ingestion now"
              onDone={setPublicRun}
            />
          </div>
          <div className="text-xs text-muted-foreground">
            No credential required — public Steam endpoints: follower counts, header art, and
            "Popular Upcoming" wishlist chart rank.
          </div>
          <LastRunSummary run={effectivePublic} />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-medium">Wishlist Leaderboard — actual counts</div>
            <IngestButton
              endpoint="run-partner-wishlist"
              label="Run partner API ingestion now"
              onDone={setPartnerRun}
            />
          </div>
          <div className="text-xs text-muted-foreground">
            Steamworks Partner API key — real daily wishlist adds/deletes/purchases for Saber /
            Mad Dog titles (Steam / Steamworks card below).
          </div>
          <LastRunSummary run={effectivePartner} />
        </div>
      </CardContent>
    </Card>
  );
}
