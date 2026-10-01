import { test } from "node:test";
import assert from "node:assert/strict";
import { pickSharedPoolPrimaries } from "./console-shared-pool";
import { editionGroupKey } from "./console-sales-family";

const row = (o: any) => ({ ratingCount: 30707, avgRating: 4.04, windowUsed: "d30", estimateMethod: "backfill-observed-pace", msrpUsdCents: 4999, revenueMidUsd: 1e6, ...o });

test("Mafia shape: Definitive bootstrap + two regional originals count once, measured original wins", () => {
  const rows = [
    row({ titleId: 11236, name: "Mafia: The Old Country Definitive Edition", releaseDate: "2026-08-14", msrpUsdCents: 6499, windowUsed: "d90", estimateMethod: "backfill-bootstrap", revenueMidUsd: 51e6 }),
    row({ titleId: 10633, name: "Mafia: The Old Country", releaseDate: "2025-08-07", revenueMidUsd: 1.1e6 }),
    row({ titleId: 10339, name: "Mafia: The Old Country", releaseDate: "2025-08-07", msrpUsdCents: null, revenueMidUsd: null }),
  ];
  const { kept, dropped } = pickSharedPoolPrimaries(rows, "ps5", "d30", editionGroupKey);
  assert.deepEqual(kept.map(r => r.titleId), [10633]);
  assert.deepEqual(dropped.map(r => r.titleId).sort(), [10339, 11236]);
});

test("LTD window: the original (earliest release) is the pool's one contributor", () => {
  const rows = [
    row({ titleId: 11236, name: "Mafia: The Old Country Definitive Edition", releaseDate: "2026-08-14", msrpUsdCents: 6499, windowUsed: "ltd", estimateMethod: "ltd-anchor-median-v03", revenueMidUsd: 50e6 }),
    row({ titleId: 10633, name: "Mafia: The Old Country", releaseDate: "2025-08-07", windowUsed: "ltd", estimateMethod: "ltd-anchor-median-v03", revenueMidUsd: 38e6 }),
  ];
  assert.deepEqual(pickSharedPoolPrimaries(rows, "ps5", "ltd", editionGroupKey).kept.map(r => r.titleId), [10633]);
});

test("different pools, Steam, and small counts are never merged", () => {
  const a = row({ titleId: 1, name: "Some Game", releaseDate: "2024-01-01" });
  const b = row({ titleId: 2, name: "Some Game Deluxe Edition", releaseDate: "2024-01-01", ratingCount: 999 });
  assert.equal(pickSharedPoolPrimaries([a, b], "ps5", "d30", editionGroupKey).dropped.length, 0);
  const c = row({ titleId: 3, name: "Some Game", ratingCount: 40 }), d = row({ titleId: 4, name: "Some Game", ratingCount: 40 });
  assert.equal(pickSharedPoolPrimaries([c, d], "ps5", "d30", editionGroupKey).dropped.length, 0);
  assert.equal(pickSharedPoolPrimaries([a, { ...a, titleId: 9 }], "steam", "d30", editionGroupKey).dropped.length, 0);
});

test("counts a few ratings apart are one pool; cross-name merge keeps the anchored row", () => {
  const mc = row({ titleId: 10314, name: "Minecraft", ratingCount: 1992897, avgRating: 4.29, releaseDate: "2016-12-19", msrpUsdCents: 1999, windowUsed: "ltd" });
  const dx = row({ titleId: 10776, name: "Minecraft: Deluxe Collection", ratingCount: 1992899, avgRating: 4.29, releaseDate: "2026-03-31", msrpUsdCents: 2999, windowUsed: "ltd", revenueMidUsd: 1.5e9 });
  const r = pickSharedPoolPrimaries([dx, mc], "ps5", "ltd", editionGroupKey, { positive: new Set([10314]), zero: new Set() });
  assert.deepEqual(r.kept.map(x => x.titleId), [10314]);
  assert.equal(r.primaryOf.get(10776), 10314);
});

