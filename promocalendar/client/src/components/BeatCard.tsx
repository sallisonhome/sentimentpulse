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
        <BeatPriceBlock beat={beat} />
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
 * Per-title price block on the right side of a BeatCard.
 *
 * When the campaign has a base-game SKU (server-detected via
 * primary_sku), we show the real prices from the sheet:
 *   $59.99  (strike, muted)
 *   $17.99  (prominent, accent color)
 *   −70%   (small chip)
 *
 * When the campaign is DLC-only (no base-game SKU), we keep the older
 * "up to X%" framing since there is no single price that represents
 * the sale. Group / multi-title cards keep the "up to" framing always;
 * see MultiBeatCard below.
 *
 * Added 2026-09-04 per user request — the plain "70% up to" number was
 * abstract; a strike-through SRP + real promo price ties the sale to a
 * concrete dollar amount the reader can act on.
 */
function BeatPriceBlock({ beat }: { beat: Beat }) {
  const sku = beat.primary_sku;
  if (!sku) {
    return (
      <div className="disc">
        {pct(beat.max_discount_pct)}
        <small>up to</small>
      </div>
    );
  }
  const off = Math.round(sku.discount_pct * 100);
  return (
    <div className="disc price" title={`Base game: ${sku.content_name}`}>
      <div className="price-was">{fmtUsdPrice(sku.current_srp_usd)}</div>
      <div className="price-now">{fmtUsdPrice(sku.promo_srp_usd)}</div>
      <div className="price-off">−{off}%</div>
    </div>
  );
}

/**
 * USD price with 2 decimals unless the trailing digits are all zeros
 * (e.g. $17.997 → $17.99 truncated; $60.00 → $60). Sheet data occasionally
 * has 4-decimal artefacts from Excel rounding — truncate at 2.
 */
function fmtUsdPrice(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  if (Number.isInteger(rounded)) return `$${rounded}`;
  return `$${rounded.toFixed(2)}`;
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
