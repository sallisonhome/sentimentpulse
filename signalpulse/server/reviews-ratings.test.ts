import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { ReviewsRatingsService, type RatingIdentity } from "./reviews-ratings-service";
import { exactCandidate, normalizeCritics, ratingIdentity, score, steamSummary, verifyCriticIdentity } from "./reviews-ratings-normalize";

const DAY = 86400_000;
const game: RatingIdentity = { name: "Elden Ring", releaseDate: "2022-02-25", steamAppId: "1245620" };
const detail = { id: 12090, name: "Elden Ring", release_date: "2022-02-25", tier: "Mighty",
  top_critic_score: 95.1, percent_recommended: 97.13, percentile: 100, review_count: 219, steam_id: null };
const summary = { success: 1, query_summary: { total_positive: 90, total_negative: 10, total_reviews: 100, review_score_desc: "Very Positive" } };
const search = { results: [
  { type: "game", id: 18502, name: "Elden Ring: Nightreign" },
  { type: "game", id: 12090, name: "Elden Ring" },
] };
function database() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE store_rating_signal_daily(id INTEGER PRIMARY KEY,title_id INTEGER,platform TEXT,
    avg_rating REAL,rating_count INTEGER,capture_date TEXT,created_at TEXT,window_label TEXT)`);
  return db;
}
function fixtureFetch(counter: string[], fail = () => false): typeof fetch {
  return (async (input: any) => {
    const url = String(input);
    counter.push(url);
    if (fail()) throw new Error("simulated upstream failure containing SECRET");
    return new Response(JSON.stringify(url.includes("appreviews") ? summary : url.includes("/search") ? search : detail));
  }) as typeof fetch;
}

test("native metrics, nulls and zero remain distinct; percentile is not recommendation percentage", () => {
  const r = normalizeCritics(detail);
  assert.equal(r.criticsRecommend, 97.13);
  assert.equal(r.topCriticScore, 95.1);
  assert.equal(r.rating, "Mighty");
  assert.equal(normalizeCritics({ ...detail, percent_recommended: 0 }).criticsRecommend, 0);
  assert.equal(normalizeCritics({ ...detail, review_count: 0 }).topCriticScore, null);
  assert.equal(normalizeCritics({ ...detail, tier: "Unknown" }).rating, null);
  for (const bad of [null, "", false, -1, 101, Infinity, NaN, "97"]) assert.equal(score(bad, 100), null);
  assert.equal(steamSummary(summary).value, 90);
  assert.equal(steamSummary({ success: 1, query_summary: { total_positive: 0, total_negative: 5, total_reviews: 5 } }).value, 0);
  assert.equal(steamSummary({ success: 1, query_summary: { total_positive: 0, total_negative: 0, total_reviews: 0 } }).value, null);
  assert.throws(() => steamSummary({ success: 1, query_summary: { total_positive: 10, total_negative: 5, total_reviews: 10 } }));
});

test("strict identity rejects sequels, demos, passes, editions, ambiguous matches and reused names", () => {
  assert.equal(exactCandidate(search, game.name)?.id, 12090);
  assert.equal(exactCandidate(search, "Elden Ring Demo"), null);
  assert.notEqual(ratingIdentity("Game Remastered"), ratingIdentity("Game"));
  assert.notEqual(ratingIdentity("Game Friends Pass"), ratingIdentity("Game"));
  assert.notEqual(ratingIdentity("Game Definitive Edition"), ratingIdentity("Game"));
  assert.throws(() => exactCandidate({ results: [...search.results, { type: "game", id: 99, name: "Elden Ring" }] }, game.name), /ambiguous/);
  assert.equal(verifyCriticIdentity(detail, game.name, "2022-02-25", game.steamAppId), true);
  assert.equal(verifyCriticIdentity(detail, game.name, "2026-02-25", game.steamAppId), false);
  assert.equal(verifyCriticIdentity(detail, game.name, null, game.steamAppId), false);
  assert.equal(verifyCriticIdentity({ ...detail, steam_id: "42" }, game.name, game.releaseDate, game.steamAppId), false);
});

test("cache, in-flight dedup, persistence, mapped ID reuse and stale failure retain verified data", async () => {
  const db = database(), requests: string[] = [];
  let now = Date.parse("2026-09-24T14:00:00Z"), fail = false;
  const request = fixtureFetch(requests, () => fail);
  const service = new ReviewsRatingsService(db, () => "test-key", request, () => now);
  assert.equal(service.get(game, []).openCritic.status, "loading");
  service.get(game, []); service.get(game, []);
  await service.settle();
  const first = service.get(game, []);
  assert.equal(requests.length, 3);
  assert.equal(first.players[0].value, 90);
  assert.equal(first.openCritic.criticsRecommend, 97.13);
  assert.equal(first.refreshing, false);
  // A second instance is a process restart using the same persisted database.
  const reboot = new ReviewsRatingsService(db, () => "test-key", request, () => now);
  assert.equal(reboot.get(game, []).openCritic.status, "ready");
  assert.equal(requests.length, 3);
  now += DAY + 1;
  reboot.get(game, []); await reboot.settle();
  assert.equal(requests.length, 5); // two updates, no repeated search
  now += DAY + 1; fail = true;
  const beforeFailure = reboot.get(game, []);
  await reboot.settle();
  const afterFailure = reboot.get(game, []);
  assert.equal(afterFailure.openCritic.status, "stale");
  assert.equal(afterFailure.openCritic.capturedAt, beforeFailure.openCritic.capturedAt);
  assert.equal(afterFailure.openCritic.topCriticScore, 95.1);
  assert.ok(!JSON.stringify(afterFailure).includes("SECRET"));
  assert.equal(requests.length, 7);
  await reboot.settle(); db.close();
});

test("unconfigured and demo products spend no critic quota", async () => {
  const db = database(), calls: string[] = [];
  const service = new ReviewsRatingsService(db, () => "", fixtureFetch(calls));
  assert.equal(service.get({ ...game, steamAppId: null }, []).openCritic.status, "unconfigured");
  const demo = new ReviewsRatingsService(db, () => "test", fixtureFetch(calls));
  assert.equal(demo.get({ name: "Elden Ring Demo", releaseDate: null, steamAppId: null }, []).openCritic.status, "unsupported");
  await demo.settle();
  assert.equal(calls.length, 0); db.close();
});

test("monthly guard counts attempts and stops before an external paid call", async () => {
  const db = database(), calls: string[] = [], now = Date.now();
  const service = new ReviewsRatingsService(db, () => "test", fixtureFetch(calls), () => now);
  const insert = db.prepare("INSERT INTO opencritic_request_usage(requested_at) VALUES(?)");
  for (let i = 0; i < 900; i++) insert.run(now);
  service.get({ ...game, steamAppId: null }, []); await service.settle();
  assert.equal(service.get({ ...game, steamAppId: null }, []).openCritic.status, "budget_exhausted");
  assert.equal(calls.length, 0); db.close();
});

test("negative matches are cached; auth/rate failures never become successful zero-score responses", async () => {
  const db = database(); let requests = 0;
  const negative = new ReviewsRatingsService(db, () => "test", (async () => {
    requests++; return new Response(JSON.stringify({ results: [] }));
  }) as typeof fetch);
  negative.get({ ...game, steamAppId: null }, []); await negative.settle();
  assert.equal(negative.get({ ...game, steamAppId: null }, []).openCritic.status, "not_found");
  assert.equal(requests, 1);
  const failing = new ReviewsRatingsService(db, () => "test", (async () => {
    requests++; return new Response("quota", { status: 429 });
  }) as typeof fetch);
  const other = { name: "Other Game", releaseDate: "2026-01-01", steamAppId: null };
  failing.get(other, []); await failing.settle();
  assert.equal(failing.get(other, []).openCritic.status, "rate_limited");
  failing.get({ ...other, name: "Third Game" }, []); await failing.settle();
  assert.equal(requests, 2); // circuit stops a second quota-rejected external call
  db.close();
});

test("console rating snapshots preserve stars, dates and zero; never sum duplicate regional SKUs", async () => {
  const db = database(), now = Date.parse("2026-09-24T14:00:00Z");
  db.exec(`INSERT INTO store_rating_signal_daily VALUES
    (1,10,'ps5',4.72,1000,'2026-09-24','2026-09-24T05:00:00Z','ltd'),
    (2,20,'xbox',0,12,'2026-09-01','2026-09-01T05:00:00Z','ltd')`);
  const service = new ReviewsRatingsService(db, () => "", fixtureFetch([]), () => now);
  const r = service.get({ ...game, steamAppId: null }, [
    { titleId: 10, platform: "ps5", externalSku: "UP1234-TEST", conceptId: null },
    { titleId: 10, platform: "ps5", externalSku: "EP1234-TEST", conceptId: null },
    { titleId: 20, platform: "xbox", externalSku: "ABCDEFGHIJKL", conceptId: null },
  ]);
  assert.equal(r.players.length, 2);
  assert.equal(r.players[0].value, 4.72);
  assert.equal(r.players[0].count, 1000);
  assert.equal(r.players[1].value, 0);
  assert.equal(r.players[1].status, "stale");
  assert.equal(r.players[1].capturedAt, "2026-09-01");
  db.close();
});
