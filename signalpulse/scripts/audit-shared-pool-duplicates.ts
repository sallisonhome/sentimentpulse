// Live regression audit: fails (exit 1) if any public PS5/Xbox board shows two rows that are one store
// rating pool (the double-counting fixed in PRs 168/169: Mafia, Minecraft Deluxe, GTA Online, Witcher 3).
// Usage: npx tsx scripts/audit-shared-pool-duplicates.ts [baseUrl]
import { sharedPoolViolations } from "../server/console-shared-pool";
import { editionGroupKey } from "../server/console-sales-family";

const base = process.argv[2] ?? "https://howmanyareplaying.com";
const windows = ["d7", "d30", "d90", "m12", "ltd"];
let failures = 0;
for (const platform of ["ps5", "xbox"]) {
  for (const window of windows) {
    const res = await fetch(`${base}/api/buying/${platform}?window=${window}&limit=100`);
    if (!res.ok) { console.error(`${platform}/${window}: HTTP ${res.status}`); failures++; continue; }
    const rows = ((await res.json()) as any).titles as any[];
    const bad = sharedPoolViolations(rows, platform, editionGroupKey);
    for (const [a, b] of bad) {
      const n = (id: number) => rows.find(r => r.titleId === id)?.name;
      console.error(`DUPLICATE POOL ${platform}/${window}: ${a} ${n(a)} duplicates ${b} ${n(b)}`);
    }
    failures += bad.length;
    console.log(`${platform}/${window}: ${rows.length} rows, ${bad.length} duplicate-pool rows`);
  }
}
if (failures) process.exit(1);
