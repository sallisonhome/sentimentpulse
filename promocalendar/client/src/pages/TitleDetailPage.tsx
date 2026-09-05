import { useMemo, useState } from "react";
import { Shell } from "../components/Shell";
import { api, type Campaign, type Sku } from "../lib/api";
import { useAsync, usePersistedState } from "../lib/hooks";
import { getToday } from "../lib/today";
import { BeatCard } from "../components/BeatCard";
import { PlatformChip, StatusChip } from "../components/chips";
import { Section, Skeleton, ErrorBanner, SegToggle } from "../components/misc";
import { fmtRange, pct, durationDays, parseISO } from "../lib/format";
import { SalesByCountryPanel, type LastPromoWindow } from "../components/SalesByCountryPanel";

type View = "cards" | "table";
type PlatFilter = "All" | "Sony" | "Microsoft" | "Steam";

export default function TitleDetailPage({ code }: { code: string }) {
  const today = getToday();
  const [view, setView] = usePersistedState<View>("promocal.view.title", "cards");
  const [platFilter, setPlatFilter] = useState<PlatFilter>("All");

  const games = useAsync(() => api.games(), []);
  const gameMeta = games.data?.games.find((g) => g.game_code === code) || null;
  const gameLabel = gameMeta?.game_label || code;

  const campaigns = useAsync(() => api.campaigns({ game_code: code }), [code]);
  const nextUp = useAsync(() => api.nextUpGame(code, 3, today), [code, today]);
  // Live Now for this title — mirrors the front-page treatment. Steam beats
  // get revenue-so-far enrichment via /api/:cal/games/:code/live-now.
  const liveNow = useAsync(() => api.liveNowGame(code, today), [code, today]);

  const filtered = useMemo(() => {
    const all = campaigns.data?.campaigns || [];
    // Only upcoming + live campaigns
    const future = all.filter((c) => c.end_date >= today);
    future.sort((a, b) => a.start_date.localeCompare(b.start_date));
    if (platFilter === "All") return future;
    return future.filter((c) => c.platform === platFilter);
  }, [campaigns.data, platFilter, today]);

  const allFuture = useMemo(() => {
    const all = campaigns.data?.campaigns || [];
    return all.filter((c) => c.end_date >= today).sort((a, b) => a.start_date.localeCompare(b.start_date));
  }, [campaigns.data, today]);

  const activeCount = allFuture.filter((c) => c.start_date <= today && today <= c.end_date).length;
  const upcoming = allFuture.filter((c) => c.start_date > today);
  const nextDays = upcoming[0] ? Math.floor((parseISO(upcoming[0].start_date).getTime() - parseISO(today).getTime()) / 86400000) : null;

  const byPlat: Record<string, Campaign[]> = { Sony: [], Microsoft: [], Steam: [] };
  for (const c of allFuture) if (byPlat[c.platform]) byPlat[c.platform].push(c);

  const crumbs = [
    { label: "Promo Calendar", href: "/" },
    { label: "Titles", href: "/titles" },
    { label: gameLabel },
  ];

  return (
    <Shell active="titles" crumbs={crumbs}>
      <div className="pdp-hero">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 20, flexWrap: "wrap" }}>
          <div>
            <div className="title">{gameLabel}</div>
            <div className="sub">
              Code: {code}
              {gameMeta ? ` · Platforms: ${gameMeta.platforms.join(" · ")}` : ""}
            </div>
          </div>
          <SegToggle
            ariaLabel="Title view"
            value={view}
            onChange={setView}
            options={[{ value: "cards", label: "Cards" }, { value: "table", label: "Table" }]}
          />
        </div>
        <div className="kpis">
          <div className="kpi">
            <div className="k">Total campaigns</div>
            <div className="v">{campaigns.data?.campaigns.length ?? "—"}</div>
            <div className="h">All years</div>
          </div>
          <div className="kpi">
            <div className="k">Active now</div>
            <div className="v" style={{ color: activeCount ? "#f87171" : undefined }}>{activeCount}</div>
            <div className="h">Live across all platforms</div>
          </div>
          <div className="kpi">
            <div className="k">Upcoming</div>
            <div className="v">{upcoming.length}</div>
            <div className="h">After today</div>
          </div>
          <div className="kpi">
            <div className="k">Next up</div>
            <div className="v">{nextDays != null ? `in ${nextDays}d` : "—"}</div>
            <div className="h">
              {upcoming[0] ? `${upcoming[0].program} · ${upcoming[0].platform}` : "No upcoming"}
            </div>
          </div>
        </div>
      </div>

      {(() => {
        const beats = liveNow.data?.beats || [];
        const top = beats.slice(0, 3);
        const more = Math.max(0, beats.length - top.length);
        if (liveNow.loading) {
          return (
            <Section title="Promos Live Now" right={<span className="sub">—</span>}>
              <Skeleton height={120} />
            </Section>
          );
        }
        if (liveNow.error) {
          return (
            <Section title="Promos Live Now" right={<span className="sub">—</span>}>
              <ErrorBanner error={liveNow.error} />
            </Section>
          );
        }
        if (!beats.length) return null;
        return (
          <Section
            title="Promos Live Now"
            right={
              <span className="sub">
                {beats.length} campaign{beats.length === 1 ? "" : "s"} in flight for {code}
                {more > 0 ? ` · showing top ${top.length}, Steam first` : ""}
              </span>
            }
          >
            <div className="strip-grid">
              {top.map((b) => <BeatCard key={b.campaign_id} beat={b} />)}
            </div>
          </Section>
        );
      })()}

      <Section title={`Next Up for ${code}`} right={<span className="sub">Next 3 beats across all platforms</span>}>
        {nextUp.loading ? (
          <Skeleton height={120} />
        ) : nextUp.error ? (
          <ErrorBanner error={nextUp.error} />
        ) : nextUp.data?.beats.length ? (
          <div className="strip-grid">
            {nextUp.data.beats.map((b) => <BeatCard key={b.campaign_id} beat={b} />)}
          </div>
        ) : (
          <div className="empty" style={{ padding: 20 }}><p>No upcoming beats for this title.</p></div>
        )}
      </Section>

      {/* ─── Sales by Country (v3.31, 2026-09-05) ───────────────── */}
      {gameMeta?.steam_app_id ? (
        <Section
          title="Sales by Country"
          right={<span className="sub">Steam per-country revenue · filters below</span>}
        >
          <SalesByCountryPanel
            steamAppId={gameMeta.steam_app_id}
            today={today}
            lastPromo={(() => {
              // Compute the most-recently-ENDED campaign strictly before today.
              const all = campaigns.data?.campaigns || [];
              const past = all.filter((c) => c.end_date < today);
              if (past.length === 0) return null;
              past.sort((a, b) => b.end_date.localeCompare(a.end_date));
              const last = past[0];
              return {
                since: last.start_date,
                until: last.end_date,
                label: `Last promo · ${last.program} (${last.platform})`,
              } as LastPromoWindow;
            })()}
          />
        </Section>
      ) : null}

      <div className="section-h" style={{ marginTop: 10 }}>
        <h2 style={{ fontSize: 20, letterSpacing: "-0.01em", textTransform: "none" }}>
          All upcoming &amp; live campaigns
        </h2>
        <span className="sub">{allFuture.length} campaigns</span>
      </div>

      <div className="plat-tabs">
        {(["All", "Sony", "Microsoft", "Steam"] as PlatFilter[]).map((p) => {
          const count = p === "All" ? allFuture.length : byPlat[p]?.length || 0;
          return (
            <button
              key={p}
              className={`tab${platFilter === p ? " on" : ""}`}
              onClick={() => setPlatFilter(p)}
            >
              {p} <span className="n">{count}</span>
            </button>
          );
        })}
      </div>

      {campaigns.loading ? (
        <Skeleton height={200} count={2} />
      ) : campaigns.error ? (
        <ErrorBanner error={campaigns.error} />
      ) : view === "cards" ? (
        <CardsGrid campaigns={filtered} today={today} />
      ) : (
        <CampaignTable campaigns={filtered} today={today} />
      )}
    </Shell>
  );
}

