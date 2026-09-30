import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

// A reset twin: same rating history, LTD units halved across the gap (ratio 20 -> 10 units per rating).
test("route: rebased gap is valued at the post-reset ratio, protected twin unchanged", async () => {
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), "gap-rebase-routes-"));
  process.chdir(dir);
  let server: any, db: any;
  const fetchOriginal = globalThis.fetch;
  try {
    db = (await import("./storage")).rawSqlite;
    const { registerConsoleLeaderboardRoutes } = await import("./routes-console-leaderboards");
    const stamp = new Date().toISOString();
    const M = "calibrated_from_actuals_v1+ltd_state:derived_max_windows";
    const ratings: Record<string, number> = { "2026-09-22": 300, "2026-09-23": 400, "2026-09-24": 450, "2026-09-25": 600, "2026-09-26": 700 };
    // Sep 23 at ratio 20 (8000), then reset to ratio 10: Sep 25 = 6000, Sep 26 = 7000.
    const ltd: Array<[string, number]> = [["2026-09-22", 6000], ["2026-09-23", 8000], ["2026-09-25", 6000], ["2026-09-26", 7000]];
    for (const id of [49993, 49994]) {
      db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,msrp_usd_cents,refreshed_at,created_at)
        VALUES(?,'steam',?,'base','paid',6000,?,?)`).run(id, String(id), stamp, stamp);
      db.prepare(`INSERT INTO console_title_igdb(title_id,name,store_name,release_date,store_release_date,refreshed_at,created_at)
        VALUES(?,?,?,'2020-01-01','2020-01-01',?,?)`).run(id, `Rebase Route ${id}`, `Rebase Route ${id}`, stamp, stamp);
      for (const [day, n] of Object.entries(ratings)) db.prepare(`INSERT INTO store_rating_signal_daily(title_id,platform,capture_date,source_endpoint,rating_count,window_label,created_at)
        VALUES(?,'steam',?,'qa',?,'ltd',?)`).run(id, day, n, stamp);
      for (const [day, u] of ltd) db.prepare(`INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,units_mid,signal_value,method,created_at)
        VALUES(?,'steam','ltd',?,?,?,?,?)`).run(id, day, u, ratings[day], M, stamp);
    }
    db.prepare(`INSERT INTO title_multiplier_overrides(title_id,platform,multiplier,ci_pct,digital_unit_share,confidence,method,effective_from,created_at) VALUES(49994,'steam',10,10,1,'high','public_report','2026-09-01',?)`).run(stamp);
    const app = express(); registerConsoleLeaderboardRoutes(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const get = async (path: string) => {
      const r = await fetchOriginal(`http://127.0.0.1:${server.address().port}${path}`);
      const body = await r.json(); assert.equal(r.status, 200, JSON.stringify(body)); return body as any;
    };
    const q = "?from=2026-09-22&to=2026-09-26";
    const at = (b: any, d: string) => b.points.find((p: any) => p.date === d);
    const plain = await get(`/api/console/titles/49993/revenue-daily${q}`);
    // Total: (600-400) ratings * 10 = 2000 units; split 50 : 150 by the daily rating gains.
    assert.equal(Math.round(at(plain, "2026-09-24").steam), Math.round(500 * 39.6));
    assert.equal(Math.round(at(plain, "2026-09-25").steam), Math.round(1500 * 39.6));
    assert.equal(at(plain, "2026-09-25").allocation.steam, "rebased_gap:own_ratings");
    assert.equal(Math.round(at(plain, "2026-09-26").steam), Math.round(1000 * 39.6));
    assert.equal(at(plain, "2026-09-23").steam, 79200);
    assert.match(plain.methodology, /post-reset ratio/);
    const prot = await get(`/api/console/titles/49994/revenue-daily${q}`);
    assert.equal(at(prot, "2026-09-24").steam, null);
    assert.equal(at(prot, "2026-09-25").steam, null);
  } finally {
    globalThis.fetch = fetchOriginal;
    if (server) await new Promise<void>((resolve, reject) => server.close((e: any) => e ? reject(e) : resolve()));
    db?.close(); process.chdir(cwd); rmSync(dir, { recursive: true, force: true });
  }
});
