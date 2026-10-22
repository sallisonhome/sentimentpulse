import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated scratch DB per the SAFE pattern (see portal-actuals.test.ts):
// chdir BEFORE any dynamic `await import(...)` of ./storage; one DB test
// per file.

// Hourly CCU poll (2026-10-22): pollDemoCcu stores Steam's charts peak for
// tracked appids that chart in the top 100 (untracked appids ignored, chart
// departures deleted), sweeps the catalog through the batched collector
// (snapshots + daily peaks written per-response, 404s never zeroed, 429s
// abort), records sweep-completion state, and compacts history losslessly:
// per-day rollups are written and old raw snapshots pruned while each
// demo's most recent snapshot and every daily peak survive.
test("demo CCU poll: Steam peak overlay, batched sweep, lossless compaction, departure handling", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "demos-ccu-scheduler-"));
  process.chdir(dir);
  let db: any;
  const realFetch = globalThis.fetch;
  try {
    db = (await import("../../storage")).rawSqlite;
    const stamp = new Date().toISOString();
    const today = stamp.slice(0, 10);

    // Catalog: two demos + one friends-pass SKU (404 on the players
    // endpoint must be recorded as unavailable, never zero).
    db.prepare(`INSERT INTO demo_titles(id,steam_app_id,name,genre,release_date,discovered_via,is_active,first_seen_at,created_at,updated_at)
      VALUES(1,'1001','Charting Demo','Simulation',?,'test',1,?,?,?)`).run(today, stamp, stamp, stamp);
    db.prepare(`INSERT INTO demo_titles(id,steam_app_id,name,genre,release_date,discovered_via,is_active,first_seen_at,created_at,updated_at)
      VALUES(2,'1002','Quiet Demo','Simulation',?,'test',1,?,?,?)`).run(today, stamp, stamp, stamp);
    db.prepare(`INSERT INTO demo_titles(id,steam_app_id,name,genre,release_date,discovered_via,is_active,first_seen_at,created_at,updated_at)
      VALUES(3,'1003','Pass SKU','Simulation',?,'test',1,?,?,?)`).run(today, stamp, stamp, stamp);
    db.prepare("UPDATE demo_titles SET sku_kind='friends_pass' WHERE id=3").run();
    // Ancient raw snapshots (older of the two must be pruned + rolled up;
    // the newer must be KEPT as demo 1's last-good sample) and daily peaks.
    db.prepare(`INSERT INTO demo_ccu_snapshots(demo_title_id,captured_at,ccu) VALUES (1,'2020-01-01T10:00:00.000Z',123)`).run();
    db.prepare(`INSERT INTO demo_ccu_snapshots(demo_title_id,captured_at,ccu) VALUES (1,'2020-01-02T10:00:00.000Z',130)`).run();
    db.prepare(`INSERT INTO demo_ccu_daily_peaks(demo_title_id,peak_date,peak_ccu,created_at) VALUES (1,'2020-01-01',123,'2020-01-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO demo_ccu_daily_peaks(demo_title_id,peak_date,peak_ccu,created_at) VALUES (1,'2020-01-02',130,'2020-01-02T00:00:00.000Z')`).run();

    const players = new Map<string, number | null>([["1001", 4321], ["1002", 17], ["1003", null]]);
    const charting: Array<[string, number, number, number]> = [["1001", 5, 4200, 5000], ["9999", 6, 4000, 6000]];
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      if (url.includes("GetGamesByConcurrentPlayers")) {
        return new Response(JSON.stringify({ response: { ranks: charting.map(([appId, rank, cur, peak]) => ({
          rank, appid: Number(appId), concurrent_in_game: cur, peak_in_game: peak })) } }), { status: 200 });
      }
      if (url.includes("GetNumberOfCurrentPlayers")) {
        const appId = new URL(url).searchParams.get("appid") as string;
        if (appId === "1003") return new Response("", { status: 404 }); // pass SKU: no endpoint
        const count = players.get(appId);
        return new Response(JSON.stringify({ response: { result: count == null ? 0 : 1, player_count: count ?? 0 } }), { status: 200 });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as any;

    const { pollDemoCcu } = await import("./ccu-scheduler");
    await pollDemoCcu();

    // Steam peak overlay: only the tracked charting appid stored.
    let peaks = db.prepare("SELECT * FROM demo_ccu_steam_peaks ORDER BY steam_app_id").all();
    assert.deepEqual(peaks.map((p: any) => p.steam_app_id), ["1001"], "untracked charting appid ignored");
    assert.equal(peaks[0].peak_ccu, 5000);
    assert.equal(peaks[0].global_rank, 5);

    // Batched sweep wrote fresh samples for both demos (per-response stamps).
    const fresh = db.prepare(
      `SELECT t.steam_app_id, s.ccu, s.captured_at FROM demo_ccu_snapshots s JOIN demo_titles t ON t.id=s.demo_title_id WHERE s.captured_at >= ?`
    ).all(stamp) as Array<{ steam_app_id: string; ccu: number; captured_at: string }>;
    const freshByApp = new Map(fresh.map(r => [r.steam_app_id, r]));
    assert.equal(freshByApp.get("1001")?.ccu, 4321);
    assert.equal(freshByApp.get("1002")?.ccu, 17);
    assert.ok(Date.parse(freshByApp.get("1001")!.captured_at) >= Date.parse(stamp), "per-response timestamp at or after sweep start");

    // The friends-pass SKU got no snapshot and no zero.
    const passRows = db.prepare(
      `SELECT COUNT(*) n FROM demo_ccu_snapshots s JOIN demo_titles t ON t.id=s.demo_title_id WHERE t.steam_app_id='1003'`
    ).get() as any;
    assert.equal(passRows.n, 0, "404 pass SKU must not produce a snapshot or a zero");

    // Lossless compaction: the OLDER ancient snapshot is pruned, the NEWER
    // one is kept as demo 1's last-good sample, rollups cover both days,
    // and the daily peaks survive.
    const ancient = db.prepare(
      `SELECT captured_at FROM demo_ccu_snapshots WHERE demo_title_id=1 AND captured_at < '2021-01-01' ORDER BY captured_at`
    ).all() as Array<{ captured_at: string }>;
    assert.deepEqual(ancient.map(r => r.captured_at.slice(0, 10)), ["2020-01-02"], "older raw snapshot pruned, newest ancient snapshot kept as last-good");
    const rollups = db.prepare(
      `SELECT rollup_date, latest_ccu, sample_count, max_ccu FROM demo_ccu_daily_rollups WHERE demo_title_id=1 ORDER BY rollup_date`
    ).all() as Array<any>;
    assert.deepEqual(rollups.map(r => r.rollup_date), ["2020-01-01", "2020-01-02"], "per-day rollups written before pruning");
    assert.equal(rollups[0].latest_ccu, 123);
    assert.equal(rollups[1].latest_ccu, 130);
    assert.equal(rollups[1].max_ccu, 130);
    const oldPeaks = db.prepare(
      `SELECT COUNT(*) n FROM demo_ccu_daily_peaks WHERE demo_title_id=1 AND peak_date LIKE '2020-01%'`
    ).get() as any;
    assert.equal(oldPeaks.n, 2, "daily peaks survive snapshot pruning");

    // History survives compaction: the 2020-01-01 point is fully rebuilt
    // from its rollup (raw snapshot pruned) and keeps the daily peak.
    const { loadDemoHistory } = await import("./history");
    const title = db.prepare("SELECT * FROM demo_titles WHERE steam_app_id='1001'").get();
    const history = loadDemoHistory(db, title, "all");
    const day1 = history.rows.find((r: any) => r.date === "2020-01-01");
    assert.ok(day1, "rollup day present in history");
    assert.equal(day1.ccuLatest, 123, "latest sample rebuilt from rollup");
    assert.equal(day1.ccuSamples, 1, "sample count rebuilt from rollup");
    assert.equal(day1.ccuPeak, 123, "daily peak preserved");

    // Sweep-completion state recorded (boot catch-up reads this).
    const state = db.prepare("SELECT last_sweep_completed_at FROM demo_ccu_poll_state WHERE id=1").get() as any;
    assert.ok(state && Date.parse(state.last_sweep_completed_at) >= Date.parse(stamp), "sweep completion state written");

    // Daily peak upsert took the fresh sweep sample.
    const todayPeak = db.prepare(
      `SELECT peak_ccu FROM demo_ccu_daily_peaks WHERE demo_title_id=1 AND peak_date=?`
    ).get(today) as any;
    assert.ok(todayPeak && todayPeak.peak_ccu >= 4321, "daily peak upserted from the sweep");

    // Chart departure: a successful refresh that omits 1001 removes its
    // overlay row immediately (it never shows a stale rank as current).
    charting.length = 0; // 9999 only, untracked
    charting.push(["9999", 6, 4000, 6000]);
    await pollDemoCcu();
    peaks = db.prepare("SELECT * FROM demo_ccu_steam_peaks").all();
    assert.equal(peaks.length, 0, "departed appid removed from the overlay");
  } finally {
    globalThis.fetch = realFetch;
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
