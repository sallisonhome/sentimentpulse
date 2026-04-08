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
