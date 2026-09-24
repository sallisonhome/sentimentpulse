import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { PORTFOLIO_RATINGS, makeBackfillSql, validateEvidence, type Evidence } from "../scripts/portfolio-ratings-backfill";
import { isVerifiedRatingsOnly, RATINGS_ONLY_SOURCE } from "./ratings-only-sku";
import { identityName } from "./console-title-identity";

function fixtures(): Evidence[] {
  const captureDate = new Date().toISOString().slice(0, 10);
  return PORTFOLIO_RATINGS.map((g, i) => {
    const snapshot = { captureDate, ratingCount: 100 + i, avgRating: 4, distributionJson: null,
      windowLabel: "ltd", isNativeWindow: true, skuCount: 1, rawJson: "{}" };
    return { name: g.name, appId: g.appId,
      steam: { name: g.name, releaseDate: "2024-01-01", header: null },
      ps: { input: { titleId: 0, productId: g.ps }, snapshot: { ...snapshot, platform: "ps5", sourceEndpoint: "ps:fixture" },
        conceptId: String(1000 + i), storeDisplayClassification: "FULL_GAME",
        productName: i === 3 ? `${g.name} [PS4 & PS5]` : i === 7 ? `${g.name} (PS4 & PS5)` : g.name,
        usedFallback: false, pdpReleaseDate: "2024-01-01" },
      xbox: { input: { titleId: 0, bigId: g.xbox },
        snapshots: [{ ...snapshot, platform: "xbox", sourceEndpoint: "xbox:fixture" }],
        pricing: { allSkusZero: false, baseMsrpUsdCents: 2999, currency: "USD" },
        productTitle: g.name, storeHeaderImageUrl: null, storeReleaseDateIso: "2024-01-01" },
    } as Evidence;
  });
}

test("ratings-only authorization and evidence reject editions, identity drift, stale data and wrong Bus Bound SKU", () => {
  const valid = { sku_role: "ratings_only", is_manual_override: 1, business_model_source: RATINGS_ONLY_SOURCE };
  assert.equal(isVerifiedRatingsOnly(valid), true);
  for (const bad of [{ ...valid, sku_role: "edition" }, { ...valid, is_manual_override: 0 },
    { ...valid, business_model_source: "unverified" }]) assert.equal(isVerifiedRatingsOnly(bad), false);
  assert.equal(identityName("Insurgency: Sandstorm [PS4 & PS5]"), identityName("Insurgency: Sandstorm"));
  assert.notEqual(identityName("World War Z: Aftermath"), identityName("World War Z"));
  assert.notEqual(identityName("Game [Remastered]"), identityName("Game"));
  validateEvidence(fixtures());
  for (const change of [
    (e: Evidence[]) => { e[0].xbox.input.bigId = "9NZP4F5QM6MH"; },
    (e: Evidence[]) => { e[1].ps.productName = "World War Z: Aftermath"; },
    (e: Evidence[]) => { e[0].ps.storeDisplayClassification = "ADD_ON"; },
    (e: Evidence[]) => { e[0].ps.snapshot.captureDate = "2020-01-01"; },
    (e: Evidence[]) => { e[0].xbox.pricing.allSkusZero = true; },
    (e: Evidence[]) => { e[0] = e[1]; },
  ]) {
    const e = fixtures(); change(e); assert.throws(() => makeBackfillSql(e));
  }
});

