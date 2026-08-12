// ─── ClickablePreview / SectionActions (v3.6, 2026-08-12) ─────────────────
//
// Two shared UI primitives to make interactive regions on product cards
// consistently discoverable:
//
// 1. <ClickablePreview>: wraps a sparkline (or any preview block) so that
//    the whole block behaves as a button. Adds cursor-pointer, a subtle
//    hover ring, and an always-visible affordance line ("Click to open
//    full chart with PLS event overlays →") at the bottom of the preview.
//
// 2. <SectionActions>: the toolbar row that appears above every
//    interactive section. Renders two labeled links ("View chart with
//    PLS events →" and "+ Input data") plus an optional context string
//    on the left. Uses explicit-affordance styling per the design
//    decision made 2026-08-12.

import { ReactNode, MouseEvent } from "react";
import { BarChart3, Plus, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

// ── ClickablePreview ─────────────────────────────────────────────────────

interface ClickablePreviewProps {
  onClick: () => void;
  children: ReactNode;
  /** Text shown as the always-visible affordance. Default: 'View full chart with PLS event overlays →' */
  affordanceLabel?: string;
  /** When true, disables the click behavior + affordance (e.g. no data). */
  disabled?: boolean;
  /** Test id root — the wrapper button gets `${testIdPrefix}-preview`, the affordance text gets `${testIdPrefix}-affordance`. */
  testIdPrefix?: string;
}

export function ClickablePreview({
  onClick,
  children,
  affordanceLabel = "View full chart with PLS event overlays →",
  disabled = false,
  testIdPrefix,
}: ClickablePreviewProps) {
  const handleClick = (e: MouseEvent) => {
    if (disabled) return;
    e.stopPropagation();
    onClick();
  };

  return (
    <div
      role={disabled ? undefined : "button"}
      tabIndex={disabled ? undefined : 0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={`
        relative rounded-md border border-transparent transition-colors
        ${disabled ? "opacity-60" : "cursor-pointer hover:border-primary/40 hover:bg-primary/5"}
      `}
      data-testid={testIdPrefix ? `${testIdPrefix}-preview` : undefined}
    >
      {children}
      {!disabled && (
        <div
          className="flex items-center justify-end gap-1 px-2 py-1.5 text-[11px] font-medium text-primary/80"
          data-testid={testIdPrefix ? `${testIdPrefix}-affordance` : undefined}
        >
          <BarChart3 className="h-3 w-3" />
          <span>{affordanceLabel}</span>
        </div>
      )}
    </div>
  );
}

// ── SectionActions ───────────────────────────────────────────────────────

interface SectionActionsProps {
  /** Optional context text shown on the left (e.g. "Updated daily via Steamworks API"). */
  contextText?: ReactNode;
  /** Chart modal action \u2014 always shown when handler is provided. */
  onOpenChart?: () => void;
  chartLabel?: string;
  chartTestId?: string;
  /** Input-data action \u2014 only shown when handler is provided. */
  onInputData?: () => void;
  inputLabel?: string;
  inputTestId?: string;
  /** Optional third action (e.g. "Fetch previous month" for portal). */
  extraAction?: ReactNode;
}

export function SectionActions({
  contextText,
  onOpenChart,
  chartLabel = "View chart with PLS events",
  chartTestId,
  onInputData,
  inputLabel = "+ Input data",
  inputTestId,
  extraAction,
}: SectionActionsProps) {
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <div className="text-xs text-muted-foreground flex-1 min-w-0">
        {contextText}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {extraAction}
        {onOpenChart && (
          <Button
            variant="outline"
            size="sm"
            onClick={onOpenChart}
            className="h-7 text-[11px] gap-1.5"
            data-testid={chartTestId}
          >
            <BarChart3 className="h-3 w-3" />
            {chartLabel}
            <span className="text-primary">→</span>
          </Button>
        )}
        {onInputData && (
          <Button
            variant="outline"
            size="sm"
            onClick={onInputData}
            className="h-7 text-[11px] gap-1"
            data-testid={inputTestId}
          >
            <Plus className="h-3 w-3" />
            {inputLabel.replace(/^\+\s*/, "")}
          </Button>
        )}
      </div>
    </div>
  );
}

// ── LinkToDetail ─────────────────────────────────────────────────────────
//
// The strip at the bottom of a dashboard card that says "View full
// product details \u2192". Used on the dashboard <Card>, wrapping the
// existing <Link>.

interface LinkToDetailProps {
  productTitle?: string;
}

export function LinkToDetail({ productTitle }: LinkToDetailProps) {
  return (
    <div className="flex items-center justify-end gap-1.5 pt-3 mt-3 border-t text-[11px] font-medium text-primary">
      <ExternalLink className="h-3 w-3" />
      <span>
        View full product details{productTitle ? ` for ${productTitle}` : ""} →
      </span>
    </div>
  );
}
