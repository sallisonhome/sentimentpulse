import { Link } from "wouter";
import { Shell } from "../components/Shell";
import { api } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { getToday } from "../lib/today";
import { PlatformChip, StatusChip } from "../components/chips";
import { Skeleton, ErrorBanner, Section } from "../components/misc";
import { BeatCard } from "../components/BeatCard";
import { fmtRange, pct, platCls } from "../lib/format";

export function PlatformsIndex() {
  const today = getToday();
  const filters = useAsync(() => api.filters(), []);
  return (
    <Shell active="platforms" crumbs={[{ label: "Promo Calendar", href: "/" }, { label: "Platforms" }]}>
      <div className="section-h" style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 20, letterSpacing: "-0.01em", textTransform: "none" }}>Platforms</h2>
        <span className="sub">{filters.data?.platforms.length || 0} platforms · anchored on {today}</span>
      </div>
      {filters.loading ? (
        <Skeleton height={100} count={1} />
      ) : filters.error ? (
        <ErrorBanner error={filters.error} />
      ) : (
        <div className="strip-grid">
          {filters.data?.platforms.map((p) => (
            <PlatformCard key={p} platform={p} today={today} />
          ))}
        </div>
      )}
    </Shell>
  );
}

function PlatformCard({ platform, today }: { platform: string; today: string }) {
  const nextUp = useAsync(() => api.nextUpPlatform(platform, 1, today), [platform, today]);
  const next = nextUp.data?.beats[0];
  return (
    <Link href={`/platforms/${encodeURIComponent(platform)}`}>
      <a className="beat" style={{ cursor: "pointer" }}>
        <div className="top">
          <div>
            <div className="title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className={`chip ${platCls(platform)}`} style={{ padding: "4px 10px", fontSize: 13 }}>{platform}</span>
            </div>
            <div className="meta">
              {next
                ? `Next: ${next.program} · ${next.game_label}`
                : nextUp.loading ? "Loading…" : "No upcoming beats"}
            </div>
          </div>
          {next && (
            <div className="disc">
              {pct(next.max_discount_pct)}
              <small>up to</small>
            </div>
          )}
        </div>
        {next && (
          <div className="chips">
            <StatusChip daysUntilStart={next.days_until_start} isActive={next.is_active} />
            <span className="chip">{fmtRange(next.start_date, next.end_date)}</span>
          </div>
        )}
      </a>
    </Link>
  );
}

export function PlatformDetail({ platform }: { platform: string }) {
  const today = getToday();
  const nextUp = useAsync(() => api.nextUpPlatform(platform, 6, today), [platform, today]);
  const campaigns = useAsync(() => api.campaigns({ platform }), [platform]);
  const upcomingCampaigns = campaigns.data?.campaigns
    .filter((c) => c.end_date >= today)
    .sort((a, b) => a.start_date.localeCompare(b.start_date)) || [];
  const liveCount = upcomingCampaigns.filter((c) => c.start_date <= today && today <= c.end_date).length;

  return (
    <Shell
      active="platforms"
      crumbs={[{ label: "Promo Calendar", href: "/" }, { label: "Platforms", href: "/platforms" }, { label: platform }]}
    >
      <div className="pdp-hero">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 20, flexWrap: "wrap" }}>
          <div>
            <div className="title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className={`chip ${platCls(platform)}`} style={{ padding: "5px 12px", fontSize: 15 }}>{platform}</span>
            </div>
            <div className="sub">All upcoming and live campaigns on {platform}</div>
          </div>
        </div>
        <div className="kpis">
          <div className="kpi"><div className="k">Total campaigns</div><div className="v">{campaigns.data?.campaigns.length ?? "—"}</div><div className="h">All years</div></div>
          <div className="kpi"><div className="k">Live now</div><div className="v" style={{ color: liveCount ? "#f87171" : undefined }}>{liveCount}</div><div className="h">Active today</div></div>
          <div className="kpi"><div className="k">Upcoming</div><div className="v">{upcomingCampaigns.length - liveCount}</div><div className="h">After today</div></div>
          <div className="kpi"><div className="k">Next up</div><div className="v">
            {upcomingCampaigns.filter((c) => c.start_date > today)[0]
              ? `in ${Math.floor((new Date(upcomingCampaigns.filter((c) => c.start_date > today)[0].start_date).getTime() - new Date(today).getTime()) / 86400000)}d`
              : "—"}
          </div><div className="h">{upcomingCampaigns.filter((c) => c.start_date > today)[0]?.program || "No upcoming"}</div></div>
        </div>
      </div>

      <Section title={`Next Up on ${platform}`} right={<span className="sub">Next 6 beats</span>}>
        {nextUp.loading ? (
          <Skeleton height={120} />
        ) : nextUp.error ? (
          <ErrorBanner error={nextUp.error} />
        ) : nextUp.data?.beats.length ? (
          <div className="strip-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
            {nextUp.data.beats.map((b) => <BeatCard key={b.campaign_id} beat={b} />)}
          </div>
        ) : (
          <div className="empty" style={{ padding: 20 }}><p>No upcoming beats on this platform.</p></div>
        )}
      </Section>

      <div className="section-h" style={{ marginTop: 20 }}>
        <h2 style={{ fontSize: 20, letterSpacing: "-0.01em", textTransform: "none" }}>All upcoming campaigns</h2>
        <span className="sub">{upcomingCampaigns.length} campaigns</span>
      </div>

      {campaigns.loading ? (
        <Skeleton height={200} />
      ) : campaigns.error ? (
        <ErrorBanner error={campaigns.error} />
      ) : upcomingCampaigns.length === 0 ? (
        <div className="empty" style={{ padding: 24 }}><p>No campaigns for this platform yet.</p></div>
      ) : (
        <div className="term-table-wrap">
          <table className="term">
            <thead>
              <tr>
                <th>Program</th>
                <th>Title</th>
                <th>Start</th>
                <th>End</th>
                <th className="num">Max %</th>
                <th className="num">SKUs</th>
              </tr>
            </thead>
            <tbody>
              {upcomingCampaigns.slice(0, 200).map((c) => {
                const isLive = c.start_date <= today && today <= c.end_date;
                return (
                  <tr key={c.id} className={isLive ? "live" : ""}>
                    <td className="prog">{c.program}</td>
                    <td>{c.game_label}</td>
                    <td className="dates">{c.start_date}</td>
                    <td className="dates">{c.end_date}</td>
                    <td className={`max num${c.max_discount_pct >= 0.5 ? " hot" : c.max_discount_pct >= 0.3 ? " warn" : ""}`}>{pct(c.max_discount_pct)}</td>
                    <td className="num">{c.sku_count}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {upcomingCampaigns.length > 200 && (
            <div style={{ padding: 12, color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>
              Showing 200 of {upcomingCampaigns.length}. Refine by title or use Analytics.
            </div>
          )}
        </div>
      )}
    </Shell>
  );
}
