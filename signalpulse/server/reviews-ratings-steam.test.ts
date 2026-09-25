import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { ReviewsRatingsService } from "./reviews-ratings-service";

const DAY = 86400_000;
const game = { name: "Marvel Rivals", steamAppId: "2767030", releaseDate: "2024-12-06" };
function summary(positive: number, negative: number) {
  return { success: 1, query_summary: { total_positive: positive,
    total_negative: negative, total_reviews: positive + negative,
    review_score_desc: positive + negative ? "Mostly Positive" : "No user reviews" } };
}
function setup(all: any) {
  const db = new Database(":memory:");
  const calls: URL[] = [];
  let now = Date.parse("2026-09-25T01:00:00Z");
  let fail = false;
  const service = new ReviewsRatingsService(db, () => undefined, (async (input: any) => {
    const url = new URL(String(input)); calls.push(url);
    assert.equal(url.pathname, "/appreviews/2767030");
    assert.equal(url.searchParams.get("language"), "all");
    assert.equal(url.searchParams.get("filter"), "all");
    assert.equal(url.searchParams.get("purchase_type"), "all");
    if (fail) throw Error("provider outage");
    return new Response(JSON.stringify(all));
  }) as typeof fetch, () => now);
  return { db, calls, service, advance: () => { now += DAY + 1; }, fail: () => { fail = true; }, now };
}

for (const oldCount of [0, 114, 100000]) {
  test(`old purchase-only cache (${oldCount} reviews) never masquerades as the broader cohort`, async () => {
    const f = setup(summary(315856, 102598));
    f.db.prepare("INSERT INTO review_rating_cache VALUES(?,?,?,?,?,?)").run(
      "steam_reviews:2767030", JSON.stringify({ value: oldCount ? 90 : null, count: oldCount }),
      f.now, f.now, f.now + DAY, "ready");
    const loading = f.service.get(game, []);
    assert.equal(loading.players[0].count, null);
    assert.equal(loading.players[0].status, "loading");
    f.service.get(game, []); // same in-flight task
    await f.service.settle();
    const result = f.service.get(game, []);
    assert.equal(result.players[0].count, 418454);
    assert.equal(result.players[0].value, 315856 / 418454 * 100);
    assert.equal(result.players[0].reviewScope, "all");
    assert.equal(result.players[0].status, "ready");
    assert.equal(result.refreshing, false);
    assert.equal(f.calls.length, 1);
    assert.equal((f.db.prepare("SELECT count(*) n FROM opencritic_request_usage").get() as any).n, 0);
    assert.equal((f.db.prepare("SELECT count(*) n FROM review_rating_cache WHERE cache_key='steam_reviews:2767030'").get() as any).n, 1);
    f.db.close();
  });
}

test("genuine no-review result remains unavailable; zero positive with reviews is valid zero percent", async () => {
  for (const [positive, negative] of [[0, 0], [0, 5]]) {
    const f = setup(summary(positive, negative));
    f.service.get(game, []); await f.service.settle();
    const p = f.service.get(game, []).players[0];
    assert.equal(p.count, negative); assert.equal(p.value, negative ? 0 : null);
    assert.equal(p.status, negative ? "ready" : "unavailable");
    assert.equal(p.reviewScope, "all"); f.db.close();
  }
});

test("refresh failure keeps previous all-types data with its scope and freshness", async () => {
  const f = setup(summary(90, 10));
  f.service.get(game, []); await f.service.settle();
  const first = f.service.get(game, []).players[0];
  f.advance(); f.fail();
  f.service.get(game, []); await f.service.settle();
  const stale = f.service.get(game, []).players[0];
  assert.equal(stale.count, 100); assert.equal(stale.value, 90);
  assert.equal(stale.reviewScope, "all"); assert.equal(stale.status, "stale");
  assert.equal(stale.capturedAt, first.capturedAt);
  assert.equal(f.calls.length, 2);
  await f.service.settle(); f.db.close();
});

test("invalid responses never publish a zero count", async () => {
  for (const invalid of [{ success: 0 }, { success: 1 }, summary(-1, 2),
    { success: 1, query_summary: { total_positive: 1, total_negative: 2, total_reviews: 4 } }]) {
    const f = setup(invalid);
    f.service.get(game, []); await f.service.settle();
    const p = f.service.get(game, []).players[0];
    assert.equal(p.count, null); assert.equal(p.status, "error");
    assert.equal(f.calls.length, 1); f.db.close();
  }
});
