import { useMemo, useState } from "react";
import { Shell } from "../components/Shell";
import { api } from "../lib/api";
import { useAsync, usePersistedState } from "../lib/hooks";
import { getToday } from "../lib/today";
import { BeatCard, MultiBeatCard } from "../components/BeatCard";
import { MonthGrid } from "../components/MonthGrid";
import { Gantt } from "../components/Gantt";
import {
  TimelineRangeControl,
  rangeForPreset,
  type TimelineRange,
} from "../components/TimelineRangeControl";
import { Section, Skeleton, ErrorBanner, EmptyNoUpload, SegToggle } from "../components/misc";
import { todayHuman } from "../lib/today";
import { PlatformChip } from "../components/chips";
import { pct } from "../lib/format";

type View = "grid" | "timeline";

const GAMES = [
  { code: "SM2", label: "Warhammer 40,000: Space Marine 2" },
  { code: "SNOW", label: "SnowRunner" },
  { code: "ROADCRAFT", label: "RoadCraft" },
  { code: "EXPE", label: "Expeditions" },
  { code: "ISS", label: "Insurgency: Sandstorm" },
  { code: "TOXIC COMMANDO", label: "Toxic Commando" },
];

export default function CalendarPage() {
  const today = getToday();
  const [view, setView] = usePersistedState<View>("promocal.view.calendar", "grid");
  const [ym, setYm] = useState(() => {
    const [y, m] = today.split("-").map(Number);
    return { y, m };
  });
  // Timeline window — defaults to 6 months centered on today. The Gantt
  // spans every campaign back to 2022 by default, which produces an
  // unreadably dense bar strip; this control lets the user narrow to
  // 6/9/12mo presets or set custom bounds. Persisted so returns to the
  // page remember the choice.
  const [tlRange, setTlRange] = usePersistedState<TimelineRange>(
    "promocal.timeline.range",
    (() => {
      const r = rangeForPreset("6mo", today);
      return { preset: "6mo", start: r.start, end: r.end } as TimelineRange;
    })(),
  );

  const me = useAsync(() => api.me(), []);
  const cals = useAsync(() => api.calendars(), []);
  const liveNow = useAsync(() => api.liveNow(today), [today]);
  const nextUp = useAsync(() => api.nextUp(3, today), [today]);
  const nextMulti = useAsync(() => api.nextUpMulti(3, today), [today]);

  // Grid month events (fetch a broad live+upcoming window)
  const evs = useAsync(() => api.events({ when: "all", today }), [today]);
  const monthEvents = useMemo(() => (evs.data?.events || []), [evs.data]);
  // Timeline-scoped subset: any event overlapping [tlRange.start, tlRange.end].
  // Filtering happens client-side because the events endpoint already returns
  // everything and we don't want a second network roundtrip on preset changes.
  const timelineEvents = useMemo(() => {
    if (!monthEvents.length) return monthEvents;
    const { start, end } = tlRange;
    return monthEvents.filter(
      (e) => e.end_date >= start && e.start_date <= end,
    );
  }, [monthEvents, tlRange]);

  const activeUpload = cals.data?.calendars.find((c) => c.id === "saber")?.active_upload;
  if (cals.data && !activeUpload) {
    return (
      <Shell active="calendar" crumbs={[{ label: "Promo Calendar", href: "/" }, { label: "Calendar" }]}>
        <EmptyNoUpload canUpload={!!me.data?.can_upload} />
      </Shell>
    );
  }


  const liveBeats = liveNow.data?.beats || [];
  const liveTop = liveBeats.slice(0, 3);
  const liveMore = Math.max(0, liveBeats.length - liveTop.length);

  return (
    <Shell active="calendar" crumbs={[{ label: "Promo Calendar", href: "/" }, { label: "Calendar" }]}>
      <Section
        title="Promos Live Now"
        right={
          liveNow.loading ? (
            <span className="sub">Loading…</span>
          ) : liveBeats.length > 0 ? (
            <span className="sub">
              {liveBeats.length} campaign{liveBeats.length === 1 ? "" : "s"} in flight on {todayHuman(today)} · Steam first
              {liveMore > 0 && (
                <>
                  {" · "}
                  <a href="#/live" className="link">View all {liveBeats.length} →</a>
                </>
              )}
            </span>
          ) : (
            <span className="sub">Nothing live on {todayHuman(today)}</span>
          )
        }
      >
        {liveNow.loading ? (
          <Skeleton height={120} count={1} />
        ) : liveNow.error ? (
          <ErrorBanner error={liveNow.error} />
        ) : liveTop.length === 0 ? (
          <div className="empty" style={{ padding: "20px 24px" }}>
            <p>No campaigns currently in flight. Check back after the next scheduled sale window.</p>
          </div>
        ) : (
          <div className="strip-grid">
            {liveTop.map((b) => <BeatCard key={b.campaign_id} beat={b} />)}
          </div>
        )}
      </Section>

      <Section
        title="Next Up"
        right={<span className="sub">Server-anchored on {todayHuman(today)} · next 3 beats across all platforms</span>}
      >
        {nextUp.loading ? (
          <Skeleton height={120} count={1} />
        ) : nextUp.error ? (
          <ErrorBanner error={nextUp.error} />
        ) : (
          <div className="strip-grid">
            {(nextUp.data?.beats || []).map((b) => <BeatCard key={b.campaign_id} beat={b} />)}
          </div>
        )}
      </Section>

      <Section
        title="Next Up Multi-Title Promo"
        right={<span className="sub">Next 3 events spanning 2+ titles</span>}
      >
        {nextMulti.loading ? (
          <Skeleton height={140} count={1} />
        ) : nextMulti.error ? (
          <ErrorBanner error={nextMulti.error} />
        ) : !nextMulti.data?.beats.length ? (
          <div className="empty" style={{ padding: "20px 24px" }}>
            <p>No multi-title events on the calendar right now.</p>
          </div>
        ) : (
          <div className="strip-grid">
            {nextMulti.data.beats.map((b) => <MultiBeatCard key={b.event_key} beat={b} />)}
          </div>
        )}
      </Section>

      <div className="section-h" style={{ marginTop: 20 }}>
        <h2 style={{ fontSize: 20, letterSpacing: "-0.01em", textTransform: "none" }}>
          {view === "grid" ? "Month calendar" : "Portfolio timeline"}
        </h2>
        <SegToggle
          ariaLabel="Calendar view"
          value={view}
          onChange={setView}
          options={[{ value: "grid", label: "Grid" }, { value: "timeline", label: "Timeline" }]}
        />
      </div>

      {view === "timeline" && !evs.loading && !evs.error && (
        <div className="timeline-header">
          <TimelineRangeControl
            value={tlRange}
            today={today}
            onChange={setTlRange}
          />
          <div className="timeline-caption">
            {timelineEvents.length} of {monthEvents.length} events ·{" "}
            {tlRange.start} → {tlRange.end}
          </div>
        </div>
      )}

      {evs.loading ? (
        <Skeleton height={400} />
      ) : evs.error ? (
        <ErrorBanner error={evs.error} />
      ) : view === "grid" ? (
        <MonthGrid
          year={ym.y}
          month={ym.m}
          today={today}
          events={monthEvents}
          onNavMonth={(dir) => {
            let { y, m } = ym;
            m += dir;
            if (m < 1) { m = 12; y -= 1; }
            if (m > 12) { m = 1; y += 1; }
            setYm({ y, m });
          }}
          onGotoToday={() => {
            const [y, m] = today.split("-").map(Number);
            setYm({ y, m });
          }}
        />
      ) : (
        <Gantt events={timelineEvents} today={today} games={GAMES} />
      )}

      {view === "grid" && monthEvents.length > 0 && (
        <div style={{ marginTop: 12, fontSize: 12, color: "var(--text-dim)" }}>
          Showing {monthEvents.length} multi-title events across the portfolio. Each colored chip is one event; click a day to inspect participants.
        </div>
      )}
    </Shell>
  );
}

/** Placeholder to avoid unused import warnings if we ever inline it. */
export const _KeepImports = { PlatformChip, pct };
