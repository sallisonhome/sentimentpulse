/**
 * Sanity-runs the parser against the uploaded Saber sample and prints a
 * summary. Not a formal test — a debugging tool that shows exactly what
 * the parser sees.
 *
 * Usage:
 *   npx tsx scripts/test_parser.ts <path-to-xlsx>
 */
import { readFileSync } from "node:fs";
import { parsePromoWorkbook } from "../server/parser.js";

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: tsx scripts/test_parser.ts <xlsx>");
    process.exit(1);
  }
  const buf = readFileSync(path);
  const res = await parsePromoWorkbook(buf);

  console.log("── sheets processed:", res.sheets_processed.length);
  console.log("── sheets skipped:  ", res.sheets_skipped.length, res.sheets_skipped);
  console.log("── campaigns:       ", res.campaigns.length);
  console.log("── warnings:        ", res.warnings.length);
  if (res.warnings.length) {
    console.log("\n── warnings (first 15):");
    for (const w of res.warnings.slice(0, 15)) console.log("   ", w);
    if (res.warnings.length > 15) console.log(`    ... ${res.warnings.length - 15} more`);
  }

  // Breakdown by sheet.
  const bySheet = new Map<string, number>();
  const byPlatform = new Map<string, number>();
  const byGame = new Map<string, number>();
  let totalSkus = 0;
  for (const c of res.campaigns) {
    bySheet.set(c.sheet_name, (bySheet.get(c.sheet_name) ?? 0) + 1);
    byPlatform.set(c.platform, (byPlatform.get(c.platform) ?? 0) + 1);
    byGame.set(c.game_label, (byGame.get(c.game_label) ?? 0) + 1);
    totalSkus += c.skus.length;
  }
  console.log("\n── total SKU lines:", totalSkus);
  console.log("\n── by sheet:");
  for (const [k, v] of [...bySheet.entries()].sort()) {
    console.log(`    ${k.padEnd(24)} ${v}`);
  }
  console.log("\n── by platform:");
  for (const [k, v] of byPlatform.entries()) {
    console.log(`    ${k.padEnd(12)} ${v}`);
  }
  console.log("\n── by game:");
  for (const [k, v] of byGame.entries()) {
    console.log(`    ${k.padEnd(40)} ${v}`);
  }

  // Show the first campaign in detail so we can eyeball structure.
  if (res.campaigns.length) {
    const c = res.campaigns[0];
    console.log("\n── first campaign detail:");
    console.log(`    ${c.game_label} · ${c.platform} · ${c.program}`);
    console.log(`    ${c.start_date} → ${c.end_date}  (sheet ${c.sheet_name} rows ${c.source_row_start}-${c.source_row_end})`);
    console.log(`    SKUs (${c.skus.length}):`);
    for (const s of c.skus.slice(0, 8)) {
      const disc = s.discount_pct != null ? `${(s.discount_pct * 100).toFixed(0)}%` : "—";
      console.log(`      • ${s.content_name.padEnd(50)} $${s.current_srp_usd} → $${s.promo_srp_usd}  (${disc})`);
    }
    if (c.skus.length > 8) console.log(`      ... ${c.skus.length - 8} more SKUs`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
