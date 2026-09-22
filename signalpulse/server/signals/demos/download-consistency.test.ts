import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileDemoDownloads } from "./download-consistency";

const base = {
  window: "ltd" as const, releaseDate: "2026-09-16",
  reviewEstimate: 13493, lifetimeReviewEstimate: 13493,
  method: "review_delta_multiplier", observedPeak: 26222,
  nowMs: Date.parse("2026-09-22T16:30:00Z"),
};

test("observed concurrency is a labeled minimum, never a new multiplier", () => {
  for (const window of ["d7", "d30", "d90", "m12", "ltd"] as const) {
    const r = reconcileDemoDownloads({ ...base, window });
    assert.equal(r.unitsMid, 26222);
    assert.equal(r.reviewEstimate, 13493);
    assert.equal(r.isObservedMinimum, true);
    assert.equal(r.lifetimeModelBelowPeak, true);
    assert.equal(r.method, "observed_ccu_lower_bound");
  }
  const hellraiser = reconcileDemoDownloads({ ...base, reviewEstimate: 101918,
    lifetimeReviewEstimate: 101918, observedPeak: 889 });
  assert.equal(hellraiser.unitsMid, 101918);
  assert.equal(hellraiser.isObservedMinimum, false);
});

test("returning players never create partial-window downloads", () => {
  for (const window of ["d7", "d30", "d90", "m12"] as const) {
    const r = reconcileDemoDownloads({ ...base, window, releaseDate: "2021-09-17", reviewEstimate: 0 });
    assert.equal(r.unitsMid, 0);
    assert.equal(r.isObservedMinimum, false);
    assert.equal(r.lifetimeModelBelowPeak, true);
  }
  for (const releaseDate of [null, "invalid", "2027-01-01", "2026-09-15"]) {
    assert.equal(reconcileDemoDownloads({ ...base, window: "d7", releaseDate }).isObservedMinimum, false);
  }
  for (const observedPeak of [null, 0, -1, NaN, Infinity]) {
    assert.equal(reconcileDemoDownloads({ ...base, observedPeak }).unitsMid, 13493);
  }
  assert.equal(reconcileDemoDownloads({ ...base, method: "steamworks_actual" }).unitsMid, 13493);
  const missing = reconcileDemoDownloads({ ...base, reviewEstimate: null, lifetimeReviewEstimate: null });
  assert.equal(missing.unitsMid, 26222);
  assert.equal(missing.isObservedMinimum, true);
  assert.equal(reconcileDemoDownloads({ ...base, reviewEstimate: 26222 }).isObservedMinimum, false);
});

test("real API reconciles before sort and limit, preserves raw estimates and source ranks", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "demo-download-consistency-"));
  process.chdir(dir);
  let db: any;
  let server: any;
  try {
    db = (await import("../../storage")).rawSqlite;
    const { default: express } = await import("express");
    const { registerDemosLeaderboardRoutes } = await import("../../routes-demos-leaderboard");
    const app = express();
    registerDemosLeaderboardRoutes(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/demos/leaderboard`;
    const today = new Date().toISOString().slice(0, 10);
    for (const [id, units, peak] of [[1, 13493, 26222], [2, 20000, 500], [3, 197, 387]]) {
      db.prepare(`INSERT INTO demo_titles(id,steam_app_id,name,genre,release_date,discovered_via,is_active,first_seen_at,created_at,updated_at)
        VALUES(?,?,?,'Casual',?,'test',1,?,?,?)`).run(id, String(id), `Demo ${id}`, id === 3 ? "2021-09-17" : today, today, today, today);
      for (const window of ["d7", "d30", "d90", "m12", "ltd"]) {
        db.prepare(`INSERT INTO demo_window_estimates_daily(demo_title_id,window,as_of_date,units_mid,units_low,units_high,method,created_at)
          VALUES(?,?,?,?,30,100,'review_delta_multiplier',?)`).run(id, window, today, units, today);
      }
      // Latest sample alone must suffice; a delayed daily-peak writer is safe.
      db.prepare("INSERT INTO demo_ccu_snapshots(demo_title_id,captured_at,ccu) VALUES(?,?,?)").run(id, today, peak);
      db.prepare("INSERT INTO demo_discovery_ranks(feed,demo_title_id,source_rank) VALUES('top',?,?)").run(id, 4-id);
    }
    for (const window of ["d7", "d30", "d90", "m12", "ltd"]) {
      const data = await (await fetch(`${url}?window=${window}&limit=1`)).json();
      assert.equal(data.demos[0].id, 1);
      assert.equal(data.demos[0].unitsMid, 26222);
      assert.equal(data.demos[0].reviewEstimate, 13493);
      assert.equal(data.demos[0].unitsHigh, null);
      assert.equal(data.demos[0].method, "observed_ccu_lower_bound");
      assert.equal(data.calibration.reportingCutoff, null);
    }
    const short = await (await fetch(`${url}?window=d7&sort=downloads&direction=asc&genre=Casual`)).json();
    assert.deepEqual(short.demos.map((d: any) => d.id), [3, 2, 1]);
    assert.equal(short.demos[0].unitsMid, 197);
    assert.equal(short.demos[0].lifetimeModelBelowPeak, true);
    const ltd = await (await fetch(`${url}?window=ltd&sort=top`)).json();
    assert.deepEqual(ltd.demos.map((d: any) => d.id), [3, 2, 1]);
    assert.equal(ltd.demos[0].unitsMid, 387);
    assert.equal(db.prepare("SELECT units_mid FROM demo_window_estimates_daily WHERE demo_title_id=1 LIMIT 1").get().units_mid, 13493);
  } finally {
    if (server) await new Promise<void>(resolve => server.close(resolve));
    db?.close();
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
