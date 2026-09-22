/**
 * Steam Demos Leaderboard (experimental).
 *
 * Route: /demos-leaderboard
 *
 * Ranks up to the top ~50 currently-active Steam demos surfaced by the
 * official Demos hub (store.steampowered.com/demos/), plus Saber
 * Interactive's own demo roster tracked regardless of hub presence.
 *
 * Two ranking modes, matching SteamDB's own "Most played game demos"
 * reference chart (steamdb.info/charts/?category=10, which ranks by
 * Current / 24h Peak / All-Time Peak CCU):
 *   - Estimated Downloads (default) — review_delta × multiplier for the
 *     selected window. PROVISIONAL: calibrated against a single verified
 *     anchor (Hellraiser Revival demo, 100k downloads / 1,527 reviews ≈
 *     65.5x), shown as a low–high range, never a single precise number.
 *   - CCU (current concurrent players) — same live-player-count signal
 *     SteamDB's chart uses.
 *
 * Window filter follows the same d7/d30/d90/m12/ltd convention as
 * /console-leaderboards and howmanyareplaying's /buying (wishlist)
 * leaderboard.
 */

import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useState } from "react";

type WindowKey = "d7" | "d30" | "d90" | "m12" | "ltd";
type SortKey = "downloads" | "ccu";

const WINDOWS: Array<{ id: WindowKey; label: string }> = [
  { id: "d7",  label: "7 days"    },
  { id: "d30", label: "30 days"   },
  { id: "d90", label: "90 days"   },
  { id: "m12", label: "12 months" },
  { id: "ltd", label: "Lifetime"  },
];

const SORTS: Array<{ id: SortKey; label: string }> = [
  { id: "downloads", label: "Estimated Downloads" },
  { id: "ccu",       label: "Concurrent Players (CCU)" },
];

interface DemoRow {
  id: number;
  steamAppId: string;
  name: string;
  genre: string | null;
  isSaberPublished: boolean;
  reviewCountTotal: number | null;
  reviewDelta: number | null;
  unitsLow: number | null;
  unitsMid: number | null;
  unitsHigh: number | null;
  method: string | null;
  ccuCurrent: number | null;
  ccuAllTimePeak: number | null;
  ccuAsOf: string | null;
}

interface LeaderboardResponse {
  window: WindowKey;
  sort: SortKey;
  asOfDate: string | null;
  multiplier: { low: number; mid: number; high: number; note: string };
  count: number;
  demos: DemoRow[];
}

function formatNumberCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function useDemosLeaderboard(window: WindowKey, sort: SortKey, limit = 50) {
  return useQuery<LeaderboardResponse>({
    queryKey: [`/signal/api/demos/leaderboard`, { window, sort, limit }],
    queryFn: async () => {
      const url = `/signal/api/demos/leaderboard?window=${window}&sort=${sort}&limit=${limit}`;
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60_000,
  });
}

export default function DemosLeaderboard() {
  const [windowSel, setWindowSel] = useState<WindowKey>("d7");
  const [sortSel, setSortSel] = useState<SortKey>("downloads");
  const { data, isLoading, isError, error } = useDemosLeaderboard(windowSel, sortSel);

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-semibold">Steam Demos Leaderboard</h1>
            <Badge variant="outline" className="text-[10px] uppercase tracking-wide">experimental</Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Top free Steam demos ranked by estimated downloads or live concurrent players.
            Sourced from Steam's official Demos hub plus Saber Interactive's own roster.
            Free titles carry no revenue estimate — reviews and CCU are the tracked signals.
          </p>
          {data?.asOfDate && (
            <p className="text-xs text-muted-foreground mt-1" data-testid="text-demos-refresh-note">
              Latest estimate as of: {data.asOfDate}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-1 flex-wrap" role="tablist" aria-label="Window">
            {WINDOWS.map(w => (
              <Button
                key={w.id}
                variant={windowSel === w.id ? "default" : "outline"}
                size="sm"
                onClick={() => setWindowSel(w.id)}
                data-testid={`btn-demos-window-${w.id}`}
                role="tab"
                aria-selected={windowSel === w.id}
              >
                {w.label}
              </Button>
            ))}
          </div>
          <div className="flex gap-1 flex-wrap" role="tablist" aria-label="Sort">
            {SORTS.map(s => (
              <Button
                key={s.id}
                variant={sortSel === s.id ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setSortSel(s.id)}
                data-testid={`btn-demos-sort-${s.id}`}
                role="tab"
                aria-selected={sortSel === s.id}
              >
                {s.label}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {sortSel === "downloads" && data?.multiplier && (
        <p className="text-xs text-muted-foreground bg-muted/40 rounded-md px-3 py-2">
          Estimated downloads = reviews added in the selected window × a downloads-per-review
          multiplier (low {data.multiplier.low}x / mid {data.multiplier.mid}x / high {data.multiplier.high}x).
          {" "}Provisional — calibrated on a single verified anchor (Hellraiser Revival demo: 100,000
          downloads / 1,527 reviews). Treat the range, not the midpoint, as the estimate.
        </p>
      )}

      <Card className="overflow-x-auto">
        {isLoading && (
          <div className="p-4 space-y-2">
            {Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        )}
        {isError && (
          <div className="p-4 text-sm text-destructive">Failed to load leaderboard: {(error as Error)?.message}</div>
        )}
        {!isLoading && !isError && data && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium w-10">#</th>
                <th className="px-3 py-2 font-medium">Demo</th>
                <th className="px-3 py-2 font-medium">Genre</th>
                <th className="px-3 py-2 font-medium text-right">Reviews (LTD)</th>
                <th className="px-3 py-2 font-medium text-right">Est. Downloads (window)</th>
                <th className="px-3 py-2 font-medium text-right">CCU Current</th>
                <th className="px-3 py-2 font-medium text-right">CCU All-Time Peak</th>
              </tr>
            </thead>
            <tbody>
              {data.demos.map((d, i) => (
                <tr key={d.id} className="border-b border-border/50 hover:bg-muted/30" data-testid={`row-demo-${d.steamAppId}`}>
                  <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                  <td className="px-3 py-2">
                    <a
                      href={`https://store.steampowered.com/app/${d.steamAppId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium hover:underline"
                    >
                      {d.name}
                    </a>
                    {d.isSaberPublished && (
                      <Badge className="ml-2 text-[10px]" variant="secondary" data-testid={`badge-saber-${d.steamAppId}`}>
                        Saber
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{d.genre ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumberCompact(d.reviewCountTotal)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {d.unitsMid != null ? (
                      <span title={`Low ${formatNumberCompact(d.unitsLow)} · High ${formatNumberCompact(d.unitsHigh)}`}>
                        {formatNumberCompact(d.unitsLow)}–{formatNumberCompact(d.unitsHigh)}
                      </span>
                    ) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumberCompact(d.ccuCurrent)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumberCompact(d.ccuAllTimePeak)}</td>
                </tr>
              ))}
              {data.demos.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">No demo data yet.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
