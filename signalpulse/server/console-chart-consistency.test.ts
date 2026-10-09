import { test } from "node:test";
import assert from "node:assert/strict";
import { applyChartConsistency, inLaunchWindow, chartModeFromEnv, groupChartRank, isChartExempt, CHART_MAX_RAISE, CHART_TOLERANCE, type ChartGroup } from "./console-chart-consistency";
import { CONSOLE_DAY_ACTUAL_TAG } from "./console-day-unit-actuals";

// 60 charted titles whose units follow a clean power law; ids 1..60 sit at rank = id.
function fixture() {
  const groups: ChartGroup[] = []; const ranks = new Map<number, number>();
  for (let i = 1; i <= 60; i++) {
    groups.push({ familyTitleIds: [i], dataSource: "estimated_console_exclusive", unitsMid: Math.round(100000 * Math.pow(i, -0.8)), revenueMidUsd: Math.round(100000 * Math.pow(i, -0.8)) * 30, ownersMid: 1 });
    ranks.set(i, i);
  }
  return { groups, ranks };
}
const clone = (g: ChartGroup[]) => g.map(x => ({ ...x, familyTitleIds: [...x.familyTitleIds] }));

test("mode parsing: default report, unknown falls back to report", () => {
  assert.equal(chartModeFromEnv(undefined), "report"); assert.equal(chartModeFromEnv("ENFORCE"), "enforce");
  assert.equal(chartModeFromEnv("off"), "off"); assert.equal(chartModeFromEnv("garbage"), "report");
});

test("a consistent chart is left untouched in every mode", () => {
  const { groups, ranks } = fixture(); const before = JSON.stringify(groups);
  for (const m of ["report", "enforce"] as const) {
    const g = clone(groups); const r = applyChartConsistency(g, ranks, new Set(), m);
    assert.equal(r.moved + r.capped, 0, m); assert.equal(JSON.stringify(g), before, m);
  }
});

test("ceiling: an over-estimated title is lowered to 1.5x the median of its five better-charting neighbours, units and revenue together", () => {
  const { groups, ranks } = fixture(); groups[29].unitsMid = groups[29].unitsMid! * 6; groups[29].revenueMidUsd = groups[29].unitsMid! * 30;
  const above = groups.slice(24, 29).map(g => g.unitsMid!).sort((a, b) => a - b);
  const expected = Math.round(CHART_TOLERANCE * above[2]);
  const g = clone(groups); const r = applyChartConsistency(g, ranks, new Set(), "enforce");
  assert.equal(g[29].unitsMid, expected); assert.equal(r.moved, 1);
  assert.ok(Math.abs(g[29].revenueMidUsd! / g[29].unitsMid! - 30) < 1e-6, "revenue scales with units (ASP preserved)");
  assert.match(String(g[29].estimateMethod), /chart_consistency_v1/);
  assert.equal((g[29].chartConsistency as any).bound, "ceiling");
});

test("report mode annotates the same rows but changes no number", () => {
  const { groups, ranks } = fixture(); groups[29].unitsMid = groups[29].unitsMid! * 6;
  const g = clone(groups); const r = applyChartConsistency(g, ranks, new Set(), "report");
  assert.equal(r.moved, 1); assert.equal(g[29].unitsMid, groups[29].unitsMid);
  assert.equal((g[29].chartConsistency as any).applied, false); assert.equal(g[29].estimateMethod, undefined);
});

test("off mode does nothing", () => {
  const { groups, ranks } = fixture(); groups[29].unitsMid = groups[29].unitsMid! * 6;
  const g = clone(groups); assert.equal(applyChartConsistency(g, ranks, new Set(), "off").skipped, "off");
  assert.equal(g[29].unitsMid, groups[29].unitsMid); assert.equal(g[29].chartConsistency, undefined);
});

