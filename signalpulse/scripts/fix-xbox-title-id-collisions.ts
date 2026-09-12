/**
 * One-shot migration to clean up the 2026-09-11 Xbox title_id collision
 * incident AND to enforce the new paid-only-in-platform_sku_map invariant.
 *
 * Runs in three phases (each idempotent, safe to re-run):
 *
 *  1. F2P PRUNE:   delete every `business_model='free_to_play'` row from
 *                  `platform_sku_map` (all platforms). These rows are
 *                  invisible to the leaderboard (paid-only render filter)
 *                  but caused the collision incident by burning title_ids
 *                  on channel positions that later were held by real paid
 *                  titles.
 *
 *  2. PAID-PAIR RESOLUTION: for the 3 remaining collisions where BOTH SKUs
 *     were classified `paid`, resolve using live evidence:
 *     - title_id 10239: keep Gotham Knights (rank #119 on live top-paid),
 *                       drop stale Madden NFL 26 SKU.
 *     - title_id 10241: keep It Takes Two - Digital (rank #90),
 *                       drop stale EA College Football 26 SKU.
 *     - title_id 10242: keep Black Ops III - Zombies Deluxe (rank #103),
 *                       drop stale Dead by Daylight SKU.
 *     Winner selection is documented in the code — no runtime picking.
 *
 *  3. NAME REFRESH: for every previously-colliding title_id, re-fetch the
 *     Xbox displaycatalog PDP for the WINNING bigId and overwrite the
 *     `console_title_igdb` row via `bootstrapConsoleTitleNames`. This
 *     replaces any name/art that the loser's fetch had written.
 *
 * DRY_RUN=1 to preview; unset to actually mutate.
 * Never touches `is_manual_override=1` rows.
 */

import { rawSqlite } from "../server/storage";
import { fetchXboxRatingSignal } from "../server/signals/console/xbox";
import { bootstrapConsoleTitleNames } from "../server/signals/console/discovery";

const DRY_RUN = process.env.DRY_RUN === "1";

// The 3 paid-pair verdicts (from 2026-09-12 live top-paid probe).
// winner = the bigId currently on Xbox's top-paid-games channel.
// loser  = the bigId not on the channel (stale from an earlier discovery run).
const PAID_PAIR_VERDICTS: Array<{
  titleId: number;
  winnerBigId: string; winnerLabel: string;
  loserBigId: string;  loserLabel: string;
  liveRank: number;
}> = [
  { titleId: 10239,
    winnerBigId: "BT3611GR00CQ", winnerLabel: "Gotham Knights",
    loserBigId:  "9NVD16NP4J8T", loserLabel:  "EA SPORTS Madden NFL 26",
    liveRank: 119 },
  { titleId: 10241,
    winnerBigId: "9NXVC0482QS5", winnerLabel: "It Takes Two - Digital Version",
    loserBigId:  "9NLKS78C4F3Z", loserLabel:  "EA SPORTS College Football 26",
    liveRank: 90 },
  { titleId: 10242,
    winnerBigId: "BPP4NB1CKGP1", winnerLabel: "Call of Duty: Black Ops III - Zombies Deluxe",
    loserBigId:  "C0N22P73QZ60", loserLabel:  "Dead by Daylight",
    liveRank: 103 },
];

function banner(s: string) {
  console.log("\n" + "─".repeat(70));
  console.log(s);
  console.log("─".repeat(70));
}

