import type Database from "better-sqlite3";

/**
 * Explicit source-data corrections, not a heuristic for reversed dates.
 * The January 2023 year follows the neighboring 2022/2023 campaigns.
 * The December 2025 start year was confirmed by the calendar owner.
 * Keep the source workbook blob unchanged for audit/rollback.
 */
export const DATE_CORRECTIONS = [
  {
    start: "2022-12-22", end: "2022-01-04",
    correctedStart: "2022-12-22", correctedEnd: "2023-01-04",
  },
  {
    start: "2026-12-18", end: "2026-01-05",
    correctedStart: "2025-12-18", correctedEnd: "2026-01-05",
  },
] as const;

export function correctEventDates(
  platform: string, program: string, start: string, end: string,
): { start: string; end: string; note: string | null } {
  const correction = platform === "Steam" && program === "Winter Sales"
    ? DATE_CORRECTIONS.find(c => c.start === start && c.end === end)
    : undefined;
  if (!correction) return { start, end, note: null };
  return {
    start: correction.correctedStart,
    end: correction.correctedEnd,
    note: `Source date correction: ${start}–${end} → ${correction.correctedStart}–${correction.correctedEnd}.`,
  };
}

/** Repair only the two known Saber tuples; repeated startup is a no-op. */
export function repairKnownEventDates(sqlite: Database.Database): number {
  return sqlite.transaction(() => {
    const update = sqlite.prepare(`
      UPDATE campaigns SET start_date = ?, end_date = ?,
        notes = CASE WHEN notes IS NULL OR notes = '' THEN ? ELSE notes || char(10) || ? END
      WHERE calendar = 'saber' AND platform = 'Steam' AND program = 'Winter Sales'
        AND start_date = ? AND end_date = ?
    `);
    let changed = 0;
    for (const c of DATE_CORRECTIONS) {
      const fixed = correctEventDates("Steam", "Winter Sales", c.start, c.end);
      changed += update.run(fixed.start, fixed.end, fixed.note, fixed.note, c.start, c.end).changes;
    }
    return changed;
  })();
}