test("unrelated small titles a few ratings apart stay separate; different average stays separate", () => {
  const a = row({ titleId: 1, name: "Daddys Messy Day", ratingCount: 14424, avgRating: 3.1 });
  const b = row({ titleId: 2, name: "Call of Duty Black Ops", ratingCount: 14427, avgRating: 3.1 });
  assert.equal(pickSharedPoolPrimaries([a, b], "xbox", "ltd", editionGroupKey).dropped.length, 0);
  const c = row({ titleId: 3, name: "Alpha", ratingCount: 500, avgRating: 3 }), d = row({ titleId: 4, name: "Beta", ratingCount: 500, avgRating: 3 });
  assert.equal(pickSharedPoolPrimaries([c, d], "ps5", "ltd", editionGroupKey).dropped.length, 0);
  const e = row({ titleId: 5, name: "Same", ratingCount: 5000, avgRating: 3 }), f = row({ titleId: 6, name: "Same", ratingCount: 5000, avgRating: 3.1 });
  assert.equal(pickSharedPoolPrimaries([e, f], "ps5", "ltd", editionGroupKey).dropped.length, 0);
});

test("a verified zero anchor (manual de-dup) is never merged; two anchored titles both stay", () => {
  const base = row({ titleId: 10442, name: "Halloween: The Game", ratingCount: 165316, releaseDate: "2026-09-01" });
  const zero = row({ titleId: 10303, name: "Halloween - Digital Deluxe Edition", ratingCount: 165316 });
  assert.equal(pickSharedPoolPrimaries([base, zero], "ps5", "ltd", editionGroupKey, { positive: new Set(), zero: new Set([10303]) }).dropped.length, 0);
  const x = row({ titleId: 7, name: "Game A", ratingCount: 9000 }), y = row({ titleId: 8, name: "Game B", ratingCount: 9000 });
  assert.equal(pickSharedPoolPrimaries([x, y], "ps5", "ltd", editionGroupKey, { positive: new Set([7, 8]), zero: new Set() }).dropped.length, 0);
});

test("an unpriced earlier SKU never replaces a priced one (family keeps its revenue)", () => {
  const std = row({ titleId: 10445, name: "WWE 2K26 Standard Edition", releaseDate: "2026-03-13", ratingCount: 7908, msrpUsdCents: 6999 });
  const att = row({ titleId: 10371, name: "WWE 2K26: Attitude Era Edition", releaseDate: "2026-03-06", ratingCount: 7908, msrpUsdCents: null, revenueMidUsd: null });
  assert.deepEqual(pickSharedPoolPrimaries([att, std], "ps5", "d30", editionGroupKey).kept.map(r => r.titleId), [10445]);
});

test("unrelated titles matching by chance never merge; JP twin links by release date", () => {
  const a = row({ titleId: 10220, name: "Mortal Shell II", ratingCount: 1170, avgRating: 4.3 });
  const b = row({ titleId: 10415, name: "Mortal Kombat 11: Ultimate", ratingCount: 1170, avgRating: 4.3 });
  assert.equal(pickSharedPoolPrimaries([a, b], "xbox", "ltd", editionGroupKey).dropped.length, 0);
  const c = row({ titleId: 1, name: "Alpha Game", ratingCount: 20000, avgRating: 4, releaseDate: "2020-01-01" });
  const d = row({ titleId: 2, name: "Zulu Other", ratingCount: 20000, avgRating: 4, releaseDate: "2021-01-01" });
  assert.equal(pickSharedPoolPrimaries([c, d], "ps5", "ltd", editionGroupKey).dropped.length, 0);
  const e = row({ titleId: 3, name: "ソニック A", ratingCount: 20000, avgRating: 4, releaseDate: "2020-01-01" });
  const f = row({ titleId: 4, name: "ソニック B Deluxe", ratingCount: 20001, avgRating: 4, releaseDate: "2020-01-01" });
  assert.equal(pickSharedPoolPrimaries([e, f], "ps5", "ltd", editionGroupKey).dropped.length, 1);
});

import { sharedPoolViolations } from "./console-shared-pool";
test("output invariant: a board with two rows of one pool is flagged; two actual rows are allowed", () => {
  const a = row({ titleId: 10318, name: "Grand Theft Auto V", ratingCount: 1012310, avgRating: 4.1, dataSource: "actual", releaseDate: "2022-03-15" });
  const b = row({ titleId: 10768, name: "Grand Theft Auto Online", ratingCount: 1012310, avgRating: 4.1, dataSource: "estimated_console_exclusive", releaseDate: "2022-03-15" });
  assert.deepEqual(sharedPoolViolations([a, b], "ps5", editionGroupKey), [[10768, 10318]]);
  assert.deepEqual(sharedPoolViolations([a, { ...b, dataSource: "actual" }], "ps5", editionGroupKey), []);
  assert.deepEqual(sharedPoolViolations([a], "ps5", editionGroupKey), []);
});