function CardsGrid({ campaigns, today }: { campaigns: Campaign[]; today: string }) {
  if (!campaigns.length) {
    return <div className="empty" style={{ padding: 24 }}><p>No campaigns match this filter.</p></div>;
  }
  return (
    <div className="pdp-card-grid">
      {campaigns.map((c, i) => (
        <PdpCard key={c.id} campaign={c} today={today} openDefault={i === 0} />
      ))}
    </div>
  );
}

function PdpCard({ campaign: c, today, openDefault }: { campaign: Campaign; today: string; openDefault: boolean }) {
  const isLive = c.start_date <= today && today <= c.end_date;
  const daysUntil = Math.floor((parseISO(c.start_date).getTime() - parseISO(today).getTime()) / 86400000);
  const dur = durationDays(c.start_date, c.end_date);
  const [open, setOpen] = useState(openDefault);
  const details = useAsync(() => (open ? api.campaign(c.id) : Promise.resolve(null)), [c.id, open]);
  return (
    <div className={`pdp-card${isLive ? " live" : ""}`}>
      <div className="top">
        <div>
          <div className="prog">{c.program}</div>
          <div className="dates">{fmtRange(c.start_date, c.end_date)} · {dur}d · {c.sku_count} SKU{c.sku_count === 1 ? "" : "s"}</div>
        </div>
        <PlatformChip platform={c.platform} />
      </div>
      <div className="row-b">
        <StatusChip daysUntilStart={daysUntil} isActive={isLive} />
        <div className="disc">{pct(c.max_discount_pct)}<small>up to</small></div>
      </div>
      <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary>SKU pricing ({c.sku_count} SKUs)</summary>
        {open && (
          details.loading ? <div style={{ padding: 8, fontSize: 12, color: "var(--text-dim)" }}>Loading pricing…</div> :
          details.error ? <div style={{ padding: 8, fontSize: 12, color: "#fecaca" }}>{details.error.message}</div> :
          details.data ? <SkuTable skus={details.data.skus} /> :
          null
        )}
      </details>
    </div>
  );
}

