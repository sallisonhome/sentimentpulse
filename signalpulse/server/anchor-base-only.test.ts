import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Steam actuals feeding the estimator are full-game (base) SKUs only: DLC revenue and units are excluded, and a 30-day
// window is 30 complete days ending on the last ingested day.
test("anchor windows sum base SKUs only and end on the last ingested day", async () => {
  process.chdir(mkdtempSync(join(tmpdir(), "anchor-base-")));
  process.env.WRITE_ANCHORS_NO_MAIN = "1";
  const { rawSqlite: db } = await import("./storage");
  const { aggregateWindow } = await import("../scripts/write-revenue-anchors");
  const st = new Date().toISOString();
  db.prepare(`INSERT INTO products(id,title,publisher,is_saber_published,platforms,player_format,genre,release_date,steam_app_id,created_at,updated_at) VALUES(901,'T','Focus',0,'steam','single','a','2024-01-01','901',?,?)`).run(st, st);
  const ins = db.prepare(`INSERT INTO steam_sales_daily(product_id,date,sku_group,net_units,gross_units,returns,net_revenue_usd,gross_revenue_usd,source,created_at,updated_at) VALUES(901,?,?,?,?,0,?,?,'portal_fetch',?,?)`);
  for (let i = 1; i <= 40; i++) {
    const d = new Date(Date.UTC(2026, 8, i)).toISOString().slice(0, 10);   // Sep 1 .. Oct 10
    ins.run(d, "base", 10, 10, 100, 100, st, st);
    ins.run(d, "dlc", 50, 50, 400, 400, st, st);
    ins.run(d, "other", 5, 5, 20, 20, st, st);
  }
  const rollup = { title_id: 1, product_ids: [901], external_skus: ["901"], msrp_usd_cents: 6000, is_manual_override: 0, first_date: "2026-09-01", last_date: "2026-10-10" };
  const d30 = aggregateWindow(rollup, 30, "2026-10-11");          // as-of is the day after the last ingested day
  assert.equal(d30.row_count, 30, "30 complete days, not 29");
  assert.equal(d30.net_revenue_usd, 3000, "base only: 30 x 100, no DLC or other");
  assert.equal(d30.net_units, 300);
  const ltd = aggregateWindow(rollup, null, "2026-10-11");
  assert.equal(ltd.net_revenue_usd, 4000);
});
