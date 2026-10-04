// Rebuild the title-level storefront rank snapshot from the stored raw chart slots. No store requests.
//
//   tsx scripts/rebuild-chart-ranks.ts                 preview (default): prints what would change, writes nothing
//   tsx scripts/rebuild-chart-ranks.ts --apply         writes the rebuilt ranks for that day (idempotent)
//   tsx scripts/rebuild-chart-ranks.ts --date 2026-10-05
//
// Runs against ./data.db like every other script here. Exit 3 when no raw slots exist yet for the platform,
// so a workflow never reports success for a replay that had nothing to replay.
import { combineChartSlots } from "../server/signals/console/chartRank";
import { latestChartSlotDate, rebuildRanksFromSlots, writeRankSnapshot, type SortKey } from "../server/signals/console/rankSnapshot";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const dateArg = argv.includes("--date") ? argv[argv.indexOf("--date") + 1] : null;
const TARGETS: Array<{ platform: "ps5" | "xbox"; sortKey: SortKey }> = [
  { platform: "xbox", sortKey: "xbox_api_top_paid" },
  { platform: "ps5", sortKey: "psn_api_sales30" },
];

let missing = 0;
console.log(`[rebuild-chart-ranks] mode=${APPLY ? "APPLY" : "PREVIEW (no writes)"}`);
for (const t of TARGETS) {
  const date = dateArg ?? latestChartSlotDate(t.platform, t.sortKey);
  if (!date) { console.log(`  ${t.platform}: no raw chart slots stored yet (first run after this change populates them)`); missing++; continue; }
  const r = rebuildRanksFromSlots(t.platform, t.sortKey, date, slots => combineChartSlots(slots));
  if (r.slots === 0) { console.log(`  ${t.platform} ${date}: no raw slots for that date`); missing++; continue; }
  const uniq = new Set(r.entries.map(e => e.rank)).size;
  console.log(`  ${t.platform} ${date}: slots=${r.slots} titles=${r.entries.length} uniqueRanks=${uniq} changed=${r.diff.length} missingFromRebuild=${r.missingFromRebuild.length}`);
  for (const d of r.diff.slice(0, 15)) console.log(`    title ${d.titleId}: stored ${d.stored ?? "-"} -> rebuilt ${d.rebuilt}`);
  if (r.missingFromRebuild.length) console.log(`    stored titles absent from slots (left untouched): ${r.missingFromRebuild.slice(0, 10).join(",")}`);
  if (APPLY && r.entries.length > 0) {
    const w = writeRankSnapshot(t.platform, t.sortKey, r.entries, date);
    console.log(`    wrote ${w.rowsWritten} rank rows for ${w.snapshotDate}`);
  }
}
process.exit(missing === TARGETS.length ? 3 : 0);
