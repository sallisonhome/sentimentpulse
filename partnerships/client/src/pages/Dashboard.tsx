import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { api } from "../lib/api";
import { dateShort, usd } from "../lib/format";
import type { DashboardRow, PartnershipsTitle } from "@shared/schema";

/**
 * Dashboard — one row per SignalPulse title with at least one non-flagged
 * opportunity. Columns are locked to the spec order.
 */
export default function Dashboard() {
  const [rows, setRows] = useState<DashboardRow[] | null>(null);
  const [allTitles, setAllTitles] = useState<PartnershipsTitle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [platform, setPlatform] = useState<string>("");
  const [hideZero, setHideZero] = useState(true);

  useEffect(() => {
    Promise.all([api.dashboard(), api.titles()])
      .then(([d, t]) => {
        setRows(d);
        setAllTitles(t);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const filtered = useMemo(() => {
    if (!rows) return [];
    return rows.filter((r) => {
      if (q && !r.title.title.toLowerCase().includes(q.toLowerCase()))
        return false;
      if (platform && !r.title.platforms.includes(platform)) return false;
      return true;
    });
  }, [rows, q, platform]);

  const untrackedTitles = useMemo(() => {
    if (!allTitles || !rows) return [];
    const withData = new Set(rows.map((r) => r.title.id));
    return allTitles.filter((t) => !withData.has(t.id));
  }, [allTitles, rows]);

  const totals = useMemo(() => {
    const t = { secRev: 0, discRev: 0, mkgSec: 0, mkgDisc: 0, mgUsd: 0 };
    for (const r of filtered) {
      t.secRev += r.securedRevenueUsd;
      t.discRev += r.inDiscussionRevenueUsd;
      t.mkgSec += r.marketingSecuredCount;
      t.mkgDisc += r.marketingInDiscussionCount;
      t.mgUsd += r.physicalRetailMgUsd;
    }
    return t;
  }, [filtered]);

  const platforms = useMemo(() => {
    const s = new Set<string>();
    (allTitles || []).forEach((t) => t.platforms.forEach((p) => s.add(p)));
    return Array.from(s).sort();
  }, [allTitles]);

  if (error) {
    return (
      <div className="max-w-6xl mx-auto px-6 py-16">
        <div
          className="card p-4 text-sm"
          style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
        >
          Failed to load dashboard: {error}
        </div>
      </div>
    );
  }

  if (!rows) {
    return (
      <div className="max-w-6xl mx-auto px-6 py-16 text-sm" style={{ color: "var(--text-muted)" }}>
        Loading…
      </div>
    );
  }

  return (
    <div className="max-w-[1600px] mx-auto px-6 py-6">
      {/* Summary bar */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
        <SummaryTile label="Titles tracked" value={String(filtered.length)} />
        <SummaryTile label="Secured revenue" value={usd(totals.secRev, { compact: true })} accent />
        <SummaryTile label="In discussion revenue" value={usd(totals.discRev, { compact: true })} />
        <SummaryTile label="Marketing (secured / discussion)" value={`${totals.mkgSec} / ${totals.mkgDisc}`} />
        <SummaryTile label="Physical retail MG" value={usd(totals.mgUsd, { compact: true })} />
      </div>

      {/* Filter bar */}
      <div className="card p-3 mb-4 flex flex-wrap items-center gap-3">
        <input
          className="input max-w-xs"
          placeholder="Search titles…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          className="select max-w-xs"
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
        >
          <option value="">All platforms</option>
          {platforms.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm" style={{ color: "var(--text-muted)" }}>
          <input
            type="checkbox"
            checked={hideZero}
            onChange={(e) => setHideZero(e.target.checked)}
          />
          Hide titles with no opportunities
        </label>
        <div className="ml-auto text-xs" style={{ color: "var(--text-dim)" }}>
          {filtered.length} title{filtered.length === 1 ? "" : "s"} shown
          {" · "}
          {untrackedTitles.length} untracked title
          {untrackedTitles.length === 1 ? "" : "s"} in SignalPulse
        </div>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr
                className="text-left"
                style={{
                  background: "var(--surface-2)",
                  color: "var(--text-dim)",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <Th>Title</Th>
                <Th>Platforms</Th>
                <Th>Release date</Th>
                <Th align="right">Secured Rev Partnerships</Th>
                <Th align="right">Secured Rev ($)</Th>
                <Th align="right">In Discussion Rev Partnerships</Th>
                <Th align="right">In Discussion Rev ($)</Th>
                <Th align="right">Mkg Ops (# Secured)</Th>
                <Th align="right">Mkg Ops (# in Disc.)</Th>
                <Th align="right"># Large Mkg Ops</Th>
                <Th>Physical Retail Partner(s)</Th>
                <Th align="right">Physical Retail MG ($)</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={12}
                    className="px-4 py-10 text-center text-sm"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {rows.length === 0
                      ? "No opportunities tracked yet. Open a SignalPulse title below to add the first one."
                      : "No titles match your filters."}
                  </td>
                </tr>
              )}
              {filtered.map((r) => (
                <tr
                  key={r.title.id}
                  className="border-t hover:bg-white/[0.02]"
                  style={{ borderColor: "var(--border)" }}
                >
                  <Td>
                    <Link href={`/titles/${r.title.id}`}>
                      <a
                        className="font-medium hover:underline"
                        style={{ color: "var(--text)" }}
                      >
                        {r.title.title}
                      </a>
                    </Link>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {r.title.platforms.slice(0, 3).map((p) => (
                        <span
                          key={p}
                          className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                          style={{
                            background: "var(--surface-2)",
                            color: "var(--text-muted)",
                          }}
                        >
                          {p}
                        </span>
                      ))}
                      {r.title.platforms.length > 3 && (
                        <span
                          className="text-[10px]"
                          style={{ color: "var(--text-dim)" }}
                        >
                          +{r.title.platforms.length - 3}
                        </span>
                      )}
                    </div>
                  </Td>
                  <Td>{dateShort(r.title.releaseDate)}</Td>
                  <Td align="right">{r.securedRevenueCount || "—"}</Td>
                  <Td align="right">
                    {r.securedRevenueUsd
                      ? <span style={{ color: "var(--secured)" }}>{usd(r.securedRevenueUsd)}</span>
                      : "—"}
                  </Td>
                  <Td align="right">{r.inDiscussionRevenueCount || "—"}</Td>
                  <Td align="right">
                    {r.inDiscussionRevenueUsd
                      ? <span style={{ color: "var(--discussion)" }}>{usd(r.inDiscussionRevenueUsd)}</span>
                      : "—"}
                  </Td>
                  <Td align="right">{r.marketingSecuredCount || "—"}</Td>
                  <Td align="right">{r.marketingInDiscussionCount || "—"}</Td>
                  <Td align="right">{r.largeMarketingCount || "—"}</Td>
                  <Td>
                    {r.physicalRetailPartners.length === 0 ? (
                      "—"
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {r.physicalRetailPartners.map((p, i) => (
                          <span
                            key={`${p}-${i}`}
                            className="rounded px-1.5 py-0.5 text-[11px]"
                            style={{
                              background: "var(--surface-2)",
                              color: "var(--text)",
                            }}
                          >
                            {p}
                          </span>
                        ))}
                      </div>
                    )}
                  </Td>
                  <Td align="right">
                    {r.physicalRetailMgUsd ? usd(r.physicalRetailMgUsd) : "—"}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Untracked titles from SignalPulse — hidden behind toggle */}
      {!hideZero && untrackedTitles.length > 0 && (
        <div className="card mt-6 p-4">
          <div
            className="text-xs uppercase tracking-widest mb-3"
            style={{ color: "var(--text-dim)" }}
          >
            SignalPulse titles with no partnerships tracked ({untrackedTitles.length})
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {untrackedTitles.map((t) => (
              <Link key={t.id} href={`/titles/${t.id}`}>
                <a
                  className="rounded-md px-3 py-2 text-sm hover:bg-white/[0.03] border"
                  style={{ borderColor: "var(--border)" }}
                >
                  <div className="font-medium">{t.title}</div>
                  <div className="text-xs mt-0.5" style={{ color: "var(--text-dim)" }}>
                    {dateShort(t.releaseDate)} · {t.platforms.slice(0, 3).join(", ")}
                    {t.platforms.length > 3 && ` +${t.platforms.length - 3}`}
                  </div>
                </a>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryTile({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="card p-3">
      <div className="label">{label}</div>
      <div
        className="mt-1 text-lg font-semibold tabular-nums"
        style={{ color: accent ? "var(--accent)" : "var(--text)" }}
      >
        {value}
      </div>
    </div>
  );
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={`px-3 py-2 text-[11px] font-semibold uppercase tracking-wider ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <td
      className={`px-3 py-2.5 align-top ${
        align === "right" ? "text-right tabular-nums" : ""
      }`}
    >
      {children}
    </td>
  );
}
