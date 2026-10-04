import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
test("rank-anchor floor skips titles with a per-title override", () => {
  const src = readFileSync(new URL("../scripts/estimate-console-units.ts", import.meta.url), "utf8");
  const i = src.indexOf("RANK_ANCHOR_SORT_KEY[row.platform]");
  assert.ok(i > 0);
  const before = src.slice(Math.max(0, i - 500), i);
  assert.match(before, /overrideByKey\.has\(`\$\{row\.titleId\}\|\$\{row\.platform\}`\)\) continue/);
});
