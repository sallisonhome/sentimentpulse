import { test } from "node:test";
import assert from "node:assert/strict";
import { pickSharedPoolPrimaries } from "./routes-console-leaderboards";
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