async function main() {
  banner(`Migration: fix-xbox-title-id-collisions.ts   DRY_RUN=${DRY_RUN ? 1 : 0}`);

  // ── Phase 0: pre-state snapshot ────────────────────────────────────────────
  banner("Phase 0: pre-state");
  const preCounts = rawSqlite.prepare(`
    SELECT platform, business_model, COUNT(*) AS n
    FROM platform_sku_map GROUP BY platform, business_model ORDER BY platform, business_model
  `).all() as Array<{ platform: string; business_model: string; n: number }>;
  for (const r of preCounts) console.log(`  ${r.platform.padEnd(6)} ${r.business_model.padEnd(14)} ${r.n}`);

  const preCollisions = rawSqlite.prepare(`
    SELECT title_id, COUNT(*) AS n_skus
    FROM platform_sku_map WHERE platform='xbox'
    GROUP BY title_id HAVING COUNT(*) > 1 ORDER BY title_id
  `).all() as Array<{ title_id: number; n_skus: number }>;
  console.log(`\n  Xbox title_ids with >1 SKU: ${preCollisions.length}`);
  if (preCollisions.length > 0) {
    console.log(`  First few: ${preCollisions.slice(0, 5).map(c => `${c.title_id}(${c.n_skus})`).join(", ")}`);
  }

  // ── Phase 1: F2P prune ─────────────────────────────────────────────────────
  banner("Phase 1: F2P prune (paid-only-leaderboard invariant)");
  const f2pRows = rawSqlite.prepare(`
    SELECT platform, external_sku, title_id, is_manual_override
    FROM platform_sku_map
    WHERE business_model='free_to_play' AND is_manual_override = 0
    ORDER BY platform, title_id
  `).all() as Array<{ platform: string; external_sku: string; title_id: number; is_manual_override: number }>;
  console.log(`  F2P rows to delete (excluding manual overrides): ${f2pRows.length}`);
  for (const r of f2pRows.slice(0, 20)) {
    console.log(`    ${r.platform.padEnd(6)} ${r.external_sku.padEnd(14)} title_id=${r.title_id}`);
  }
  if (f2pRows.length > 20) console.log(`    ...and ${f2pRows.length - 20} more`);

  if (!DRY_RUN && f2pRows.length > 0) {
    const del = rawSqlite.prepare(
      `DELETE FROM platform_sku_map
       WHERE platform=? AND external_sku=? AND business_model='free_to_play' AND is_manual_override=0`
    );
    const runDel = rawSqlite.transaction((rs: typeof f2pRows) => {
      let n = 0;
      for (const r of rs) { del.run(r.platform, r.external_sku); n++; }
      return n;
    });
    const n = runDel(f2pRows);
    console.log(`  ✔ deleted ${n} F2P rows`);
  } else if (DRY_RUN) {
    console.log(`  (DRY_RUN) would delete ${f2pRows.length} F2P rows`);
  }

  // ── Phase 2: paid-pair resolution ─────────────────────────────────────────
  banner("Phase 2: paid-pair resolution (3 title_ids)");
  const del = rawSqlite.prepare(
    `DELETE FROM platform_sku_map
     WHERE platform='xbox' AND external_sku=? AND business_model='paid' AND is_manual_override=0`
  );
  const check = rawSqlite.prepare(
    `SELECT title_id, business_model, is_manual_override
     FROM platform_sku_map WHERE platform='xbox' AND external_sku=?`
  );
  let paidPairsResolved = 0;
  for (const v of PAID_PAIR_VERDICTS) {
    const winner = check.get(v.winnerBigId) as { title_id: number; business_model: string; is_manual_override: number } | undefined;
    const loser  = check.get(v.loserBigId)  as { title_id: number; business_model: string; is_manual_override: number } | undefined;
    console.log(`\n  title_id ${v.titleId}:`);
    console.log(`    winner: ${v.winnerLabel.padEnd(45)} bigId=${v.winnerBigId}  live rank #${v.liveRank}`);
    console.log(`            DB row: ${winner ? `title_id=${winner.title_id} bm=${winner.business_model} manual=${winner.is_manual_override}` : "MISSING"}`);
    console.log(`    loser : ${v.loserLabel.padEnd(45)} bigId=${v.loserBigId}`);
    console.log(`            DB row: ${loser ? `title_id=${loser.title_id} bm=${loser.business_model} manual=${loser.is_manual_override}` : "MISSING"}`);
    if (!winner) { console.log(`    ⚠ winner row missing; skipping`); continue; }
    if (winner.title_id !== v.titleId) { console.log(`    ⚠ winner title_id=${winner.title_id} != expected ${v.titleId}; skipping`); continue; }
    if (!loser)  { console.log(`    ✔ loser already absent; nothing to delete`); paidPairsResolved++; continue; }
    if (loser.is_manual_override === 1) { console.log(`    ⚠ loser is_manual_override=1; refusing to delete`); continue; }
    if (loser.title_id !== v.titleId) { console.log(`    ⚠ loser title_id=${loser.title_id} != expected ${v.titleId}; skipping`); continue; }

    if (!DRY_RUN) {
      del.run(v.loserBigId);
      console.log(`    ✔ deleted loser SKU`);
    } else {
      console.log(`    (DRY_RUN) would delete loser SKU`);
    }
    paidPairsResolved++;
  }
  console.log(`\n  Paid pairs resolved: ${paidPairsResolved}/${PAID_PAIR_VERDICTS.length}`);

  // ── Phase 3: name refresh ─────────────────────────────────────────────────
  banner("Phase 3: cti name refresh for previously-colliding title_ids");
  // All 19 originally-colliding title_ids: 10224..10242.
  // Now that losers are pruned, each title_id has exactly one Xbox SKU
  // remaining. Re-fetch displaycatalog for that bigId so the cti row's
  // name/art reflects the surviving SKU.
  const survivors = rawSqlite.prepare(`
    SELECT title_id, external_sku
    FROM platform_sku_map
    WHERE platform='xbox' AND title_id BETWEEN 10224 AND 10242
    ORDER BY title_id
  `).all() as Array<{ title_id: number; external_sku: string }>;
  console.log(`  Survivors to refresh: ${survivors.length}`);
  const refreshRows: Array<{ titleId: number; name: string; headerImageUrl?: string | null; releaseDateIso?: string | null }> = [];
  let refetched = 0, refetchFailed = 0;
  for (const s of survivors) {
    try {
      const r = await fetchXboxRatingSignal({ titleId: s.title_id, bigId: s.external_sku });
      if (r.productTitle && r.productTitle.trim().length > 0) {
        refreshRows.push({
          titleId: s.title_id,
          name: r.productTitle.trim(),
          headerImageUrl: r.storeHeaderImageUrl ?? null,
          releaseDateIso: r.storeReleaseDateIso ?? null,
        });
        console.log(`    ✔ ${s.title_id}  ${s.external_sku}  ${r.productTitle.trim()}`);
        refetched++;
      } else {
        console.log(`    ✘ ${s.title_id}  ${s.external_sku}  (no title from displaycatalog)`);
        refetchFailed++;
      }
    } catch (e) {
      console.log(`    ✘ ${s.title_id}  ${s.external_sku}  fetch error: ${e instanceof Error ? e.message : e}`);
      refetchFailed++;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  if (!DRY_RUN && refreshRows.length > 0) {
    const b = bootstrapConsoleTitleNames(refreshRows);
    console.log(`\n  bootstrapConsoleTitleNames: inserted=${b.inserted} kept=${b.kept} updatedName=${b.updatedName}`);
  } else if (DRY_RUN) {
    console.log(`\n  (DRY_RUN) would refresh ${refreshRows.length} cti rows`);
  }
  console.log(`  Refetched OK: ${refetched}   Failed: ${refetchFailed}`);

  // ── Phase 4: post-state verification ──────────────────────────────────────
  banner("Phase 4: post-state");
  const postCounts = rawSqlite.prepare(`
    SELECT platform, business_model, COUNT(*) AS n
    FROM platform_sku_map GROUP BY platform, business_model ORDER BY platform, business_model
  `).all() as Array<{ platform: string; business_model: string; n: number }>;
  for (const r of postCounts) console.log(`  ${r.platform.padEnd(6)} ${r.business_model.padEnd(14)} ${r.n}`);

  const postCollisions = rawSqlite.prepare(`
    SELECT title_id, COUNT(*) AS n_skus
    FROM platform_sku_map WHERE platform='xbox'
    GROUP BY title_id HAVING COUNT(*) > 1 ORDER BY title_id
  `).all() as Array<{ title_id: number; n_skus: number }>;
  console.log(`\n  Xbox title_ids with >1 SKU: ${postCollisions.length}`);
  if (postCollisions.length > 0) {
    console.log(`  REMAINING COLLISIONS:`);
    for (const c of postCollisions) console.log(`    title_id=${c.title_id}  n_skus=${c.n_skus}`);
  }

  const remainingF2p = rawSqlite.prepare(`
    SELECT COUNT(*) AS n FROM platform_sku_map
    WHERE business_model='free_to_play' AND is_manual_override=0
  `).get() as { n: number };
  console.log(`  Remaining F2P rows (non-override): ${remainingF2p.n}`);

  banner("Done");
  const clean = postCollisions.length === 0 && remainingF2p.n === 0;
  if (DRY_RUN) {
    console.log("DRY_RUN complete — re-run without DRY_RUN=1 to apply.");
  } else if (clean) {
    console.log("✅ Migration complete. No collisions, no F2P rows.");
  } else {
    console.log("⚠ Migration finished but state is not clean. Review output above.");
    process.exit(1);
  }
}

main().catch(e => {
  console.error("MIGRATION FAILED:", e);
  process.exit(1);
});
