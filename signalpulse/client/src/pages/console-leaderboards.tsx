/**
 * Console Leaderboards — hub page.
 *
 * Route: /console-leaderboards
 * Sub-routes: /console-leaderboards/:platform (list) and .../:platform/:titleId (PDP)
 *
 * Only paid/premium titles surface here (business_model = 'paid' at API layer).
 */

import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ArrowRight, Gamepad2 } from "lucide-react";
import { useState } from "react";

type Platform = "steam" | "xbox" | "ps5";
type WindowKey = "d7" | "d30" | "d90" | "m12" | "ltd";

const PLATFORMS: Array<{ id: Platform; label: string }> = [
  { id: "steam", label: "Steam" },
  { id: "xbox", label: "Xbox" },
  { id: "ps5", label: "PlayStation 5" },
];

const WINDOWS: Array<{ id: WindowKey; label: string }> = [
  { id: "d7", label: "7 days" },
  { id: "d30", label: "30 days" },
  { id: "d90", label: "90 days" },
  { id: "m12", label: "12 months" },
  { id: "ltd", label: "Lifetime" },
];

interface LeaderboardRow {
  titleId: number;
  externalSku: string;
  msrpUsdCents: number | null;
  businessModel: string;
  name: string | null;
  coverUrl: string | null;
  releaseDate: string | null;
  ratingCount: number | null;
  avgRating: number | null;
  ratingCapturedAt: string | null;
  ownersMid: number | null;
  unitsMid: number | null;
  gatedReason: string | null;
}

function formatNumberCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function formatUsd(cents: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

// ─── Hub (all platforms overview) ────────────────────────────────────────────

export default function ConsoleLeaderboardsHub() {
  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Console Leaderboards</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Premium paid titles across Steam, Xbox, and PlayStation. Ranked by live store signals; free-to-play titles are excluded.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {PLATFORMS.map(p => (
          <Link key={p.id} href={`/console-leaderboards/${p.id}`}>
            <Card className="p-6 cursor-pointer hover:border-primary/50 transition-colors">
              <div className="flex items-center gap-3">
                <Gamepad2 className="h-6 w-6 text-primary" />
                <div>
                  <div className="font-medium">{p.label}</div>
                  <div className="text-xs text-muted-foreground">Top paid titles</div>
                </div>
                <ArrowRight className="h-4 w-4 ml-auto text-muted-foreground" />
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ─── Platform list ───────────────────────────────────────────────────────────

export function ConsoleLeaderboardsPlatform() {
  const params = useParams<{ platform: Platform }>();
  const platform = params.platform;
  const [window, setWindow] = useState<WindowKey>("d30");
  const { data, isLoading } = useQuery<{ platform: Platform; window: WindowKey; count: number; titles: LeaderboardRow[] }>({
    queryKey: [`/api/console/leaderboards/${platform}`, { window }],
    queryFn: async () => {
      const r = await fetch(`/api/console/leaderboards/${platform}?window=${window}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!platform,
  });
  const platformLabel = PLATFORMS.find(p => p.id === platform)?.label || platform;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Link href="/console-leaderboards">
            <button className="text-xs text-muted-foreground hover:text-foreground" data-testid="link-back-hub">← All platforms</button>
          </Link>
          <h1 className="text-2xl font-semibold mt-1">{platformLabel} · Top Paid Titles</h1>
        </div>
        <div className="flex gap-1 flex-wrap">
          {WINDOWS.map(w => (
            <Button
              key={w.id}
              variant={window === w.id ? "default" : "outline"}
              size="sm"
              onClick={() => setWindow(w.id)}
              data-testid={`btn-window-${w.id}`}
            >
              {w.label}
            </Button>
          ))}
        </div>
      </div>

      {isLoading && (
        <div className="space-y-2">
          {[1,2,3,4,5].map(i => <Skeleton key={i} className="h-16 w-full rounded-md" />)}
        </div>
      )}

      {!isLoading && data && (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr className="text-xs text-muted-foreground">
                <th className="text-left px-3 py-2 font-medium">#</th>
                <th className="text-left px-3 py-2 font-medium">Title</th>
                <th className="text-right px-3 py-2 font-medium">Rating count</th>
                <th className="text-right px-3 py-2 font-medium">Avg rating</th>
                <th className="text-right px-3 py-2 font-medium">Est. owners ({window})</th>
                <th className="text-right px-3 py-2 font-medium">MSRP</th>
              </tr>
            </thead>
            <tbody>
              {data.titles.length === 0 && (
                <tr><td className="p-6 text-center text-muted-foreground text-sm" colSpan={6}>No titles yet — run discovery + signal collectors.</td></tr>
              )}
              {data.titles.map((t, i) => (
                <tr key={t.titleId} className="border-t border-border hover:bg-muted/30">
                  <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                  <td className="px-3 py-2">
                    <Link href={`/console-leaderboards/${platform}/${t.titleId}`}>
                      <span className="cursor-pointer hover:underline flex items-center gap-2" data-testid={`link-title-${t.titleId}`}>
                        {t.coverUrl && <img src={t.coverUrl} alt="" className="h-8 w-6 object-cover rounded-sm" />}
                        <span>{t.name || t.externalSku}</span>
                      </span>
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{formatNumberCompact(t.ratingCount)}</td>
                  <td className="px-3 py-2 text-right font-mono">{t.avgRating != null ? t.avgRating.toFixed(2) : "—"}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {t.ownersMid != null ? formatNumberCompact(t.ownersMid) : (
                      <span className="text-muted-foreground" title={t.gatedReason || "insufficient history"}>—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{formatUsd(t.msrpUsdCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
