import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { changeExplainedBySignal, allocateSpan, allocationEnabled, launchBaseline, loadGapEvidence, protectionReason, type GapEvidence, type SeriesRow } from "./daily-gap-allocation";

const sum = (m: Map<string, number>) => Array.from(m.values()).reduce((a, b) => a + b, 0);
function evidence(): GapEvidence {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE store_rating_signal_daily(title_id,platform,capture_date,rating_count,created_at);
    CREATE TABLE platform_sku_map(title_id,platform,external_sku);
    CREATE TABLE steam_review_history(app_id,bucket_start,bucket_granularity,recommendations_up,recommendations_down);
    CREATE TABLE console_title_igdb(title_id,release_date,store_release_date);
    INSERT INTO platform_sku_map VALUES(1,'steam','3669870'),(2,'ps5','PS'),(3,'xbox','XB');
    INSERT INTO console_title_igdb VALUES(1,'2026-09-24',NULL),(2,NULL,'2026-09-24'),(3,NULL,NULL);
  `);
  const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 1000;
  [["24", 768, 118], ["25", 1313, 177], ["26", 1031, 149]].forEach(([d, u, n]) =>
    db.prepare("INSERT INTO steam_review_history VALUES('3669870',?, 'day',?,?)").run(day(`2026-09-${d}`), u, n));
  db.prepare("INSERT INTO steam_review_history VALUES('3669870',?, 'week',5111,638)").run(day("2026-09-24"));
  const r = (id: number, p: string, d: string, n: number | null, t = "2026-09-25T00:00:00Z") =>
    db.prepare("INSERT INTO store_rating_signal_daily VALUES(?,?,?,?,?)").run(id, p, d, n, t);
  r(1, "steam", "2026-09-24", null); r(1, "steam", "2026-09-25", 2003);
  r(2, "ps5", "2026-09-22", 0); r(2, "ps5", "2026-09-23", 462); r(2, "ps5", "2026-09-25", 2253);
  r(3, "xbox", "2026-09-24", 60, "2026-09-24T09:00:00Z"); r(3, "xbox", "2026-09-24", 82, "2026-09-24T17:00:00Z"); r(3, "xbox", "2026-09-25", 132);
  return loadGapEvidence(db, [1, 2, 3]);
}
const rows = (...r: Array<[string, number | null, number | null]>): SeriesRow[] => r.map(([date, units, signal]) => ({ date, units, signal }));

test("evidence loader uses day buckets only, last snapshot per day, earliest release", () => {
  const ev = evidence();
  assert.equal(ev.steamDaily.get("2026-09-24"), 886);
  assert.equal(ev.steamDaily.size, 3);
  assert.equal(ev.ratings.xbox.get("2026-09-24"), 82);
  assert.equal(ev.releaseDate, "2026-09-24");
});

test("Steam launch seed is split by dated review activity with a snapshot-consistent final day", () => {
  const ev = evidence();
  const series = rows(["2026-09-22", null, null], ["2026-09-23", null, null], ["2026-09-25", 80522, 2003]);
  assert.equal(launchBaseline(series, 2, ev, "steam"), "2026-09-23");
  const a = allocateSpan("steam", "launch", ["2026-09-24", "2026-09-25"], 80522, "2026-09-23", true, ev)!;
  // Sep 25 and Sep 26 review buckets are stored, so the reviews-trail-purchases lag applies.
  assert.equal(a.basis, "steam_review_activity_lag1");
  assert.ok(Math.abs(a.units.get("2026-09-24")! - 80522 * 1490 / (1490 + 1180)) < 1e-6);
  // Without the following day's bucket the same-day, snapshot-consistent split is used.
  ev.steamDaily.delete("2026-09-26");
  const same = allocateSpan("steam", "launch", ["2026-09-24", "2026-09-25"], 80522, "2026-09-23", true, ev)!;
  assert.equal(same.basis, "steam_review_activity");
  assert.ok(Math.abs(same.units.get("2026-09-24")! - 80522 * 886 / 2003) < 1e-6);
  assert.ok(Math.abs(sum(a.units) - 80522) < 1e-6);
});

test("console launch uses a recorded zero baseline and its own rating growth", () => {
  const ev = evidence();
  const ps5 = rows(["2026-09-22", null, 0], ["2026-09-23", 14589, 462]);
  assert.equal(launchBaseline(ps5, 1, ev, "ps5"), "2026-09-22");
  const one = allocateSpan("ps5", "launch", ["2026-09-23"], 14589, "2026-09-22", true, ev)!;
  assert.equal(one.units.get("2026-09-23"), 14589);
  const xbox = rows(["2026-09-25", 21560, 132]);
  assert.equal(launchBaseline(xbox, 0, ev, "xbox"), "2026-09-23");
  const x = allocateSpan("xbox", "launch", ["2026-09-24", "2026-09-25"], 21560, "2026-09-23", true, ev)!;
  assert.equal(x.basis, "own_ratings");
  assert.ok(Math.abs(x.units.get("2026-09-24")! - 21560 * 82 / 132) < 1e-6);
  assert.ok(Math.abs(sum(x.units) - 21560) < 1e-6);
});

test("missed day on a console without its own evidence follows Steam activity shape and conserves the change", () => {
  const ev = evidence();
  const a = allocateSpan("ps5", "gap", ["2026-09-24", "2026-09-25"], 56558, "2026-09-23", false, ev)!;
  assert.equal(a.basis, "steam_activity_shape");
  assert.ok(Math.abs(a.units.get("2026-09-24")! - 56558 * 886 / (886 + 1490)) < 1e-6);
  assert.ok(Math.abs(sum(a.units) - 56558) < 1e-6);
});

test("no dated evidence means no allocation: never an even split", () => {
  const ev = evidence();
  assert.equal(allocateSpan("ps5", "gap", ["2026-10-01", "2026-10-02"], 100, "2026-09-30", false, ev), null);
  assert.equal(allocateSpan("ps5", "gap", Array.from({ length: 8 }, (_, i) => `2026-10-0${i + 1}`), 100, "x", false, ev), null);
  assert.equal(launchBaseline(rows(["2026-10-05", 100, 5]), 0, { ...ev, releaseDate: null }, "ps5"), null);
  // A catalog appearance of an old title (or a bogus SKU inheriting one) is not a launch.
  assert.equal(launchBaseline(rows(["2026-09-22", null, 0], ["2026-09-23", 1230979, 38981]), 1, { ...ev, releaseDate: "2024-09-09" }, "ps5"), null);
  const none = { ...ev, ratings: { steam: new Map(), ps5: new Map(), xbox: new Map() } };
  // Launch never borrows another platform's shape.
  assert.equal(allocateSpan("ps5", "launch", ["2026-09-24", "2026-09-25"], 100, "2026-09-23", true, none), null);
  assert.equal(allocateSpan("ps5", "gap", ["2026-09-24"], -5, "x", false, ev), null);
});

// Saber's Steamworks actuals for Twisted Tower (app 1575990), launch 2026-08-18, against stored
// daily review buckets. Reviews trail purchases, so launch seeds weight by next-day reviews.
const TT_ACTUAL = [9176, 4793, 3485, 3039, 2651, 1604, 1015, 824, 779, 624, 732, 727, 624, 523, 314, 0];
const TT_REVIEWS = [160, 345, 211, 141, 151, 122, 86, 75, 59, 48, 36, 53, 50, 36, 26, 20];
test("launch weights are validated against Saber actual daily sales", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE store_rating_signal_daily(title_id,platform,capture_date,rating_count,created_at);
    CREATE TABLE platform_sku_map(title_id,platform,external_sku);
    CREATE TABLE steam_review_history(app_id,bucket_start,bucket_granularity,recommendations_up,recommendations_down);
    CREATE TABLE console_title_igdb(title_id,release_date,store_release_date);
    INSERT INTO platform_sku_map VALUES(1,'steam','1575990');
    INSERT INTO console_title_igdb VALUES(1,'2026-08-18',NULL);`);
  TT_REVIEWS.forEach((n, i) => db.prepare("INSERT INTO steam_review_history VALUES('1575990',?,'day',?,0)")
    .run(Date.parse("2026-08-18T00:00:00Z") / 1000 + i * 86400, n));
  const ev = loadGapEvidence(db, [1]);
  const dates = Array.from({ length: 14 }, (_, i) => new Date(Date.parse("2026-08-18T00:00:00Z") + i * 86400000).toISOString().slice(0, 10));
  const total = TT_ACTUAL.slice(0, 14).reduce((a, b) => a + b, 0);
  const a = allocateSpan("steam", "launch", dates, total, "2026-08-17", true, ev)!;
  assert.equal(a.basis, "steam_review_activity_lag1");
  const misallocated = dates.reduce((s, d, i) => s + Math.abs(a.units.get(d)! / total - TT_ACTUAL[i] / total), 0) / 2;
  assert.ok(misallocated < 0.1, `misallocated ${misallocated}`);
  // Same-day review shares would misallocate more than twice as much.
  const same = TT_REVIEWS.slice(0, 14), sameSum = same.reduce((x, y) => x + y, 0);
  const sameErr = same.reduce((s, n, i) => s + Math.abs(n / sameSum - TT_ACTUAL[i] / total), 0) / 2;
  assert.ok(sameErr > 2 * misallocated);
});

