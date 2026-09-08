import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatNumber(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US");
}

export function formatCurrency(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** "5m ago" / "3h ago" / "2d ago" style relative timestamp, for CCU
 * "last captured at" / "last polled at" displays. Accepts a full ISO
 * timestamp (not a date-only string like formatDate). */
export function formatRelativeTime(isoStr: string | null | undefined): string {
  if (!isoStr) return "—";
  const then = new Date(isoStr).getTime();
  if (Number.isNaN(then)) return "—";
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export function getPlatformClass(platform: string): string {
  switch (platform) {
    case "PC (Steam)": return "platform-steam";
    case "PS5": return "platform-ps5";
    case "Xbox": return "platform-xbox";
    case "Switch 2": return "platform-switch";
    case "Epic Games Store": return "platform-egs";
    default: return "platform-egs";
  }
}

export function getPlayerFormatLabel(format: string): string {
  switch (format) {
    case "co_op": return "Co-Op";
    case "multiplayer": return "Multiplayer";
    case "single_player": return "Single Player";
    default: return format;
  }
}
