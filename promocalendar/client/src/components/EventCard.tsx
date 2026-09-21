import { useLocation } from "wouter";
import { PlatformChip, StatusChip, GameChip } from "./chips";
import { EventPerformanceSummary } from "./EventPerformance";
import { fmtEventRange, pct, durationDays } from "../lib/format";
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
        <StatusChip daysUntilStart={event.days_until_start} isActive={event.is_active} isPast={event.is_past} invalid={event.end_date < event.start_date} />
      </div>
      <div className="dates">
        {fmtEventRange(event.start_date, event.end_date)} · {event.end_date < event.start_date ? "Check dates" : `${dur} days`} · {event.title_count} titles
      </div>
      <EventPerformanceSummary performance={event.performance} />
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
