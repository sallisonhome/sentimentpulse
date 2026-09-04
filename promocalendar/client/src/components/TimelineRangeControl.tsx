import { useState } from "react";

/**
 * Preset windows for the portfolio timeline. The main page ships every
 * campaign back to 2022 which produces an unreadably dense Gantt when
 * plotted at portfolio width — this control lets the user narrow to a
 * bounded window ending N months ago through today, with Custom for
 * arbitrary date bounds.
 *
 * Values are ISO strings so persistence and URL sharing stay trivial.
 * `preset` drives auto-computed windows; "custom" enables the two date
 * inputs. Callers should treat (start, end) as inclusive.
 *
 * Added 2026-09-04 for the Timeline density fix.
 */
export type TimelineRange = {
  preset: "6mo" | "9mo" | "12mo" | "all" | "custom";
  // Inclusive ISO date bounds; end is today for preset ranges.
  start: string;
  end: string;
};

const PRESETS: Array<{ value: TimelineRange["preset"]; label: string }> = [
  { value: "6mo", label: "6 mo" },
  { value: "9mo", label: "9 mo" },
  { value: "12mo", label: "12 mo" },
  { value: "all", label: "All (2022→)" },
  { value: "custom", label: "Custom…" },
];

/** Convert a preset to a concrete ISO range anchored on `today`. */
export function rangeForPreset(
  preset: TimelineRange["preset"],
  today: string,
  custom?: { start: string; end: string },
): { start: string; end: string } {
  if (preset === "custom" && custom) {
    return { start: custom.start, end: custom.end };
  }
  if (preset === "all") {
    return { start: "2022-01-01", end: today };
  }
  const months = preset === "6mo" ? 6 : preset === "9mo" ? 9 : 12;
  // Anchor the window on today and roll back N months. Half of the window
  // sits behind today and half ahead — a 6-month window shows ~3 past
  // and ~3 upcoming months, which matches how planners scan a promo
  // calendar (past context on the left, planning window on the right).
  const t = parseISO(today);
  const past = new Date(t.getTime());
  past.setUTCMonth(past.getUTCMonth() - Math.floor(months / 2));
  const future = new Date(t.getTime());
  future.setUTCMonth(future.getUTCMonth() + Math.ceil(months / 2));
  return { start: isoOf(past), end: isoOf(future) };
}

function parseISO(s: string): Date {
  return new Date(s + "T00:00:00Z");
}

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function TimelineRangeControl({
  value,
  today,
  onChange,
}: {
  value: TimelineRange;
  today: string;
  onChange: (next: TimelineRange) => void;
}) {
  // Local custom-input state so typing a partial date doesn't spam onChange
  // and re-render the Gantt on every keystroke. Committed only on blur or
  // when both fields have a valid YYYY-MM-DD.
  const [customStart, setCustomStart] = useState(value.start);
  const [customEnd, setCustomEnd] = useState(value.end);

  const commitCustom = (nextStart: string, nextEnd: string) => {
    if (isIsoDate(nextStart) && isIsoDate(nextEnd) && nextStart <= nextEnd) {
      onChange({ preset: "custom", start: nextStart, end: nextEnd });
    }
  };

  return (
    <div className="timeline-range">
      <div className="range-presets">
        {PRESETS.map((p) => (
          <button
            key={p.value}
            type="button"
            className={`range-chip${value.preset === p.value ? " on" : ""}`}
            aria-pressed={value.preset === p.value}
            onClick={() => {
              if (p.value === "custom") {
                setCustomStart(value.start);
                setCustomEnd(value.end);
                onChange({ preset: "custom", start: value.start, end: value.end });
                return;
              }
              const r = rangeForPreset(p.value, today);
              onChange({ preset: p.value, start: r.start, end: r.end });
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      {value.preset === "custom" && (
        <div className="range-custom">
          <label>
            From
            <input
              type="date"
              value={customStart}
              max={customEnd || undefined}
              onChange={(e) => setCustomStart(e.target.value)}
              onBlur={() => commitCustom(customStart, customEnd)}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={customEnd}
              min={customStart || undefined}
              onChange={(e) => setCustomEnd(e.target.value)}
              onBlur={() => commitCustom(customStart, customEnd)}
            />
          </label>
        </div>
      )}
    </div>
  );
}

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}
