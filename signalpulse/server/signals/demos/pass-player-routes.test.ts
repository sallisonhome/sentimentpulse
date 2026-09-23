import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PassPlayerEvidence } from "./pass-player-evidence";

test("real DB/API path isolates own pass data, sorts estimates, and leaves downloads unchanged", async () => {
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), "pass-player-routes-"));
  process.chdir(dir);
  let db: any, server: any;
  try {
    db = (await import("../../storage")).rawSqlite;
    const { upsertDiscoveredDemo } = await import("./discovery");
    const now = Date.now(), end = Math.floor(now / 86_400_000) * 86_400_000;
    const start = end - 7 * 86_400_000, release = new Date(start).toISOString().slice(0, 10);
    for (const [id, name, kind] of [
      ["100", "A Friend Pass", "friends_pass"], ["101", "B Friend Pass", "friends_pass"],
      ["102", "Missing Friend Pass", "friends_pass"], ["3052150", "Split Fiction Friend Pass", "friends_pass"],
      ["999", "Main game metric decoy", "demo"],
    ]) upsertDiscoveredDemo({ steamAppId: id, name, genre: "Action", releaseDate: release,
      skuKind: kind as "friends_pass" | "demo", discoveredVia: "manual" });
    const ids = new Map((db.prepare("SELECT id,steam_app_id FROM demo_titles").all() as any[])
      .map(r => [r.steam_app_id, r.id]));
    const insert = db.prepare("INSERT INTO demo_ccu_snapshots(demo_title_id,captured_at,ccu) VALUES(?,?,?)");
    db.transaction(() => {
      for (const [app, ccu] of [["100", 10], ["101", 20], ["999", 999999], ["3052150", 100]] as const)
        for (let t = start; t <= end; t += 30 * 60_000)
          insert.run(ids.get(app), new Date(t).toISOString(), ccu);
    })();
    const evidence: PassPlayerEvidence[] = ["100", "101", "102", "3052150"].map(appId => ({
      appId, runtimeAppId: appId, runtimeEvidenceUrl: "https://evidence.example/fixture/runtime",
      runtimeVerifiedAt: new Date(start).toISOString(), runtimeValidUntil: new Date(now + 86_400_000).toISOString(),
      calibrations: (["d7", "d30", "d90", "m12", "ltd"] as const).map(window => ({
        window, meanHoursPerPlayer: 2, population: "own_pass_online_active_players",
        validFrom: new Date(start).toISOString(), validUntil: new Date(now + 86_400_000).toISOString(),
        sourceUrl: "https://evidence.example/fixture/playtime",
        validationUrl: "https://evidence.example/fixture/validation", validatedAt: new Date(start).toISOString(),
      })),
    }));
    const app = express();
    const { registerDemosLeaderboardRoutes } = await import("../../routes-demos-leaderboard");
    registerDemosLeaderboardRoutes(app, evidence);
    const baseline = express(); registerDemosLeaderboardRoutes(baseline);
    app.use("/baseline", baseline);
    server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/demos/leaderboard`;
    for (const window of ["d7", "d30", "d90", "m12", "ltd"]) {
      const before = await (await fetch(base.replace("/api/", "/baseline/api/") + `?kind=friends_pass&window=${window}`)).json() as any;
      const units = new Map(before.demos.map((d: any) => [d.steamAppId, d.unitsMid]));
      assert.ok(before.demos.every((d: any) => d.playerEstimate.players === null), "empty production calibration registry never invents players");
      for (const direction of ["asc", "desc"]) {
        const r = await (await fetch(`${base}?kind=friends_pass&window=${window}&sort=players&direction=${direction}`)).json() as any;
        assert.equal(r.count, 4);
        assert.deepEqual(r.demos.slice(0, 2).map((d: any) => d.steamAppId), direction === "asc" ? ["100", "101"] : ["101", "100"]);
        assert.deepEqual(r.demos.slice(0, 2).map((d: any) => d.playerEstimate.players), direction === "asc" ? [840, 1680] : [1680, 840]);
        assert.ok(r.demos.every((d: any) => d.unitsMid === units.get(d.steamAppId)), "existing download results unchanged, including legacy CCU lower bounds");
        assert.equal(r.demos.find((d: any) => d.steamAppId === "102").playerEstimate.status, "insufficient_history");
        assert.equal(r.demos.find((d: any) => d.steamAppId === "3052150").playerEstimate.status, "shared_runtime");
      }
    }
    const page = await (await fetch(`${base}?kind=friends_pass&sort=players&limit=1&offset=1`)).json() as any;
    assert.equal(page.demos[0].steamAppId, "100"); assert.equal(page.availableCount, 4);
    const filtered = await (await fetch(`${base}?kind=friends_pass&sort=players&search=Missing`)).json() as any;
    assert.equal(filtered.count, 1); assert.equal(filtered.demos[0].playerEstimate.players, null);
    assert.equal((await fetch(`${base}?kind=demo&sort=players`)).status, 400);
    const demo = await (await fetch(base)).json() as any;
    assert.equal(demo.sort, "downloads"); assert.equal(demo.demos[0].playerEstimate, null);
    const defaults = await (await fetch(`${base}?kind=friends_pass`)).json() as any;
    assert.equal(defaults.sort, "downloads");
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
    assert.equal(db.prepare("SELECT count(*) n FROM demo_download_actuals").get().n, 0);
  } finally {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    db?.close(); process.chdir(cwd); rmSync(dir, { recursive: true, force: true });
  }
});
