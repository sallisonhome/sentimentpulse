import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { legacyFloor, medianPeerFloor, chooseFloor, rankAnchorModeFromEnv, curveFloor } from "./rank-anchor-curve";
import { fitRankCurve } from "./console-chart-consistency";

const powerRefs = (n: number, exp = -0.8, scale = 400000, skip = -1) =>
  Array.from({ length: n }, (_, i) => i + 1).filter(r => r !== skip).map(rank => ({ rank, units: Math.round(scale * Math.pow(rank, exp)) }));

test("legacy floor reproduces the production formula on the Gears peers (14, 18, 20) and is moved by one outlier", () => {
  const peers = [{ rank: 14, units: 11107 }, { rank: 18, units: 5911 }, { rank: 20, units: 316213 }];
  const a = 0.7, anchor = 17;
  const mean = (11107 + 5911 + 316213) / 3, w = (Math.pow(14, -a) + Math.pow(18, -a) + Math.pow(20, -a)) / 3;
  assert.ok(Math.abs(legacyFloor(peers, anchor, a)! - mean * Math.pow(anchor, -a) / w) < 1e-6);
  assert.equal(legacyFloor([], anchor, a), null);
  const noOutlier = legacyFloor(peers.slice(0, 2), anchor, a)!;
  assert.ok(legacyFloor(peers, anchor, a)! > 10 * noOutlier, "one 28x peer multiplies the legacy floor");
});

test("median peer floor ignores a single outlier and needs three peers", () => {
  const peers = [{ rank: 14, units: 11107 }, { rank: 18, units: 5911 }, { rank: 20, units: 316213 }];
  const m = medianPeerFloor(peers, 17, 0.7)!;
  assert.ok(m > 5000 && m < 15000, String(m));
  assert.equal(medianPeerFloor(peers.slice(0, 2), 17, 0.7), null);
});

test("chooseFloor: curve when it fits, else the peer median, else nothing", () => {
  const refs = powerRefs(40, -0.8, 400000, 17);
  const peers = [{ rank: 14, units: 40000 }, { rank: 15, units: 38000 }, { rank: 16, units: 36000 }];
  const c = chooseFloor(refs, peers, 17, 0.7);
  assert.equal(c.basis, "curve");
  assert.ok(Math.abs(c.floor! - 400000 * Math.pow(17, -0.8)) / c.floor! < 0.02);
  const m = chooseFloor(refs.slice(0, 10), peers, 17, 0.7);
  assert.equal(m.basis, "median_peers"); assert.ok(m.floor! > 0);
  const none = chooseFloor(refs.slice(0, 10), peers.slice(0, 2), 17, 0.7);
  assert.deepEqual([none.floor, none.basis], [null, null]);
  assert.equal(curveFloor(powerRefs(40, +0.5), 17), null, "a rising curve is rejected");
});

test("mode parsing: unknown or missing means legacy", () => {
  assert.deepEqual([undefined, "", "REPORT", "curve", "bogus"].map(rankAnchorModeFromEnv), ["legacy", "legacy", "report", "curve", "legacy"]);
});

