import type { EventPerformance as Performance } from "../../../shared/event-performance";
import { performanceCoverage } from "../../../shared/event-performance";
import { fmtUsdCompact } from "./BeatCard";

export function EventPerformanceSummary({ performance: p }: { performance?: Performance }) {
  if (!p) return null;
  return (
    <div className="event-performance-summary" data-status={p.status}>
      {p.net_revenue_usd != null && <strong>Net revenue {fmtUsdCompact(p.net_revenue_usd)}</strong>}
      <span>{performanceCoverage(p)}</span>
    </div>
  );
}

export function EventPerformanceDetail({ performance: p }: { performance?: Performance }) {
  if (!p) return null;
  return (
    <section className="analytics-card event-performance-detail" aria-label="Event sales performance">
      <h3>Event sales performance</h3>
      <div className="event-performance-values">
        <div><span>Net revenue</span><strong>{p.net_revenue_usd == null ? "—" : fmtUsdCompact(p.net_revenue_usd)}</strong></div>
        <div><span>Gross revenue</span><strong>{p.gross_revenue_usd == null ? "—" : fmtUsdCompact(p.gross_revenue_usd)}</strong></div>
      </div>
      <p>{performanceCoverage(p)}</p>
      <p className="performance-note">
        {p.status === "invalid_window" ? "The workbook end date precedes its start date. Sales are not calculated until the dates are corrected." :
          p.status === "not_started" ? "Sales capture begins when the event starts." :
          <>Reported window: {p.window_start} to {p.window_end}. A title-day is one participating title with a reported sales day.</>}
      </p>
      <p className="performance-note">
        {p.source ? `Source: ${p.source}. ` : "No partner actual-sales source is connected for this platform. "}
        Revenue includes base game and DLC in the date window; it is not incremental uplift or SKU-specific attribution.
        {p.fetched_at && ` Last successful fetch: ${new Date(p.fetched_at).toLocaleString()}.`}
        {p.checked_at && ` Last checked: ${new Date(p.checked_at).toLocaleString()}.`}
      </p>
    </section>
  );
}
