import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import {
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { api } from "../lib/api";
import { ceWorkbackDate, dateShort, usd } from "../lib/format";
import type {
  Opportunity,
  OpportunityBucket,
  PdpPayload,
  PhysicalRetailPartner,
} from "@shared/schema";
import OpportunityFormModal, {
  type FormMode,
} from "../components/OpportunityFormModal";
import CollectorsEditionPanel from "../components/CollectorsEditionPanel";

const BUCKET_COLORS: Record<OpportunityBucket, string> = {
  PhysicalRetail: "#3b82f6",
  IncrementalRevenue: "#14b8a6",
  CollectorsEdition: "#a855f7",
  MarketingOpportunity: "#f59e0b",
};

export default function ProductDetail({ productId }: { productId: number }) {
  const [data, setData] = useState<PdpPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState<FormMode | null>(null);

  const reload = useCallback(() => {
    api.pdp(productId).then(setData).catch((e) => setError(String(e)));
  }, [productId]);

  useEffect(() => {
    reload();
  }, [reload]);

  if (error) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-16">
        <div
          className="card p-4 text-sm"
          style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
        >
          {error}
        </div>
        <Link href="/">
          <a className="btn-secondary mt-4">← Back</a>
        </Link>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-16 text-sm" style={{ color: "var(--text-muted)" }}>
        Loading…
      </div>
    );
  }

  const { title, totalSecuredRevenueUsd, ringChart, quadrants } = data;

  // Ring chart data — show only non-zero slices, fall back to a placeholder
  // arc when nothing is Secured yet so the chart doesn't collapse.
  const chartData = ringChart.filter((r) => r.usd > 0);
  const hasSecured = chartData.length > 0;

  return (
    <div className="max-w-[1400px] mx-auto px-6 py-6">
      {/* Header banner — Hellraiser-mockup styled */}
      <div
        className="rounded-lg border overflow-hidden"
        style={{ borderColor: "var(--panel-border)" }}
      >
        <div
          className="flex items-center justify-between px-6 py-5"
          style={{
            background:
              "linear-gradient(180deg, #0d1b3b 0%, #0a1530 100%)",
          }}
        >
          <div>
            <div
              className="text-[10px] uppercase tracking-[0.2em] mb-1"
              style={{ color: "#8ea5d6" }}
            >
              Publishing Partnerships
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-white">
              {title.title}
            </h1>
            <div className="mt-1 text-xs" style={{ color: "#8ea5d6" }}>
              {dateShort(title.releaseDate)} · {title.platforms.join(" · ")}
              {title.launchMsrpUsd != null && ` · Launch ${usd(title.launchMsrpUsd)}`}
            </div>
          </div>
          <div className="text-right">
            <div
              className="text-[10px] uppercase tracking-[0.2em]"
              style={{ color: "#8ea5d6" }}
            >
              Total Secured Partnership Revenue
            </div>
            <div
              className="mt-1 text-3xl font-bold tabular-nums"
              style={{ color: "var(--secured)" }}
            >
              {usd(totalSecuredRevenueUsd)}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <Link href="/">
          <a className="btn-secondary">← Back to dashboard</a>
        </Link>
        <div className="flex gap-2 flex-wrap">
          <button
            className="btn-primary"
            onClick={() => setFormOpen({ kind: "incremental" })}
          >
            + Incremental Revenue
          </button>
          <button
            className="btn-primary"
            onClick={() => setFormOpen({ kind: "retail" })}
          >
            + Physical Retail Partner
          </button>
          <button
            className="btn-primary"
            onClick={() => setFormOpen({ kind: "collectors" })}
          >
            + Collector's Edition
          </button>
          <button
            className="btn-primary"
            onClick={() => setFormOpen({ kind: "marketing" })}
          >
            + Marketing Opportunity
          </button>
        </div>
      </div>

      {/* Ring chart */}
      <div className="mt-5 card p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-1 flex flex-col items-center justify-center">
            <div className="label mb-2">Secured Revenue Share</div>
            <div style={{ width: "100%", height: 220 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie
                    data={hasSecured ? chartData : [{ label: "No secured revenue yet", usd: 1 }]}
                    dataKey="usd"
                    nameKey="label"
                    innerRadius={55}
                    outerRadius={85}
                    stroke="var(--surface)"
                    strokeWidth={2}
                  >
                    {(hasSecured ? chartData : [{ bucket: undefined as unknown as OpportunityBucket }]).map(
                      (entry, i) => (
                        <Cell
                          key={i}
                          fill={
                            hasSecured
                              ? BUCKET_COLORS[
                                  (entry as { bucket: OpportunityBucket }).bucket
                                ]
                              : "var(--surface-3)"
                          }
                        />
                      ),
                    )}
                  </Pie>
                  {hasSecured && (
                    <Tooltip
                      contentStyle={{
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        color: "var(--text)",
                      }}
                      formatter={(v: number) => usd(v)}
                    />
                  )}
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="md:col-span-2 grid grid-cols-2 gap-3">
            {ringChart.map((r) => (
              <div
                key={r.bucket}
                className="rounded-md p-3 border flex items-center gap-3"
                style={{
                  borderColor: "var(--border)",
                  background: "var(--surface-2)",
                }}
              >
                <div
                  className="h-3 w-3 rounded-sm"
                  style={{ background: BUCKET_COLORS[r.bucket] }}
                />
                <div className="flex-1">
                  <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                    {r.label}
                  </div>
                  <div className="text-lg font-semibold tabular-nums">
                    {usd(r.usd)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 4 Quadrants — positions match the Hellraiser mockup exactly */}
      <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Top-left: Physical Retail */}
        <Quadrant title="Physical Retail">
          {quadrants.physicalRetail.secured.length === 0 &&
          quadrants.physicalRetail.inDiscussion.length === 0 ? (
            <EmptyHint>Add a Physical Retail Partner to populate this quadrant.</EmptyHint>
          ) : (
            <div className="space-y-2">
              {quadrants.physicalRetail.secured.map((p) => (
                <RetailPartnerRow key={p.id} p={p} state="secured" />
              ))}
              {quadrants.physicalRetail.inDiscussion.map((p) => (
                <RetailPartnerRow key={p.id} p={p} state="discussion" />
              ))}
            </div>
          )}
        </Quadrant>

        {/* Top-right: Incremental Revenue */}
        <Quadrant title="Incremental Revenue">
          {quadrants.incrementalRevenue.secured.length === 0 &&
          quadrants.incrementalRevenue.inDiscussion.length === 0 ? (
            <EmptyHint>Add an Incremental Revenue opportunity to populate this quadrant.</EmptyHint>
          ) : (
            <div className="space-y-2">
              {quadrants.incrementalRevenue.secured.map((o) => (
                <OpportunityRow key={o.id} o={o} state="secured" showMoney />
              ))}
              {quadrants.incrementalRevenue.inDiscussion.map((o) => (
                <OpportunityRow key={o.id} o={o} state="discussion" showMoney />
              ))}
            </div>
          )}
        </Quadrant>

        {/* Bottom-left: Physical Collectors Editions */}
        <Quadrant title="Physical Collectors Editions">
          <CollectorsEditionPanel
            productId={productId}
            secured={quadrants.collectorsEditions.secured}
            inDiscussion={quadrants.collectorsEditions.inDiscussion}
            items={quadrants.collectorsEditions.items}
            workbackDate={ceWorkbackDate(title.releaseDate)}
            onChange={reload}
          />
        </Quadrant>

        {/* Bottom-right: Marketing Opportunities */}
        <Quadrant title="Marketing Opportunities">
          {quadrants.marketingOpportunities.secured.length === 0 &&
          quadrants.marketingOpportunities.inDiscussion.length === 0 ? (
            <EmptyHint>Add a Marketing Opportunity to populate this quadrant.</EmptyHint>
          ) : (
            <div className="space-y-2">
              {quadrants.marketingOpportunities.secured.map((o) => (
                <MarketingRow key={o.id} o={o} state="secured" />
              ))}
              {quadrants.marketingOpportunities.inDiscussion.map((o) => (
                <MarketingRow key={o.id} o={o} state="discussion" />
              ))}
            </div>
          )}
        </Quadrant>
      </div>

      {/* In Discussion summary */}
      <InDiscussionSummary data={data} />

      {formOpen && (
        <OpportunityFormModal
          mode={formOpen}
          productId={productId}
          onClose={() => setFormOpen(null)}
          onSaved={() => {
            setFormOpen(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function Quadrant({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="quadrant">
      <div className="quadrant-header">{title}</div>
      <div className="quadrant-body">{children}</div>
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="italic text-sm"
      style={{ color: "#7c8ec2" }}
    >
      {children}
    </div>
  );
}

function StateChip({ state }: { state: "secured" | "discussion" }) {
  return (
    <span className={`chip ${state === "secured" ? "chip-secured" : "chip-discussion"}`}>
      {state === "secured" ? "Secured" : "In Negotiation"}
    </span>
  );
}

function OpportunityRow({
  o,
  state,
  showMoney,
}: {
  o: Opportunity;
  state: "secured" | "discussion";
  showMoney?: boolean;
}) {
  return (
    <div
      className="rounded-md p-2.5 flex items-start gap-2"
      style={{ background: "rgba(255,255,255,0.04)" }}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <StateChip state={state} />
          <span className="font-medium text-white text-sm truncate">
            {o.subtype}
          </span>
        </div>
        {o.details && (
          <div className="text-xs mt-1" style={{ color: "#a7b6dd" }}>
            {o.details}
          </div>
        )}
      </div>
      {showMoney && o.revenueUsd != null && (
        <div className="text-right">
          <div
            className="font-semibold tabular-nums text-sm"
            style={{ color: state === "secured" ? "var(--secured)" : "var(--discussion)" }}
          >
            {usd(o.revenueUsd)}
          </div>
        </div>
      )}
    </div>
  );
}

function MarketingRow({
  o,
  state,
}: {
  o: Opportunity;
  state: "secured" | "discussion";
}) {
  return (
    <div
      className="rounded-md p-2.5"
      style={{ background: "rgba(255,255,255,0.04)" }}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <StateChip state={state} />
        {o.marketingImpact && (
          <span
            className="chip"
            style={{
              background: "rgba(139, 92, 246, 0.14)",
              color: "#c4b5fd",
            }}
          >
            {o.marketingImpact}
          </span>
        )}
        <span className="font-medium text-white text-sm truncate">
          {o.marketingName || o.subtype}
        </span>
      </div>
      <div className="text-xs mt-1 flex flex-wrap gap-x-3 gap-y-0.5" style={{ color: "#a7b6dd" }}>
        {o.marketingPlatform && <span>{o.marketingPlatform}</span>}
        {o.marketingStartDate && <span>{dateShort(o.marketingStartDate)}</span>}
        {o.marketingValueUsd != null && <span>Value {usd(o.marketingValueUsd)}</span>}
        {o.marketingReach != null && (
          <span>Reach {Intl.NumberFormat("en-US").format(o.marketingReach)}</span>
        )}
      </div>
      {o.details && (
        <div className="text-xs mt-1" style={{ color: "#a7b6dd" }}>
          {o.details}
        </div>
      )}
    </div>
  );
}

function RetailPartnerRow({
  p,
  state,
}: {
  p: PhysicalRetailPartner;
  state: "secured" | "discussion";
}) {
  const name = p.partnerName === "Other" && p.partnerNameOther ? p.partnerNameOther : p.partnerName;
  const territories: string[] = (() => {
    try {
      return JSON.parse(p.territoriesJson);
    } catch {
      return [];
    }
  })();
  return (
    <div
      className="rounded-md p-2.5 flex items-start gap-2"
      style={{ background: "rgba(255,255,255,0.04)" }}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <StateChip state={state} />
          <span className="font-medium text-white text-sm truncate">{name}</span>
        </div>
        <div className="text-xs mt-1" style={{ color: "#a7b6dd" }}>
          {territories.join(", ") || "—"}
          {p.royaltyPctNet ? ` · ${p.royaltyPctNet}% net royalty` : ""}
        </div>
      </div>
      <div className="text-right">
        <div className="text-[10px] uppercase" style={{ color: "#8ea5d6" }}>
          MG
        </div>
        <div
          className="font-semibold tabular-nums text-sm"
          style={{ color: state === "secured" ? "var(--secured)" : "var(--discussion)" }}
        >
          {usd(p.mgAmountUsd)}
        </div>
      </div>
    </div>
  );
}

function InDiscussionSummary({ data }: { data: PdpPayload }) {
  const items: Array<{ label: string; count: number; value: number }> = [
    {
      label: "Physical Retail",
      count: data.quadrants.physicalRetail.inDiscussion.length,
      value: data.quadrants.physicalRetail.inDiscussion.reduce(
        (a, b) => a + (b.mgAmountUsd || 0),
        0,
      ),
    },
    {
      label: "Incremental Revenue",
      count: data.quadrants.incrementalRevenue.inDiscussion.length,
      value: data.quadrants.incrementalRevenue.inDiscussion.reduce(
        (a, b) => a + (b.revenueUsd || 0),
        0,
      ),
    },
    {
      label: "Collectors Editions",
      count: data.quadrants.collectorsEditions.inDiscussion.length,
      value: data.quadrants.collectorsEditions.inDiscussion.reduce(
        (a, b) => a + (b.revenueUsd || 0),
        0,
      ),
    },
    {
      label: "Marketing Opportunities",
      count: data.quadrants.marketingOpportunities.inDiscussion.length,
      value: data.quadrants.marketingOpportunities.inDiscussion.reduce(
        (a, b) => a + (b.marketingValueUsd || 0),
        0,
      ),
    },
  ];
  const total = items.reduce((a, b) => a + b.count, 0);
  return (
    <div className="mt-4 card p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div
            className="text-[10px] uppercase tracking-[0.14em]"
            style={{ color: "var(--text-dim)" }}
          >
            In Discussion
          </div>
          <div className="text-lg font-semibold">
            {total} active discussion{total === 1 ? "" : "s"} across all buckets
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {items.map((i) => (
          <div
            key={i.label}
            className="rounded-md p-3 border"
            style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}
          >
            <div className="text-xs" style={{ color: "var(--text-muted)" }}>
              {i.label}
            </div>
            <div className="mt-1 flex items-baseline gap-3">
              <div className="text-xl font-semibold tabular-nums">{i.count}</div>
              <div
                className="text-xs tabular-nums"
                style={{ color: "var(--discussion)" }}
              >
                {i.value ? usd(i.value) : ""}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
