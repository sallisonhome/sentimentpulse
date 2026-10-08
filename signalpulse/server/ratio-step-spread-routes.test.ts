import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

// Multiplier refit: units per rating 20 -> 30 on 2026-10-06. Scoped family spreads the restatement over its earlier days;
// an identical title outside the scope keeps the legacy series (global behaviour unchanged).
test("route: ratio step is spread over earlier days for scoped families only, total conserved", async () => {
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), "ratio-step-routes-"));
  process.chdir(dir);
  let server: any, db: any;
  const fetchOriginal = globalThis.fetch;
  try {
    db = (await import("./storage")).rawSqlite;
    const { registerConsoleLeaderboardRoutes } = await import("./routes-console-leaderboards");
    const stamp = new Date().toISOString();
    const M = "calibrated_from_actuals_v1+steam_histogram_nonoverlap_v1";
    const ratings: Record<string, number> = { "2026-10-02": 1000, "2026-10-03": 1100, "2026-10-04": 1200, "2026-10-05": 1300, "2026-10-06": 1400, "2026-10-07": 1500 };
    const ltd: Record<string, number> = { "2026-10-02": 20000, "2026-10-03": 22000, "2026-10-04": 24000, "2026-10-05": 26000, "2026-10-06": 42000, "2026-10-07": 45000 };
    const ids: Array<[number, string]> = [[49981, "Control Resonant"], [49982, "Unscoped Step Title"]];
    for (const [id, name] of ids) {
      db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,msrp_usd_cents,refreshed_at,created_at)
        VALUES(?,'steam',?,'base','paid',6000,?,?)`).run(id, String(id), stamp, stamp);
      db.prepare(`INSERT INTO console_title_igdb(title_id,name,store_name,release_date,store_release_date,refreshed_at,created_at)
        VALUES(?,?,?,'2020-01-01','2020-01-01',?,?)`).run(id, name, name, stamp, stamp);
      for (const [day, n] of Object.entries(ratings)) db.prepare(`INSERT INTO store_rating_signal_daily(title_id,platform,capture_date,source_endpoint,rating_count,window_label,created_at)
        VALUES(?,'steam',?,'qa',?,'ltd',?)`).run(id, day, n, stamp);
      for (const [day, u] of Object.entries(ltd)) db.prepare(`INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,units_mid,signal_value,method,created_at)
        VALUES(?,'steam','ltd',?,?,?,?,?)`).run(id, day, u, ratings[day], M, stamp);
    }
    const app = express(); registerConsoleLeaderboardRoutes(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const get = async (path: string) => {
      const r = await fetchOriginal(`http://127.0.0.1:${server.address().port}${path}`);
      const body = await r.json(); assert.equal(r.status, 200, JSON.stringify(body)); return body as any;
    };
    const q = "?from=2026-10-03&to=2026-10-07";
    const at = (b: any, d: string) => b.points.find((p: any) => p.date === d).steam as number;
    const scoped = await get(`/api/console/titles/49981/revenue-daily${q}`);
    const plain = await get(`/api/console/titles/49982/revenue-daily${q}`);
    const unit = 60 * 0.66; // msrp dollars x steam ASP factor
    // Legacy: the step day carries the whole 16,000-unit jump.
    assert.equal(Math.round(at(plain, "2026-10-06")), Math.round(16000 * unit));
    // Scoped: the step day is only its own 100 ratings at the new ratio (3,000 units).
    assert.equal(Math.round(at(scoped, "2026-10-06")), Math.round(3000 * unit));
    // The 13,000 restated units are spread over Sep 23-25 (equal days, so equal shares: +4,333.33 units each).
    for (const d of ["2026-10-03", "2026-10-04", "2026-10-05"]) assert.equal(Math.round(at(scoped, d)), Math.round((2000 + 13000 / 3) * unit));
    assert.equal(Math.round(at(scoped, "2026-10-07")), Math.round(3000 * unit));
    // Total conserved across the window.
    const sum = (b: any) => ["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"].reduce((s, d) => s + at(b, d), 0);
    assert.ok(Math.abs(sum(scoped) - sum(plain)) < 1);
    // Cutoff invariance: ending the query on the step day gives the same series.
    const cut = await get(`/api/console/titles/49981/revenue-daily?from=2026-10-03&to=2026-10-06`);
    for (const d of ["2026-10-03", "2026-10-05", "2026-10-06"]) assert.equal(Math.round(at(cut, d)), Math.round(at(scoped, d)));
  } finally {
    globalThis.fetch = fetchOriginal;
    if (server) await new Promise<void>((resolve, reject) => server.close((e: any) => e ? reject(e) : resolve()));
    db?.close(); process.chdir(cwd); rmSync(dir, { recursive: true, force: true });
  }
});

