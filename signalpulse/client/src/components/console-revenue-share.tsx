import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
const LABELS: Record<string, string> = { steam: "Steam", ps5: "PS5", xbox: "Xbox" };
const COLORS: Record<string, string> = { steam: "#66c0f4", ps5: "#818cf8", xbox: "#34d399" };
const PERIODS: Record<string, string> = { d7: "7 days", d30: "30 days", d90: "90 days", m12: "12 months", ltd: "Lifetime" };
const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
export interface RevenueSummary {
  calibration?: { mode: string; applied: boolean; note: string };
  window: string; titleCount: number; combinedRevenueUsd: number;
  incomplete?: boolean;
  platforms: { platform: string; revenueUsd: number; sharePct: number | null; missingTitleCount?: number }[];
}
export function RevenueShare({ summary, pie = false }: { summary?: RevenueSummary; pie?: boolean }) {
  if (!summary) return null;
  return <section className="p-4 border border-border rounded-lg bg-muted/30" aria-label="Platform revenue share">
    <h3 className="text-sm font-semibold">{pie ? "Title family revenue share" : `Top ${summary.titleCount} combined titles`} · {PERIODS[summary.window] ?? summary.window}</h3>
    <p className="text-sm mt-1">{summary.incomplete ? "Available estimated revenue subtotal" : "Total estimated revenue"}: {money(summary.combinedRevenueUsd)}</p>
    {summary.incomplete && <p className="text-xs text-muted-foreground mt-2" role="note">Incomplete estimate: one or more platform estimates are unavailable for this period. Missing estimates are excluded, not zero sales. Revenue shares are unavailable.</p>}
    {pie && !summary.incomplete && summary.combinedRevenueUsd > 0 && <div style={{ height: 220 }} aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%"><PieChart>
        <Pie data={summary.platforms} dataKey="revenueUsd" nameKey="platform" outerRadius={88} isAnimationActive={false}>
          {summary.platforms.map(p => <Cell key={p.platform} fill={COLORS[p.platform]} />)}
        </Pie><Tooltip formatter={(v: number, name: string) => [money(v), LABELS[name] ?? name]} />
      </PieChart></ResponsiveContainer>
    </div>}
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
      {summary.platforms.map(p => <div key={p.platform} className="text-sm">
        <span className="inline-block w-2.5 h-2.5 rounded-sm mr-2" style={{ background: COLORS[p.platform] }} />
        <span className="font-semibold">{LABELS[p.platform]}</span>{" "}
        {p.sharePct == null ? "N/A" : `${p.sharePct.toFixed(1)}%`} · {p.missingTitleCount && p.revenueUsd === 0 ? "Unavailable" : money(p.revenueUsd)}
        {!!p.missingTitleCount && p.revenueUsd > 0 && " (partial)"}
      </div>)}
    </div>
    <p className="text-xs text-muted-foreground mt-2">
      {pie ? "Editions are grouped into one title family." : "Revenue share of the titles in this table only."} {summary.window === "d7" ? "Weekly estimates use seven-day evidence only; monthly totals are never substituted." : "Estimates retain the selected period's fallback rules."}
    </p>
    {summary.calibration?.note && <p className="text-xs text-muted-foreground mt-2" role="note">{summary.calibration.note}</p>}
  </section>;
}
