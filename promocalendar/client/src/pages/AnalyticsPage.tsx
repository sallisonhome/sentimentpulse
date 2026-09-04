import { useMemo, useState } from "react";
import { Shell } from "../components/Shell";
import { api, type Campaign } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { getToday, todayHuman } from "../lib/today";
import { Skeleton, ErrorBanner } from "../components/misc";
import { PlatformChip } from "../components/chips";
import { pct } from "../lib/format";
import { useLocation } from "wouter";

type SortKey = "start_date" | "end_date" | "game_label" | "platform" | "program" | "max_discount_pct" | "sku_count";

export default function AnalyticsPage() {
  const today = getToday();
  const cals = useAsync(() => api.calendars(), []);
  const campaigns = useAsync(() => api.campaigns({ from: today }), [today]);
  const events = useAsync(() => api.events({ when: "all", today }), [today]);

  const active = cals.data?.calendars.find((c) => c.id === "saber")?.active_upload;
  const totalCampaigns = active?.campaigns_count || 0;
  const totalEvents = active?.events_count || 0;

  const all = campaigns.data?.campaigns || [];
  const liveCount = all.filter((c) => c.start_date <= today && today <= c.end_date).length;
  const upcomingCount = all.filter((c) => c.start_date > today).length;
  const upcoming30 = all.filter((c) => {
    if (c.start_date <= today) return false;
    const diff = (new Date(c.start_date).getTime() - new Date(today).getTime()) / 86400000;
    return diff <= 30;
  }).length;
  const maxDisc = all.length ? Math.max(...all.map((c) => c.max_discount_pct)) : 0;

  // Group by platform
  const byPlat = new Map<string, { count: number; maxDisc: number }>();
  for (const c of all) {
    if (!byPlat.has(c.platform)) byPlat.set(c.platform, { count: 0, maxDisc: 0 });
    const rec = byPlat.get(c.platform)!;
    rec.count++;
    if (c.max_discount_pct > rec.maxDisc) rec.maxDisc = c.max_discount_pct;
  }

  // Group by game
  const byGame = new Map<string, { label: string; count: number; maxDisc: number }>();
  for (const c of all) {
    if (!byGame.has(c.game_code)) byGame.set(c.game_code, { label: c.game_label, count: 0, maxDisc: 0 });
    const rec = byGame.get(c.game_code)!;
    rec.count++;
    if (c.max_discount_pct > rec.maxDisc) rec.maxDisc = c.max_discount_pct;
  }

  return (
    <Shell active="analytics" crumbs={[{ label: "Promo Calendar", href: "/" }, { label: "Analytics" }]}>
      <div className="strip-hd">
        <h2>Analytics · anchored on {todayHuman(today)}</h2>
        <span className="sub">{campaigns.loading ? "loading…" : `${all.length} campaigns in window`}</span>
      </div>

      <div className="kpi-strip">
        <KpiCell k="Total campaigns" v={String(totalCampaigns)} h="All years" />
        <KpiCell k="Events" v={String(totalEvents)} h="Live + upcoming + past" />
        <KpiCell k="Live now" v={String(liveCount)} h="Active today" hot={liveCount > 0} />
        <KpiCell k="Upcoming" v={String(upcomingCount)} h="After today" />
        <KpiCell k="Next 30 days" v={String(upcoming30)} h="Starting soon" />
        <KpiCell k="Max discount" v={pct(maxDisc)} h="This window" warn />
      </div>

      <div className="top-live-strip">
        {events.data?.events.filter((e) => e.is_active).slice(0, 6).map((e) => (
          <span key={e.event_key} className="live-pill">
            <span className="dot" aria-hidden /> {e.program} <span className="max">{pct(e.max_discount_pct)}</span>
          </span>
        ))}
        {!events.loading && events.data && events.data.events.filter((e) => e.is_active).length === 0 && (
          <span className="chip" style={{ background: "var(--surface-2)" }}>No live events right now</span>
        )}
      </div>

      <div className="analytics-grid">
        <div className="analytics-card">
          <h3>Campaigns by platform</h3>
          {Array.from(byPlat.entries())
            .sort((a, b) => b[1].count - a[1].count)
            .map(([p, r]) => {
              const max = Math.max(...Array.from(byPlat.values()).map((v) => v.count));
              return (
                <div key={p} className="bar-row">
                  <span className="lbl"><PlatformChip platform={p} /></span>
                  <span className="track"><span style={{ width: `${(r.count / max) * 100}%` }} /></span>
                  <span className="val">{r.count}</span>
                </div>
              );
            })}
        </div>
        <div className="analytics-card">
          <h3>Campaigns by title (upcoming+live)</h3>
          {Array.from(byGame.entries())
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 8)
            .map(([code, r]) => {
              const max = Math.max(...Array.from(byGame.values()).map((v) => v.count));
              return (
                <div key={code} className="bar-row">
                  <span className="lbl" title={r.label}>{r.label.length > 18 ? r.label.slice(0, 17) + "…" : r.label}</span>
                  <span className="track"><span style={{ width: `${(r.count / max) * 100}%` }} /></span>
                  <span className="val">{r.count}</span>
                </div>
              );
            })}
        </div>
      </div>

      {campaigns.loading ? (
        <Skeleton height={300} />
      ) : campaigns.error ? (
        <ErrorBanner error={campaigns.error} />
      ) : (
        <MasterCampaignTable campaigns={all} today={today} />
      )}
    </Shell>
  );
}

