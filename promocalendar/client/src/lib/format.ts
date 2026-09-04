/** Date + display formatting helpers. Mirrors _shared.py conventions. */

const MO = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export function parseISO(d: string): Date {
  // Parse YYYY-MM-DD as UTC-anchored calendar date to avoid TZ drift.
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}

export function fmtRange(a: string, b: string): string {
  const da = parseISO(a);
  const db = parseISO(b);
  const yA = da.getUTCFullYear();
  const yB = db.getUTCFullYear();
  if (db < da) {
    return `${MO[da.getUTCMonth()]} ${da.getUTCDate()} – ${MO[db.getUTCMonth()]} ${db.getUTCDate()}, ${yA + 1}`;
  }
  if (yA !== yB) {
    return `${MO[da.getUTCMonth()]} ${da.getUTCDate()}, ${yA} – ${MO[db.getUTCMonth()]} ${db.getUTCDate()}, ${yB}`;
  }
  return `${MO[da.getUTCMonth()]} ${da.getUTCDate()} – ${MO[db.getUTCMonth()]} ${db.getUTCDate()}`;
}

export function fmtDay(a: string): string {
  const d = parseISO(a);
  return `${MO[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function fmtDayLong(a: string): string {
  const d = parseISO(a);
  const wk = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  return `${wk[d.getUTCDay()]} ${MO[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export function daysLabel(daysUntilStart: number, isActive: boolean): string {
  if (isActive) return "LIVE";
  if (daysUntilStart === 0) return "starts today";
  if (daysUntilStart === 1) return "in 1 day";
  if (daysUntilStart < 0) return `started ${-daysUntilStart}d ago`;
  return `in ${daysUntilStart} days`;
}

export function durationDays(start: string, end: string): number {
  const s = parseISO(start);
  const e = parseISO(end);
  let ms = e.getTime() - s.getTime();
  if (ms < 0) {
    // year-wrap: assume end is next year
    const eNext = new Date(Date.UTC(e.getUTCFullYear() + 1, e.getUTCMonth(), e.getUTCDate()));
    ms = eNext.getTime() - s.getTime();
  }
  return Math.floor(ms / (86400 * 1000)) + 1;
}

export function platCls(p: string): string {
  return p === "Steam" ? "plat-steam" : p === "Microsoft" ? "plat-ms" : p === "Sony" ? "plat-sony" : "";
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  const wk = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  return `${wk[d.getUTCDay()]} ${MO[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} · ${d.getUTCHours().toString().padStart(2, "0")}:${d.getUTCMinutes().toString().padStart(2, "0")} UTC`;
}
