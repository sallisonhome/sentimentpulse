// Compare two SQLite databases' window_estimates_daily for the same as_of_date, to measure what an estimator
// change would do against a copy of the live database without touching the live one.
//
//   tsx scripts/preview-estimate-diff.ts <live.db> <candidate.db> [window=d30] [topN=15]
//
// Read-only on both files. Prints counts, platform unit totals before/after and the largest relative movers.
import Database from "better-sqlite3";

const [liveP, candP, window = "d30", topN = "15"] = process.argv.slice(2);
if (!liveP || !candP) { console.error("usage: preview-estimate-diff.ts <live.db> <candidate.db> [window] [topN]"); process.exit(2); }
const db = new Database(candP, { readonly: true });
db.exec(`ATTACH DATABASE '${liveP.replace(/'/g, "''")}' AS live`);
const asOf = (db.prepare(`SELECT MAX(as_of_date) d FROM main.window_estimates_daily`).get() as { d: string | null }).d;
if (!asOf) { console.error("candidate has no window_estimates_daily rows"); process.exit(3); }
const q = `
  SELECT c.platform, c.title_id, i.name, l.units_mid AS before, c.units_mid AS after,
         l.gated_reason AS gatedBefore, c.gated_reason AS gatedAfter, l.method AS methodBefore, c.method AS methodAfter,
         l.signal_value AS signalBefore, c.signal_value AS signalAfter
    FROM main.window_estimates_daily c
    LEFT JOIN live.window_estimates_daily l ON l.title_id = c.title_id AND l.platform = c.platform AND l.window = c.window AND l.as_of_date = c.as_of_date
    LEFT JOIN main.console_title_igdb i ON i.title_id = c.title_id
   WHERE c.window = ? AND c.as_of_date = ?`;
const rows = db.prepare(q).all(window, asOf) as Array<{ platform: string; title_id: number; name: string | null; before: number | null; after: number | null; gatedBefore: string | null; gatedAfter: string | null; methodBefore: string | null; methodAfter: string | null; signalBefore: number | null; signalAfter: number | null }>;
const changed = rows.filter(r => (r.before ?? 0) !== (r.after ?? 0));
const revived = rows.filter(r => !(r.before ?? 0) && (r.after ?? 0) > 0).length;   // blank or zero in live, an estimate in the candidate
const lost = rows.filter(r => (r.before ?? 0) > 0 && !(r.after ?? 0)).length;       // an estimate in live, blank in the candidate
console.log(`[preview-estimate-diff] as_of=${asOf} window=${window} rows=${rows.length} changed=${changed.length} revived=${revived} lost=${lost} noLiveRow=${rows.filter(r => r.before == null).length}`);
for (const p of ["ps5", "xbox", "steam"]) {
  const pr = rows.filter(r => r.platform === p);
  if (!pr.length) continue;
  const b = pr.reduce((s, r) => s + (r.before ?? 0), 0), a = pr.reduce((s, r) => s + (r.after ?? 0), 0);
  const pRev = pr.filter(r => !(r.before ?? 0) && (r.after ?? 0) > 0).length;
  console.log(`  ${p}: revived=${pRev}; units before ${Math.round(b).toLocaleString()} after ${Math.round(a).toLocaleString()} (${b ? (((a - b) / b) * 100).toFixed(1) : "n/a"}%)`);
}
const movers = changed.filter(r => r.before && r.after).sort((x, y) => Math.abs(Math.log(y.after! / y.before!)) - Math.abs(Math.log(x.after! / x.before!))).slice(0, Number(topN));
for (const m of movers) console.log(`  ${m.platform} ${m.title_id} ${(m.name ?? "?").slice(0, 36)}: ${Math.round(m.before!).toLocaleString()} -> ${Math.round(m.after!).toLocaleString()}`);

// Per-row list of every changed row (capped), one CSV line each, so a reviewer can judge individual titles.
const ROW_CAP = 500;
const csv = (v: unknown) => { const t = v == null ? "" : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
console.log("ROW,window,platform,title_id,name,units_before,units_after,ratio,gated_before,gated_after,signal_before,signal_after,method_before,method_after");
for (const r of [...changed].sort((a, b) => (b.after ?? 0) - (a.after ?? 0)).slice(0, ROW_CAP)) {
  const ratio = r.before && r.after ? (r.after / r.before).toFixed(2) : "";
  console.log(["ROW", window, r.platform, r.title_id, r.name, r.before == null ? "" : Math.round(r.before), r.after == null ? "" : Math.round(r.after), ratio, r.gatedBefore, r.gatedAfter, r.signalBefore, r.signalAfter, r.methodBefore, r.methodAfter].map(csv).join(","));
}
if (changed.length > ROW_CAP) console.log(`ROW_TRUNCATED,${window},${changed.length - ROW_CAP} more changed rows not listed`);
