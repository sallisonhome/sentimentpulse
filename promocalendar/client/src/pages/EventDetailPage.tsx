import { Shell } from "../components/Shell";
import { api } from "../lib/api";
import { useAsync, usePendingSalesRefresh } from "../lib/hooks";
import { getToday } from "../lib/today";
import { PlatformChip, StatusChip } from "../components/chips";
import { Skeleton, ErrorBanner } from "../components/misc";
import { EventPerformanceDetail } from "../components/EventPerformance";
import { fmtEventRange, fmtDay, pct, durationDays, parseISO } from "../lib/format";

export default function EventDetailPage({ eventKey }: { eventKey: string }) {
  const today = getToday();
  const detail = useAsync(() => api.event(eventKey, today), [eventKey, today]);
  usePendingSalesRefresh(detail.data?.event.performance?.status === "pending", detail.reload);

  return (
    <Shell
      active="events"
      crumbs={[
        { label: "Promo Calendar", href: "/" },
        { label: "Events", href: "/events" },
        { label: detail.data?.event.program || "Event" },
      ]}
    >
      {detail.loading ? (
        <Skeleton height={200} count={2} />
      ) : detail.error ? (
        <ErrorBanner error={detail.error} />
      ) : detail.data ? (
        <EventBody ev={detail.data.event} today={today} />
      ) : null}
    </Shell>
  );
}

function EventBody({ ev, today }: { ev: import("../lib/api").EventDetail; today: string }) {
  const dur = durationDays(ev.start_date, ev.end_date);
  const invalidWindow = ev.end_date < ev.start_date;
  const startD = parseISO(ev.start_date);
  const endD = parseISO(ev.end_date);
  const todayD = parseISO(today);
  const elapsedDays = Math.max(0, Math.min(dur, Math.floor((todayD.getTime() - startD.getTime()) / 86400000) + 1));
  const pctDone = Math.max(0, Math.min(100, (elapsedDays / dur) * 100));
  const remaining = Math.max(0, Math.ceil((endD.getTime() - todayD.getTime()) / 86400000));

  const games = [...ev.games].sort((a, b) => b.max_discount_pct - a.max_discount_pct);
  const totalSku = games.reduce((s, g) => s + g.sku_count, 0);

  return (
    <>
      <div className="evd-hero">
        <div className="name">{ev.program}</div>
        <div className="meta">
          <PlatformChip platform={ev.platform} />
          <span>·</span>
          <strong style={{ color: "var(--text)" }}>{fmtEventRange(ev.start_date, ev.end_date)}</strong>
          <span>·</span>
          <span>{invalidWindow ? "Check event dates" : `${dur} days`}</span>
          <span>·</span>
          <span>{ev.title_count} participating title{ev.title_count === 1 ? "" : "s"} · {totalSku} SKUs</span>
          <span>·</span>
          <StatusChip daysUntilStart={ev.days_until_start} isActive={ev.is_active} isPast={ev.is_past} invalid={invalidWindow} />
        </div>
        <div className="row2">
          <div style={{ color: "var(--text-muted)", fontSize: 12.5 }}>
            {invalidWindow ? "Workbook dates need correction" : ev.is_active
              ? `Sale window has been live for ${Math.abs(ev.days_until_start)} days · ${remaining} day${remaining === 1 ? "" : "s"} remaining`
              : ev.days_until_start > 0
                ? `Starts in ${ev.days_until_start} day${ev.days_until_start === 1 ? "" : "s"}`
                : `Ended ${Math.max(0, Math.floor((todayD.getTime() - endD.getTime()) / 86400000))}d ago`}
            {" · anchored to server date "} {today}
          </div>
          <div className="kpi-row">
            <div className="discsum">
              <div className="lbl">Overall discount range</div>
              <div className="val">{pct(ev.min_discount_pct)} – {pct(ev.max_discount_pct)}</div>
            </div>
          </div>
          {!invalidWindow && <div className="progress">
            <div className="bar"><div className="fill" style={{ width: `${pctDone.toFixed(0)}%` }} /></div>
            <div className="lbl">
              <span>{fmtDay(ev.start_date)}</span>
              <span>{pctDone.toFixed(0)}% elapsed</span>
              <span>{fmtDay(ev.end_date)}</span>
            </div>
          </div>}
        </div>
      </div>

      <EventPerformanceDetail performance={ev.performance} />
      {ev.archived && <p className="performance-note">Preserved from an earlier calendar upload.</p>}

      <div className="section-h" style={{ marginBottom: 10 }}>
        <h2 style={{ fontSize: 20, letterSpacing: "-0.01em", textTransform: "none" }}>Participating titles ({ev.title_count})</h2>
        <span className="sub">Sorted by max discount</span>
      </div>

      <div className="evd-grid">
        {games.map((g) => {
          const rangeLbl = g.min_discount_pct === g.max_discount_pct
            ? pct(g.max_discount_pct)
            : `${pct(g.min_discount_pct)} – ${pct(g.max_discount_pct)}`;
          const leftPct = g.min_discount_pct * 100;
          const widthPct = Math.max(2, (g.max_discount_pct - g.min_discount_pct) * 100);
          return (
            <article key={g.game_code} className="evd-title-card">
              <div className="name">
                {g.game_label}
                <small>Campaign #{g.campaign_id}</small>
              </div>
              <div className="disc-row">
                <span className="max">{pct(g.max_discount_pct)}</span>
                <span className="rng">{rangeLbl}</span>
              </div>
              <div className="discbar">
                <div className="range" style={{ left: `${leftPct}%`, width: `${widthPct}%` }} />
              </div>
              {ev.performance && (() => {
                const t = ev.performance.titles.find(t => t.game_code === g.game_code);
                if (!t) return null;
                return <div className="performance-note">
                  {t.net_revenue_usd == null ? "No reported sales data" : `Net revenue ${t.net_revenue_usd.toLocaleString("en-US", { style: "currency", currency: "USD" })}`}
                  {" · "}{t.days_covered} reported days
                </div>;
              })()}
              <div className="footer">
                <span className="sku">{g.sku_count} SKU{g.sku_count === 1 ? "" : "s"}</span>
                <a className="lnk" href={`#/titles/${encodeURIComponent(g.game_code)}`}>Open title →</a>
              </div>
            </article>
          );
        })}
      </div>

      <div style={{ marginTop: 22, color: "var(--text-dim)", fontSize: 12 }}>
        Event key: <span style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", color: "var(--text-muted)" }}>{ev.event_key}</span>
      </div>
    </>
  );
}
