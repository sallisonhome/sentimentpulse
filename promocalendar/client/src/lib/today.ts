/**
 * Server-anchored "today" for demo/testing.
 *
 * If the hash URL carries `?today=YYYY-MM-DD` (parsed from the wouter
 * hash location — hash-based routing means the query is inside the
 * fragment), that value is used. Otherwise falls back to the real UTC
 * date.
 *
 * NOTE: We rely on window.location.hash rather than history query so
 * that this works under wouter/useHashLocation. Format example:
 *   #/events?today=2026-09-04
 */

export function getToday(): string {
  if (typeof window === "undefined") return new Date().toISOString().slice(0, 10);
  const hash = window.location.hash || "";
  const qIdx = hash.indexOf("?");
  if (qIdx >= 0) {
    const params = new URLSearchParams(hash.slice(qIdx + 1));
    const t = params.get("today");
    if (t && /^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  }
  // Also honor a top-level ?today= on the URL for direct-hit testing.
  const topParams = new URLSearchParams(window.location.search);
  const top = topParams.get("today");
  if (top && /^\d{4}-\d{2}-\d{2}$/.test(top)) return top;
  return new Date().toISOString().slice(0, 10);
}

export function todayHuman(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const wk = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${wk[dt.getUTCDay()]} ${mo[dt.getUTCMonth()]} ${dt.getUTCDate()}, ${dt.getUTCFullYear()}`;
}
