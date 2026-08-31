export function usd(n: number | null | undefined, opts?: { compact?: boolean }): string {
  if (n == null || Number.isNaN(n)) return "—";
  if (opts?.compact && Math.abs(n) >= 1000) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(n);
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

export function pct(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${n.toFixed(1)}%`;
}

export function dateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

/**
 * Compute a Collector's Edition "work-back" date = release − 12 months.
 * Per spec: "the vendor for the collector's edition needs to be picked
 * approximately 1 year in advance of the games release date."
 */
export function ceWorkbackDate(releaseIso: string): string {
  const d = new Date(releaseIso);
  if (Number.isNaN(d.getTime())) return releaseIso;
  d.setMonth(d.getMonth() - 12);
  return d.toISOString().slice(0, 10);
}
