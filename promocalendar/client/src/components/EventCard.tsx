import { useLocation } from "wouter";
import { PlatformChip, StatusChip, GameChip } from "./chips";
import { fmtRange, pct, durationDays } from "../lib/format";
import type { EventSummary } from "../lib/api";

export function EventCard({
  event,
  participatingCodes,
}: {
  event: EventSummary;
  participatingCodes?: string[];
}) {
  const [, navigate] = useLocation();
  const dur = durationDays(event.start_date, event.end_date);
  const cls = event.is_active ? " live" : "";
  const codes = participatingCodes || [];
  return (
    <article
      className={`event-card${cls}`}
      role="link"
      tabIndex={0}
      onClick={() => navigate(`/events/${event.event_key}`)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          navigate(`/events/${event.event_key}`);
        }
      }}
      style={{ cursor: "pointer" }}
    >
      <div className="top">
        <div className="name">
          {event.program}
          <small>
            <PlatformChip platform={event.platform} />
          </small>
        </div>
        <StatusChip daysUntilStart={event.days_until_start} isActive={event.is_active} />
      </div>
      <div className="dates">
        {fmtRange(event.start_date, event.end_date)} · {dur} days · {event.title_count} titles
      </div>
      {codes.length > 0 && (
        <div className="titles">
          {codes.map((c) => (
            <GameChip key={c} code={c} />
          ))}
        </div>
      )}
      <div className="footer">
        <div className="disc">
          {pct(event.max_discount_pct)}
          <small>
            {pct(event.min_discount_pct)} – {pct(event.max_discount_pct)} range
          </small>
        </div>
        <div className="link">Open →</div>
      </div>
    </article>
  );
}
