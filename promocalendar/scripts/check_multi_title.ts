import { readFileSync } from "node:fs";
import { parsePromoWorkbook } from "../server/parser.js";

async function main() {
  const buf = readFileSync("/tmp/saber_promo.xlsx");
  const res = await parsePromoWorkbook(buf);
  const groups = new Map<string, { program: string; platform: string; start: string; end: string; games: Set<string> }>();
  for (const c of res.campaigns) {
    const key = `${c.program}|${c.platform}|${c.start_date}|${c.end_date}`;
    let g = groups.get(key);
    if (!g) {
      g = { program: c.program, platform: c.platform, start: c.start_date, end: c.end_date, games: new Set() };
      groups.set(key, g);
    }
    g.games.add(c.game_label);
  }
  const multi = [...groups.values()].filter(g => g.games.size >= 2).sort((a, b) => a.start.localeCompare(b.start));
  console.log(`Total groups: ${groups.size}`);
  console.log(`Multi-title groups (2+ titles): ${multi.length}`);
  console.log(`\nFirst 20 multi-title clusters:`);
  for (const g of multi.slice(0, 20)) {
    console.log(`  ${g.start} → ${g.end}  ${g.platform.padEnd(10)}  ${g.program.padEnd(35)}  ${g.games.size} titles: ${[...g.games].join(", ")}`);
  }
  // Also biggest clusters
  console.log(`\nBiggest 10 multi-title clusters:`);
  for (const g of [...multi].sort((a,b) => b.games.size - a.games.size).slice(0, 10)) {
    console.log(`  ${g.games.size} titles · ${g.start} → ${g.end}  ${g.platform.padEnd(10)}  ${g.program}`);
    console.log(`    ${[...g.games].join(" · ")}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
