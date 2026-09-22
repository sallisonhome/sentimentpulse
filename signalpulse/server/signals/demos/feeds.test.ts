import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import express from "express";
import { DEMO_FEEDS, demoFeedUrl, fetchDemoFeed, parseDemoFeedContext, DEMO_FEED_LIMIT, DEMO_NEW_FEED_MAX } from "./feeds";
import { createDemoVerifier, hasExactDemoDownload } from "./metadata";

const hub = `data-event="{&quot;ANNOUNCEMENT_GID&quot;:&quot;987654321&quot;}"
  data-groupvanityinfo="[{&quot;clanAccountID&quot;:999,&quot;vanity_url&quot;:&quot;store_contenthubs&quot;}]"
  data-browser_contenthub_newandtrending_0_50_888_7_="{}"`;
const childEnv = { ...process.env, TSX_TSCONFIG_PATH: join(process.cwd(), "tsconfig.json") };

test("Steam context comes from hub; all feeds are paginated, bounded and keep source order", async () => {
  const context = parseDemoFeedContext(hub);
  assert.deepEqual(context, { clan: "999", announcement: "987654321", section: "888", tab: "7" });
  for (const feed of Object.keys(DEMO_FEEDS) as Array<keyof typeof DEMO_FEEDS>) {
    const calls: number[] = [];
    const result = await fetchDemoFeed(context, feed, async url => {
      const params = new URL(url).searchParams;
      assert.equal(params.get("flavor"), DEMO_FEEDS[feed]);
      assert.equal(params.get("strContentHubType"), "demos");
      assert.equal(params.get("sectionuniqueid"), "888");
      const start = Number(params.get("start")); calls.push(start);
      return JSON.stringify({ success: 1, appids: Array.from({ length: 50 }, (_, i) => start + i + 1),
        match_count: 5000, possible_has_more: true });
    });
    assert.deepEqual(calls, Array.from({length:10},(_,i)=>i*50));
    assert.equal(result.entries.length, 500);
    assert.equal(result.scannedSlots,500);
    assert.equal(result.stopReason,feed==="new"?"bootstrap":"bounded");
    assert.deepEqual(result.entries[99], { appId: "100", rank: 100 });
  }
  assert.throws(() => parseDemoFeedContext("<html>contract changed</html>"), /missing/);
  assert.equal(new URL(demoFeedUrl(context, "top", 50)).searchParams.get("start"), "50");
});

test("New Releases catches up beyond 500 to prior head plus overlap, and detects safety truncation", async () => {
  const context=parseDemoFeedContext(hub);
  const previous=new Set(Array.from({length:100},(_,i)=>String(10000+i)));
  const read=async(url:string)=>{
    const start=Number(new URL(url).searchParams.get("start"));
    return JSON.stringify({success:1,match_count:10000,possible_has_more:true,
      appids:Array.from({length:50},(_,i)=>start>=550?10000+start-550+i:start+i+1)});
  };
  const caught=await fetchDemoFeed(context,"new",read,previous);
  assert.equal(caught.scannedSlots,650);
  assert.equal(caught.stopReason,"watermark");
  const capped=await fetchDemoFeed(context,"new",async(url)=>{
    const start=Number(new URL(url).searchParams.get("start"));
    // Four persistent future-date candidates at the front are not a watermark.
    return JSON.stringify({success:1,match_count:10000,possible_has_more:true,
      appids:Array.from({length:50},(_,i)=>i<4?10000+i:start+i+1)});
  },previous);
  assert.equal(capped.scannedSlots,DEMO_NEW_FEED_MAX);
  assert.equal(capped.stopReason,"safety_cap");
  assert.equal(DEMO_FEED_LIMIT,500);
});

test("exact demo download parser ignores parent/wrong IDs, comments, scripts and hidden actions",()=>{
  const offer=(id:string)=>`<a href="javascript:ShowGotSteamModal( 'steam://install/${id}', &quot;Demo&quot;, &quot;Download&quot; )"><span>Download</span></a>`;
  assert.equal(hasExactDemoDownload(offer("4889650"),"4889650"),true);
  assert.equal(hasExactDemoDownload(`<a href="steam://install/4889650">Install Demo</a>`,"4889650"),true);
  for(const html of [offer("4838130"),offer("48896500"),`<script>${offer("4889650")}</script>`,
    `<!--${offer("4889650")}-->`,offer("4889650").replace("<a ","<a aria-hidden=\"true\" "),
    offer("4889650").replace("<span>Download</span>","Wishlist"),
    "<p>Download steam://install/4889650</p>"])assert.equal(hasExactDemoDownload(html,"4889650"),false);
});

