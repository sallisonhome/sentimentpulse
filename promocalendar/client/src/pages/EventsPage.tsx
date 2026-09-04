import { useMemo, useState } from "react";
import { Shell } from "../components/Shell";
import { api, type EventSummary } from "../lib/api";
import { useAsync, usePersistedState } from "../lib/hooks";
import { getToday } from "../lib/today";
import { Skeleton, ErrorBanner, SegToggle } from "../components/misc";
import { PlatformChip, StatusChip, GameChip } from "../components/chips";
import { EventCard } from "../components/EventCard";
import { fmtRange, pct, durationDays } from "../lib/format";
import { useLocation } from "wouter";

type View = "list" | "table";
type When = "all" | "live" | "upcoming" | "past";
type PlatFilter = "All" | "Steam" | "Microsoft" | "Sony";

export default function EventsPage() {
  const today = getToday();
  const [view, setView] = usePersistedState<View>("promocal.view.events", "list");
  const [when, setWhen] = useState<When>("all");
  const [plat, setPlat] = useState<PlatFilter>("All");

  const evs = useAsync(
    () => api.events({ when, platform: plat === "All" ? undefined : plat, today }),
    [when, plat, today],
  );

  const events = evs.data?.events || [];
  const live = events.filter((e) => e.is_active);
  const upcoming = events.filter((e) => !e.is_active && !e.is_past);
  const past = events.filter((e) => e.is_past);

  return (
    <Shell active="events" crumbs={[{ label: "Promo Calendar", href: "/" }, { label: "Events" }]}>
      <div className="section-h" style={{ marginBottom: 8 }}>
        <div>
          <h2 style={{ fontSize: 20, letterSpacing: "-0.01em", textTransform: "none" }}>Events</h2>
          <span className="sub">{events.length} multi-title events</span>
        </div>
        <SegToggle
          ariaLabel="Events view"
          value={view}
          onChange={setView}
          options={[{ value: "list", label: "List" }, { value: "table", label: "Table" }]}
        />
      </div>

      <div className="filter-bar">
        <span className="lbl">When</span>
        <div className="grp">
          {(["all", "live", "upcoming", "past"] as When[]).map((w) => (
            <button key={w} className={when === w ? "on" : ""} onClick={() => setWhen(w)}>
              {w[0].toUpperCase() + w.slice(1)}
            </button>
          ))}
        </div>
        <span className="lbl">Platform</span>
        <div className="grp">
          {(["All", "Steam", "Microsoft", "Sony"] as PlatFilter[]).map((p) => (
            <button key={p} className={plat === p ? "on" : ""} onClick={() => setPlat(p)}>{p}</button>
          ))}
        </div>
      </div>

      {evs.loading ? (
        <Skeleton height={200} count={2} />
      ) : evs.error ? (
        <ErrorBanner error={evs.error} />
      ) : events.length === 0 ? (
        <div className="empty" style={{ padding: 24 }}><p>No events match these filters.</p></div>
      ) : view === "list" ? (
        <ListView live={live} upcoming={upcoming} past={past} />
      ) : (
        <TableView events={events} today={today} />
      )}
    </Shell>
  );
}

function ListView({ live, upcoming, past }: { live: EventSummary[]; upcoming: EventSummary[]; past: EventSummary[] }) {
  return (
    <div className="events-grid">
      {live.length > 0 && (
        <>
          <div className="month-section-h" style={{ borderColor: "rgba(239,68,68,0.25)", color: "#fecaca" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--live)", boxShadow: "0 0 0 4px rgba(239,68,68,0.18)" }} aria-hidden />
              Live now · {live.length} event{live.length === 1 ? "" : "s"}
            </span>
          </div>
          {live.map((e) => <EventCard key={e.event_key} event={e} />)}
        </>
      )}
      {groupByMonth(upcoming).map((grp) => (
        <MonthGroup key={grp.month} label={monthLabel(grp.month)} events={grp.events} />
      ))}
      {past.length > 0 && (
        <>
          <div className="month-section-h">Past · {past.length} events</div>
          {past.slice(0, 24).map((e) => <EventCard key={e.event_key} event={e} />)}
        </>
      )}
    </div>
  );
}

function MonthGroup({ label, events }: { label: string; events: EventSummary[] }) {
  return (
    <>
      <div className="month-section-h">{label} · {events.length} events</div>
      {events.map((e) => <EventCard key={e.event_key} event={e} />)}
    </>
  );
}

function groupByMonth(events: EventSummary[]) {
  const map = new Map<string, EventSummary[]>();
  for (const e of events) {
    const k = e.start_date.slice(0, 7);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(e);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, events]) => ({ month, events }));
}

function monthLabel(k: string): string {
  const [y, m] = k.split("-").map(Number);
  const MO = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${MO[m - 1]} ${y}`;
}

type SortKey = "start_date" | "end_date" | "program" | "platform" | "max_discount_pct" | "title_count";

function TableView({ events, today }: { events: EventSummary[]; today: string }) {
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: "start_date", dir: 1 });
  const [, navigate] = useLocation();
  const sorted = useMemo(() => {
    const arr = [...events];
    arr.sort((a, b) => {
      const va = a[sort.k] as string | number;
      const vb = b[sort.k] as string | number;
      if (va < vb) return -sort.dir;
      if (va > vb) return sort.dir;
      return 0;
    });
    return arr;
  }, [events, sort]);
  const columns: Array<{ k: SortKey; label: string; num?: boolean }> = [
    { k: "program", label: "Program" },
    { k: "platform", label: "Platform" },
    { k: "start_date", label: "Start" },
    { k: "end_date", label: "End" },
    { k: "title_count", label: "Titles", num: true },
    { k: "max_discount_pct", label: "Max %", num: true },
  ];
  const toggle = (k: SortKey) =>
    setSort((s) => ({ k, dir: s.k === k ? ((s.dir * -1) as 1 | -1) : 1 }));
  return (
    <div className="term-table-wrap">
      <table className="term">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.k} className={c.num ? "num" : ""} onClick={() => toggle(c.k)}>
                {c.label}
                {sort.k === c.k && <span className="arrow">{sort.dir === 1 ? "▲" : "▼"}</span>}
              </th>
            ))}
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((e) => (
            <tr
              key={e.event_key}
              className={e.is_active ? "live" : ""}
              onClick={() => navigate(`/events/${e.event_key}`)}
              style={{ cursor: "pointer" }}
            >
              <td className="prog">{e.program}</td>
              <td><PlatformChip platform={e.platform} /></td>
              <td className="dates">{e.start_date}</td>
              <td className="dates">{e.end_date} <span className="rel">({durationDays(e.start_date, e.end_date)}d)</span></td>
              <td className="num">{e.title_count}</td>
              <td className={`max num${e.max_discount_pct >= 0.5 ? " hot" : e.max_discount_pct >= 0.3 ? " warn" : ""}`}>{pct(e.max_discount_pct)}</td>
              <td><StatusChip daysUntilStart={e.days_until_start} isActive={e.is_active} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Keep imports for potential inline reuse. */
export const _keep = { GameChip, fmtRange };
