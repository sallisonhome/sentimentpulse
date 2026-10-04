import { test } from "node:test";
import assert from "node:assert/strict";
import { correctedLtdUnits } from "./ltd-state-cap-correction";
const w = (window: string, u: number | null, method = "m", g: string | null = null) => ({ window, units_mid: u, method, gated_reason: g });
const capped = "rank_anchor:xbox_api_top_paid+ratings_cap_v1";
test("lowers stale state to the largest non-ltd window", () => {
  assert.deepEqual(correctedLtdUnits([w("d7", 154350, capped), w("d30", 154350), w("ltd", 311931)], 311931), { target: 154350, reason: "lower stored LTD to the largest window" });
});
test("refuses without the cap tag, without windows, or when it would raise", () => {
  assert.equal(correctedLtdUnits([w("d7", 154350, "rank_anchor:xbox_api_top_paid"), w("ltd", 1)], 311931).target, null);
  assert.equal(correctedLtdUnits([w("d7", null, capped)], 311931).target, null);
  assert.equal(correctedLtdUnits([w("d7", 400000, capped)], 311931).target, null);
});
test("gated windows are ignored", () => {
  assert.equal(correctedLtdUnits([w("d7", 100, capped), w("d30", 999999, "m", "no_signal")], 311931).target, 100);
});
