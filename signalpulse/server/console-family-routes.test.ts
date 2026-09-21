import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

// Real Express routes and migrated SQLite schema, isolated from developer data.
// This reproduces the production identity split, null confidence, poisoned Xbox
// seed, regional PS5 duplication and the actual 2026-09-21 window quantities.
test("No Man's Sky family reconciles every platform and window without update or region duplication", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "console-family-"));
  process.chdir(dir);
  const realFetch = globalThis.fetch;
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  let db: any;
  try {
    const { rawSqlite } = await import("./storage");
    db = rawSqlite;
    const { registerConsoleLeaderboardRoutes } = await import("./routes-console-leaderboards");
    const stamp = "2026-09-21";
    const name = "No Man's Sky";
    const child = "No Man's Sky: Worlds Part II";
    for (const [id, platform, sku, price] of [
      [10005, "steam", "275850", 5999],
      [10350, "ps5", "EP2034-PPSA01412_00-NOMANSSKYHG00001", null],
      [10350, "ps5", "UP2034-PPSA02110_00-NOMANSSKYHG00001", 5999],
      [10438, "xbox", "BQVQTL3PCH05", 5999],
    ]) {
      db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,msrp_usd_cents,refreshed_at,created_at)
        VALUES(?,?,?,'base','paid',?,?,?)`).run(id,platform,sku,price,stamp,stamp);
    }
    for (const [id, storeName, release] of [
      [10005, name, "2016-08-12"], [10350, `${name} PS4 & PS5`, "2020-11-12"], [10438, name, "2018-07-24"],
    ]) {
      db.prepare(`INSERT INTO console_title_igdb(title_id,name,store_name,igdb_id,summary,release_date,store_release_date,refreshed_at,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id,id===10350?storeName:child,storeName,id===10350?null:329714,"Update 5.50",
          id===10350?release:"2025-01-29",release,stamp,stamp);
    }
    db.prepare(`INSERT INTO xbox_title_cache VALUES(?,?,?,?,?,?,1)`)
      .run("BQVQTL3PCH05",child,"https://example.test/wrong-update-cover.jpg","seeded_from_cti",stamp,stamp);
    const quantities: Record<string, number[]> = {
      d7: [53909,13200,23847], d30: [333142,62053,72030], d90: [494105,186158,263130],
      m12: [1661489,754989,1067057], ltd: [13290827,3787202,5851580],
    };
    const titles = [10005,10350,10438], platforms = ["steam","ps5","xbox"];
    for (let i=0;i<3;i++) {
      db.prepare(`INSERT INTO store_rating_signal_daily(title_id,platform,capture_date,source_endpoint,rating_count,avg_rating,window_label,created_at)
        VALUES(?,?,?,'fixture',100000,4.5,'ltd',?)`).run(titles[i],platforms[i],stamp,stamp);
    }
    for (const [window, units] of Object.entries(quantities)) {
      for (let i=0;i<3;i++) {
        db.prepare(`INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,units_mid,owners_mid,method,created_at)
          VALUES(?,?,?,?,?,?,'review_velocity',?)`).run(titles[i],platforms[i],window,stamp,units[i],units[i],stamp);
      }
    }
    const before = db.prepare("SELECT * FROM window_estimates_daily ORDER BY id").all();
    globalThis.fetch = async (input, init) => {
      if (String(input).includes("api.steampowered.com")) return new Response(JSON.stringify({
        response: {store_items:[{appid:275850,success:1,assets:{library_capsule_2x:"verified/library_capsule_2x.jpg"}}]},
      }), {status:200});
      return realFetch(input, init);
    };
    const app = express();
    registerConsoleLeaderboardRoutes(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server!.once("listening", resolve));
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    const get = async (path: string) => {
      const response = await realFetch(origin + path);
      const body = await response.json();
      assert.equal(response.status,200,JSON.stringify(body));
      return body as any;
    };
    for (const [window, units] of Object.entries(quantities)) {
      const family = await get(`/api/console/multiplatform-title/${encodeURIComponent("no man's sky")}?window=${window}`);
      assert.equal(family.name,name);
      assert.equal(family.releaseDate,"2016-08-12");
      assert.equal(family.summary,null);
      assert.deepEqual(family.platforms,platforms);
      assert.equal(family.skus.length,3);
      assert.equal(family.combinedUnits,Object.values(family.perPlatform).reduce((a:number,b:any)=>a+b.unitsMid,0));
      for (let i=0;i<3;i++) {
        const p = family.perPlatform[platforms[i]];
        assert.equal(p.unitsMid,Math.round(p.revenueUsd*100/p.aspUsdCents));
        assert.equal(p.unitsMidEstimated,units[i]);
        assert.equal(family.perPlatform[platforms[i]].windowUsed,window);
      }
      const steamRevenue=units[0]*5999*0.66/100;
      assert.ok(Math.abs(family.combinedRevenueUsd-steamRevenue/0.495)<0.01);
      assert.ok(Math.abs(family.revenueSummary.platforms.reduce((sum:number,p:any)=>sum+p.sharePct,0)-100)<0.01);
      const board = await get(`/api/console/leaderboards-multiplatform?window=${window}`);
      const row = board.titles.find((r:any)=>r.editionGroupKey==="no man's sky");
      assert.ok(row,JSON.stringify(board));
      assert.deepEqual(row.platforms,platforms);
      assert.equal(row.revenueCombined,family.combinedRevenueUsd);
      assert.ok(!board.titles.some((r:any)=>r.name.includes("Worlds Part")));
      for (const platform of platforms) {
        const per = await get(`/api/console/leaderboards/${platform}?window=${window}`);
        const r = per.titles.find((r:any)=>r.editionGroupKey==="no man's sky");
        assert.ok(r,JSON.stringify(per));
        assert.ok(Math.abs(r.revenueMidUsd-family.perPlatform[platform].revenueUsd)<0.01);
        assert.equal(r.unitsMid,family.perPlatform[platform].unitsMid);
        const detail = await get(`/api/console/titles/${r.titleId}?window=${window}`);
        const kpi = detail.windowKpisPerPlatform.find((p:any)=>p.platform===platform);
        assert.equal(kpi.revenueMidUsd,r.revenueMidUsd);
        assert.equal(kpi.unitsMid,r.unitsMid);
      }
    }
    for (const id of titles) {
      const pdp = await get(`/api/console/titles/${id}?window=d7`);
      assert.ok(!JSON.stringify([pdp.igdb?.name,pdp.xboxTitle?.name]).includes("Worlds Part"));
      assert.ok(pdp.portraitCandidates[0]?.includes("/275850/"));
    }
    assert.deepEqual(db.prepare("SELECT * FROM window_estimates_daily ORDER BY id").all(),before);
    const anchor = (id:number, platform:string, window:string, revenue:number, units:number|null, source:string) =>
      db.prepare(`INSERT OR REPLACE INTO revenue_calibration_anchors
        (title_id,platform,window,as_of_date,actual_revenue_usd,actual_units,reference_msrp_usd_cents,sale_state,data_source,created_at)
        VALUES(?,?,?,?,?,?,5999,'regular',?,?)`).run(id,platform,window,stamp,revenue,units,source,stamp);
    // Each period uses its own anchor, never a lifetime value masquerading as d7.
    for (const [wi,window] of Object.keys(quantities).entries()) {
      anchor(10005,"steam",window,100000*(wi+1),99999999,"portal_fetch");
      anchor(10350,"ps5",window,200000*(wi+1),5000*(wi+1),"manual_anchor_verified_ltd");
      // Auto-derived console anchor must NOT override the Steam-based model.
      anchor(10438,"xbox",window,999999999,null,"estimator");
      const family = await get(`/api/console/multiplatform-title/${encodeURIComponent("no man's sky")}?window=${window}`);
      assert.equal(family.perPlatform.steam.revenueUsd,100000*(wi+1));
      assert.equal(family.perPlatform.steam.unitsMid,Math.round(100000*(wi+1)/39.5934));
      assert.equal(family.perPlatform.ps5.unitsMid,5000*(wi+1));
      assert.equal(family.perPlatform.ps5.aspUsdCents,4000);
      assert.equal(family.perPlatform.ps5.unitSource,"verified_anchor");
      assert.ok(Math.abs(family.perPlatform.xbox.revenueUsd-100000*(wi+1)*.126/.495)<1e-8);
      for (const [pi,platform] of platforms.entries()) {
        const pdp = await get(`/api/console/titles/${titles[pi]}?window=${window}`);
        const k = pdp.windowKpisPerPlatform[0], f = family.perPlatform[platform];
        assert.equal(k.revenueMidUsd,f.revenueUsd);
        assert.equal(k.unitsMid,f.unitsMid);
      }
      const board = await get(`/api/console/leaderboards-multiplatform?window=${window}`);
      assert.equal(board.titles[0].revenueCombined,family.combinedRevenueUsd);
      assert.equal(board.revenueSummary.calibration.applied,false);
    }
    // Changes to published economics must never become training observations.
    assert.deepEqual(db.prepare("SELECT * FROM window_estimates_daily ORDER BY id").all(),before);
    const anchorsBefore = db.prepare("SELECT * FROM revenue_calibration_anchors ORDER BY id").all();
    await get("/api/console/leaderboards/ps5?window=ltd&sort=units&dir=asc");
    assert.deepEqual(db.prepare("SELECT * FROM revenue_calibration_anchors ORDER BY id").all(),anchorsBefore);

    // A revenue-only anchor with missing price is unknown units, not the stale estimate.
    db.prepare("UPDATE platform_sku_map SET msrp_usd_cents=NULL WHERE title_id=10005").run();
    let family = await get(`/api/console/multiplatform-title/${encodeURIComponent("no man's sky")}?window=d7`);
    assert.equal(family.perPlatform.steam.revenueUsd,100000);
    assert.equal(family.perPlatform.steam.unitsMid,null);
    assert.equal(family.combinedUnits,null);
    anchor(10005,"steam","d7",0,null,"portal_fetch");
    family = await get(`/api/console/multiplatform-title/${encodeURIComponent("no man's sky")}?window=d7`);
    assert.equal(family.perPlatform.steam.unitsMid,0);
    db.prepare("UPDATE platform_sku_map SET msrp_usd_cents=5999 WHERE title_id=10005").run();

    // Preserve protected shorter-window scaling, and do not fall back to LTD.
    db.prepare("DELETE FROM revenue_calibration_anchors WHERE window<>'ltd'").run();
    family = await get(`/api/console/multiplatform-title/${encodeURIComponent("no man's sky")}?window=d7`);
    assert.equal(family.perPlatform.ps5.dataSource,"scaled_to_verified_ltd_anchor_units");
    assert.equal(family.perPlatform.ps5.unitsMid,Math.round(13200*25000/3787202));
    db.prepare("DELETE FROM revenue_calibration_anchors").run();
    db.prepare("DELETE FROM window_estimates_daily WHERE window<>'ltd'").run();
    family = await get(`/api/console/multiplatform-title/${encodeURIComponent("no man's sky")}?window=m12`);
    assert.equal(family.perPlatform.steam.revenueUsd,null);
    assert.equal(family.perPlatform.ps5.unitsMid,null);
    assert.equal(family.combinedUnits,null);

    // A low raw estimate outside the old 250-row pre-anchor cut must still rank.
    for (let i=0;i<260;i++) {
      db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,msrp_usd_cents,refreshed_at,created_at)
        VALUES(?,'steam',?,'base','paid',1000,?,?)`).run(20000+i,String(20000+i),stamp,stamp);
      db.prepare(`INSERT INTO console_title_igdb(title_id,name,store_name,refreshed_at,created_at)
        VALUES(?,?,?,?,?)`).run(20000+i,`QA catalog ${i}`,`QA catalog ${i}`,stamp,stamp);
      db.prepare(`INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,units_mid,method,created_at)
        VALUES(?,'steam','d7',?,?,'review_velocity',?)`).run(20000+i,stamp,10000-i,stamp);
    }
    anchor(20259,"steam","d7",100000000,null,"portal_fetch");
    const descending = await get("/api/console/leaderboards/steam?window=d7&sort=units&dir=desc");
    assert.equal(descending.titles[0].titleId,20259);
    assert.equal(descending.count,100);
    for (const dir of ["asc","desc"]) {
      const sorted = await get(`/api/console/leaderboards/steam?window=d7&sort=units&dir=${dir}`);
      const values = sorted.titles.map((r:any)=>r.unitsMid).filter((n:any)=>n!=null);
      assert.deepEqual(values,[...values].sort((a,b)=>dir==="asc"?a-b:b-a));
    }
    // Refresh must repair a recently cached mismatch, search the store name
    // rather than its old child title, and prefer the parent even at rank 2.
    for (const key of ["twitch_client_id","twitch_client_secret"]) {
      db.prepare(`INSERT INTO app_settings(key,value,label,category,created_at,updated_at)
        VALUES(?,'test-only','test','test',?,?) ON CONFLICT(key) DO UPDATE SET value='test-only'`).run(key,stamp,stamp);
    }
    let query = "";
    let childOnly = false;
    globalThis.fetch = async (input,init) => {
      if (String(input).includes("id.twitch.tv")) return new Response(JSON.stringify({access_token:"test-only",expires_in:3600}));
      if (String(input).includes("api.igdb.com")) {
        query = String(init?.body);
        return new Response(JSON.stringify([
          {id:329714,name:child,slug:"no-mans-sky-worlds-part-ii"},
          ...(!childOnly ? [{id:42,name,slug:"no-mans-sky"}] : []),
        ]));
      }
      throw new Error(`Unexpected outbound request: ${input}`);
    };
    const { refreshIgdbForTitle } = await import("./signals/console/igdb");
    const refreshed = await refreshIgdbForTitle(10005,child);
    assert.equal(refreshed.fromCache,false);
    assert.equal(refreshed.igdbId,42);
    assert.ok(query.includes(`search "${name}"`));
    assert.ok(!query.includes("Worlds Part II"));
    assert.equal(db.prepare("SELECT name FROM console_title_igdb WHERE title_id=10005").get().name,name);
    childOnly = true;
    await refreshIgdbForTitle(10005,child,true);
    assert.equal(db.prepare("SELECT match_confidence FROM console_title_igdb WHERE title_id=10005").get().match_confidence,"low");
  } finally {
    globalThis.fetch = realFetch;
    if (server) await new Promise<void>((resolve,reject)=>server!.close(e=>e?reject(e):resolve()));
    db?.close();
    process.chdir(cwd);
    rmSync(dir,{recursive:true,force:true});
  }
});
