/**
 * Regression tests for the promo-schedule Excel parser.
 *
 * Uses the real Saber sample workbook committed to the repo under
 * `scripts/fixtures/`. If that fixture ever moves, update the SAMPLE
 * constant below.
 */
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePromoWorkbook } from "./parser.js";

const SAMPLE = process.env.PROMO_SAMPLE_XLSX || "scripts/fixtures/Promo-Schedule-Saber.xlsx";

function loadFixture(): Buffer | null {
  if (!existsSync(SAMPLE)) return null;
  return readFileSync(SAMPLE);
}

test("parser: no fixture -> skip (CI without sample file)", () => {
  const buf = loadFixture();
  if (!buf) {
    console.warn(`[skip] fixture not found at ${SAMPLE}`);
  }
  assert.ok(true);
});

test("parser: real Saber sample produces >900 campaigns, >4000 SKUs, <25 warnings", async () => {
  const buf = loadFixture();
  if (!buf) return; // skip when fixture missing
  const res = await parsePromoWorkbook(buf);

  assert.ok(
    res.campaigns.length > 900,
    `expected >900 campaigns, got ${res.campaigns.length}`,
  );
  const totalSkus = res.campaigns.reduce((s, c) => s + c.skus.length, 0);
  assert.ok(totalSkus > 4000, `expected >4000 SKUs, got ${totalSkus}`);
  assert.ok(
    res.warnings.length < 25,
    `expected <25 warnings, got ${res.warnings.length}: ${res.warnings.slice(0, 5).join(" | ")}`,
  );
});

test("parser: platform banners split Steam/Microsoft/Sony correctly", async () => {
  const buf = loadFixture();
  if (!buf) return;
  const res = await parsePromoWorkbook(buf);
  const byPlatform = new Map<string, number>();
  for (const c of res.campaigns) {
    byPlatform.set(c.platform, (byPlatform.get(c.platform) ?? 0) + 1);
  }
  assert.ok((byPlatform.get("Steam") ?? 0) > 200, "expected many Steam campaigns");
  assert.ok((byPlatform.get("Microsoft") ?? 0) > 200, "expected many Microsoft campaigns");
  assert.ok((byPlatform.get("Sony") ?? 0) > 100, "expected many Sony campaigns");
});

test("parser: SKU prices are populated (formula cells unwrapped)", async () => {
  const buf = loadFixture();
  if (!buf) return;
  const res = await parsePromoWorkbook(buf);
  const withPromoPrice = res.campaigns
    .flatMap((c) => c.skus)
    .filter((s) => s.promo_srp_usd != null).length;
  const total = res.campaigns.reduce((s, c) => s + c.skus.length, 0);
  // At least 80% of SKU rows should have a promo price (some are bundle
  // items priced at $0 or `-`, that's fine).
  assert.ok(
    withPromoPrice / total > 0.8,
    `expected >80% of SKUs to have a promo price; got ${withPromoPrice}/${total}`,
  );
});

test("parser: multi-title clusters exist (Spring Sales / Autumn Sales / Black Friday)", async () => {
  const buf = loadFixture();
  if (!buf) return;
  const res = await parsePromoWorkbook(buf);
  const groups = new Map<string, Set<string>>();
  for (const c of res.campaigns) {
    const key = `${c.program}|${c.platform}|${c.start_date}|${c.end_date}`;
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key)!.add(c.game_code);
  }
  const multi = [...groups.entries()].filter(([, g]) => g.size >= 2);
  assert.ok(multi.length > 100, `expected >100 multi-title clusters, got ${multi.length}`);
});

test("parser: games map to display labels", async () => {
  const buf = loadFixture();
  if (!buf) return;
  const res = await parsePromoWorkbook(buf);
  const labels = new Set(res.campaigns.map((c) => c.game_label));
  assert.ok(labels.has("Warhammer 40,000: Space Marine 2"), "SM2 label missing");
  assert.ok(labels.has("SnowRunner"), "SnowRunner label missing");
  assert.ok(labels.has("Insurgency: Sandstorm"), "Insurgency label missing");
});
