import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Production evidence (Hellraiser, 2026-09-30): day-level country rows existed for 17 of 42 days.
// The other 25 days fell back to a month panel with ~$216 of country revenue against ~$810k of
// real sales, which clipped every country to the ASP floor and renormalized them all to one
// identical ASP ($41.94 in all 85 countries).

test("isRevenueIncomplete: sparse wide panel is flagged, complete panel is not", async () => {
  const cwd = process.cwd();
  process.chdir(mkdtempSync(join(tmpdir(), "country-pooled-rule-")));
  const { isRevenueIncomplete } = await import("./promo-support-routes");
  process.chdir(cwd);
  const rev = new Map([["2026-09-01", 1000], ["2026-09-02", 1000], ["2026-10-05", 5000]]);
  const bucket = { start: "2026-09-01", end: "2026-09-30" };
  assert.equal(isRevenueIncomplete(bucket, [{ revenueUsd: 216 }], rev), true);
  assert.equal(isRevenueIncomplete(bucket, [{ revenueUsd: 1900 }], rev), false);
  assert.equal(isRevenueIncomplete(bucket, [{ revenueUsd: 0 }], new Map()), false); // no sales to compare
});

async function setup(productId: number) {
  const dir = mkdtempSync(join(tmpdir(), "country-pooled-"));
  process.chdir(dir);
  const { storage, rawSqlite: db } = await import("./storage");
  const { computeSalesByCountry } = await import("./promo-support-routes");
  const stamp = new Date().toISOString();
  db.prepare(`INSERT INTO products(id,title,platforms,player_format,genre,release_date,steam_app_id,created_at,updated_at)
    VALUES(?,'Pooled Test','["pc"]','single','action','2026-10-08',?,?,?)`).run(productId, String(9100 + productId), stamp, stamp);
  const days = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06"];
  storage.upsertSteamSalesRows(days.map(d => ({
    productId, date: d, skuGroup: "base", netUnits: 100, grossUnits: 100, returns: 0,
    netRevenueUsd: 4200, grossRevenueUsd: 4200, source: "portal_fetch", batchId: "t",
  })) as any);
  const row = (periodStart: string, periodEnd: string, granularity: string, iso: string, name: string,
    units: number, rev: number, pu: number | null, pr: number | null) => ({
    productId, periodStart, periodEnd, granularity, countryIso: iso, countryName: name, units, revenueUsd: rev,
    activations: 0, activationRevenueUsd: 0, pctOfUnits: pu, pctOfRevenue: pr, source: "portal_fetch",
  });
  return { storage, computeSalesByCountry, days, row };
}

test("days without day-level revenue use the pooled country profile instead of one flat ASP", async () => {
  const cwd = process.cwd();
  try {
    const { storage, computeSalesByCountry, days, row } = await setup(911);
    const rows: any[] = [];
    // Day-level shares on the first two days: US 60% units / 70% rev (ASP $49), DE 40% / 30% ($31.50)
    for (const d of days.slice(0, 2)) {
      rows.push(row(d, d, "day", "US", "United States", 60, 2940, 0.6, 0.7));
      rows.push(row(d, d, "day", "DE", "Germany", 40, 1260, 0.4, 0.3));
    }
    // Remaining four days: only a month panel with almost no revenue and no percentages
    rows.push(row("2026-09-01", "2026-09-30", "month", "US", "United States", 600, 0, null, null));
    rows.push(row("2026-09-01", "2026-09-30", "month", "DE", "Germany", 400, 5, null, null));
    storage.upsertSteamSalesByCountry(rows as any);

    const c = computeSalesByCountry(911, "2026-09-01", "2026-09-06");
    assert.equal(c.days_in_window, 6);
    assert.equal(c.days_pooled_profile, 4);
    assert.equal(c.shares_source, "authoritative");
    assert.equal(c.total_units_authoritative, 600);
    assert.ok(Math.abs(c.total_revenue_usd - 25200) < 1, `revenue ${c.total_revenue_usd}`);
    const us = c.countries.find(x => x.country_iso === "US")!;
    const de = c.countries.find(x => x.country_iso === "DE")!;
    assert.ok(Math.abs(us.asp_usd - 49) < 0.5, `US ASP ${us.asp_usd}`);
    assert.ok(Math.abs(de.asp_usd - 31.5) < 0.5, `DE ASP ${de.asp_usd}`);
    assert.notEqual(Math.round(us.asp_usd), Math.round(de.asp_usd));
  } finally { process.chdir(cwd); }
});

test("with no authoritative days at all, a month panel keeps its previous behavior", async () => {
  const cwd = process.cwd();
  try {
    const { storage, computeSalesByCountry, row } = await setup(912);
    storage.upsertSteamSalesByCountry([
      row("2026-09-01", "2026-09-30", "month", "US", "United States", 600, 29400, null, null),
      row("2026-09-01", "2026-09-30", "month", "DE", "Germany", 400, 12600, null, null),
    ] as any);
    const c = computeSalesByCountry(912, "2026-09-01", "2026-09-06");
    assert.equal(c.days_pooled_profile, 0);
    assert.equal(c.shares_source, "legacy");
    const us = c.countries.find(x => x.country_iso === "US")!;
    assert.ok(Math.abs(us.asp_usd - 49) < 0.5, `US ASP ${us.asp_usd}`);
  } finally { process.chdir(cwd); }
});

test("days with no country rows at all are attributed with the pooled profile, not skipped", async () => {
  const cwd = process.cwd();
  try {
    const { storage, computeSalesByCountry, days, row } = await setup(913);
    const rows: any[] = [];
    // Only the first two days have country rows; the other four have none at any granularity.
    for (const d of days.slice(0, 2)) {
      rows.push(row(d, d, "day", "US", "United States", 60, 2940, 0.6, 0.7));
      rows.push(row(d, d, "day", "DE", "Germany", 40, 1260, 0.4, 0.3));
    }
    storage.upsertSteamSalesByCountry(rows as any);
    const c = computeSalesByCountry(913, "2026-09-01", "2026-09-06");
    assert.equal(c.days_with_shares, 2);
    assert.equal(c.days_pooled_profile, 4);
    assert.equal(Math.round(c.total_units), 600);
    assert.ok(Math.abs(c.total_revenue_usd - 25200) < 1, `revenue ${c.total_revenue_usd}`);
    const us = c.countries.find(x => x.country_iso === "US")!;
    const de = c.countries.find(x => x.country_iso === "DE")!;
    assert.ok(Math.abs(us.asp_usd - 49) < 0.5, `US ASP ${us.asp_usd}`);
    assert.ok(Math.abs(de.asp_usd - 31.5) < 0.5, `DE ASP ${de.asp_usd}`);
  } finally { process.chdir(cwd); }
});