test("actual schema, idempotent seed, same daily PS collector and all eight public PDPs reuse ratings without sales writes", async () => {
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), "portfolio-ratings-"));
  process.chdir(dir);
  const realFetch = globalThis.fetch;
  let db: any, server: any, service: any;
  try {
    const { rawSqlite } = await import("./storage");
    db = rawSqlite;
    const { editionGroupKey } = await import("./routes-console-leaderboards");
    assert.equal(editionGroupKey("Insurgency: Sandstorm [PS4 & PS5]"), "insurgency: sandstorm");
    assert.notEqual(editionGroupKey("World War Z: Aftermath"), "world war z");
    const e = fixtures(), stamp = new Date().toISOString();
    // Mirrors production: seven existing Steam rows, six missing metadata,
    // SnowRunner already enriched, Expeditions missing from Buying entirely.
    for (const [i, g] of PORTFOLIO_RATINGS.slice(0, 7).entries()) {
      db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,
        msrp_usd_cents,business_model_source,is_manual_override,refreshed_at,created_at)
        VALUES(?,'steam',?,'base','paid',1999,'existing_protected',1,?,?)`).run(10000 + i, g.appId, stamp, stamp);
    }
    db.prepare(`INSERT INTO console_title_igdb(title_id,name,store_name,store_release_date,refreshed_at,created_at)
      VALUES(10005,'SnowRunner','SnowRunner','2021-05-18',?,?)`).run(stamp, stamp);
    db.prepare(`INSERT INTO window_estimates_daily(title_id,platform,window,as_of_date,units_mid,created_at)
      VALUES(10000,'steam','ltd','2026-09-23',12345,?)`).run(stamp);
    const originalSkus = db.prepare("SELECT * FROM platform_sku_map ORDER BY id").all();
    const originalEstimates = db.prepare("SELECT * FROM window_estimates_daily").all();
    const sql = makeBackfillSql(e);
    for (let pass = 0; pass < 2; pass++) for (const statement of Object.values(sql)) db.exec(statement);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM platform_sku_map").get().n, 24);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM platform_sku_map WHERE sku_role='base'").get().n, 7);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM store_rating_signal_daily").get().n, 16);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM xbox_title_cache").get().n, 8);
    assert.deepEqual(db.prepare("SELECT * FROM platform_sku_map WHERE title_id BETWEEN 10000 AND 10006 ORDER BY id").all(), originalSkus);
    assert.deepEqual(db.prepare("SELECT * FROM window_estimates_daily").all(), originalEstimates);
    assert.equal(db.prepare("SELECT store_release_date FROM console_title_igdb WHERE title_id=10005").get().store_release_date, "2021-05-18");

    globalThis.fetch = (async (input: any, init: any) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
      if (url.includes("appreviews/")) return new Response(JSON.stringify({
        success: 1, query_summary: { total_positive: 80, total_negative: 20, total_reviews: 100 },
      }));
      if (url.includes("web.np.playstation.com")) {
        const id = JSON.parse(new URL(url).searchParams.get("variables")!).productId;
        const row = e.find(r => r.ps.input.productId === id)!;
        return new Response(JSON.stringify({ data: { productRetrieve: {
          id, name: row.ps.productName, storeDisplayClassification: "FULL_GAME", concept: { id: row.ps.conceptId },
          starRating: { totalRatingsCount: 222, averageRating: 4.2 },
        } } }));
      }
      if (url.includes("store.playstation.com")) return new Response('{"releaseDate":"2024-01-01T00:00:00Z"}');
      throw new Error(`Unexpected fixture request ${url}`);
    }) as typeof fetch;
    const { runPsCollector } = await import("./signals/console/runner");
    const collected = await runPsCollector(e.map(r => r.ps.input));
    assert.equal(collected.ingested, 8);
    assert.equal(collected.failed, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM store_rating_signal_daily").get().n, 16);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM store_rating_signal_daily WHERE platform='ps5' AND rating_count=222").get().n, 8);
    const { registerReviewsRatingsRoutes } = await import("./routes-reviews-ratings");
    const app = express(); service = registerReviewsRatingsRoutes(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(r => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const game of PORTFOLIO_RATINGS) {
      const path = `${base}/api/reviews-ratings/steam/${game.appId}`;
      assert.equal((await realFetch(path)).status, 200);
      await service.settle();
      const response = await (await realFetch(path)).json();
      assert.deepEqual(response.players.map((p: any) => p.source), ["steam", "ps5", "xbox"], game.name);
      assert.equal(response.players[1].value, 4.2);
      assert.equal(response.players[1].count, 222);
      assert.equal(response.players[1].url.includes(game.ps), true);
      assert.equal(response.players[2].url.includes(game.xbox), true);
      if (game.name === "World War Z") assert.match(response.players[1].description, /PS4 listing/);
    }
    assert.deepEqual(db.prepare("SELECT * FROM window_estimates_daily").all(), originalEstimates);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM platform_sku_map WHERE business_model='paid' AND sku_role='base'").get().n, 7);
  } finally {
    await service?.settle();
    globalThis.fetch = realFetch;
    if (server) await new Promise<void>(r => server.close(r));
    db?.close(); process.chdir(cwd); rmSync(dir, { recursive: true, force: true });
  }
});
