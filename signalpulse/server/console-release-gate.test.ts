import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { unreleasedGateSql, steamDerivationBlockedByFutureRelease } from "./console-release-gate";
import { editionGroupKey } from "./console-sales-family";

function visible(sqlFor: (col: string | null) => string, rows: Array<[string, string, string | null, string | null]>, platformFilter?: string) {
  const db = new Database(":memory:");
  db.function("console_identity_matches", (_a: unknown, _b: unknown) => 1);
  db.exec(`CREATE TABLE psm(id INTEGER, platform TEXT); CREATE TABLE igdb(title_id INTEGER, release_date TEXT, store_release_date TEXT, match_confidence TEXT, store_name TEXT, name TEXT);`);
  rows.forEach(([name, platform, rd, srd], i) => {
    db.prepare("INSERT INTO psm VALUES (?,?)").run(i + 1, platform);
    db.prepare("INSERT INTO igdb VALUES (?,?,?,NULL,?,?)").run(i + 1, rd, srd, name, name);
  });
  const sql = `SELECT igdb.name FROM psm JOIN igdb ON igdb.title_id = psm.id WHERE 1=1 ${sqlFor("psm.platform")} ${platformFilter ?? ""} ORDER BY psm.id`;
  return db.prepare(sql).all().map((r: any) => r.name);
}
const future = "2999-01-01", past = "2020-01-01";
const rows: Array<[string, string, string | null, string | null]> = [
  ["steam-future", "steam", future, null], ["ps5-future", "ps5", future, null], ["xbox-future", "xbox", null, future],
  ["steam-past", "steam", past, null], ["ps5-past", "ps5", past, null], ["ps5-unknown", "ps5", null, null],
];

test("multi-platform gate: Steam is exempt from the future-release filter, PS5 and Xbox are not", () => {
  assert.deepEqual(visible(c => unreleasedGateSql(c), rows), ["steam-future", "steam-past", "ps5-past", "ps5-unknown"]);
});
test("per-platform gate keeps the old behaviour for PS5/Xbox and exempts Steam", () => {
  assert.deepEqual(visible(() => unreleasedGateSql(null, "ps5"), rows, "AND psm.platform='ps5'"), ["ps5-past", "ps5-unknown"]);
  assert.deepEqual(visible(() => unreleasedGateSql(null, "xbox"), rows, "AND psm.platform='xbox'"), []);
  assert.deepEqual(visible(() => unreleasedGateSql(null, "steam"), rows, "AND psm.platform='steam'"), ["steam-future", "steam-past"]);
});
test("console revenue is never derived from a Steam row whose official release is in the future", () => {
  assert.equal(steamDerivationBlockedByFutureRelease("2026-10-06", "2026-10-02"), true);
  assert.equal(steamDerivationBlockedByFutureRelease("2026-10-06", "2026-10-06"), false);
  assert.equal(steamDerivationBlockedByFutureRelease("2026-10-01", "2026-10-02"), false);
  assert.equal(steamDerivationBlockedByFutureRelease(null, "2026-10-02"), false);
  assert.equal(steamDerivationBlockedByFutureRelease("garbage", "2026-10-02"), false);
});
test("trailing Pre-Order listings join their launched parent title; nothing else moves", () => {
  assert.equal(editionGroupKey("Gears of War: E-Day Premium Edition Pre-Order"), editionGroupKey("Gears of War: E-Day"));
  assert.equal(editionGroupKey("ACE COMBAT 8: WINGS OF THEVE Deluxe Edition Pre-Order"), editionGroupKey("ACE COMBAT 8: WINGS OF THEVE"));
  assert.equal(editionGroupKey("Some Game Pre-Purchase"), "some game");
  // Not trailing, and sequel/identity words stay.
  assert.equal(editionGroupKey("Aniimo Pre-Order Pack: Advanced Edition"), "aniimo pre-order pack: advanced edition");
  assert.notEqual(editionGroupKey("Gears of War: Reloaded"), editionGroupKey("Gears of War: E-Day"));
  assert.equal(editionGroupKey("Gears of War: Reloaded"), "gears of war: reloaded");
});
