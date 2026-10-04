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
  SELECT c.platform, c.title_id, i.name, l.units_mid AS before, c.units_mid AS after
    FROM main.window_estimates_daily c
    LEFT JOIN live.window_estimates_daily l ON l.title_id = c.title_id AND l.platform = c.platform AND l.window = c.window AND l.as_of_date = c.as_of_date
    LEFT JOIN main.console_title_igdb i ON i.title_id = c.title_id
   WHERE c.window = ? AND c.as_of_date = ?`;
const rows = db.prepare(q).all(window, asOf) as Array<{ platform: string; title_id: number; name: string | null; before: number | null; after: number | null }>;
const changed = rows.filter(r => (r.before ?? 0) !== (r.after ?? 0));
console.log(`[preview-estimate-diff] as_of=${asOf} window=${window} rows=${rows.length} changed=${changed.length} newOrMissingInLive=${rows.filter(r => r.before == null).length}`);
for (const p of ["ps5", "xbox", "steam"]) {
  const pr = rows.filter(r => r.platform === p);
  if (!pr.length) continue;
  const b = pr.reduce((s, r) => s + (r.before ?? 0), 0), a = pr.reduce((s, r) => s + (r.after ?? 0), 0);
  console.log(`  ${p}: units before ${Math.round(b).toLocaleString()} after ${Math.round(a).toLocaleString()} (${b ? (((a - b) / b) * 100).toFixed(1) : "n/a"}%)`);
}
const movers = changed.filter(r => r.before && r.after).sort((x, y) => Math.abs(Math.log(y.after! / y.before!)) - Math.abs(Math.log(x.after! / x.before!))).slice(0, Number(topN));
for (const m of movers) console.log(`  ${m.platform} ${m.title_id} ${(m.name ?? "?").slice(0, 36)}: ${Math.round(m.before!).toLocaleString()} -> ${Math.round(m.after!).toLocaleString()}`);