test("floor: an under-estimated title is raised, never by more than the raise cap", () => {
  const { groups, ranks } = fixture(); const orig = groups[29].unitsMid!; groups[29].unitsMid = Math.round(orig / 20);
  const g = clone(groups); applyChartConsistency(g, ranks, new Set(), "enforce");
  assert.ok(g[29].unitsMid! > groups[29].unitsMid!); assert.ok(g[29].unitsMid! <= CHART_MAX_RAISE * groups[29].unitsMid!);
  assert.equal((g[29].chartConsistency as any).bound, "floor");
});

test("anchors, actuals, verified anchors and overrides are never moved but still serve as references", () => {
  const { groups, ranks } = fixture();
  for (const [idx, src] of [[19, "actual"], [20, "native_public_ceiling"], [21, "scaled_to_verified_ltd_anchor_units"], [22, "estimated_public_unit_milestone"]] as const) { groups[idx].dataSource = src; groups[idx].unitsMid = groups[idx].unitsMid! * 20; }
  groups[23].verifiedAnchorUnits = 123; groups[23].unitsMid = groups[23].unitsMid! * 20;
  groups[24].unitsMid = groups[24].unitsMid! * 20;                                    // override via title table
  groups[25].estimateMethod = "override:alinea_analytics_3day"; groups[25].unitsMid = groups[25].unitsMid! * 20;
  const g = clone(groups); applyChartConsistency(g, ranks, new Set([25]), "enforce");   // title 25 = groups[24]
  for (const i of [19, 20, 21, 22, 23, 24, 25]) assert.equal(g[i].unitsMid, groups[i].unitsMid, `row ${i} must not move`);
  assert.equal(isChartExempt({ familyTitleIds: [1], unitsMid: 1, revenueMidUsd: 1, dataSource: "actual" }, new Set()), true);
  assert.equal(isChartExempt({ familyTitleIds: [1], unitsMid: 1, revenueMidUsd: 1, dataSource: "derived_from_steam_ip_override" }, new Set()), false);
});

test("rows anchored on an operator day-one actual (d1_actual_anchor tag) are never moved but still serve as references", () => {
  const { groups, ranks } = fixture(); groups[29].unitsMid = groups[29].unitsMid! * 6;
  groups[29].estimateMethod = `ltd-anchor-median-v03+${CONSOLE_DAY_ACTUAL_TAG}+ltd_state:derived_max_windows`;
  const g = clone(groups); const r = applyChartConsistency(g, ranks, new Set(), "enforce");
  assert.equal(g[29].unitsMid, groups[29].unitsMid, "anchored row must not move");
  assert.equal(r.moved + r.capped, 0);
  assert.equal(isChartExempt({ familyTitleIds: [1], unitsMid: 1, revenueMidUsd: 1, estimateMethod: `x+${CONSOLE_DAY_ACTUAL_TAG}` }, new Set()), true);
});

test("results do not depend on row order even when neighbours are adjusted too", () => {
  const { groups, ranks } = fixture(); groups[29].unitsMid = groups[29].unitsMid! * 6; groups[30].unitsMid = groups[30].unitsMid! * 6;
  const a = clone(groups); applyChartConsistency(a, ranks, new Set(), "enforce");
  const rev = clone(groups).reverse(); applyChartConsistency(rev, ranks, new Set(), "enforce"); rev.reverse();
  assert.deepEqual(a.map(x => x.unitsMid), rev.map(x => x.unitsMid));
});

test("off-chart title is capped at 1.5x the median of the five deepest charted titles; an uncharted small title is untouched", () => {
  const { groups, ranks } = fixture();
  groups.push({ familyTitleIds: [999], dataSource: "derived_from_steam", unitsMid: 900000, revenueMidUsd: 27000000 });
  groups.push({ familyTitleIds: [998], dataSource: "derived_from_steam", unitsMid: 10, revenueMidUsd: 300 });
  const deepest = groups.slice(55, 60).map(g => g.unitsMid!).sort((a, b) => a - b);
  const g = clone(groups); const r = applyChartConsistency(g, ranks, new Set(), "enforce");
  assert.equal(g[60].unitsMid, Math.round(CHART_TOLERANCE * deepest[2])); assert.equal(g[61].unitsMid, 10); assert.equal(r.capped, 1);
});

