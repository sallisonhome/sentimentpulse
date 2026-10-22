import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

test("public demos read endpoints serve an allowlisted, window-scoped board and private routes stay authenticated", async () => {
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), "demos-public-"));
  process.chdir(dir);
  process.env.AUTH_MODE = "saber";
  process.env.SABER_AUTH_JWT_SECRET = "test-secret";
  const fetchOriginal = globalThis.fetch;
  let server: any, db: any;
  try {
    db = (await import("./storage")).rawSqlite;
    const { createSaberAuthMiddleware } = await import("./saber-auth");
    const { registerDemosPublicRoutes } = await import("./routes-demos-public");
    const { registerDemosLeaderboardRoutes } = await import("./routes-demos-leaderboard");
    const { registerDemoDetailRoutes } = await import("./routes-demo-detail");

    const stamp = new Date().toISOString();
    const today = stamp.slice(0, 10);
    const day = (offsetDays: number) =>
      new Date(Date.now() - offsetDays * 86400_000).toISOString().slice(0, 10);

    const ins = db.prepare(`INSERT INTO demo_titles(id,steam_app_id,name,is_saber_published,genre,release_date,
      discovered_via,is_active,first_seen_at,last_checked_at,created_at,updated_at,sku_kind,availability_source,tracking_excluded_reason)
      VALUES(?,?,?,?,?,?, 'test',?,?,?,?,?,'demo','steam_demo',NULL)`);
    ins.run(1, "111001", "Saber Demo One", 1, "Action, RPG", "2026-09-01", 1, stamp, stamp, stamp, stamp);
    ins.run(2, "222002", "Indie Demo Two", 0, "Adventure", "2026-10-01", 1, stamp, stamp, stamp, stamp);
    ins.run(3, "333003", "Retired Demo Three", 1, "Action", "2026-01-01", 0, stamp, stamp, stamp, stamp);
    db.prepare("UPDATE demo_titles SET deactivated_at=? WHERE id=3").run(stamp);
    ins.run(5, "555005", "Volume Demo Five", 0, "Adventure", "2026-08-01", 1, stamp, stamp, stamp, stamp);
    db.prepare(`INSERT INTO demo_titles(id,steam_app_id,name,is_saber_published,genre,release_date,
      discovered_via,is_active,first_seen_at,last_checked_at,created_at,updated_at,sku_kind)
      VALUES(4,'444004','Friends Pass Four',1,NULL,NULL,'test',1,?,?,?,?,'friends_pass')`).run(stamp, stamp, stamp, stamp);

    // Saber actuals (Steamworks report) for windows d7/d30/ltd.
    const actuals = db.prepare(`INSERT INTO demo_download_actuals(steam_app_id,window,downloads,report_start_date,
      report_end_date,fetched_at,source,last_attempt_at) VALUES(?,?,?,?,?,?, 'steamworks_downloads_report',?)`);
    actuals.run("111001", "d7", 12_000, day(7), today, stamp, stamp);
    actuals.run("111001", "d30", 40_000, day(30), today, stamp, stamp);
    actuals.run("111001", "ltd", 250_000, "2026-09-01", today, stamp, stamp);
    // Retired demo keeps an ltd actual only.
    actuals.run("333003", "ltd", 99_000, "2026-01-01", today, stamp, stamp);

    // Non-Saber review-delta estimates.
    const est = db.prepare(`INSERT INTO demo_window_estimates_daily(demo_title_id,window,as_of_date,
      review_count_total,review_delta,units_low,units_mid,units_high,multiplier_id,method,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,'review_delta_multiplier',?)`);
    est.run(2, "d7", today, 300, 40, null, 5_200, null, "trial_v1", stamp);
    est.run(2, "d30", today, 300, 120, null, 15_600, null, "trial_v1", stamp);
    est.run(2, "ltd", today, 300, 300, null, 39_000, null, "trial_v1", stamp);
    est.run(5, "d7", today, 900, 90, null, 11_700, null, "trial_v1", stamp);
    est.run(5, "d30", today, 900, 260, null, 33_800, null, "trial_v1", stamp);
    est.run(5, "ltd", today, 900, 900, null, 117_000, null, "trial_v1", stamp);

    // Review summaries (day buckets).
    const reviews = db.prepare(`INSERT INTO steam_review_history(app_id,bucket_start,bucket_granularity,
      recommendations_up,recommendations_down,source_endpoint,created_at) VALUES(?,?,'day',?,?,'test',?)`);
    // Daily summaries require coverage_start <= release_date (see
    // loadDemoReviewSummaries), so bucket from just after each release.
    const bucket = (releaseDate: string) => Math.floor(Date.parse(`${releaseDate}T00:00:00Z`) / 1000);
    reviews.run("222002", bucket("2026-10-01"), 260, 40, stamp);
    reviews.run("555005", bucket("2026-08-01"), 820, 80, stamp);
    reviews.run("111001", bucket("2026-09-01"), 900, 100, stamp);

    // CCU: demo 1 has an in-window snapshot (600) plus a daily peak inside
    // d7 (500) and an older peak (900) that only d30+ sees. Demo 2 and 5 tie
    // at 300 inside d7 so the tie-break (name, then id) is exercised.
    const peaks = db.prepare(`INSERT INTO demo_ccu_daily_peaks(demo_title_id,peak_date,peak_ccu,created_at)
      VALUES(?,?,?,?)`);
    peaks.run(1, day(6), 500, stamp);
    peaks.run(1, day(25), 900, stamp);
    peaks.run(2, day(3), 300, stamp);
    peaks.run(5, day(2), 300, stamp);
    peaks.run(3, day(40), 700, stamp);
    const snaps = db.prepare(`INSERT INTO demo_ccu_snapshots(demo_title_id,captured_at,ccu) VALUES(?,?,?)`);
    snaps.run(1, new Date(Date.now() - 3600_000).toISOString(), 600);
    snaps.run(1, day(25) + "T12:00:00.000Z", 800);
    snaps.run(3, day(40) + "T12:00:00.000Z", 700);

    // Steam discovery feed for the top view (demo 1 and 2 only — retired 3
    // is filtered from top/new availability).
    const ranks = db.prepare(`INSERT INTO demo_discovery_ranks(feed,demo_title_id,source_rank) VALUES('top',?,?)`);
    ranks.run(1, 1);
    ranks.run(2, 2);

    // 100 filler demos so the top-100 slice and cap are exercised.
    const filler = db.prepare(`INSERT INTO demo_titles(id,steam_app_id,name,is_saber_published,genre,release_date,
      discovered_via,is_active,first_seen_at,last_checked_at,created_at,updated_at,sku_kind)
      VALUES(?,?,'Filler Demo',0,'Action','2026-07-01','test',1,?,?,?,?,'demo')`);
    for (let i = 10; i < 115; i++) {
      filler.run(i, String(900000 + i), stamp, stamp, stamp, stamp);
      est.run(i, "d7", today, 10, 1, null, 100 + i, null, "trial_v1", stamp);
    }

    db.prepare(`CREATE TABLE IF NOT EXISTS demo_media_cache (steam_app_id TEXT PRIMARY KEY, payload TEXT,
      fetched_at TEXT, last_attempt_at TEXT, status TEXT)`).run();
    db.prepare(`INSERT INTO demo_media_cache VALUES(?,?,?,?,?)`)
      .run("111001", JSON.stringify({ header: "https://example.test/header.jpg" }), stamp, stamp, "matched");

    const auth = createSaberAuthMiddleware();
    const app = express();
    app.use(auth.middleware);
    registerDemosLeaderboardRoutes(app);
    registerDemoDetailRoutes(app);
    registerDemosPublicRoutes(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (path: string) => {
      const r = await fetchOriginal(`${base}${path}`);
      return { status: r.status, body: await r.json().catch(() => null) as any };
    };

    // Private demo routes stay authenticated; public prefix is exempt.
    assert.equal((await get("/api/demos/leaderboard")).status, 401);
    assert.equal((await get("/api/demos/titles/111001")).status, 401);

    const board = await get("/api/demos/public/leaderboard?window=d7");
    assert.equal(board.status, 200);
    assert.equal(board.body.scope, "steam-demos");
    // Top-100 cap applied over the complete filtered catalog.
    assert.equal(board.body.demos.length, 100);
    assert.ok(board.body.demos.every((d: any, i: number) => d.rank === i + 1));
    const byApp = new Map(board.body.demos.map((d: any) => [d.steamAppId, d]));
    // Friends Pass excluded; the row set is Steam demos only.
    assert.ok(!byApp.has("444004"));
    const saber = byApp.get("111001");
    assert.ok(saber, "Saber demo in top 100");
    // Explicit allowlist: no licenses, no estimate internals, no pass data.
    const allowed = new Set(["steamAppId", "name", "genre", "releaseDate", "releaseDateUnverified",
      "isSaberPublished", "isArchived", "retiredAt", "downloads", "reviews", "ccu", "sourceRank", "rank"]);
    assert.deepEqual(Object.keys(saber).sort(), [...allowed].sort());
    assert.deepEqual(Object.keys(saber.downloads).sort(), ["asOf", "isSaberActual", "observedMinimum", "stale", "value"]);
    assert.deepEqual(Object.keys(saber.ccu).sort(), ["asOf", "current", "peakAllTime", "peakWindow"]);
    assert.equal(saber.downloads.value, 12_000);
    assert.equal(saber.downloads.isSaberActual, true);
    // Window-scoped peak: max of the in-window snapshot (600) and daily
    // peak (500); the 25-day-old peak (900) is outside d7.
    assert.equal(saber.ccu.peakWindow, 600);
    assert.equal(saber.ccu.peakAllTime, 900);
    assert.equal(saber.reviews.total, 1000);
    // Downloads ranking over the full catalog: Volume (11,700) above Indie (5,200).
    assert.ok(byApp.get("555005").rank < byApp.get("222002").rank);

    // d30 peak widens to include the 25-day-old observations.
    const d30 = await get("/api/demos/public/leaderboard?window=d30&sort=peak&direction=desc");
    assert.equal(d30.status, 200);
    assert.equal(d30.body.demos.find((d: any) => d.steamAppId === "111001").ccu.peakWindow, 900);
    // Deterministic tie-break: Indie Demo Two and Volume Demo Five tie at
    // 300 inside d7 — name order decides.
    const peakBoard = await get("/api/demos/public/leaderboard?window=d7&sort=peak&direction=desc");
    const peakRows = peakBoard.body.demos.filter((d: any) => ["222002", "555005"].includes(d.steamAppId));
    assert.equal(peakRows[0].name, "Indie Demo Two");
    assert.equal(peakRows[1].name, "Volume Demo Five");

    // ltd window peak equals the all-time observed peak.
    const ltd = await get("/api/demos/public/leaderboard?window=ltd&sort=downloads&direction=desc");
    const ltdRow = ltd.body.demos.find((d: any) => d.steamAppId === "111001");
    assert.equal(ltdRow.ccu.peakWindow, ltdRow.ccu.peakAllTime);
    assert.equal(ltdRow.downloads.value, 250_000);
    // Retired demos stay in metric views, marked.
    const retired = ltd.body.demos.find((d: any) => d.steamAppId === "333003");
    assert.ok(retired, "retired demo stays in metric views");
    assert.equal(retired.isArchived, true);
    assert.ok(retired.retiredAt);
    // top view is availability-based: retired excluded.
    const top = await get("/api/demos/public/leaderboard?window=d7&sort=top");
    assert.ok(!top.body.demos.some((d: any) => d.steamAppId === "333003"));
    assert.equal(top.body.demos[0].steamAppId, "111001");

    // Validation: limit cap, window, sort, genre.
    assert.equal((await get("/api/demos/public/leaderboard?limit=500")).status, 400);
    assert.equal((await get("/api/demos/public/leaderboard?window=bad")).status, 400);
    assert.equal((await get("/api/demos/public/leaderboard?sort=players")).status, 400);
    assert.equal((await get("/api/demos/public/leaderboard?genre=Nope")).status, 400);
    const genreBoard = await get("/api/demos/public/leaderboard?genre=Adventure");
    assert.ok(genreBoard.body.demos.every((d: any) => (d.genre ?? "").includes("Adventure")));

    // PDP: public allowlist of DemoDetail (no historyCoverage jobs/checks),
    // friends-pass identity rejected, bad appid shape rejected.
    const pdp = await get("/api/demos/public/titles/111001?days=7");
    assert.equal(pdp.status, 200);
    assert.equal(pdp.body.appId, "111001");
    assert.ok(!pdp.body.historyCoverage.jobs);
    assert.ok(!pdp.body.historyCoverage.checks);
    assert.ok(Array.isArray(pdp.body.rows));
    assert.ok(Array.isArray(pdp.body.latestWindows));
    assert.equal(pdp.body.latest.downloads, 250_000);
    const pdpNonSaber = await get("/api/demos/public/titles/222002?days=30");
    assert.equal(pdpNonSaber.status, 200);
    assert.equal(pdpNonSaber.body.multiplier, 130);
    assert.equal((await get("/api/demos/public/titles/444004")).status, 404);
    assert.equal((await get("/api/demos/public/titles/notanappid")).status, 404);
    assert.equal((await get("/api/demos/public/titles/111001?days=13")).status, 400);

    // Media route serves from cache without an upstream call.
    const media = await get("/api/demos/public/titles/111001/media");
    assert.equal(media.status, 200);
    assert.equal(media.body.media.header, "https://example.test/header.jpg");
    assert.equal(media.body.status, "matched");
  } finally {
    if (server) server.close();
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    delete process.env.AUTH_MODE;
    delete process.env.SABER_AUTH_JWT_SECRET;
  }
});
