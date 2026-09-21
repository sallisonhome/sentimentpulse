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
      assert.equal(family.combinedUnits,units.reduce((a,b)=>a+b,0));
      for (let i=0;i<3;i++) {
        assert.equal(family.perPlatform[platforms[i]].unitsMid,units[i]);
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
      }
    }
    for (const id of titles) {
      const pdp = await get(`/api/console/titles/${id}?window=d7`);
      assert.ok(!JSON.stringify([pdp.igdb?.name,pdp.xboxTitle?.name]).includes("Worlds Part"));
      assert.ok(pdp.portraitCandidates[0]?.includes("/275850/"));
    }
    assert.deepEqual(db.prepare("SELECT * FROM window_estimates_daily ORDER BY id").all(),before);
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
