// ─── SteamChartCard (v3.11, 2026-08-12) ────────────────────────────────────
//
// Compact click-for-chart card used inside the Steam Sales section. Two of
// these render side-by-side: one for Units (Steam Sales by Units) and one
// for Revenue (Steam Sales by Revenue). Both open the full chart modal
// with PLS milestone overlays.
//
// Design mirrors the click-affordance pattern locked in v3.6:
//   - Uppercase eyebrow title
//   - Small right-side stat (LTD total)
//   - SectionActions toolbar with 'View chart with PLS events →'
//   - ClickablePreview-wrapped sparkline
//
// Both cards are visually identical apart from color + label + endpoint.

import { ReactNode } from "react";
import { SectionSparkline } from "@/components/time-series-chart";
import { ClickablePreview, SectionActions } from "@/components/clickable-preview";

interface SteamChartCardProps {
  /** Uppercase eyebrow title, e.g. 'Steam Sales by Units'. */
  title: string;
  /** Small right-aligned stat, e.g. 'LTD: 5,415,167 units' or 'LTD: $272.6M'. */
  rightStat?: ReactNode;
  /** Short context line under the title, e.g. 'Cumulative through 2026-07-31'. */
  contextText?: ReactNode;
  /** Product id for the sparkline query. */
  productId: number;
  /** API endpoint the sparkline reads from. */
  endpoint: string;
  /** Stroke color for the sparkline area chart. */
  color: string;
  /** Handler for opening the full chart modal. */
  onOpenChart: () => void;
  /** Prefix for data-testid attributes. */
  testIdPrefix: string;
  /**
   * v3.11 (2026-08-12): color accent (e.g. 'blue' | 'green') controls the
   * card background tint, border color, and eyebrow title color. Picked in
   * the QA pass as 'Variant B' — subtle color-tinting per meaning.
   */
  accent?: "blue" | "green";
  /**
   * v3.12 (2026-08-12): sparkline preview mode. 'delta' (used for Steam
   * Sales by Units/Revenue) plots day-over-day movement instead of the
   * running cumulative total, so the mini-chart actually looks like a
   * fluctuating chart rather than an all-time-cumulative ramp.
   */
  sparklineMode?: "cumulative" | "delta";
}

export function SteamChartCard({
  title,
  rightStat,
  contextText,
  productId,
  endpoint,
  color,
  onOpenChart,
  testIdPrefix,
  accent,
  sparklineMode = "cumulative",
}: SteamChartCardProps) {
  // v3.11 accent tinting. Same alpha values as the QA mockup Variant B.
  const cardStyle =
    accent === "blue"
      ? { background: "rgba(37,99,235,0.06)", borderColor: "rgba(37,99,235,0.22)" }
      : accent === "green"
      ? { background: "rgba(16,185,129,0.06)", borderColor: "rgba(16,185,129,0.22)" }
      : undefined;
  const titleClass =
    accent === "blue"
      ? "text-xs uppercase tracking-wide font-medium text-blue-600 dark:text-blue-400"
      : accent === "green"
      ? "text-xs uppercase tracking-wide font-medium text-emerald-600 dark:text-emerald-400"
      : "text-xs text-muted-foreground uppercase tracking-wide font-medium";

  return (
    <div
      className="rounded-md border p-3 space-y-2"
      style={cardStyle}
      data-testid={`${testIdPrefix}-card`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className={titleClass}>{title}</div>
        {rightStat && (
          <div className="text-sm font-semibold tabular-nums shrink-0">
            {rightStat}
          </div>
        )}
      </div>
      {contextText && (
        <div className="text-[11px] text-muted-foreground">
          {contextText}
        </div>
      )}
      <SectionActions
        onOpenChart={onOpenChart}
        chartLabel="View chart with PLS events"
        chartTestId={`${testIdPrefix}-open-chart`}
      />
      <ClickablePreview
        onClick={onOpenChart}
        testIdPrefix={testIdPrefix}
        affordanceLabel="Click for full chart with PLS event overlays →"
      >
        <SectionSparkline
          productId={productId}
          endpoint={endpoint}
          color={color}
          mode={sparklineMode}
        />
      </ClickablePreview>
    </div>
  );
}
