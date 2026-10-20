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

test("Call of Duty matches franchise-wide with the 65/10/25 console-skewed mix", () => {
  for (const n of ["Call of Duty®: Modern Warfare® 4", "CALL OF DUTY: MODERN WARFARE 4 - Vault Edition",
    "Call of Duty®: Black Ops 8", "Call of Duty®: Modern Warfare® 4 - Cross-Gen Edition"]) {
    assert.ok(ipRuleMatches(n), n);
  }
  // COD: PS5 = 65/25 = 2.6× Steam, Xbox = 10/25 = 0.4× Steam (user direction 2026-10-20).
  assert.equal(ipOverrideFactorFor("Call of Duty®: Modern Warfare® 4", "ps5")?.factor, 2.6);
  assert.equal(ipOverrideFactorFor("Call of Duty®: Modern Warfare® 4", "xbox")?.factor, 0.4);
  assert.equal(ipOverrideFactorFor("Call of Duty®: Modern Warfare® 4", "steam"), null);
  // Trademark glyphs and edition suffixes do not break the prefix match.
  assert.equal(ipOverrideFactorFor("CALL OF DUTY®: MODERN WARFARE® 4 - Vault Edition", "ps5")!.factor, 2.6);
  // The franchise hub row matches the rule but has no Steam sibling, so the
  // override cannot fire for it — matching is necessary, not sufficient.
  assert.ok(ipRuleMatches("Call of Duty®"));
  // Not-COD titles are not captured. (Note: "Callofdutyland"-style names DO
  // match — \s* tolerates zero whitespace, same as the EA prefix rules.)
  for (const n of ["Duty Caller", "Calls of Duty Simulator", "The Call of Duty of Love"]) {
    assert.equal(ipRuleMatches(n), false, n);
  }
});

test("unrelated titles are not captured", () => {
  for (const n of ["Madden Fan Art Simulator", "Football Manager 26", "Control Resonant", "FCC Compliance Simulator", "WWE 2K26", "NHL® 27 Standard Edition PS5"]) {
    assert.equal(ipRuleMatches(n), false, n);
  }
});

test("Minecraft Dungeons II: PS5 is set from its own ratings (0.216x Steam), Xbox keeps 0.77x, Minecraft Dungeons 1 stays on the default mix", () => {
  const ps5 = ipOverrideFactorFor("Minecraft Dungeons II", "ps5")!.factor, xbox = ipOverrideFactorFor("Minecraft Dungeons II", "xbox")!.factor;
  assert.ok(Math.abs(ps5 - 10.7 / 49.5) < 1e-9);
  assert.ok(Math.abs(xbox - 37.9 / 49.5) < 1e-9);
  assert.equal(ipOverrideFactorFor("MINECRAFT DUNGEONS II Deluxe Edition", "xbox")!.factor, xbox);
  assert.equal(ipOverrideFactorFor("MINECRAFT DUNGEONS II Deluxe Edition", "ps5")!.factor, ps5);
  assert.equal(ipOverrideFactorFor("Minecraft Dungeons for Windows + Launcher", "xbox"), null);
  assert.equal(ipOverrideFactorFor("Minecraft", "xbox"), null);
});
