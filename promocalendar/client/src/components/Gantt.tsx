import { useMemo } from "react";
import { platCls, pct, parseISO, fmtRange } from "../lib/format";
import type { EventSummary } from "../lib/api";

const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

interface GameLane {
  code: string;
  label: string;
  bars: EventSummary[];
}

/**
 * Portfolio Gantt/timeline. Renders one row per game with campaign
 * bars positioned by start/end date across a computed window.
 * Adapted from approach_a_timeline / _approach_a.py.
 */
export function Gantt({
  events,
  today,
  games,
}: {
  events: EventSummary[];
  today: string;
  games: Array<{ code: string; label: string }>;
}) {
  const window = useMemo(() => computeWindow(events, today), [events, today]);
  const lanes: GameLane[] = games.map((g) => ({ code: g.code, label: g.label, bars: [] }));

  // Group events per game. Since the events endpoint gives multi-title
  // events, we render each event across all lanes (approximation — see
  // notes). We don't have per-lane participation from events?when=…, so
  // we fan out to *all* game lanes for now.
  for (const ev of events) {
    for (const lane of lanes) lane.bars.push(ev);
  }

  const tx = xPct(today, window);
  const monthMarks = buildMonthMarks(window);

  return (
    <div className="gantt-wrap">
      <div className="gantt-head">
        <div className="titles-col" style={{ display: "flex", alignItems: "flex-end", paddingBottom: 6 }}>
          <span className="label">Title</span>
        </div>
        <div className="gantt-scale">
          {monthMarks.map((m) => (
            <div key={m.label} className="month" style={{ left: `${m.left}%` }}>{m.label}</div>
          ))}
          {buildWeekTicks(window).map((left, i) => (
            <div key={i} className="week-tick" style={{ left: `${left}%` }} />
          ))}
          <div className="today-line" style={{ left: `${tx}%` }} />
          <div className="today-label" style={{ left: `${tx}%` }}>TODAY</div>
        </div>
      </div>

      {lanes.map((lane) => {
        const placed = layoutBars(lane.bars);
        const nRows = placed.length ? Math.max(...placed.map((p) => p.row)) + 1 : 1;
        const trackH = Math.max(56, 8 + nRows * 22 + 6);
        return (
          <div key={lane.code} className="gantt-row" style={{ minHeight: trackH }}>
            <div className="title-cell">
              <div className="name">{lane.label}</div>
              <div className="sub">{lane.bars.length} events</div>
            </div>
            <div className="gantt-track">
              <div style={{ position: "absolute", top: 0, bottom: 0, left: `${tx}%`, width: 1, background: "rgba(239,68,68,0.55)", pointerEvents: "none" }} />
              {placed.map((p, i) => {
                const left = xPct(p.bar.start_date, window);
                const width = Math.max(0.4, xPct(p.bar.end_date, window) - left);
                const cls = platCls(p.bar.platform);
                const live = p.bar.is_active ? " live" : "";
                return (
                  <div
                    key={i}
                    className={`bar ${cls}${live}`}
                    style={{ left: `${left}%`, width: `${width}%`, top: 8 + p.row * 22 }}
                    title={`${p.bar.program} · ${p.bar.platform} · ${fmtRange(p.bar.start_date, p.bar.end_date)} · ${pct(p.bar.max_discount_pct)} max`}
                  >
                    <span>{p.bar.program}</span>
                    <span className="b-disc">{pct(p.bar.max_discount_pct)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="legend">
        <span><span className="sw plat-steam" />Steam</span>
        <span><span className="sw plat-ms" />Microsoft</span>
        <span><span className="sw plat-sony" />Sony</span>
        <span style={{ marginLeft: "auto" }}>Bars represent multi-title events across the portfolio · red outline = live now</span>
      </div>
    </div>
  );
}

interface Window { start: Date; end: Date; days: number; }

function computeWindow(events: EventSummary[], today: string): Window {
  const dates = events.flatMap((e) => [e.start_date, e.end_date]);
  const todayD = parseISO(today);
  let min = todayD;
  let max = new Date(todayD.getTime() + 120 * 86400000);
  for (const d of dates) {
    const dd = parseISO(d);
    if (dd < min) min = dd;
    if (dd > max) max = dd;
  }
  // Pad by a week on either side
  const start = new Date(min.getTime() - 7 * 86400000);
  const end = new Date(max.getTime() + 7 * 86400000);
  const days = Math.floor((end.getTime() - start.getTime()) / 86400000);
  return { start, end, days };
}

function xPct(iso: string, w: Window): number {
  const d = parseISO(iso);
  let dd = d;
  if (dd < w.start) dd = w.start;
  if (dd > w.end) dd = w.end;
  return ((dd.getTime() - w.start.getTime()) / 86400000 / w.days) * 100;
}

function buildMonthMarks(w: Window): Array<{ label: string; left: number }> {
  const marks: Array<{ label: string; left: number }> = [];
  const cursor = new Date(Date.UTC(w.start.getUTCFullYear(), w.start.getUTCMonth(), 1));
  while (cursor <= w.end) {
    const iso = cursor.toISOString().slice(0, 10);
    const left = Math.max(0, xPct(iso, w));
    marks.push({ label: MONTH_SHORT[cursor.getUTCMonth()] + " " + cursor.getUTCFullYear(), left });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return marks;
}

function buildWeekTicks(w: Window): number[] {
  const ticks: number[] = [];
  const cursor = new Date(w.start.getTime());
  while (cursor <= w.end) {
    ticks.push(xPct(cursor.toISOString().slice(0, 10), w));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return ticks;
}

function layoutBars(bars: EventSummary[]): Array<{ bar: EventSummary; row: number }> {
  const sorted = [...bars].sort((a, b) => a.start_date.localeCompare(b.start_date));
  const rowEnds: Date[] = [];
  const placed: Array<{ bar: EventSummary; row: number }> = [];
  for (const b of sorted) {
    const s = parseISO(b.start_date);
    const e = parseISO(b.end_date);
    let row = rowEnds.findIndex((end) => s > end);
    if (row === -1) {
      row = rowEnds.length;
      rowEnds.push(e);
    } else {
      rowEnds[row] = e;
    }
    placed.push({ bar: b, row });
  }
  return placed;
}
