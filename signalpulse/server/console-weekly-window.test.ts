import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

test("weekly API never substitutes monthly sales, including protected anchors and missing signals", async () => {
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), "weekly-window-"));
  process.chdir(dir);
  let db: any, server: any;
  const responses: Record<string, unknown> = {};
  try {
    db = (await import("./storage")).rawSqlite;
    const { registerConsoleLeaderboardRoutes } = await import("./routes-console-leaderboards");
    const stamp = "2026-09-25";
    for (const [id, platform, sku] of [[10113,"steam","2592160"],[10267,"xbox","9NDJSV855T3P"]] as const) {
      db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,msrp_usd_cents,refreshed_at,created_at)
        VALUES(?,?,?,'base','paid',2999,?,?)`).run(id,platform,sku,stamp,stamp);
      db.prepare(`INSERT INTO console_title_igdb(title_id,name,store_name,release_date,store_release_date,refreshed_at,created_at)
        VALUES(?,'Dispatch','Dispatch','2025-10-22','2025-10-22',?,?)`).run(id,stamp,stamp);
    }
    db.prepare("INSERT INTO xbox_title_cache VALUES(?,?,?,?,?,?,1)")
      .run("9NDJSV855T3P","Dispatch",null,"displaycatalog",stamp,stamp);
    const estimates = [
      [10113,"steam","d7",12904,null,321],[10113,"steam","d30",73125,null,1819],
      [10113,"steam","d90",269424,null,6702],[10113,"steam","m12",7175518,null,178493],
      [10113,"steam","ltd",7240965,null,178493],
      [10267,"xbox","d7",null,"signal_too_small",47],[10267,"xbox","d30",49653,null,304],
      [10267,"xbox","d90",88200,null,540],[10267,"xbox","m12",357700,null,2190],
      [10267,"xbox","ltd",357700,null,2173],
    ];
    for (const [id,p,w,units,gate,signal] of estimates) {
      db.prepare(`INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,units_mid,owners_mid,gated_reason,signal_value,method,created_at)
        VALUES(?,?,?,?,?,?,?,?,'fixture',?)`).run(id,p,w,stamp,units,units,gate,signal,stamp);
    }
    const anchor = (id:number,p:string,w:string,rev:number,units:number) =>
      db.prepare(`INSERT INTO revenue_calibration_anchors(title_id,platform,window,as_of_date,actual_revenue_usd,actual_units,
        reference_msrp_usd_cents,sale_state,data_source,created_at) VALUES(?,?,?,?,?,?,2999,'regular','manual_anchor_verified_ltd',?)`)
        .run(id,p,w,stamp,rev,units,stamp);
    anchor(10113,"steam","ltd",50000000,3030000);
    anchor(10267,"xbox","ltd",8000000,320000);
    const before = db.prepare("SELECT * FROM window_estimates_daily ORDER BY id").all();
    const anchorsBefore = db.prepare("SELECT * FROM revenue_calibration_anchors ORDER BY id").all();
    const app = express(); registerConsoleLeaderboardRoutes(app);
    server = app.listen(0,"127.0.0.1");
    await new Promise<void>(r => server.once("listening",r));
    const get = async (path:string) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
      const body:any = await response.json();
      assert.equal(response.status,200,JSON.stringify(body));
      responses[path]=body;
      return body;
    };
    const family = await get("/api/console/multiplatform-title/dispatch?window=d7");
    assert.deepEqual(family.cascade,["d7"]);
    assert.equal(family.perPlatform.xbox.revenueUsd,null);
    assert.equal(family.perPlatform.xbox.unitsMid,null);
    assert.equal(family.perPlatform.xbox.windowUsed,null);
    assert.equal(family.perPlatform.xbox.dataSource,"unavailable");
    assert.equal(family.combinedRevenueUsd,family.perPlatform.steam.revenueUsd);
    assert.equal(family.combinedUnits,null);
    assert.equal(family.revenueSummary.incomplete,true);
    assert.ok(family.revenueSummary.platforms.every((p:any)=>p.sharePct===null));
    const board = await get("/api/console/leaderboards-multiplatform?window=d7");
    assert.equal(board.titles[0].revenueXbox,null);
    assert.equal(board.titles[0].revenueCombined,family.combinedRevenueUsd);
    assert.equal(board.titles[0].revenueIncomplete,true);
    assert.equal(board.revenueSummary.incomplete,true);
    for (const [p,id] of [["steam",10113],["xbox",10267]] as const) {
      const per = await get(`/api/console/leaderboards/${p}?window=d7`);
      assert.deepEqual(per.cascade,["d7"]);
      assert.equal(per.titles[0].revenueMidUsd,family.perPlatform[p].revenueUsd);
      const pdp = await get(`/api/console/titles/${id}?window=d7`);
      assert.equal(pdp.windowKpisPerPlatform[0].revenueMidUsd,family.perPlatform[p].revenueUsd);
      assert.equal(pdp.windowKpisPerPlatform[0].windowUsed,family.perPlatform[p].windowUsed);
    }
    // Exact-period correction must not change the valid wider-window estimates.
    const expected = {d30:1065719.6766005033,d90:1893067.3972602738,m12:7677440,ltd:8000000};
    for (const [window,revenue] of Object.entries(expected)) {
      const f=await get(`/api/console/multiplatform-title/dispatch?window=${window}`);
      assert.ok(Math.abs(f.perPlatform.xbox.revenueUsd-revenue)<.01,window);
      assert.equal(f.perPlatform.xbox.windowUsed,window);
      assert.equal(f.revenueSummary.incomplete,false);
    }
    assert.deepEqual(db.prepare("SELECT * FROM window_estimates_daily ORDER BY id").all(),before);
    assert.deepEqual(db.prepare("SELECT * FROM revenue_calibration_anchors ORDER BY id").all(),anchorsBefore);
    // Save real route outputs, before scenario mutation, for both-client QA.
    if (process.env.WEEKLY_QA_OUTPUT) writeFileSync(process.env.WEEKLY_QA_OUTPUT,JSON.stringify(responses));

    // Missing row behaves like a gated row; same-period verified anchors still win.
    db.prepare("DELETE FROM window_estimates_daily WHERE title_id=10267 AND window='d7'").run();
    assert.equal((await get("/api/console/multiplatform-title/dispatch?window=d7")).perPlatform.xbox.revenueUsd,null);
    anchor(10267,"xbox","d7",12345,500);
    let f=await get("/api/console/multiplatform-title/dispatch?window=d7");
    assert.equal(f.perPlatform.xbox.revenueUsd,12345);
    assert.equal(f.perPlatform.xbox.unitsMid,500);
    assert.equal(f.perPlatform.xbox.windowUsed,"d7");
    db.prepare("DELETE FROM revenue_calibration_anchors WHERE platform='xbox'").run();
    // Existing same-week Steam-ratio model remains valid, labelled as modeled.
    f=await get("/api/console/multiplatform-title/dispatch?window=d7");
    assert.equal(f.perPlatform.xbox.dataSource,"derived_from_steam");
    assert.equal(f.perPlatform.xbox.windowUsed,"d7");
    assert.ok(Math.abs(f.perPlatform.xbox.revenueUsd-f.perPlatform.steam.revenueUsd*.126/.495)<.01);
    // Steam monthly revenue must not leak through the console overlay either.
    db.prepare("UPDATE window_estimates_daily SET units_mid=NULL WHERE window='d7'").run();
    f=await get("/api/console/multiplatform-title/dispatch?window=d7");
    assert.equal(f.perPlatform.steam.revenueUsd,null);
    assert.equal(f.perPlatform.xbox.revenueUsd,null);
    assert.equal(f.revenueSummary.incomplete,true);
    assert.equal((await get("/api/console/leaderboards-multiplatform?window=d7")).titles.length,0);
    // True zero in a requested-window anchor is not "unavailable".
    anchor(10267,"xbox","d7",0,0);
    f=await get("/api/console/multiplatform-title/dispatch?window=d7");
    assert.equal(f.perPlatform.xbox.revenueUsd,0);
    assert.equal(f.perPlatform.xbox.unitsMid,0);
    assert.equal(f.perPlatform.xbox.windowUsed,"d7");
  } finally {
    if(server)await new Promise<void>(r=>server.close(()=>r()));
    db?.close();process.chdir(cwd);rmSync(dir,{recursive:true,force:true});
  }
});
