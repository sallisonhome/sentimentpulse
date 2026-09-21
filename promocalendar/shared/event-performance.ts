/** Platform-neutral ACTUAL sales contract. Never substitute console estimates. */
export interface EventPerformance {
  platform: string;
  source: string | null;
  currency: "USD";
  basis: "actual";
  status: "pending" | "not_started" | "invalid_window" | "unsupported" | "unavailable" | "partial" | "complete";
  window_start: string;
  window_end: string;
  net_revenue_usd: number | null;
  gross_revenue_usd: number | null;
  titles_total: number;
  titles_mapped: number;
  titles_covered: number;
  title_days_covered: number;
  title_days_expected: number;
  checked_at: string | null;
  fetched_at: string | null;
  stale: boolean;
  refresh_error: boolean;
  titles: Array<{
    game_code: string;
    source_id: string | null;
    days_covered: number;
    net_revenue_usd: number | null;
    gross_revenue_usd: number | null;
  }>;
}

export function performanceCoverage(p: EventPerformance): string {
  const labels: Partial<Record<EventPerformance["status"], string>> = {
    pending: "Awaiting sales refresh",
    not_started: "Not started",
    invalid_window: "Check event dates",
    unsupported: "Actual-sales feed not connected",
    unavailable: "No reported sales data",
  };
  const coverage = labels[p.status] ??
    `${p.status === "complete" ? "Complete" : "Partial"} · ${p.titles_covered}/${p.titles_total} titles · ${p.title_days_covered}/${p.title_days_expected} title-days`;
  return `${coverage}${p.refresh_error ? " · refresh failed" : ""}${p.stale ? " · saved data" : ""}`;
}
