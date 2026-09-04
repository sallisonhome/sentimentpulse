import { PlatformChip, StatusChip, gameShort } from "./chips";
import { fmtRange, pct } from "../lib/format";
import type { Beat, MultiTitleBeat } from "../lib/api";

/** Copy of B's .beat card (approach_b_grid/01_calendar.html). */
export function BeatCard({ beat }: { beat: Beat }) {
  return (
    <div className="beat">
      <div className="top">
        <div>
          <div className="title">{beat.game_label}</div>
          <div className="meta">{beat.program}</div>
        </div>
        <div className="disc">
          {pct(beat.max_discount_pct)}
          <small>up to</small>
        </div>
      </div>
      <div className="chips">
        <PlatformChip platform={beat.platform} />
        <StatusChip daysUntilStart={beat.days_until_start} isActive={beat.is_active} />
        <span className="chip">{fmtRange(beat.start_date, beat.end_date)}</span>
        <SteamRevenueChip beat={beat} />
      </div>
    </div>
  );
}

/**
 * Steam revenue accrued so far in this in-flight window (beat.start_date
 * through today). Server-side aggregation from SignalPulse; see
 * server/signalpulse-client.ts for the fetch and cache semantics.
 *
 * Renders only when:
 *   - platform is Steam,
 *   - beat is currently in-flight,
 *   - SignalPulse returned at least one day of data (days_covered > 0).
 *
 * When SignalPulse is unreachable or has no rows yet, we render NOTHING
 * instead of "$0" so a data lag never looks like zero sales. If you want
 * a placeholder chip when data is missing, change this to render "—".
 */
function SteamRevenueChip({ beat }: { beat: Beat }) {
  if (beat.platform !== "Steam" || !beat.is_active) return null;
  const net = beat.steam_current_net_revenue_usd;
  const days = beat.steam_current_days_covered ?? 0;
  if (net == null || days === 0) return null;
  return (
    <span
      className="chip steam-rev"
      title={`Steam net revenue from ${beat.start_date} through today (${days} day${days === 1 ? "" : "s"} of sales data). Source: SignalPulse Steam Revenue Leaderboard.`}
    >
      <span className="steam-rev-label">Rev</span>
      {fmtUsdCompact(net)}
    </span>
  );
}

/**
 * Compact USD formatter for the revenue chip: keeps cards from bloating
 * with 9-digit numbers.
 *   $1,234       -> $1.2K
 *   $12,345      -> $12.3K
 *   $1,234,567   -> $1.2M
 * Below $1K we show whole dollars.
 */
export function fmtUsdCompact(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Math.round(n).toLocaleString()}`;
}

export function MultiBeatCard({ beat }: { beat: MultiTitleBeat }) {
  const gamesLine = beat.games.map((g) => gameShort(g.game_code)).join(" · ");
  return (
    <div className="beat">
      <div className="top">
        <div>
          <div className="title">{beat.program}</div>
          <div className="meta">{beat.title_count} titles</div>
        </div>
        <div className="disc">
          {pct(beat.max_discount_pct)}
          <small>up to</small>
        </div>
      </div>
      <div className="chips">
        <PlatformChip platform={beat.platform} />
        <StatusChip daysUntilStart={beat.days_until_start} isActive={beat.is_active} />
        <span className="chip discount">
          {pct(beat.min_discount_pct)} – {pct(beat.max_discount_pct)}
        </span>
      </div>
      {gamesLine && <div className="games-line">{gamesLine}</div>}
    </div>
  );
}
