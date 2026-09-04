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
      </div>
    </div>
  );
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