function KpiCell({ k, v, h, hot, warn }: { k: string; v: string; h: string; hot?: boolean; warn?: boolean }) {
  return (
    <div className="kpi">
      <div className="k">{k}</div>
      <div className={`v${hot ? " hot" : warn ? " warn" : ""}`}>{v}</div>
      <div className="h">{h}</div>
    </div>
  );
}

function MasterCampaignTable({ campaigns, today }: { campaigns: Campaign[]; today: string }) {
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: "start_date", dir: 1 });
  const [q, setQ] = useState("");
  const [, navigate] = useLocation();

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return campaigns;
    return campaigns.filter(
      (c) =>
        c.program.toLowerCase().includes(term) ||
        c.game_label.toLowerCase().includes(term) ||
        c.game_code.toLowerCase().includes(term) ||
        c.platform.toLowerCase().includes(term),
    );
  }, [campaigns, q]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      const va = a[sort.k] as string | number;
      const vb = b[sort.k] as string | number;
      if (va < vb) return -sort.dir;
      if (va > vb) return sort.dir;
      return 0;
    });
    return arr;
  }, [filtered, sort]);

  const columns: Array<{ k: SortKey; label: string; num?: boolean }> = [
    { k: "program", label: "Program" },
    { k: "game_label", label: "Title" },
    { k: "platform", label: "Platform" },
    { k: "start_date", label: "Start" },
    { k: "end_date", label: "End" },
    { k: "max_discount_pct", label: "Max %", num: true },
    { k: "sku_count", label: "SKUs", num: true },
  ];
  const toggle = (k: SortKey) =>
    setSort((s) => ({ k, dir: s.k === k ? ((s.dir * -1) as 1 | -1) : 1 }));

  return (
    <div className="term-table-wrap">
      <div className="term-toolbar">
        <span className="count">Rows <strong>{sorted.length}</strong> of {campaigns.length}</span>
        <input
          type="text"
          className="search"
          placeholder="Search program, title, platform…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div style={{ maxHeight: 600, overflow: "auto" }}>
        <table className="term">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.k} className={c.num ? "num" : ""} onClick={() => toggle(c.k)}>
                  {c.label}
                  {sort.k === c.k && <span className="arrow">{sort.dir === 1 ? "▲" : "▼"}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, 500).map((c) => {
              const isLive = c.start_date <= today && today <= c.end_date;
              return (
                <tr
                  key={c.id}
                  className={isLive ? "live" : ""}
                  onClick={() => navigate(`/titles/${encodeURIComponent(c.game_code)}`)}
                  style={{ cursor: "pointer" }}
                >
                  <td className="prog">{c.program}</td>
                  <td>{c.game_label}</td>
                  <td><PlatformChip platform={c.platform} /></td>
                  <td className="dates">{c.start_date}</td>
                  <td className="dates">{c.end_date}</td>
                  <td className={`max num${c.max_discount_pct >= 0.5 ? " hot" : c.max_discount_pct >= 0.3 ? " warn" : ""}`}>{pct(c.max_discount_pct)}</td>
                  <td className="num">{c.sku_count}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {sorted.length > 500 && (
        <div style={{ padding: 12, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>
          Showing first 500 of {sorted.length}. Refine with search.
        </div>
      )}
    </div>
  );
}
