import { test } from "node:test";
import assert from "node:assert/strict";
import { ipOverrideFactorFor, ipRuleMatches, normalizeIpName } from "./routes-console-leaderboards";

test("console-first sports rules match store names with trademark glyphs", () => {
  for (const n of ["EA SPORTS™ Madden NFL 27", "Madden NFL 26", "EA SPORTS™ College Football 27", "EA Sports College Football 27",
    "EA SPORTS FC™ 26 Standard Edition PS4 & PS5", "EA SPORTS™ FC 27", "NBA 2K27: Deluxe Edition", "NBA 2K26 for PS5®"]) {
    assert.ok(ipRuleMatches(n), n);
  }
  assert.equal(normalizeIpName("EA SPORTS™  Madden NFL 27"), "EA SPORTS Madden NFL 27");
  // Madden: PS5 = 6.5x Steam, Xbox = 2.5x Steam (mix 65 / 25 / 10).
  assert.equal(ipOverrideFactorFor("EA SPORTS™ Madden NFL 27", "ps5")?.factor, 6.5);
  assert.equal(ipOverrideFactorFor("EA SPORTS™ Madden NFL 27", "xbox")?.factor, 2.5);
  assert.equal(ipOverrideFactorFor("EA SPORTS™ Madden NFL 27", "steam"), null);
});

test("unrelated titles are not captured", () => {
  for (const n of ["Madden Fan Art Simulator", "Football Manager 26", "Control Resonant", "FCC Compliance Simulator", "WWE 2K26", "NHL® 27 Standard Edition PS5"]) {
    assert.equal(ipRuleMatches(n), false, n);
  }
});
