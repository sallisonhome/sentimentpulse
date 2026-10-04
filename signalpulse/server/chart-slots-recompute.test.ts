import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";

const SP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(SP, "node_modules/.bin/tsx");
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const run = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(TSX, args, { cwd, env: { ...process.env, TSX_TSCONFIG_PATH: join(SP, "tsconfig.json"), ...env }, encoding: "utf8", timeout: 240000 });

// Fresh DB with the production schema (the storage module creates it on first import).
function freshDb(dir: string) {
  const r = run(dir, ["-e", "import('" + join(SP, "server/storage.ts") + "').then(m => { m.rawSqlite.close(); })"]);
  assert.equal(r.status, 0, r.stderr);
  return new Database(join(dir, "data.db"));
}
const seedSlots = (db: Database.Database, platform: string, sortKey: string, date: string, slots: Array<[number, number]>) => {
  for (const [pos, tid] of slots) db.prepare(`INSERT INTO console_chart_slot_daily VALUES(?,?,?,?,?,?,?)`).run(platform, sortKey, date, pos, tid, `SKU${pos}`, "t");
};

test("DDL is additive and idempotent: the new table appears, re-running changes nothing, old tables untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "slots-ddl-"));
  try {
    const db = freshDb(dir);
    const cols = (db.prepare(`PRAGMA table_info(console_chart_slot_daily)`).all() as any[]).map(c => c.name);
    assert.deepEqual(cols, ["platform", "sort_key", "snapshot_date", "position", "title_id", "external_sku", "captured_at"]);
    const before = (db.prepare(`SELECT name, sql FROM sqlite_master WHERE name != 'console_chart_slot_daily' AND name NOT LIKE 'console_chart_slot_daily_%' ORDER BY name`).all() as any[]);
    db.close();
    const db2 = freshDb(dir);   // second import = second DDL pass on an existing DB
    const after = (db2.prepare(`SELECT name, sql FROM sqlite_master WHERE name != 'console_chart_slot_daily' AND name NOT LIKE 'console_chart_slot_daily_%' ORDER BY name`).all() as any[]);
    assert.deepEqual(after, before);
    db2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rank rebuild: preview writes nothing, apply is idempotent, ranks are unique, singles exact, no slots exits 3", () => {
  const dir = mkdtempSync(join(tmpdir(), "slots-rebuild-"));
  try {
    const db = freshDb(dir);
    const r0 = run(dir, [join(SP, "scripts/rebuild-chart-ranks.ts")]);
    assert.equal(r0.status, 3, "nothing stored yet must not look like success"); assert.match(r0.stdout, /no raw chart slots stored yet/);
    // xbox: title 1 has 2 slots (1,3), title 2 single at 2, title 3 single at 4; stored rank snapshot is the OLD last-write result
    seedSlots(db, "xbox", "xbox_api_top_paid", "2026-10-04", [[1, 1], [2, 2], [3, 1], [4, 3]]);
    for (const [t, rk] of [[1, 3], [2, 2], [3, 4]]) db.prepare(`INSERT INTO console_storefront_rank_daily VALUES('xbox','xbox_api_top_paid','2026-10-04',?,?,'t')`).run(t, rk);
    const stored = () => db.prepare(`SELECT title_id, rank FROM console_storefront_rank_daily ORDER BY title_id`).all();
    const before = JSON.stringify(stored());
    const p = run(dir, [join(SP, "scripts/rebuild-chart-ranks.ts")]);
    assert.equal(p.status, 0, p.stderr); assert.match(p.stdout, /PREVIEW/); assert.match(p.stdout, /title 1: stored 3 -> rebuilt 1/);
    assert.equal(JSON.stringify(stored()), before, "preview must not write");
    const a = run(dir, [join(SP, "scripts/rebuild-chart-ranks.ts"), "--apply"]);
    assert.equal(a.status, 0, a.stderr);
    const after = stored() as Array<{ title_id: number; rank: number }>;
    assert.deepEqual(after.map(x => [x.title_id, x.rank]), [[1, 1], [2, 2], [3, 4]], "combined title ahead, singles keep exact positions");
    const a2 = run(dir, [join(SP, "scripts/rebuild-chart-ranks.ts"), "--apply"]);
    assert.match(a2.stdout, /changed=0/); assert.deepEqual(stored(), after);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("slot writer: replaces the day atomically, empty list never wipes, other days untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "slots-writer-"));
  try {
    const db = freshDb(dir); db.close();
    const code = `
      const m = await import('${join(SP, "server/signals/console/rankSnapshot.ts")}');
      m.writeChartSlots('ps5','psn_api_sales30',[{position:1,titleId:9,externalSku:'A'},{position:2,titleId:8,externalSku:'B'},{position:3,titleId:9,externalSku:'C'}],'2026-10-03');
      m.writeChartSlots('ps5','psn_api_sales30',[{position:1,titleId:9},{position:2,titleId:8}],'2026-10-04');
      m.writeChartSlots('ps5','psn_api_sales30',[{position:1,titleId:7}],'2026-10-04');
      const emptied = m.writeChartSlots('ps5','psn_api_sales30',[],'2026-10-04');
      console.log(JSON.stringify({ d3: m.readChartSlots('ps5','psn_api_sales30','2026-10-03').length, d4: m.readChartSlots('ps5','psn_api_sales30','2026-10-04'), emptied, latest: m.latestChartSlotDate('ps5','psn_api_sales30') }));`;
    const r = run(dir, ["-e", `(async()=>{${code}})()`]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split("\n").pop()!);
    assert.equal(out.d3, 3); assert.deepEqual(out.d4.map((x: any) => x.titleId), [7]); assert.equal(out.emptied.rowsWritten, 0); assert.equal(out.latest, "2026-10-04");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("estimator honours ./data.db in its working directory, so a copy can be previewed without touching the live file", () => {
  const live = mkdtempSync(join(tmpdir(), "est-live-")), copy = mkdtempSync(join(tmpdir(), "est-copy-"));
  try {
    freshDb(live).close();
    const liveHash = sha(join(live, "data.db"));
    // copy of the live DB via the same online-backup mechanism the workflow uses
    const src = new Database(join(live, "data.db")); src.exec(`VACUUM INTO '${join(copy, "data.db").replace(/'/g, "''")}'`); src.close();
    const r = run(copy, [join(SP, "scripts/estimate-console-units.ts")], { LTD_ACCUMULATOR_ENABLED: "1" });
    assert.equal(r.status, 0, r.stdout.slice(-600) + r.stderr.slice(-600));
    assert.match(r.stdout, /wrote \d+ rows to window_estimates_daily/);
    assert.equal(sha(join(live, "data.db")), liveHash, "live DB file must be byte-identical after running the estimator in the copy directory");
  } finally { rmSync(live, { recursive: true, force: true }); rmSync(copy, { recursive: true, force: true }); }
});

test("estimate diff: reports changed rows and totals, never writes either database", () => {
  const dir = mkdtempSync(join(tmpdir(), "est-diff-"));
  try {
    const mk = (name: string, rows: Array<[number, string, number]>) => {
      const p = join(dir, name); const d = new Database(p);
      d.exec(`CREATE TABLE window_estimates_daily(id INTEGER PRIMARY KEY, title_id INT, platform TEXT, window TEXT, as_of_date TEXT, units_mid REAL, signal_value REAL, gated_reason TEXT, method TEXT);
              CREATE TABLE console_title_igdb(title_id INT, name TEXT);`);
      for (const [t, plat, u] of rows) { d.prepare(`INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,units_mid,signal_value,gated_reason,method) VALUES(?,?,'d30','2026-10-04',?,?,?,?)`).run(t, plat, u, u / 10, u > 100 ? null : "signal_too_small", name.startsWith("live") ? "m,old" : "m-new"); d.prepare(`INSERT INTO console_title_igdb VALUES(?,?)`).run(t, `Game ${t}`); }
      d.close(); return p;
    };
    const live = mk("live.db", [[1, "xbox", 1000], [2, "xbox", 500], [3, "ps5", 200]]);
    const cand = mk("cand.db", [[1, "xbox", 250], [2, "xbox", 500], [3, "ps5", 400], [4, "ps5", 90]]);
    const [h1, h2] = [sha(live), sha(cand)];
    const r = run(dir, [join(SP, "scripts/preview-estimate-diff.ts"), live, cand, "d30", "5"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /rows=4 changed=3 revived=1 lost=0 noLiveRow=1/);
    assert.match(r.stdout, /xbox: revived=0; units before 1,500 after 750 \(-50\.0%\)/);
    assert.match(r.stdout, /xbox 1 Game 1: 1,000 -> 250/);
    const rowsOut = r.stdout.split("\n").filter(l => l.startsWith("ROW,"));
    assert.equal(rowsOut[0], "ROW,window,platform,title_id,name,units_before,units_after,ratio,gated_before,gated_after,signal_before,signal_after,method_before,method_after");
    assert.equal(rowsOut.length, 1 + 3, "header plus the 3 changed rows");
    assert.ok(rowsOut.includes('ROW,d30,xbox,1,Game 1,1000,250,0.25,,,100,25,"m,old",m-new'), "csv quoting and before/after columns: " + rowsOut.join(" | "));
    assert.ok(rowsOut.some(l => l.startsWith("ROW,d30,ps5,4,Game 4,,90,,,signal_too_small,,9,")), "new row has empty before");
    assert.equal(sha(live), h1); assert.equal(sha(cand), h2);
    assert.equal(run(dir, [join(SP, "scripts/preview-estimate-diff.ts")]).status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function db2seed(dir: string, key: string, value: string) {
  const d = new Database(join(dir, "data.db"));
  d.prepare(`INSERT INTO app_settings(key,value,label,category,is_secret,created_at,updated_at) VALUES(?,?,'t','t',0,'t','t') ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value);
  d.close();
}

// End-to-end through the real shell script with a fake systemctl: every action, guard rails and exit codes.
test("signalpulse-recompute.sh: previews leave the live DB byte-identical; refuses unknown actions and a running daily refresh", { skip: spawnSync("which", ["sqlite3"]).status !== 0 }, () => {
  const wd = mkdtempSync(join(tmpdir(), "recompute-wd-")), bin = mkdtempSync(join(tmpdir(), "recompute-bin-"));
  try {
    for (const n of ["scripts", "server", "shared", "node_modules", "package.json", "tsconfig.json", "deploy"]) if (existsSync(join(SP, n))) symlinkSync(join(SP, n), join(wd, n));
    freshDb(wd).close();
    const db = new Database(join(wd, "data.db"));
    seedSlots(db, "xbox", "xbox_api_top_paid", "2026-10-04", [[1, 1], [2, 2], [3, 1]]);
    db.prepare(`INSERT INTO console_storefront_rank_daily VALUES('xbox','xbox_api_top_paid','2026-10-04',1,3,'t')`).run();
    db.prepare(`INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,units_mid,created_at) VALUES(1,'xbox','d30','2026-10-04',1000,'t')`).run(); db.close();
    const fake = (active: string) => { writeFileSync(join(bin, "systemctl"), `#!/usr/bin/env bash
case "$*" in
  *WorkingDirectory*) echo "${wd}";;
  *signalpulse-daily.service*) echo "${active}";;
  *Environment*) echo "LTD_ACCUMULATOR_ENABLED=1";;
esac`); chmodSync(join(bin, "systemctl"), 0o755); };
    const sh = (action: string) => spawnSync("bash", [join(SP, "deploy/signalpulse-recompute.sh"), action], { encoding: "utf8", timeout: 280000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SP_LOCK_FILE: join(wd, "lock") } });
    fake("inactive");
    const h = sha(join(wd, "data.db"));
    assert.equal(sh("bogus").status, 64);
    const rp = sh("ranks-preview"); assert.equal(rp.status, 0, rp.stdout + rp.stderr); assert.match(rp.stdout, /stored 3 -> rebuilt 1/);
    assert.equal(sha(join(wd, "data.db")), h, "ranks-preview left the DB byte-identical");
    const ep = sh("estimate-preview"); assert.equal(ep.status, 0, ep.stdout.slice(-800) + ep.stderr.slice(-800)); assert.match(ep.stdout, /live database unchanged/); assert.match(ep.stdout, /\[preview-estimate-diff\] as_of=2026-10-04 window=d30/);
    assert.equal(sha(join(wd, "data.db")), h, "estimate-preview left the live DB byte-identical");
    const ra = sh("ranks-apply"); assert.equal(ra.status, 0, ra.stdout + ra.stderr);
    const chk = new Database(join(wd, "data.db"), { readonly: true });
    assert.equal((chk.prepare(`SELECT rank FROM console_storefront_rank_daily WHERE title_id=1`).get() as any).rank, 1); chk.close();
    // overlay: validated, applied to the COPY only, and visible to the estimator (noise gate printed by the estimator itself)
    db2seed(wd, "noise_gate_min_signal", "50");
    const hOv = sha(join(wd, "data.db"));
    const shOv = (action: string, ov: string, mode?: string) => spawnSync("bash", [join(SP, "deploy/signalpulse-recompute.sh"), action, ov, ...(mode ? [mode] : [])], { encoding: "utf8", timeout: 280000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SP_LOCK_FILE: join(wd, "lock") } });
    assert.equal(shOv("estimate-preview", "noise_gate_min_signal.xbox=abc").status, 64, "non-numeric overlay rejected");
    assert.equal(shOv("estimate-preview", "x=1;rm -rf /").status, 64, "shell metacharacters rejected");
    assert.equal(shOv("ranks-preview", "noise_gate_min_signal.xbox=10").status, 64, "overlay only allowed for estimate-preview");
    const ov = shOv("estimate-preview", "noise_gate_min_signal.xbox=10");
    assert.equal(ov.status, 0, ov.stdout.slice(-900) + ov.stderr.slice(-900));
    assert.match(ov.stdout, /overlay applied to the COPY only: noise_gate_min_signal\.xbox=10/);
    assert.match(ov.stdout, /noise_gate\.xbox=10/, "the estimator on the copy used the overlaid gate");
    const plain = shOv("estimate-preview", ""); assert.equal(plain.status, 0, plain.stdout.slice(-600));
    assert.match(plain.stdout, /noise_gate\.xbox=50/, "without the overlay the copy keeps the legacy gate");
    assert.doesNotMatch(plain.stdout, /overlay applied/);
    // anchor mode: validated, preview-only, passed to the copy's estimator
    assert.equal(shOv("estimate-preview", "", "bogus").status, 64, "unknown anchor mode rejected");
    assert.equal(shOv("ranks-preview", "", "report").status, 64, "anchor mode only allowed for estimate-preview");
    const rep = shOv("estimate-preview", "", "report"); assert.equal(rep.status, 0, rep.stdout.slice(-600) + rep.stderr.slice(-600));
    assert.match(rep.stdout, /no rank-anchor-compare lines \(mode report\)|\[rank-anchor-compare\] mode=report/, "report mode ran on the copy");
    assert.match(plain.stdout, /no rank-anchor-compare lines \(mode legacy\)/, "default mode is legacy and prints no comparison");
    assert.equal((ov.stdout.match(/^CHART /gm) ?? []).length, 8, "chart report printed for before and after, 2 platforms x 2 windows");
    assert.equal(sha(join(wd, "data.db")), hOv, "live DB unchanged by an overlay preview");
    const ea = sh("estimate-apply"); assert.equal(ea.status, 0, ea.stdout.slice(-600) + ea.stderr.slice(-600)); assert.match(ea.stdout, /PHASE 3[\s\S]*PHASE 4[\s\S]*recompute done/);
    fake("active");
    const busy = sh("estimate-apply"); assert.equal(busy.status, 75); assert.match(busy.stdout, /refusing to overlap/);
    assert.ok(!existsSync(join(wd, "tmp-should-not-exist")));
  } finally { rmSync(wd, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true }); }
});