test("future or missing dates need an exact offered demo, game parent, and are never invented",async()=>{
  const realFetch=globalThis.fetch;
  const pages:string[]=[];
  try {
    globalThis.fetch=async input=>{
      const url=new URL(String(input));
      if(url.hostname==="store.steampowered.com"){
        pages.push(url.href);
        return new Response(`<a href="javascript:ShowGotSteamModal( 'steam://install/1', &quot;Demo&quot;, &quot;Download&quot; )">Download</a>`);
      }
      const ids=JSON.parse(url.searchParams.get("input_json")!).ids;
      return Response.json({response:{store_items:ids.map(({appid:id}:any)=>({
        id,appid:id,success:1,type:id===500?0:id===600?6:1,visible:id!==3,is_free:id!==4,
        name:id===7?"Fixture Friend's Pass":`Demo ${id}`,
        release:{steam_release_date:Math.floor(Date.now()/1000)+86400},
        related_items:id===5?{}:{parent_appid:id===6?600:500}
      }))}});
    };
    const verifier=createDemoVerifier(0), result=await verifier.verify(["1","2","3","4","5","6","7"]);
    assert.equal(result.get("1")?.demo?.releaseDate,null);
    assert.equal(result.get("1")?.demo?.availabilitySource,"store_download");
    assert.match(result.get("1")?.demo?.availabilitySourceUrl??"",/\/app\/500\//);
    for(const id of ["2","3","4","5","6","7"])assert.equal(result.get(id)?.demo,null);
    assert.equal(result.get("7")?.reason,"friend_pass_review_required");
    await verifier.verify(["1","2"]);
    assert.equal(pages.length,1,"same parent's availability page is cached within run");
    globalThis.fetch=async input=>String(input).includes("store.steampowered.com")
      ?new Response("rate limit",{status:429}):await realMetadata(input);
    async function realMetadata(input:any) {
      const ids=JSON.parse(new URL(String(input)).searchParams.get("input_json")!).ids;
      return Response.json({response:{store_items:ids.map(({appid:id}:any)=>({
        id,appid:id,success:1,type:id===500?0:1,visible:true,is_free:true,
        release:{steam_release_date:Math.floor(Date.now()/1000)+86400},related_items:{parent_appid:500}
      }))}});
    }
    const failed=await createDemoVerifier(0).verify(["1"]);
    assert.match(failed.get("1")?.error??"",/429/,"transport failure is not a confirmed deactivation");
  } finally {globalThis.fetch=realFetch;}
});

test("malformed, repeated and silently empty feeds fail instead of claiming fresh coverage", async () => {
  const context = parseDemoFeedContext(hub);
  for (const response of [{ success: 0 }, { success: 1, appids: [], match_count: 3 },
    { success: 1, appids: ["x"], match_count: 1 }]) {
    await assert.rejects(fetchDemoFeed(context, "top", async () => JSON.stringify(response)));
  }
  await assert.rejects(fetchDemoFeed(context, "top", async () => JSON.stringify({
    success: 1, appids: Array.from({ length: 50 }, (_, i) => i + 1), match_count: 500,
    possible_has_more: true,
  })), /repeated/);
  const empty = await fetchDemoFeed(context, "new", async () => JSON.stringify({
    success: 1, appids: [], match_count: 0, possible_has_more: false,
  }));
  assert.equal(empty.entries.length, 0);
});

test("batch verifier excludes future, hidden, paid, missing-parent and software demos and caches within a run", async () => {
  const realFetch = globalThis.fetch;
  const batches: number[][] = [];
  try {
    globalThis.fetch = async input => {
      const ids = JSON.parse(new URL(String(input)).searchParams.get("input_json")!).ids.map((i: any) => i.appid);
      batches.push(ids); assert.ok(ids.length <= 50);
      return Response.json({ response: { store_items: ids.map((id: number) => {
        const item: any = { id, appid: id, success: 1, visible: true, type: id >= 500 ? 0 : 1,
          is_free: true, release: { steam_release_date: 1 }, related_items: { parent_appid: 500 } };
        if (id === 2) item.release.steam_release_date = Math.floor(Date.now() / 1000) + 86400;
        if (id === 3) item.visible = false;
        if (id === 4) item.is_free = false;
        if (id === 5) delete item.related_items;
        if (id === 6) item.related_items.parent_appid = 600;
        if (id === 600) item.type = 6;
        return item;
      }) } });
    };
    const verifier = createDemoVerifier(0);
    const first = await verifier.verify(Array.from({ length: 75 }, (_, i) => String(i + 1)));
    assert.ok(first.get("1")?.demo);
    for (const id of ["2","3","4","5","6"]) assert.equal(first.get(id)?.demo, null);
    assert.deepEqual(batches.map(batch => batch.length), [50, 25, 2]);
    await verifier.verify(["1", "2"]);
    assert.equal(batches.length, 3, "no duplicate metadata calls during eligibility pass");
  } finally { globalThis.fetch = realFetch; }
});

test("discovery, migration and HTTP views preserve source order, null estimates and last good snapshots", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "demo-feeds-"));
  const realFetch = globalThis.fetch;
  let db: any;
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  process.chdir(dir);
  try {
    const storageUrl = new URL("../../storage.ts", import.meta.url).href;
    db = (await import("../../storage")).rawSqlite;
    // Existing-schema upgrade, not just an empty-database test.
    db.exec(`INSERT INTO app_settings(key,value,label,category,created_at,updated_at)
      VALUES('demo_migration_sentinel','preserve','Test','test','2026-09-22','2026-09-22');
      DROP TABLE demo_discovery_ranks; DROP TABLE demo_discovery_feeds;
      ALTER TABLE demo_titles DROP COLUMN release_date;
      ALTER TABLE demo_titles DROP COLUMN availability_source;
      ALTER TABLE demo_titles DROP COLUMN availability_source_url;
      ALTER TABLE demo_titles DROP COLUMN availability_checked_at;`);
    db.exec("ALTER TABLE demo_titles DROP COLUMN sku_kind;");
    execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e",
      `const {rawSqlite}=await import(${JSON.stringify(storageUrl)});rawSqlite.close();`], { cwd: dir, env: childEnv });
    assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='demo_migration_sentinel'").get().value, "preserve");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM pragma_table_info('demo_discovery_ranks')").get().n, 3);
    assert.ok(db.prepare("SELECT name FROM pragma_table_info('demo_titles') WHERE name='release_date'").get());
    assert.ok(db.prepare("SELECT name FROM pragma_table_info('demo_titles') WHERE name='availability_source'").get());
    assert.ok(db.prepare("SELECT name FROM pragma_table_info('demo_titles') WHERE name='sku_kind'").get());
    assert.ok(db.prepare("SELECT name FROM pragma_table_info('demo_discovery_feeds') WHERE name='anchor_app_ids'").get());
    execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e",
      `const {rawSqlite}=await import(${JSON.stringify(storageUrl)});rawSqlite.close();`], { cwd: dir, env: childEnv });
    let failTop = false;
    let metadataFailure = false;
    let round = 1;
    const metadataCalls: string[] = [];
    globalThis.fetch = async input => {
      const url = String(input);
      if (url === "https://store.steampowered.com/demos/") return new Response(hub);
      if (url.includes("/ajaxgetsaledynamicappquery?")) {
        const flavor = new URL(url).searchParams.get("flavor");
        if (failTop && flavor === DEMO_FEEDS.top) throw new Error("fixture upstream outage");
        const appids = flavor === DEMO_FEEDS.top ? (round === 1 ? [2, 3, 1] : [1, 2])
          : flavor === DEMO_FEEDS.new ? [4, 2] : [2, 1];
        return Response.json({ success: 1, appids, match_count: appids.length, possible_has_more: false });
      }
      assert.ok(url.includes("/IStoreBrowseService/GetItems/"));
      const ids = JSON.parse(new URL(url).searchParams.get("input_json")!).ids;
      return Response.json({ response: { store_items: ids.filter((i: any) => !(metadataFailure && i.appid === 2))
        .map((i: any) => {
          const id = String(i.appid); metadataCalls.push(id);
          return { id: i.appid, appid: i.appid, success: 1, visible: true,
            type: id === "500" ? 0 : id === "600" ? 6 : 1, name: `Demo ${id}`, is_free: true,
            tagids: id === "2" ? [19, 21] : id === "4" ? [9] : [599],
            related_items: { parent_appid: id === "3" ? 600 : 500 }, release: { steam_release_date: Number(id) * 86400 } };
        }) } });
    };
    const { runDemosHubDiscovery } = await import("./discovery");
    const first = await runDemosHubDiscovery(0);
    assert.equal(first.hubAppIdsFound, 4);
    assert.equal(first.newlyDiscovered, 3);
    assert.equal(first.rejectedNotDemo, 1);
    assert.equal(metadataCalls.filter(id => id === "2").length, 1, "cross-feed dedup before metadata calls");
    assert.ok(first.feeds.every(feed => feed.status === "success"));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM demo_titles WHERE steam_app_id='3'").get().n, 0, "software excluded");
    const metadataFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ success: 0 });
    const { runDemosReviewHistoryCollector } = await import("./runner");
    const noReviews = await runDemosReviewHistoryCollector(0, new Set(["4"]));
    assert.equal(noReviews.failed, 1);
    assert.equal(noReviews.deactivated, 0);
    assert.equal(db.prepare("SELECT is_active FROM demo_titles WHERE steam_app_id='4'").get().is_active, 1);
    globalThis.fetch = metadataFetch;
    const { registerDemosLeaderboardRoutes } = await import("../../routes-demos-leaderboard");
    const app = express(); registerDemosLeaderboardRoutes(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server!.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/demos/leaderboard`;
    for (const window of ["d7", "d30", "d90", "m12", "ltd"]) {
      const top = await (await realFetch(`${base}?sort=top&window=${window}`)).json() as any;
      assert.deepEqual(top.demos.map((row: any) => row.steamAppId), ["2", "1"]);
      assert.deepEqual(top.demos.map((row: any) => row.sourceRank), [1, 3], "retain actual Steam rank gaps");
      const latest = await (await realFetch(`${base}?sort=new&window=${window}`)).json() as any;
      assert.deepEqual(latest.demos.map((row: any) => row.steamAppId), ["4", "2"]);
      assert.equal(latest.demos[0].unitsMid, null, "new release with no reviews remains visible");
      for (const sort of ["downloads", "ccu"]) assert.equal((await realFetch(`${base}?sort=${sort}&window=${window}`)).status, 200);
    }
    assert.equal((await realFetch(`${base}?sort=wrong`)).status, 400);
    assert.equal((await realFetch(`${base}?window=wrong`)).status, 400);
    assert.equal((await realFetch(`${base}?direction=wrong`)).status, 400);
    assert.equal((await realFetch(`${base}?genre=madeup`)).status, 400);
    assert.equal(((await (await realFetch(`${base}?sort=top&limit=1`)).json()) as any).count, 1);
    const page1=await(await realFetch(`${base}?sort=top&limit=1`)).json() as any;
    const page2=await(await realFetch(`${base}?sort=top&limit=1&offset=1`)).json() as any;
    assert.equal(page1.hasMore,true);assert.equal(page2.hasMore,false);
    assert.equal(page2.demos[0].steamAppId,"1");assert.equal(page2.demos[0].sourceRank,3);
    assert.equal((await realFetch(`${base}?offset=-1`)).status,400);
    assert.equal((await realFetch(`${base}?offset=1.5`)).status,400);
    const searched=await(await realFetch(`${base}?search=demo%204`)).json() as any;
    assert.deepEqual(searched.demos.map((r:any)=>r.steamAppId),["4"]);
    const byId=await(await realFetch(`${base}?search=2&offset=999`)).json() as any;
    assert.equal(byId.offset,0);assert.equal(byId.demos[0].steamAppId,"2");
    assert.equal(((await(await realFetch(`${base}?search=NO-MATCH`)).json()) as any).count,0);
    assert.equal(((await (await realFetch(`${base}?sort=top&genre=Adventure`)).json()) as any).demos[0].steamAppId, "2");
    assert.equal(((await (await realFetch(`${base}?sort=top&genre=Strategy`)).json()) as any).count, 0);
    // Exercise every numeric/date sort in both directions before limiting.
    for (const id of ["1", "2"]) {
      const demoId = db.prepare("SELECT id FROM demo_titles WHERE steam_app_id=?").get(id).id;
      db.prepare(`INSERT INTO demo_window_estimates_daily
        (demo_title_id,window,as_of_date,review_count_total,units_mid,method,created_at)
        VALUES (?,'d7','2026-09-22',?,?,'review_delta_multiplier','2026-09-22')`)
        .run(demoId, id === "1" ? 20 : 30, id === "1" ? 200 : 100);
      db.prepare("INSERT INTO demo_ccu_snapshots(demo_title_id,captured_at,ccu) VALUES (?,'2026-09-22',?)")
        .run(demoId, id === "1" ? 3 : 2);
      db.prepare("INSERT INTO demo_ccu_daily_peaks(demo_title_id,peak_date,peak_ccu,created_at) VALUES (?,'2026-09-22',?,'2026-09-22')")
        .run(demoId, id === "1" ? 5 : 9);
    }
    db.prepare("UPDATE demo_titles SET release_date=NULL WHERE steam_app_id='1'").run();
    const expectedDesc = { reviews: ["2", "1", "4"], downloads: ["1", "2", "4"], ccu: ["1", "2", "4"],
      peak: ["2", "1", "4"], release: ["4", "2", "1"] };
    for (const [sort, expected] of Object.entries(expectedDesc)) {
      for (const direction of ["desc", "asc"]) {
        const payload = await (await realFetch(`${base}?sort=${sort}&direction=${direction}`)).json() as any;
        assert.deepEqual(payload.demos.map((row: any) => row.steamAppId),
          direction === "desc" ? expected : [expected[1], expected[0], expected[2]], `${sort} ${direction}, nulls last`);
      }
      const filtered = await (await realFetch(`${base}?sort=${sort}&genre=Action&limit=1`)).json() as any;
      assert.equal(filtered.demos[0].steamAppId, "2");
      assert.deepEqual(filtered.genres, ["Action", "Adventure", "Simulation", "Strategy"]);
    }
    const previous = db.prepare("SELECT * FROM demo_discovery_ranks WHERE feed='top' ORDER BY source_rank").all();
    failTop = true; round = 2;
    await runDemosHubDiscovery(0);
    assert.deepEqual(db.prepare("SELECT * FROM demo_discovery_ranks WHERE feed='top' ORDER BY source_rank").all(), previous);
    assert.match(db.prepare("SELECT error FROM demo_discovery_feeds WHERE feed='top'").get().error, /outage/);
    failTop = false; metadataFailure = true;
    await runDemosHubDiscovery(0);
    assert.deepEqual(db.prepare("SELECT * FROM demo_discovery_ranks WHERE feed='top' ORDER BY source_rank").all(), previous);
    metadataFailure = false;
    await runDemosHubDiscovery(0);
    const recovered = await (await realFetch(`${base}?sort=top`)).json() as any;
    assert.deepEqual(recovered.demos.map((row: any) => row.steamAppId), ["1", "2"]);
    assert.equal(recovered.coverage.feeds.find((feed: any) => feed.feed === "top").error, null);
    const beforeCap=db.prepare("SELECT * FROM demo_discovery_feeds WHERE feed='new'").get();
    const oldNewRanks=db.prepare("SELECT * FROM demo_discovery_ranks WHERE feed='new'").all();
    const normalFetch=globalThis.fetch;
    globalThis.fetch=async(input,init)=>{
      const url=new URL(String(input));
      if(url.searchParams.get("flavor")===DEMO_FEEDS.new){
        const start=Number(url.searchParams.get("start"));
        return Response.json({success:1,appids:Array.from({length:50},(_,i)=>7000+start+i),
          match_count:5000,possible_has_more:true});
      }
      return normalFetch(input,init);
    };
    const truncated=await runDemosHubDiscovery(0);
    assert.match(truncated.feeds.find(f=>f.feed==="new")?.error??"",/catch-up incomplete/);
    const afterCap=db.prepare("SELECT * FROM demo_discovery_feeds WHERE feed='new'").get();
    assert.equal(afterCap.last_success_at,beforeCap.last_success_at);
    assert.equal(afterCap.anchor_app_ids,beforeCap.anchor_app_ids);
    assert.deepEqual(db.prepare("SELECT * FROM demo_discovery_ranks WHERE feed='new'").all(),oldNewRanks);
    // Candidates can enter tracking from a partial attempt, but no false
    // complete source ranking or advanced watermark is published.
    const large=await(await realFetch(`${base}?search=Demo%207&limit=100`)).json() as any;
    const largeNext=await(await realFetch(`${base}?search=Demo%207&limit=100&offset=100`)).json() as any;
    assert.equal(large.count,100);assert.equal(largeNext.count,100);
    assert.ok(large.hasMore);assert.ok(largeNext.availableCount>250);
    assert.ok(large.demos.every((a:any)=>!largeNext.demos.some((b:any)=>b.id===a.id)),"no duplicate rows across pages");
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    globalThis.fetch = realFetch;
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    db?.close(); process.chdir(cwd); rmSync(dir, { recursive: true, force: true });
  }
});
