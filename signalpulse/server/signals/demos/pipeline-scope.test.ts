import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

test("daily and manual pipeline ingest only released game demos, never license categories", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "demo-scope-"));
  const realFetch = globalThis.fetch;
  process.chdir(dir);
  let db: any;
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  try {
    const { rawSqlite } = await import("../../storage");
    db = rawSqlite;
    const { seedSaberDemos } = await import("./saber-seed");
    seedSaberDemos();
    const stamp = new Date().toISOString();
    const rejected = ["101", "102", "103", "104", "105", "106", "107", "108", "109"];
    // Polluted/legacy/manual rows must be checked too, even off the hub.
    for (const appId of rejected) {
      db.prepare(`INSERT INTO demo_titles
        (steam_app_id,name,is_active,discovered_via,first_seen_at,created_at,updated_at)
        VALUES (?,?,1,'manual',?,?,?)`).run(appId, `fixture ${appId}`, stamp, stamp, stamp);
    }
    const demoId = db.prepare("SELECT id FROM demo_titles WHERE steam_app_id='5184670'").get().id;
    db.prepare(`INSERT INTO demo_portal_daily
      (demo_title_id,date,complimentary_units_period,lifetime_free_licenses,source,created_at,updated_at)
      VALUES (?, ?, 999999, 999999, 'fixture', ?, ?)`).run(demoId, stamp.slice(0,10), stamp, stamp);
    const calls: string[] = [];
    globalThis.fetch = async input => {
      const url = String(input);
      calls.push(url);
      if (url === "https://store.steampowered.com/demos/") {
        return new Response(`data-event="{&quot;ANNOUNCEMENT_GID&quot;:&quot;123456&quot;}"
          data-groupvanityinfo="[{&quot;clanAccountID&quot;:123,&quot;vanity_url&quot;:&quot;store_contenthubs&quot;}]"
          data-browser_contenthub_newandtrending_0_50_123_6_="{}"`);
      }
      if (url.includes("/ajaxgetsaledynamicappquery?")) {
        return Response.json({ success: 1, appids: [5184670,101,102,103,104,105,106,107,108,109],
          match_count: 10, possible_has_more: false });
      }
      if (url.includes("/IStoreBrowseService/GetItems/")) {
        const ids = JSON.parse(new URL(url).searchParams.get("input_json")!).ids;
        return Response.json({ response: { store_items: ids.filter((i: any) => i.appid !== 109).map((i: any) => {
          const id = String(i.appid);
          let data: any = { id: i.appid, appid: i.appid, success: 1, visible: true,
            type: 1, name: `fixture ${id}`, is_free: true,
            related_items: { parent_appid: 50001 }, release: { steam_release_date: 1 } };
          if (id === "50001") data.type = 0;
          if (id === "50002") data.type = 6;
          if (id === "101") data.type = 0; // F2P, not a demo
          if (id === "102") data.type = 4; // DLC
          if (id === "103") data.type = 5; // video
          if (id === "104") data.related_items = { parent_appid: 50002 }; // software
          if (id === "105") data.release.is_coming_soon = true;
          if (id === "106") delete data.related_items;
          if (id === "107") data.is_free = false;
          if (id === "108") data.success = 15;
          return data;
        }) } });
      }
      if (url.includes("/appreviewhistogram/")) {
        const id = new URL(url).pathname.split("/").pop()!;
        assert.ok(["5184670","4010800"].includes(id), `ineligible histogram: ${id}`);
        return Response.json({ success: 1, results: {
          rollup_type: "day", recent: [{ date: Math.floor(Date.parse(stamp)/1000)-60,
            recommendations_up: 10, recommendations_down: 0 }], rollups: [],
        } });
      }
      if (url.includes("/GetNumberOfCurrentPlayers/")) {
        const id = new URL(url).searchParams.get("appid")!;
        assert.ok(["5184670","4010800"].includes(id), `ineligible CCU: ${id}`);
        return Response.json({ response: { result: 1, player_count: 3 } });
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    };
    const { runDemosDailyPipeline } = await import("./pipeline");
    const daily = await runDemosDailyPipeline(0);
    assert.equal(daily.eligibility.eligible, 2);
    assert.equal(daily.eligibility.excluded, 8);
    assert.equal(daily.eligibility.failed, 1);
    assert.equal(daily.reviewHistory.ingested, 2);
    assert.equal(daily.ccu.succeeded, 2);
    assert.equal(daily.portalActualsFetch.status, "skipped");
    assert.equal(daily.actuals.rowsWritten, 0);
    // Exercise the real orchestrator through HTTP without booting the
    // application, starting schedulers or touching developer data.
    const app = express();
    app.post("/api/ops/demos-pipeline-run", async (_req, res) => {
      res.json({ ok: true, result: await runDemosDailyPipeline(0) });
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server!.once("listening", resolve));
    const address = server.address() as { port: number };
    const response = await realFetch(`http://127.0.0.1:${address.port}/api/ops/demos-pipeline-run`, { method: "POST" });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.result.portalActualsFetch.status, "skipped");
    assert.equal(body.result.actuals.rowsWritten, 0);
    assert.equal(body.result.estimates.rowsWritten, 10);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM demo_portal_daily").get().n, 1, "no portal rows added");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM demo_window_estimates_daily WHERE method='steamworks_actual'").get().n, 0);
    assert.deepEqual(db.prepare(`SELECT DISTINCT t.steam_app_id FROM demo_window_estimates_daily e
      JOIN demo_titles t ON t.id=e.demo_title_id ORDER BY t.steam_app_id`).all()
      .map((r: any) => r.steam_app_id), ["4010800", "5184670"]);
    assert.equal(db.prepare("SELECT units_mid FROM demo_window_estimates_daily WHERE demo_title_id=? AND window='d7'").get(demoId).units_mid, 655);
    assert.ok(!calls.some(url => url.includes("partner.steam")), "no Steamworks portal calls");
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  } finally {
    globalThis.fetch = realFetch;
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    db?.close();
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