test("kill switch", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE app_settings(key,value)");
  assert.equal(allocationEnabled(db), true);
  db.exec("INSERT INTO app_settings VALUES('daily_gap_allocation_enabled','0')");
  assert.equal(allocationEnabled(db), false);
});

test("only signal-explained changes are allocated; rebasing jumps are not", () => {
  // Control Resonant PS5: 14,589 -> 71,147 units on 462 -> 2,253 ratings (~31.6 units per rating).
  assert.equal(changeExplainedBySignal(56558, 462, 2253, 71147), true);
  // Black Myth-style method flip: +13.6M units on +260 reviews.
  assert.equal(changeExplainedBySignal(13656905, 897760, 898020, 36100905), false);
  assert.equal(changeExplainedBySignal(10, null, 100, 1000), false);
  assert.equal(changeExplainedBySignal(10, 100, 90, 1000), false);
  assert.equal(changeExplainedBySignal(0, 100, 100, 1000), true);
});

test("anchored, overridden, milestone and Saber titles are never reallocated", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE revenue_calibration_anchors(title_id);
    CREATE TABLE title_multiplier_overrides(title_id);
    CREATE TABLE steam_unit_milestones(title_id,active);
    CREATE TABLE products(steam_app_id);
    CREATE TABLE platform_sku_map(title_id,platform,external_sku);
    INSERT INTO platform_sku_map VALUES(1,'steam','111'),(2,'steam','222'),(3,'ps5','P'),(4,'steam','444'),(5,'steam','555');`);
  assert.equal(protectionReason(db, [1]), null);
  db.exec("INSERT INTO revenue_calibration_anchors VALUES(1)");
  assert.equal(protectionReason(db, [1, 3]), "revenue_anchor");
  db.exec("INSERT INTO title_multiplier_overrides VALUES(3)");
  assert.equal(protectionReason(db, [3]), "multiplier_override");
  db.exec("INSERT INTO steam_unit_milestones VALUES(4,1),(5,0)");
  assert.equal(protectionReason(db, [4]), "public_milestone");
  assert.equal(protectionReason(db, [5]), null);
  db.exec("INSERT INTO products VALUES('222')");
  assert.equal(protectionReason(db, [2]), "saber_product");
  assert.equal(protectionReason(db, []), "no_titles");
  db.exec("DROP TABLE products");
  assert.equal(protectionReason(db, [5]), null);
});
