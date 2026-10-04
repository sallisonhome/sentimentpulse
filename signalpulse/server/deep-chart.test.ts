import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { rerankPaidOnly, collectXboxChartIds, classifyXboxChart, type DeepItem, type XboxDeepDeps } from "./signals/console/deepChartCore";
import { xboxPricingFromProduct } from "./signals/console/xbox";
import { applyChartConsistency, fitRankCurve, curveUnits } from "./console-chart-consistency";

const SP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(SP, "node_modules/.bin/tsx");
const run = (cwd: string, args: string[]) => spawnSync(TSX, args, { cwd, env: { ...process.env, TSX_TSCONFIG_PATH: join(SP, "tsconfig.json") }, encoding: "utf8", timeout: 240000 });

const item = (p: number, bm: DeepItem["businessModel"]): DeepItem => ({ rawPosition: p, externalSku: "S" + p, name: "N" + p, businessModel: bm, msrpUsdCents: bm === "paid" ? 5999 : bm === "free_to_play" ? 0 : null });

test("rerank: free-to-play dropped (null), unknown kept, dense 1..N in store order, input order irrelevant", () => {
  const r = rerankPaidOnly([item(4, "paid"), item(1, "free_to_play"), item(3, "unknown"), item(2, "paid"), item(5, "free_to_play"), item(6, "paid")]);
  assert.deepEqual(r.map(x => x.rawPosition), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(r.map(x => x.paidRank), [null, 1, 2, 3, null, 4]);
});

test("pricing rule parity: all-zero MSRPs are free, mixed are paid with the max non-zero base, no prices are unknown", () => {
  const prod = (m: Array<number | undefined>) => ({ DisplaySkuAvailabilities: [{ Availabilities: m.map(v => ({ OrderManagementData: { Price: v === undefined ? undefined : { MSRP: v, CurrencyCode: "USD" } } })) }] });
  assert.deepEqual(xboxPricingFromProduct(prod([0, 0, 0])), { allSkusZero: true, baseMsrpUsdCents: 0, currency: "USD" });
  assert.deepEqual(xboxPricingFromProduct(prod([29.99, 0, 69.99])), { allSkusZero: false, baseMsrpUsdCents: 6999, currency: "USD" });
  assert.deepEqual(xboxPricingFromProduct(prod([undefined])), { allSkusZero: false, baseMsrpUsdCents: null, currency: null });
  assert.deepEqual(xboxPricingFromProduct({}), { allSkusZero: false, baseMsrpUsdCents: null, currency: null });
});

const product = (id: string, msrps: number[]) => ({ ProductId: id, LocalizedProperties: [{ ProductTitle: "T-" + id }], DisplaySkuAvailabilities: [{ Availabilities: msrps.map(m => ({ OrderManagementData: { Price: { MSRP: m, CurrencyCode: "USD" } } })) }] });

test("xbox collector: pages until the cursor ends, de-duplicates, honours the cap; classifier batches by 20 and keeps failed/missing SKUs ranked as unknown", async () => {
  const pages = [["A", "B", "C"], ["C", "D", "E"], ["F"]];
  let calls = 0;
  const deps: XboxDeepDeps = {
    fetchPage: async (_c, ct) => { const i = ct ? Number(ct) : 0; calls++; return { productIds: pages[i], nextCT: i + 1 < pages.length ? String(i + 1) : null }; },
    fetchProducts: async () => [], sleep: async () => {},
  };
  assert.deepEqual(await collectXboxChartIds(100, deps), ["A", "B", "C", "D", "E", "F"]);
  assert.equal(calls, 3);
  assert.deepEqual(await collectXboxChartIds(4, deps), ["A", "B", "C", "D"], "cap respected");

  const ids = Array.from({ length: 45 }, (_, i) => "P" + i);
  const batches: string[][] = [];
  const cdeps: XboxDeepDeps = {
    fetchPage: async () => ({ productIds: [], nextCT: null }), sleep: async () => {},
    fetchProducts: async (b) => {
      batches.push(b);
      if (b[0] === "P20") throw new Error("boom");                        // whole batch fails
      return b.filter(x => x !== "P3").map(x => product(x, x === "P0" ? [0, 0] : [59.99]));   // P3 missing, P0 free
    },
  };
  const out = await classifyXboxChart(ids, cdeps);
  assert.deepEqual(batches.map(b => b.length), [20, 20, 5]);
  assert.equal(out[0].businessModel, "free_to_play");
  assert.equal(out[1].businessModel, "paid");
  assert.equal(out[3].businessModel, "unknown", "missing product stays ranked as unknown");
  assert.equal(out[25].businessModel, "unknown", "failed batch stays ranked as unknown");
  assert.equal(out[44].businessModel, "paid");
  const ranked = rerankPaidOnly(out);
  assert.equal(ranked[0].paidRank, null);
  assert.deepEqual(ranked.slice(1, 4).map(r => r.paidRank), [1, 2, 3]);
});

test("store: DDL additive; write replaces the day atomically; tiny/empty fetch never wipes; reader joins platform_sku_map and keeps the best rank per title", () => {
  const dir = mkdtempSync(join(tmpdir(), "deep-store-"));
  try {
    let r = run(dir, ["-e", "import('" + join(SP, "server/storage.ts") + "').then(m => m.rawSqlite.close())"]); assert.equal(r.status, 0, r.stderr);
    const cols = (new Database(join(dir, "data.db")).prepare(`PRAGMA table_info(console_chart_rank_deep_daily)`).all() as any[]).map(c => c.name);
    assert.deepEqual(cols, ["platform", "sort_key", "snapshot_date", "raw_position", "paid_rank", "external_sku", "name", "business_model", "msrp_usd_cents", "captured_at"]);
    const code = `(async()=>{
      const core = await import('${join(SP, "server/signals/console/deepChartCore.ts")}');
      const st = await import('${join(SP, "server/signals/console/deepChartStore.ts")}');
      const { rawSqlite } = await import('${join(SP, "server/storage.ts")}');
      const mk = (n, f2pAt) => Array.from({length:n},(_,i)=>({rawPosition:i+1,externalSku:'X'+(i+1),name:'n',businessModel:(i+1)===f2pAt?'free_to_play':'paid',msrpUsdCents:5999}));
      const w1 = st.writeDeepChart('xbox', core.rerankPaidOnly(mk(30, 1)), '2026-10-03');
      const w2 = st.writeDeepChart('xbox', core.rerankPaidOnly(mk(30, 1)), '2026-10-04');
      const w3 = st.writeDeepChart('xbox', core.rerankPaidOnly(mk(5, 0)), '2026-10-04');
      const w4 = st.writeDeepChart('xbox', [], '2026-10-04');
      const n4 = rawSqlite.prepare("SELECT COUNT(*) n FROM console_chart_rank_deep_daily WHERE snapshot_date='2026-10-04'").get().n;
      const n3 = rawSqlite.prepare("SELECT COUNT(*) n FROM console_chart_rank_deep_daily WHERE snapshot_date='2026-10-03'").get().n;
      const f2p = rawSqlite.prepare("SELECT paid_rank FROM console_chart_rank_deep_daily WHERE snapshot_date='2026-10-04' AND raw_position=1").get();
      const ins = rawSqlite.prepare("INSERT INTO platform_sku_map (platform, external_sku, title_id, sku_role, business_model, business_model_source, is_manual_override, refreshed_at, created_at) VALUES ('xbox', ?, ?, 'base', 'paid', 't', 0, 't', 't')");
      ins.run('X2', 501); ins.run('X9', 501); ins.run('X5', 502);
      const rd = st.readDeepRankByTitle('xbox');
      const empty = st.readDeepRankByTitle('ps5');
      console.log(JSON.stringify({ w1, w2, w3, w4, n4, n3, f2p, ranks: [...rd.ranks.entries()], date: rd.snapshotDate, paidRows: rd.paidRows, emptyDate: empty.snapshotDate }));
    })()`;
    r = run(dir, ["-e", code]); assert.equal(r.status, 0, r.stderr + r.stdout.slice(-500));
    const o = JSON.parse(r.stdout.trim().split("\n").pop()!);
    assert.equal(o.w1.rowsWritten, 30); assert.equal(o.w2.rowsWritten, 30);
    assert.match(o.w3.skipped, /too_few_rows/); assert.equal(o.w4.rowsWritten, 0);
    assert.equal(o.n4, 30, "tiny and empty fetches did not wipe the day"); assert.equal(o.n3, 30, "other day untouched");
    assert.equal(o.f2p.paid_rank, null, "free-to-play row kept for audit with NULL paid rank");
    assert.deepEqual(o.ranks.sort((a: number[], b: number[]) => a[0] - b[0]), [[501, 1], [502, 4]], "X2 is paid rank 1 (X1 dropped), X9 is 8; best rank wins; X5 is 4");
    assert.equal(o.date, "2026-10-04"); assert.equal(o.paidRows, 29); assert.equal(o.emptyDate, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Synthetic chart: units = 400000 * rank^-0.8 with a little deterministic noise for ranks 1..80.
const mkGroup = (id: number, units: number, extra: Record<string, unknown> = {}) => ({ familyTitleIds: [id], unitsMid: units, revenueMidUsd: units * 50, dataSource: "derived_from_steam", ...extra });
const curveGroups = () => Array.from({ length: 80 }, (_, i) => mkGroup(i + 1, Math.round(400000 * Math.pow(i + 1, -0.8) * (1 + ((i * 7) % 5 - 2) * 0.03))));

test("curve fit: recovers the slope, rejects flat/rising/too-few data, trimming resists outliers", () => {
  const pts = curveGroups().map((g, i) => ({ rank: i + 1, units: g.unitsMid }));
  const c = fitRankCurve(pts)!;
  assert.ok(Math.abs(c.b + 0.8) < 0.05 && c.r2 > 0.98, JSON.stringify(c));
  assert.equal(fitRankCurve(pts.slice(0, 10)), null, "too few points");
  assert.equal(fitRankCurve(pts.map(p => ({ rank: p.rank, units: 1000 }))), null, "flat curve rejected");
  assert.equal(fitRankCurve(pts.map(p => ({ rank: p.rank, units: p.rank * 100 }))), null, "rising curve rejected");
  const noisy = pts.map((p, i) => (i % 9 === 4 ? { rank: p.rank, units: p.units * 6 } : p));
  const cn = fitRankCurve(noisy)!;
  assert.ok(Math.abs(cn.b + 0.8) < 0.15, "outliers trimmed: slope " + cn.b);
});

test("deep rank ceiling: lowers an off-chart title by its deep rank, never raises, falls back to the flat cap without deep data, report mode changes nothing", () => {
  const rank = new Map<number, number>(); curveGroups().forEach((_, i) => rank.set(i + 1, i + 1));
  const mkAll = () => [...curveGroups(), mkGroup(901, 90000), mkGroup(902, 90000), mkGroup(903, 800), mkGroup(904, 90000)] as any[];
  const deep = new Map<number, number>([[901, 150], [902, 900], [903, 400]]);   // 904 has no deep rank
  const flat = mkAll(); const rf = applyChartConsistency(flat, rank, new Set(), "report", { today: "2026-10-04" });
  const dp = mkAll(); const rd = applyChartConsistency(dp, rank, new Set(), "report", { today: "2026-10-04", deepRankByTitle: deep });
  const byId = (g: any[], id: number) => g.find(x => x.familyTitleIds[0] === id);
  const flatCap = byId(flat, 901).chartConsistency.after;
  assert.equal(byId(flat, 901).chartConsistency.bound, "off_chart_cap");
  const n901 = byId(dp, 901).chartConsistency, n902 = byId(dp, 902).chartConsistency;
  assert.equal(n901.bound, "deep_rank_ceiling"); assert.equal(n901.deepPaidRank, 150);
  assert.ok(n901.after < flatCap && n902.after < n901.after, `deeper rank gets a lower ceiling: ${n901.after} ${n902.after} flat ${flatCap}`);
  assert.equal(byId(dp, 903).chartConsistency, undefined, "800 units at deep rank 400 is below the ceiling: untouched, never raised");
  assert.equal(byId(dp, 904).chartConsistency.bound, "off_chart_cap", "no deep rank: flat cap");
  assert.equal(byId(dp, 904).chartConsistency.after, flatCap);
  assert.equal(byId(dp, 901).unitsMid, 90000, "report mode changes no numbers");
  assert.ok(rd.capped >= rf.capped);
  // enforce applies the deep ceiling
  const en = mkAll(); applyChartConsistency(en, rank, new Set(), "enforce", { today: "2026-10-04", deepRankByTitle: deep });
  assert.equal(byId(en, 901).unitsMid, n901.after);
  // exemptions still win
  const ex = mkAll(); ex[80] = mkGroup(901, 90000, { dataSource: "actual" });
  applyChartConsistency(ex, rank, new Set(), "report", { today: "2026-10-04", deepRankByTitle: deep });
  assert.equal(ex[80].chartConsistency, undefined, "actual rows are never moved");
  // a thin deep fit (fewer than 20 refs) falls back to flat
  const thin = mkAll().slice(0, 15).concat(mkAll().slice(80)); const rankThin = new Map([...rank].filter(([k]) => k <= 15));
  applyChartConsistency(thin, rankThin, new Set(), "report", { today: "2026-10-04", deepRankByTitle: deep, minRanked: 10 });
  assert.equal(thin.find((g: any) => g.familyTitleIds[0] === 901).chartConsistency.bound, "off_chart_cap");
  assert.ok(curveUnits(fitRankCurve(curveGroups().map((g, i) => ({ rank: i + 1, units: g.unitsMid })))!, 100) > 0);
});