test("thin chart (<50 ranked titles) skips the whole pass", () => {
  const { groups, ranks } = fixture(); const few = groups.slice(0, 30); few[10].unitsMid = few[10].unitsMid! * 50;
  const g = clone(few); const r = applyChartConsistency(g, ranks, new Set(), "enforce");
  assert.match(String(r.skipped), /thin_chart/); assert.equal(g[10].unitsMid, few[10].unitsMid);
});

test("null, zero and gated units are ignored; multi-SKU family uses its combined rank", () => {
  const { groups, ranks } = fixture(); groups[5].unitsMid = null; groups[6].unitsMid = 0;
  const g = clone(groups); applyChartConsistency(g, ranks, new Set(), "enforce"); assert.equal(g[5].unitsMid, null); assert.equal(g[6].unitsMid, 0);
  const fam: ChartGroup = { familyTitleIds: [40, 41], unitsMid: 1, revenueMidUsd: 1 };
  assert.equal(groupChartRank(fam, ranks), 15);   // two SKUs near #40 sum to the demand of one slot at ~#15 (units ~ rank^-0.7)
});

test("invariant: values stay positive and finite and raises stay capped at 3x (randomised, 200 charts, iteration included)", () => {
  let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  for (let t = 0; t < 200; t++) {
    const { groups, ranks } = fixture();
    for (const g of groups) if (rnd() < 0.3) g.unitsMid = Math.max(1, Math.round(g.unitsMid! * Math.exp((rnd() - 0.5) * 5)));
    const pre = clone(groups); const g = clone(groups); applyChartConsistency(g, ranks, new Set(), "enforce");
    g.forEach((row, i) => {
      assert.ok(row.unitsMid! > 0 && Number.isFinite(row.unitsMid!));
      if (row.unitsMid! > pre[i].unitsMid!) assert.ok(row.unitsMid! <= CHART_MAX_RAISE * pre[i].unitsMid! + 1);
    });
  }
});

test("off-chart cap never applies to a title that charted on a recent snapshot; public-ceiling families are exempt", () => {
  const { groups, ranks } = fixture();
  groups.push({ familyTitleIds: [999], dataSource: "derived_from_steam", unitsMid: 900000, revenueMidUsd: 1 });
  groups.push({ familyTitleIds: [998], dataSource: "derived_from_steam", unitsMid: 900000, revenueMidUsd: 1, editionGroupKey: "valheim" });
  const g1 = clone(groups); applyChartConsistency(g1, ranks, new Set(), "enforce", { recentlyCharted: new Set([999]) });
  assert.equal(g1[60].unitsMid, 900000, "missed today but charted recently: untouched"); assert.ok(g1[61].unitsMid! < 900000);
  const g2 = clone(groups); applyChartConsistency(g2, ranks, new Set(), "enforce", { recentlyCharted: new Set(), extraExempt: g => g.editionGroupKey === "valheim" });
  assert.ok(g2[60].unitsMid! < 900000, "absent from every recent snapshot: capped"); assert.equal(g2[61].unitsMid, 900000, "public ceiling family exempt");
});

