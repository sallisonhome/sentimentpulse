// Pure helper for the 2026-10-12 age-covering-window ceiling. Kept separate so
// it is trivially unit-testable without running the whole estimator.

export type EstimateRowLike = {
  window: string;
  gatedReason: string | null;
  unitsMid: number | null;
};

/** Map age in days to the window that covers the title's whole time in market. */
export function ageCoveringWindow(ageDays: number): "d7" | "d30" | "d90" | "m12" {
  if (ageDays <= 7) return "d7";
  if (ageDays <= 30) return "d30";
  if (ageDays <= 90) return "d90";
  return "m12";
}

/**
 * Returns the cap on LTD for a title under 366 days old, or null when no cap
 * applies (missing/gated age-window row).
 */
export function ageWindowCapFor(
  ageDays: number | null,
  titleRows: EstimateRowLike[],
): number | null {
  if (ageDays == null || ageDays < 0 || ageDays >= 366) return null;
  const w = ageCoveringWindow(ageDays);
  const row = titleRows.find(
    (r) => r.window === w && r.gatedReason == null && r.unitsMid != null,
  );
  return row?.unitsMid ?? null;
}
