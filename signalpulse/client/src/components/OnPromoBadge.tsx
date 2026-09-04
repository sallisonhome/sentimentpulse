// Cross-app "On Promo" badge.
//
// Renders a single-line pill of the form:
//   On Promo: Steam through Sep 14, Xbox through Sep 10, PS5 through Sep 9
//
// Data comes from the SignalPulse /api/onpromo/* endpoints, which in turn
// wrap the Promo Calendar backend. This component is UI-only — it never
// fetches. Callers (leaderboards, PDP, Dashboard card) pass pre-fetched
// promos in as a prop.
//
// Empty state: if `promos.length === 0` this renders NOTHING (no chip, no
// placeholder). That's an explicit product decision — pages with no active
// promos should look identical to before this feature shipped.
//
// Visual style: matches the SignalPulse chip/badge convention. Reuses the
// shared `Badge` primitive with `variant="outline"` and colour tokens in
// the emerald family (parallel to the amber "External" badge already used
// on the Dashboard and PDP header).

import { Badge } from "@/components/ui/badge";

// Promo Calendar `platform` values → user-facing platform labels. Anything
// not in this map falls through to the raw value verbatim, which is safe
// for future platforms the backend might add without a corresponding UI
// update.
const PLATFORM_LABELS: Record<string, string> = {
  Steam: "Steam",
  Microsoft: "Xbox",
  Sony: "PS5",
  Nintendo: "Switch",
  Epic: "Epic",
  Other: "Other",
};

function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

// Format an ISO YYYY-MM-DD date as `MMM D` (e.g. `Sep 14`). Uses a plain
// UTC construction so a 2026-09-14 string never accidentally becomes
// Sep 13 in a US timezone.
const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
function formatEndDate(iso: string): string {
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  const monthIdx = Number(parts[1]) - 1;
  const day = Number(parts[2]);
  if (!Number.isFinite(monthIdx) || !Number.isFinite(day)) return iso;
  const abbr = MONTH_ABBR[monthIdx] ?? parts[1];
  return `${abbr} ${day}`;
}

export interface OnPromoBadgeProps {
  promos: { platform: string; end_date: string }[];
  // Optional size override. Default is the same size as the "External"
  // meta chip used on the Dashboard card + PDP header (h-4, text-[10px]).
  // The PDP header + Dashboard "On Promo Now" card use `size="md"` for a
  // slightly larger, more prominent pill.
  size?: "sm" | "md";
  // Optional test id — the four call sites each pass their own so the
  // screenshot script can locate every instance unambiguously.
  testId?: string;
  className?: string;
}

export function OnPromoBadge({ promos, size = "sm", testId, className }: OnPromoBadgeProps) {
  if (!promos || promos.length === 0) return null;

  // Promos arrive pre-sorted (soonest-ending first, deduped-by-platform)
  // from the server, but we defensively sort again on the client so the
  // component is safe to use with hand-constructed data too.
  const sorted = [...promos].sort((a, b) =>
    a.end_date < b.end_date ? -1 : a.end_date > b.end_date ? 1 : 0,
  );

  const parts = sorted.map((p) => `${platformLabel(p.platform)} through ${formatEndDate(p.end_date)}`);
  const text = parts.join(", ");

  // Size tokens. Small variant mirrors the existing amber "External" chip
  // dimensions used elsewhere so it slots into row/card layouts without
  // reflowing anything. Medium variant is used only on the PDP hero and
  // the Dashboard summary card, where the pill stands alone.
  const sizeClass =
    size === "md"
      ? "text-[11px] px-2 py-0.5 h-5"
      : "text-[10px] px-1.5 py-0 h-4";

  return (
    <Badge
      variant="outline"
      // Emerald tokens (parallel to the amber "External" chip). Tailwind's
      // `bg-emerald-500/10` gives a subtle tint that reads as "active /
      // earning" without shouting; the darker border on dark mode keeps
      // contrast comfortable in both themes.
      className={
        "font-normal text-emerald-700 dark:text-emerald-400 " +
        "bg-emerald-500/10 border-emerald-500/30 " +
        sizeClass +
        (className ? ` ${className}` : "")
      }
      data-testid={testId ?? "badge-on-promo"}
      title={`On Promo: ${text}`}
    >
      <span className="font-semibold mr-1">On Promo:</span>
      <span className="tabular-nums">{text}</span>
    </Badge>
  );
}
