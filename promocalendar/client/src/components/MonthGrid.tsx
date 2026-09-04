import { useMemo, useState } from "react";
import { platCls, pct, parseISO, fmtRange, fmtDay } from "../lib/format";
import { PlatformChip, StatusChip } from "./chips";
import type { EventSummary, EventDetail } from "../lib/api";
import { api } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { useLocation } from "wouter";

const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const MO = ["January","February","March","April","May","June","July","August","September","October","November","December"];

/**
 * Render a 6-row month calendar with per-day event chips.
 * Selecting a day (with events) opens the side drawer showing details.
 */
export function MonthGrid({
  year,
  month, // 1-12
  today,
  events,
  onNavYear,
  onNavMonth,
  onGotoToday,
}: {
  year: number;
  month: number;
  today: string;
  events: EventSummary[];
  onNavYear?: (y: number) => void;
  onNavMonth?: (dir: -1 | 1) => void;
  onGotoToday?: () => void;
}) {
  // Build 42 cells (6 weeks). Sunday-first.
  const first = new Date(Date.UTC(year, month - 1, 1));
  const lead = (first.getUTCDay()) % 7; // Sunday=0
  const grid: Date[] = [];
  for (let i = 0; i < 42; i++) {
    grid.push(new Date(Date.UTC(year, month - 1, 1 - lead + i)));
  }
  const todayD = parseISO(today);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedEvents = useMemo(
    () =>
      selected
        ? events.filter((e) => e.start_date <= selected && selected <= e.end_date)
            .sort((a, b) => (a.is_active === b.is_active ? a.platform.localeCompare(b.platform) : a.is_active ? -1 : 1))
        : [],
    [events, selected],
  );

  return (
    <div className="cal-shell">
      <div>
        <div className="month-nav">
          <button className="btn" onClick={() => onNavMonth?.(-1)} aria-label="Previous month">‹</button>
          <h1>{MO[month - 1]} {year}</h1>
          <button className="btn" onClick={() => onNavMonth?.(1)} aria-label="Next month">›</button>
          <button className="today-jump" onClick={() => onGotoToday?.()}>Today</button>
        </div>

        <div className="cal-grid">
          <div className="dow-row">
            {DOW.map((d) => <div key={d}>{d}</div>)}
          </div>
          <div className="cal-body">
            {grid.map((d, i) => {
              const iso = d.toISOString().slice(0, 10);
              const isCurrent = d.getUTCMonth() === month - 1;
              const isToday = iso === today;
              const isPast = d < todayD && !isToday;
              const isSelected = selected === iso;
              const cellEvents = events
                .filter((e) => e.start_date <= iso && iso <= e.end_date)
                .sort((a, b) =>
                  a.is_active !== b.is_active
                    ? a.is_active ? -1 : 1
                    : a.platform === b.platform
                      ? b.max_discount_pct - a.max_discount_pct
                      : a.platform.localeCompare(b.platform),
                );
              const shown = cellEvents.slice(0, 3);
              const overflow = cellEvents.length - shown.length;
              return (
                <div
                  key={i}
                  className={[
                    "day-cell",
                    !isCurrent && "other-month",
                    isToday && "today",
                    isPast && "past",
                  ].filter(Boolean).join(" ")}
                  onClick={() => cellEvents.length > 0 && setSelected(iso)}
                  style={{ cursor: cellEvents.length > 0 ? "pointer" : "default" }}
                >
                  <span className="num">{d.getUTCDate()}</span>
                  {shown.length > 0 && (
                    <div className="chip-stack">
                      {shown.map((c, idx) => (
                        <div
                          key={c.event_key + idx}
                          className={`day-chip ${platCls(c.platform)}${c.is_active ? " live" : ""}${isSelected && idx === 0 ? " selected" : ""}`}
                          title={`${c.program} · ${c.platform} · ${fmtRange(c.start_date, c.end_date)}`}
                        >
                          <span className="prog">{c.program}</span>
                          <span className="disc">{pct(c.max_discount_pct)}</span>
                        </div>
                      ))}
                      {overflow > 0 && <div className="more">+ {overflow} more</div>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <DayDrawer selectedDay={selected} events={selectedEvents} onClose={() => setSelected(null)} today={today} />
    </div>
  );
}

function DayDrawer({
  selectedDay,
  events,
  onClose,
  today,
}: {
  selectedDay: string | null;
  events: EventSummary[];
  onClose: () => void;
  today: string;
}) {
  const [, navigate] = useLocation();
  const e0 = events[0] || null;
  const detail = useAsync(
    async () => (e0 ? (await api.event(e0.event_key, today)).event : null),
    [e0?.event_key, today],
  );

  if (!selectedDay) {
    return (
      <aside className="drawer">
        <div className="d-hd">
          <div>
            <h3>Day details</h3>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>Click any day cell with events to inspect</div>
          </div>
        </div>
        <div className="field">
          <div className="lbl">Tip</div>
          <div className="val" style={{ fontSize: 12 }}>Chips represent multi-title events. Colored bar = platform. Red outline = live now.</div>
        </div>
      </aside>
    );
  }

  if (!e0) {
    return (
      <aside className="drawer">
        <div className="d-hd">
          <div>
            <h3>{fmtDay(selectedDay)}</h3>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>No events on this day</div>
          </div>
          <button className="close" onClick={onClose} aria-label="Close">✕</button>
        </div>
      </aside>
    );
  }

  const ev: EventDetail | null = detail.data;

  return (
    <aside className="drawer">
      <div className="d-hd">
        <div>
          <h3>{e0.program}</h3>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
            Selected · {fmtDay(selectedDay)}
          </div>
        </div>
        <button className="close" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="field">
        <div className="lbl">Dates</div>
        <div className="val">{fmtRange(e0.start_date, e0.end_date)}</div>
      </div>
      <div className="field">
        <div className="lbl">Platform / Status</div>
        <div className="val" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <PlatformChip platform={e0.platform} />
          <StatusChip daysUntilStart={e0.days_until_start} isActive={e0.is_active} />
        </div>
      </div>
      <div className="field">
        <div className="lbl">Discount range</div>
        <div className="val big">{pct(e0.min_discount_pct)} – {pct(e0.max_discount_pct)}</div>
      </div>
      <div className="field">
        <div className="lbl">Participating titles ({e0.title_count})</div>
        <div className="titles-list">
          {ev
            ? ev.games.map((g) => (
                <div key={g.game_code} className="t-row">
                  <span>{g.game_label}</span>
                  <span className="d">{pct(g.max_discount_pct)}</span>
                </div>
              ))
            : <div style={{ padding: 8, fontSize: 12, color: "var(--text-dim)" }}>Loading…</div>}
        </div>
      </div>
      {events.length > 1 && (
        <div className="field">
          <div className="lbl">Also active this day</div>
          {events.slice(1).map((ee) => (
            <div key={ee.event_key} style={{ fontSize: 12.5, color: "var(--text-muted)", padding: "6px 0", display: "flex", gap: 6, alignItems: "center" }}>
              <PlatformChip platform={ee.platform} />
              <span>{ee.program} · {pct(ee.max_discount_pct)}</span>
            </div>
          ))}
        </div>
      )}
      <button
        className="chip"
        style={{ width: "100%", padding: 9, background: "var(--primary)", color: "white", borderColor: "var(--primary)", justifyContent: "center", fontWeight: 600, cursor: "pointer" }}
        onClick={() => navigate(`/events/${e0.event_key}`)}
      >
        Open event detail →
      </button>
    </aside>
  );
}