function SkuTable({ skus }: { skus: Sku[] }) {
  if (!skus.length) return <div style={{ padding: 8, fontSize: 12, color: "var(--text-dim)" }}>No SKU-level data.</div>;
  return (
    <table>
      <thead><tr><th>SKU</th><th>SRP</th><th>Promo</th><th>Off</th></tr></thead>
      <tbody>
        {skus.map((s) => (
          <tr key={s.id}>
            <td className="name">{s.content_name}</td>
            <td><span className="old">{s.current_srp_usd != null ? `$${s.current_srp_usd.toFixed(2)}` : "—"}</span></td>
            <td><span className="new">{s.promo_srp_usd != null ? `$${s.promo_srp_usd.toFixed(2)}` : "—"}</span></td>
            <td><span className="pctc">−{Math.round(s.discount_pct * 100)}%</span></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type SortKey = "start_date" | "end_date" | "program" | "platform" | "max_discount_pct" | "sku_count";

function CampaignTable({ campaigns, today }: { campaigns: Campaign[]; today: string }) {
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: "start_date", dir: 1 });
  const sorted = useMemo(() => {
    const arr = [...campaigns];
    arr.sort((a, b) => {
      const va = a[sort.k] as string | number;
      const vb = b[sort.k] as string | number;
      if (va < vb) return -sort.dir;
      if (va > vb) return sort.dir;
      return 0;
    });
    return arr;
  }, [campaigns, sort]);

  const columns: Array<{ k: SortKey; label: string; num?: boolean }> = [
    { k: "program", label: "Program" },
    { k: "platform", label: "Platform" },
    { k: "start_date", label: "Start" },
    { k: "end_date", label: "End" },
    { k: "max_discount_pct", label: "Max %", num: true },
    { k: "sku_count", label: "SKUs", num: true },
  ];

  const toggle = (k: SortKey) =>
    setSort((s) => ({ k, dir: s.k === k ? ((s.dir * -1) as 1 | -1) : 1 }));

  if (!campaigns.length) return <div className="empty" style={{ padding: 24 }}><p>No campaigns match this filter.</p></div>;

  return (
    <div className="term-table-wrap">
      <table className="term">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.k}
                className={c.num ? "num" : ""}
                onClick={() => toggle(c.k)}
              >
                {c.label}
                {sort.k === c.k && <span className="arrow">{sort.dir === 1 ? "▲" : "▼"}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((c) => {
            const isLive = c.start_date <= today && today <= c.end_date;
            return (
              <tr key={c.id} className={isLive ? "live" : ""}>
                <td className="prog">{c.program}</td>
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
  );
}
