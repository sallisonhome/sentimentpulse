import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import jwt from "jsonwebtoken";

test("real routes and migrations: all PDP identities, public boundary, family ratings and no sales writes", async () => {
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), "ratings-routes-"));
  process.chdir(dir);
  const realFetch = globalThis.fetch;
  const previousMode = process.env.AUTH_MODE, previousSecret = process.env.SABER_AUTH_JWT_SECRET;
  let server: any, db: any, service: any;
  try {
    const storageModule = await import("./storage");
    db = storageModule.rawSqlite;
    storageModule.storage.seedDefaultSettings();
    const stamp = new Date().toISOString().slice(0, 10);
    for (const [id, platform, sku] of [
      [100, "steam", "2183900"], [101, "ps5", "UP0000-PPSA00000_00-TEST"], [102, "xbox", "ABCDEFGHIJKL"],
    ]) {
      db.prepare(`INSERT INTO platform_sku_map(title_id,platform,external_sku,sku_role,business_model,refreshed_at,created_at)
        VALUES(?,?,?,'base','paid',?,?)`).run(id, platform, sku, stamp, stamp);
      db.prepare(`INSERT INTO console_title_igdb(title_id,name,store_name,igdb_id,release_date,store_release_date,refreshed_at,created_at)
        VALUES(?, 'Warhammer 40,000: Space Marine 2','Warhammer 40,000: Space Marine 2',1,'2024-09-09','2024-09-09',?,?)`).run(id, stamp, stamp);
      db.prepare(`INSERT INTO store_rating_signal_daily(title_id,platform,capture_date,source_endpoint,rating_count,avg_rating,window_label,created_at)
        VALUES(?,?,?,'fixture',100,4.5,'ltd',?)`).run(id, platform, stamp, stamp);
    }
    db.prepare(`INSERT INTO products(id,title,platforms,player_format,genre,release_date,steam_app_id,created_at,updated_at)
      VALUES(1,'Warhammer 40,000: Space Marine 2','["Steam","PS5","Xbox"]','single','Action','2024-09-09','2183900',?,?)`).run(stamp, stamp);
    db.prepare(`INSERT INTO amazon_asin_map(product_id,platform,asin,updated_at) VALUES(1,'ps5','B123456789',?)`).run(stamp);
    globalThis.fetch = (async (input: any, opts: any) => {
      if (String(input).includes("store.steampowered.com/appreviews/2183900")) {
        return new Response(JSON.stringify({ success: 1, query_summary: {
          total_reviews: 100, total_positive: 85, total_negative: 15, review_score_desc: "Very Positive",
        } }));
      }
      if (String(input).startsWith("http://127.0.0.1:")) return realFetch(input, opts);
      throw new Error("Unexpected external fetch in isolated route test");
    }) as typeof fetch;
    process.env.AUTH_MODE = "saber"; process.env.SABER_AUTH_JWT_SECRET = "local-qa-not-a-production-secret";
    const { createSaberAuthMiddleware } = await import("./saber-auth");
    const { registerReviewsRatingsRoutes } = await import("./routes-reviews-ratings");
    const app = express();
    app.use(createSaberAuthMiddleware().middleware);
    service = registerReviewsRatingsRoutes(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(r => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}/api/reviews-ratings`;
    const token = jwt.sign({ sub: "qa", email: "qa@example.test", scopes: ["signalpulse"], jti: "qa" }, process.env.SABER_AUTH_JWT_SECRET!);
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    for (const suffix of ["title/100", "title/101", "steam/2183900", "family/warhammer%2040%2C000%3A%20space%20marine%202"]) {
      const response = await realFetch(`${base}/${suffix}`);
      assert.equal(response.status, 200, suffix);
    }
    await service.settle();
    const combined = await (await realFetch(`${base}/title/101`)).json();
    assert.equal(combined.title, "Warhammer 40,000: Space Marine 2");
    assert.deepEqual(combined.players.map((p: any) => p.source), ["steam", "ps5", "xbox"]);
    assert.equal(combined.players[0].value, 85);
    assert.equal(combined.players[1].value, 4.5);
    assert.equal(combined.openCritic.status, "unconfigured");
    assert.ok(!JSON.stringify(combined).includes("api_key"));
    for (const suffix of ["product/1", "amazon/B123456789"]) {
      assert.equal((await realFetch(`${base}/${suffix}`)).status, 401);
      const privateResponse = await realFetch(`${base}/${suffix}`, auth);
      assert.equal(privateResponse.status, 200);
      assert.equal(privateResponse.headers.get("cache-control"), "private, max-age=30");
    }
    assert.equal((await realFetch(`${base}/title/100`, { method: "POST" })).status, 401);
    assert.equal((await realFetch(`${base}/title/100/admin`)).status, 401);
    assert.equal((await realFetch(`${base}/title/9999`)).status, 404);
    assert.equal((await realFetch(`${base}/steam/1x`, auth)).status, 400);
    assert.equal((await realFetch(`${base}/amazon/INVALID`, auth)).status, 400);
    const unknownAmazon = await (await realFetch(`${base}/amazon/B999999999`, auth)).json();
    assert.equal(unknownAmazon.openCritic.status, "unavailable");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM window_estimates_daily").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM store_rating_signal_daily").get().n, 3);
    // Idempotent additive schema on the same migrated database.
    registerReviewsRatingsRoutes(express());
    assert.equal(db.prepare("SELECT COUNT(*) n FROM review_rating_cache").get().n, 1);
  } finally {
    await service?.settle();
    globalThis.fetch = realFetch;
    if (previousMode === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = previousMode;
    if (previousSecret === undefined) delete process.env.SABER_AUTH_JWT_SECRET; else process.env.SABER_AUTH_JWT_SECRET = previousSecret;
    if (server) await new Promise<void>(r => server.close(r));
    db?.close(); process.chdir(cwd); rmSync(dir, { recursive: true, force: true });
  }
});
