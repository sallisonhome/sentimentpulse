import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readPage = (name: string) =>
  readFileSync(new URL(`../client/src/pages/${name}.tsx`, import.meta.url), "utf8");

test("sales presentation retains units/revenue but not intermediate owners", () => {
  for (const page of ["console-title-detail", "console-multiplatform-detail", "console-leaderboards"]) {
    const source = readPage(page);
    assert.doesNotMatch(source, /\bowners\b|ownersMid|owners_mid|combinedOwners/i, page);
    assert.match(source, /unitsMid/, page);
    assert.match(source, /revenue/i, page);
  }
});

test("combined totals use two responsive columns; both rating controls remain", () => {
  const combined = readPage("console-multiplatform-detail");
  assert.match(combined, /md:grid-cols-2[^"]*" data-testid="combined-kpi-row"/);
  assert.match(combined, /data\.combinedUnits/);
  assert.match(combined, /data\.combinedRevenueUsd/);
  const individual = readPage("console-title-detail");
  assert.match(individual, /id: "rating_count"/);
  assert.match(individual, /id: "avg_rating"/);
});
