import { useMemo, useState } from "react";
import { api } from "../lib/api";
import { useAsync, usePendingSalesRefresh } from "../lib/hooks";
import { ErrorBanner, Skeleton } from "./misc";
import { EventPerformanceSummary } from "./EventPerformance";
import { PlatformChip } from "./chips";
import { fmtUsdCompact } from "./BeatCard";

export function EventPerformanceAnalytics({ today }: { today: string }) {
  const [platform, setPlatform] = useState("Steam");
  const [when, setWhen] = useState<"past" | "live" | "all">("past");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("recent");
  const [count, setCount] = useState(20);
  const result = useAsync(() => api.events({ when, platform: platform || undefined, today }), [when, platform, today]);
  usePendingSalesRefresh(result.data?.events.some(e => e.performance?.status === "pending"), result.reload);
  const invalidRange = !!from && !!to && from > to;
  const rows = useMemo(() => (result.data?.events ?? []).filter(e =>
    !invalidRange && (!from || e.end_date >= from) && (!to || e.start_date <= to) &&
    e.program.toLowerCase().includes(search.toLowerCase())).sort((a, b) => {
      if (sort === "revenue") {
        const av = a.performance?.net_revenue_usd, bv = b.performance?.net_revenue_usd;
        if (av == null && bv != null) return 1;
        if (bv == null && av != null) return -1;
        if (av != null && bv != null && av !== bv) return bv - av;
      }
      return b.end_date.localeCompare(a.end_date);
    }), [result.data, from, to, search, sort, invalidRange]);
  const covered = rows.filter(e => e.performance?.net_revenue_usd != null);
  const best = [...covered].sort((a, b) => b.performance!.net_revenue_usd! - a.performance!.net_revenue_usd!)[0];
  return (
    <section className="event-performance-analytics" aria-label="Promotion event performance">
      <div className="section-h">
        <div><h2>Promotion event performance</h2><p className="performance-note">Historical and live event-window sales from SignalPulse. Partial coverage is shown, not estimated.</p></div>
        <button className="btn" onClick={result.reload}>Refresh view</button>
      </div>
      <div className="performance-filters">
        <label>Platform<select value={platform} onChange={e => { setPlatform(e.target.value); setCount(20); }}>
          <option value="Steam">Steam</option><option value="Sony">PlayStation / Sony</option><option value="Microsoft">Xbox / Microsoft</option><option value="">All platforms</option>
        </select></label>
        <label>Events<select value={when} onChange={e => { setWhen(e.target.value as typeof when); setCount(20); }}>
          <option value="past">Past</option><option value="live">Live</option><option value="all">All</option>
        </select></label>
        <label>From<input type="date" value={from} onChange={e => { setFrom(e.target.value); setCount(20); }} /></label>
        <label>To<input type="date" value={to} onChange={e => { setTo(e.target.value); setCount(20); }} /></label>
        <label>Order<select value={sort} onChange={e => setSort(e.target.value)}><option value="recent">Most recent</option><option value="revenue">Net revenue: highest first</option></select></label>
        <label>Find event<input type="search" placeholder="Program name" value={search} onChange={e => { setSearch(e.target.value); setCount(20); }} /></label>
      </div>
      {invalidRange && <p role="alert">The From date must be on or before the To date.</p>}
      {result.loading ? <Skeleton height={180} /> : result.error ? <ErrorBanner error={result.error} /> : <>
        <div className="performance-overview">
          <span><strong>{rows.length}</strong> events</span>
          <span><strong>{covered.length}</strong> with reported revenue</span>
          {best && <span>Highest reported net: <strong>{fmtUsdCompact(best.performance!.net_revenue_usd!)}</strong> · {best.program}</span>}
        </div>
        <p className="performance-note">Dates select overlapping events; each row retains its full event window (live events through today). Overlapping events may share sales, so rows are not added into a portfolio total. Ranking includes partial and saved data; compare coverage before drawing conclusions.</p>
        {rows.length === 0 ? <div className="empty"><p>No events match these filters.</p></div> :
          <div className="term-table-wrap performance-table"><table className="term"><thead><tr>
            <th>Event</th><th>Platform</th><th>Event window</th><th>Net revenue & coverage</th><th className="num">Gross revenue</th><th>Last fetched</th>
          </tr></thead><tbody>{rows.slice(0, count).map(e => <tr key={e.event_key}>
            <td><a href={`#/events/${e.event_key}`}>{e.program}</a><small className="performance-note">{e.is_active ? "Live" : e.is_past ? "Past" : "Upcoming"}{e.archived ? " · archived" : ""}</small></td>
            <td data-label="Platform"><PlatformChip platform={e.platform} /></td>
            <td data-label="Event window" className="dates">{e.start_date}<br />{e.end_date}</td>
            <td><EventPerformanceSummary performance={e.performance} /></td>
            <td data-label="Gross revenue" className="num">{e.performance?.gross_revenue_usd == null ? "—" : fmtUsdCompact(e.performance.gross_revenue_usd)}</td>
            <td data-label="Last fetched" className="dates">{e.performance?.fetched_at ? new Date(e.performance.fetched_at).toLocaleString() : "Not fetched"}</td>
          </tr>)}</tbody></table></div>}
        {rows.length > count && <button className="btn" onClick={() => setCount(n => n + 20)}>Show more events ({rows.length - count} remaining)</button>}
      </>}
    </section>
  );
}