test("estimator end to end: legacy unchanged, report only logs, curve applies the durable floor", async () => {
  const root = process.cwd(), dir = mkdtempSync(join(tmpdir(), "rank-anchor-curve-"));
  process.chdir(dir); let db: any;
  try {
    db = (await import("./storage")).rawSqlite;
    const day = new Date().toISOString().slice(0, 10), stamp = new Date().toISOString();
    const iso = (d: number) => new Date(Date.parse(day) - d * 86400000).toISOString().slice(0, 10);
    db.exec(`INSERT INTO ownership_multipliers(platform,cohort_key,multiplier,ci_pct,digital_unit_share,confidence,method,effective_from,created_at)
      VALUES('ps5','default',10,.3,1,'test','test_model','2020-01-01','${stamp}')`);
    const FRESH = 99200, FRESH_RANK = 5, OUTLIER_RANK = 7;
    const addTitle = (id: number, rank: number, release: string, base: number, today: number) => {
      db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,msrp_usd_cents,refreshed_at,created_at) VALUES(?,?,?,?,?,?,?,?)`).run(id, "ps5", `sku${id}`, "base", "paid", 4999, stamp, stamp);
      db.prepare(`INSERT INTO console_title_igdb(title_id,name,store_name,release_date,store_release_date,refreshed_at,created_at) VALUES(?,?,?,?,?,?,?)`).run(id, `T${id}`, `T${id}`, release, release, stamp, stamp);
      for (const [d, c] of Array.from({ length: 10 }, (_, k) => 9 - k).map(k => [iso(k), k >= 7 ? base : Math.round(base + (today - base) * (7 - k) / 7)] as [string, number]))
        db.prepare(`INSERT INTO store_rating_signal_daily(title_id,platform,capture_date,source_endpoint,rating_count,raw_json,created_at) VALUES(?,?,?,?,?,'{}',?)`).run(id, "ps5", d, "test", c, stamp);
      db.prepare(`INSERT INTO console_storefront_rank_daily(platform,sort_key,snapshot_date,title_id,rank,snapshot_at) VALUES('ps5','psn_api_sales30',?,?,?,?)`).run(day, id, rank, stamp);
    };
    for (let rank = 1; rank <= 30; rank++) {
      if (rank === FRESH_RANK) continue;
      const sig = Math.round(4000 * Math.pow(rank, -0.8)) * (rank === OUTLIER_RANK ? 30 : 1);
      addTitle(99100 + rank, rank, "2020-01-01", 1000, 1000 + sig);
    }
    addTitle(FRESH, FRESH_RANK, iso(2), 0, 60);
    const run = (mode?: string) => execFileSync(resolve(root, "node_modules/.bin/tsx"), ["--tsconfig", resolve(root, "tsconfig.json"), resolve(root, "scripts/estimate-console-units.ts")],
      { cwd: dir, env: { ...process.env, DB_PATH: join(dir, "data.db"), ...(mode ? { RANK_ANCHOR_MODE: mode } : {}) }, timeout: 60000, stdio: "pipe" }).toString();
    const fresh = () => db.prepare("SELECT units_mid, method FROM window_estimates_daily WHERE title_id=? AND platform='ps5' AND window='d7' AND as_of_date=?").get(FRESH, day);
    const d7 = () => db.prepare("SELECT title_id, units_mid FROM window_estimates_daily WHERE platform='ps5' AND window='d7' AND as_of_date=? AND title_id<>?").all(day, FRESH) as Array<{ title_id: number; units_mid: number }>;

    const outLegacy = run();
    assert.doesNotMatch(outLegacy, /rank-anchor-compare/, "legacy mode logs no comparison");
    const L = fresh(); assert.match(L.method, /^rank_anchor:psn_api_sales30$/, JSON.stringify(L));
    const units = new Map(d7().map(r => [r.title_id - 99100, r.units_mid]));
    const peersLegacy = [2, 3, 4, 6, 7, 8].filter(r => units.get(r)! > 0).map(r => ({ rank: r, units: units.get(r)! }));
    assert.equal(peersLegacy.length, 6);
    assert.equal(L.units_mid, Math.round(legacyFloor(peersLegacy, FRESH_RANK, 0.7)!), "legacy value is exactly the old formula");

    const outReport = run("report");
    const R = fresh();
    assert.equal(R.units_mid, L.units_mid, "report mode applies the legacy value"); assert.equal(R.method, L.method);
    assert.match(outReport, /\[rank-anchor-compare\] mode=report platform=ps5 title=99200 .* legacy=\d+ .* durable=\d+ basis=curve /);

    const outCurve = run("curve");
    const C = fresh();
    assert.match(C.method, /^rank_anchor:psn_api_sales30\+curve_v1$/, JSON.stringify(C));
    const refs = [...units].filter(([r]) => r !== OUTLIER_RANK).map(([rank, u]) => ({ rank, units: u })).concat([{ rank: OUTLIER_RANK, units: units.get(OUTLIER_RANK)! }]);
    const expect = curveFloor(refs, FRESH_RANK)!.floor;
    assert.equal(C.units_mid, Math.round(expect), "curve mode applies the curve value at the title's rank");
    assert.ok(C.units_mid < L.units_mid, `outlier-driven legacy ${L.units_mid} exceeds the durable ${C.units_mid}`);
    assert.match(outCurve, /mode=curve/);
    assert.ok(fitRankCurve(refs), "the fixture curve fits");
  } finally { db?.close(); process.chdir(root); rmSync(dir, { recursive: true, force: true }); }
});