test("launch window: a pre-order / launch-week title is annotated but never moved, in enforce mode too", () => {
  const { groups, ranks } = fixture();
  groups[29].unitsMid = groups[29].unitsMid! * 8; groups[29].revenueMidUsd = groups[29].revenueMidUsd! * 8;
  groups[29].releaseDate = "2026-10-01";          // Gears-like: premium early access opened 10-01, launch 10-06
  const g = clone(groups); const before = g[29].unitsMid;
  const res = applyChartConsistency(g, ranks, new Set(), "enforce", { today: "2026-10-04" });
  assert.equal(g[29].unitsMid, before); assert.equal(res.protectedLaunch, 1);
  assert.equal((g[29].chartConsistency as any).bound, "launch_window_protected"); assert.equal((g[29].chartConsistency as any).applied, false);
  // same title once the window has passed is moved like any other
  const h = clone(groups); applyChartConsistency(h, ranks, new Set(), "enforce", { today: "2026-10-09" });
  assert.ok(h[29].unitsMid! < before);
  assert.equal(inLaunchWindow("2026-10-06", "2026-10-04"), true);   // future release (pre-order)
  assert.equal(inLaunchWindow("2026-09-26", "2026-10-04"), false);
  assert.equal(inLaunchWindow(null, "2026-10-04"), false); assert.equal(inLaunchWindow("bad", "2026-10-04"), false);
});

// Regression for Minecraft Dungeons II on PS5 (2026-10-04): the ceiling for a title came from the median of its
// neighbours' PRE-cut values, two of which were inflated and about to be cut or were launch-protected, so the title
// kept a bound of 168K while its neighbours settled at 16K-54K.
function mdFixture() {
  const { groups, ranks } = fixture();
  // title at rank 30; its five better-charting neighbours (ranks 25..29) are inflated 6x and are themselves out of bounds
  for (const i of [24, 25, 26, 27, 28]) groups[i].unitsMid = groups[i].unitsMid! * 6;
  groups[29].unitsMid = groups[29].unitsMid! * 10;
  return { groups, ranks };
}

test("a ceiling follows the neighbours' adjusted values, not the pre-cut values they are about to lose", () => {
  const { groups, ranks } = mdFixture();
  const g = clone(groups); applyChartConsistency(g, ranks, new Set(), "enforce");
  const adjAbove = g.slice(24, 29).map(x => x.unitsMid!).sort((a, b) => a - b);
  const bound = Math.round(CHART_TOLERANCE * adjAbove[2]);
  assert.ok(g[29].unitsMid! <= bound + 1, `rank 30 holds ${g[29].unitsMid} but adjusted neighbours bound it at ${bound}`);
  // the old single-pass bound, for contrast, is far higher
  const preAbove = groups.slice(24, 29).map(x => x.unitsMid!).sort((a, b) => a - b);
  assert.ok(Math.round(CHART_TOLERANCE * preAbove[2]) > bound, "the single-pass bound would have been higher");
  // report mode shows the same final bound and changes nothing
  const r = clone(groups); applyChartConsistency(r, ranks, new Set(), "report");
  assert.equal(r[29].unitsMid, groups[29].unitsMid);
  assert.equal((r[29].chartConsistency as any).after, g[29].unitsMid);
});

test("a launch-week title is not used as a reference for its neighbours", () => {
  const { groups, ranks } = fixture();
  groups[26].unitsMid = groups[26].unitsMid! * 20; groups[26].releaseDate = "2026-10-01";   // inflated launch title at rank 27
  groups[29].unitsMid = groups[29].unitsMid! * 3;                                            // rank 30, above its neighbours' scale
  const g = clone(groups); applyChartConsistency(g, ranks, new Set(), "enforce", { today: "2026-10-04" });
  assert.equal(g[26].unitsMid, groups[26].unitsMid, "the launch title itself is never moved");
  const clean = groups.slice(24, 29).filter((_, i) => i !== 2).map(x => x.unitsMid!);   // neighbours without the launch title
  const nbrs = [groups[23].unitsMid!, ...clean].sort((a, b) => a - b);
  assert.ok(g[29].unitsMid! <= Math.round(CHART_TOLERANCE * nbrs[2]) + 1);
});

test("a consistent chart is untouched by the iteration", () => {
  const { groups, ranks } = fixture();
  const before = JSON.stringify(groups);
  const g = clone(groups); applyChartConsistency(g, ranks, new Set(), "enforce");
  assert.equal(JSON.stringify(g), before);
});
