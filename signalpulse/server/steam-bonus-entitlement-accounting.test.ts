import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBonusEntitlementRow } from "./steam-sales-accounting";

// Production evidence (2026-09-30): Hellraiser had 19,303 base units / $809,597 and exactly
// 19,303 "DLC" units / $0 over 42 portal days. The $0 rows are bonus entitlements attached to
// base purchases, so counting them doubled units and halved ASP ($41.94 -> $20.97).
const row = (skuGroup: string, netUnits: number, rev: number, gross = rev) =>
  ({ skuGroup, netUnits, netRevenueUsd: rev, grossRevenueUsd: gross });

test("rule: only zero-revenue DLC rows are bonus entitlements", () => {
  assert.equal(isBonusEntitlementRow(row("dlc", 100, 0)), true);
  assert.equal(isBonusEntitlementRow(row("dlc", 100, 1000)), false); // paid $10 upgrade stays a sale
  assert.equal(isBonusEntitlementRow(row("dlc", 5, -20, 40)), false); // refunds are not bonuses
  assert.equal(isBonusEntitlementRow(row("base", 100, 0)), false); // base rows are never reclassified
  assert.equal(isBonusEntitlementRow(row("other", 100, 0)), false);
});

test("summary, country chart and ASP count each Hellraiser unit once; paid upgrades stay separate", async () => {
  const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), "bonus-entitlement-"));
  process.chdir(dir);
  try {
    const { storage, rawSqlite: db } = await import("./storage");
    const { computeSalesByCountry } = await import("./promo-support-routes");
    const stamp = new Date().toISOString();
    db.prepare(`INSERT INTO products(id,title,platforms,player_format,genre,release_date,steam_app_id,created_at,updated_at)
      VALUES(901,'Bonus Test','["pc"]','single','action','2026-10-08','9000901',?,?)`).run(stamp, stamp);
    const days = ["2026-09-01", "2026-09-02"];
    const mk = (date: string, skuGroup: string, units: number, rev: number) => ({
      productId: 901, date, skuGroup, netUnits: units, grossUnits: units, returns: 0,
      netRevenueUsd: rev, grossRevenueUsd: rev, source: "portal_fetch", batchId: "t",
    });
    storage.upsertSteamSalesRows(days.flatMap(d => [
      mk(d, "base", 100, 4200), mk(d, "dlc", 100, 0), // bonus entitlement mirrors base units
    ]) as any);
    storage.upsertSteamSalesByCountry(days.map(d => ({
      productId: 901, periodStart: d, periodEnd: d, granularity: "day", countryIso: "US", countryName: "United States",
      units: 60, revenueUsd: 2800, activations: 0, activationRevenueUsd: 0, pctOfUnits: 0.6, pctOfRevenue: 0.7, source: "portal_fetch",
    })).concat(days.map(d => ({
      productId: 901, periodStart: d, periodEnd: d, granularity: "day", countryIso: "DE", countryName: "Germany",
      units: 40, revenueUsd: 1200, activations: 0, activationRevenueUsd: 0, pctOfUnits: 0.4, pctOfRevenue: 0.3, source: "portal_fetch",
    }))) as any);

    // Summary
    const s = storage.getSteamSalesSummary(901);
    assert.equal(s.baseNetUnits, 200);
    assert.equal(s.dlcNetUnits, 0);
    assert.equal(s.dlcNetRevenueUsd, 0);
    assert.equal(s.bonusEntitlementUnits, 200);

    // Country chart: units equal base units, ASP equals base ASP, DLC is zero
    const c = computeSalesByCountry(901, "2026-09-01", "2026-09-02");
    assert.equal(c.total_units_authoritative, 200);
    assert.equal(c.base_units, 200);
    assert.equal(c.dlc_units, 0);
    assert.equal(Math.round(c.total_units), 200);
    assert.ok(Math.abs(c.asp_usd - 42) < 0.01, `ASP ${c.asp_usd}`);
    assert.ok(c.countries.every(x => x.asp_usd > 0));

    // A later paid upgrade is tracked as DLC, separately from base copies.
    storage.upsertSteamSalesRows([mk("2026-09-03", "base", 100, 4200), mk("2026-09-03", "dlc", 10, 100)] as any);
    const s2 = storage.getSteamSalesSummary(901);
    assert.equal(s2.baseNetUnits, 300);
    assert.equal(s2.dlcNetUnits, 10);
    assert.equal(s2.dlcNetRevenueUsd, 100);
  } finally {
    process.chdir(cwd);
  }
});
