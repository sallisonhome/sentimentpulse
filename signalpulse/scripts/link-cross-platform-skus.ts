/**
 * link-cross-platform-skus.ts
 *
 * Automates the cross-platform SKU-linking work that was previously done by
 * hand each time a title showed up on one storefront (say PS5) but not on
 * another (Steam) — leaving `platform_sku_map` short a row and the
 * steam-pace estimator unable to produce d7/d30/d90/m12 windows for the
 * console side.
 *
 * Two independent jobs, both driven by IGDB metadata already resident in
 * `console_title_igdb`:
 *
 *   PASS 1 — MERGE cross-platform duplicates
 *     When two title_ids share the SAME igdb_id, they are the SAME game.
 *     Discovery on Xbox/PS5/Steam allocates a fresh title_id on first sight
 *     because titleIdFor() (see scripts/verify-discovery.ts) only checks
 *     (platform, external_sku) — not the underlying game identity. That is
 *     the root cause of the manual-backfill work: the estimator looks up
 *     Steam siblings by title_id, so a duplicate PS5-only title_id can
 *     never gain the Steam signal.
 *
 *     For every igdb_id with >1 title_id we pick the smallest title_id as
 *     canonical, then rewrite platform_sku_map.title_id and every history
 *     table (store_rating_signal_daily, window_estimates_daily, …) so the
 *     canonical title_id owns everything. The losing console_title_igdb
 *     rows are deleted last.
 *
 *   PASS 2 — DISCOVER missing Steam SKUs from IGDB external_games
 *     For every canonical title_id that HAS an igdb_id but LACKS a Steam
 *     row in platform_sku_map, we call IGDB /external_games?category=1
 *     (Steam) to find the AppID. We then verify the AppID exists via
 *     Steam's own appdetails API (same call the manual backfill uses) and,
 *     only when the appdetails name token-overlaps the console_title_igdb
 *     name, INSERT into platform_sku_map with is_manual_override=1.
 *
 * Safety
 *   - DRY_RUN=1 (default when workflow is first stood up) writes NOTHING
 *     and logs every proposed change.
 *   - --allow-merges must be passed to actually rewrite title_ids in
 *     history tables. Without it Pass 1 stops after producing the merge
 *     report.
 *   - Titles listed in the manually-curated SKU_BASE_TITLE_ID remap
 *     (server/signals/console/discovery.ts) are NEVER touched — the manual
 *     remap wins.
 *   - Both console_title_igdb rows in a proposed merge must have
 *     match_confidence != 'low'. A low-confidence match likely means the
 *     igdb_id is bogus, and merging on a bogus id would corrupt both
 *     title_ids' history.
 *   - Steam AppID auto-add is skipped when appdetails returns is_free=true
 *     (the collector gates F2P anyway) or when the appdetails name fails
 *     the same first-token/coverage guard used in igdb.ts.
 *
 * Idempotent. Re-running after a merge finds no duplicates to merge; after
 * a Steam auto-add finds the row already present and skips it.
 *
 * Exit codes:
 *   0 — success (including "nothing to do")
 *   1 — one or more merges failed halfway; partial state possible, re-run
 *       required. Details in the log.
 *   2 — fatal precondition failure (missing credentials, missing tables).
 */

import { rawSqlite, storage } from "../server/storage";

// ─── Config ──────────────────────────────────────────────────────────────────

const DRY_RUN = process.env.DRY_RUN === "1";
const ALLOW_MERGES = process.argv.includes("--allow-merges");
const ALLOW_STEAM_ADDS = !process.argv.includes("--no-steam-adds");
const MAX_STEAM_ADDS = parseInt(process.env.MAX_STEAM_ADDS || "50", 10);
const IGDB_RPS = 4;
const STEAM_RPS = 2;
const REQUIRE_TWITCH_CREDS = ALLOW_STEAM_ADDS;

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

// ─── SKU_BASE_TITLE_ID import (kept in sync with discovery.ts by hand — do
//     NOT touch these title_ids automatically; operator-owned remap) ──
//
// This is a manually-maintained safety fence. The list is short and
// duplicating it here is cheaper than a cross-module import gymnastics.
// If discovery.ts grows this map, add the same title_ids here too.
const MANUALLY_REMAPPED_TITLE_IDS: ReadonlySet<number> = new Set<number>([
  10335, 10352, 10386, 10312, 10318, 10394, 10447, 10370, 10350, 10357, 10333, 10364,
]);

// ─── IGDB client (minimal — same OAuth flow igdb.ts uses) ────────────────────

let cachedToken: { access_token: string; expires_at: number } | null = null;

async function getTwitchToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expires_at > now + 60_000) return cachedToken.access_token;
  const clientId = storage.getSetting("twitch_client_id")?.value;
  const clientSecret = storage.getSetting("twitch_client_secret")?.value;
  if (!clientId || !clientSecret) {
    throw new Error("twitch_client_id / twitch_client_secret not set in app_settings");
  }
  const url = `https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials`;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) throw new Error(`Twitch OAuth failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as { access_token: string; expires_in: number };
  cachedToken = { access_token: data.access_token, expires_at: now + data.expires_in * 1000 };
  return cachedToken.access_token;
}

interface ExternalGame {
  id: number;
  game: number;            // IGDB game id (matches console_title_igdb.igdb_id)
  uid: string;             // storefront id (Steam appid, PSN productId, MS bigId)
  category: number;        // 1 = Steam, 11 = Xbox Live/Store, 36 = PS Store, 45 = PSN
  name?: string;
}

// Category constants — from IGDB /external_game_categories
const IGDB_CATEGORY_STEAM = 1;
const IGDB_CATEGORY_XBOX = 11;
const IGDB_CATEGORY_PLAYSTATION = 36;

async function igdbQuery<T>(endpoint: string, body: string): Promise<T> {
  const token = await getTwitchToken();
  const clientId = storage.getSetting("twitch_client_id")!.value!;
  const res = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
    method: "POST",
    headers: {
      "Client-ID": clientId,
      "Authorization": `Bearer ${token}`,
      "Content-Type": "text/plain",
      "Accept": "application/json",
    },
    body,
  });
  if (!res.ok) throw new Error(`IGDB ${endpoint} HTTP ${res.status}: ${await res.text()}`);
  return await res.json() as T;
}

async function fetchExternalGamesForIgdbId(igdbId: number): Promise<ExternalGame[]> {
  // IGDB caps at 500 rows/response; a single game has at most a handful of
  // external_games entries (one per storefront × region), so 50 is plenty.
  const body = `fields id,game,uid,category,name; where game = ${igdbId} & category = (${IGDB_CATEGORY_STEAM},${IGDB_CATEGORY_XBOX},${IGDB_CATEGORY_PLAYSTATION}); limit 50;`;
  return await igdbQuery<ExternalGame[]>("external_games", body);
}

// ─── Steam appdetails verifier ───────────────────────────────────────────────

interface SteamAppDetails {
  success: boolean;
  data?: {
    name: string;
    type: string;
    is_free: boolean;
    price_overview?: { initial: number };
  };
}

async function fetchSteamAppDetails(appId: string): Promise<SteamAppDetails["data"] | null> {
  const url = `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appId)}&filters=basic,price_overview`;
  const res = await fetch(url, { headers: { "User-Agent": "SignalPulse/link-cross-platform-skus" } });
  if (!res.ok) return null;
  const data = await res.json() as Record<string, SteamAppDetails>;
  const entry = data[appId];
  if (!entry || !entry.success || !entry.data) return null;
  return entry.data;
}

// ─── Name-token match guard (same algorithm as igdb.ts classifyMatchConfidence) ──

function tokenize(s: string): string[] {
  const stop = new Set([
    "the", "a", "an", "of", "to", "and",
    "deluxe", "edition", "ultimate", "digital", "standard",
    "remastered", "remake", "gold", "premium", "complete", "anniversary", "goty",
    "ps4", "ps5", "xbox", "series", "one", "pc",
  ]);
  return s
    .normalize("NFD").replace(/[\u0300-\u036f]+/g, "")
    .toLowerCase().replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/).filter(t => t.length >= 2 && !stop.has(t));
}

function nameMatch(a: string, b: string): "high" | "low" {
  const at = tokenize(a);
  const bt = tokenize(b);
  if (at.length === 0 || bt.length === 0) return "low";
  const prefixMatch = (x: string, y: string) => {
    if (x === y) return true;
    const [s, l] = x.length <= y.length ? [x, y] : [y, x];
    return s.length >= 3 && l.startsWith(s);
  };
  if (!prefixMatch(at[0], bt[0])) return "low";
  let hits = 0;
  for (const t of at) if (bt.some(x => prefixMatch(t, x))) hits++;
  return hits / at.length >= 0.6 ? "high" : "low";
}

// ─── Discovery of tables that reference title_id (for the merge) ─────────────
//
// The merge pass must remap every history table that stores title_id, or
// we leak orphaned rows. Rather than hardcode the list (which drifts), we
// enumerate every table with a `title_id` column at runtime and remap
// each one under a single transaction.

interface RefTable { name: string; }

function tablesReferencingTitleId(): string[] {
  const tables = rawSqlite.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
  ).all() as RefTable[];
  const withTitle: string[] = [];
  for (const t of tables) {
    const cols = rawSqlite.prepare(`PRAGMA table_info(${t.name})`).all() as Array<{ name: string }>;
    if (cols.some(c => c.name === "title_id")) withTitle.push(t.name);
  }
  return withTitle;
}

// ─── PASS 1: merge duplicates by shared igdb_id ──────────────────────────────

interface MergeCandidate {
  igdbId: number;
  canonicalTitleId: number;
  loserTitleIds: number[];
  names: string[];
  matchConfidences: string[];
}

function findMergeCandidates(): MergeCandidate[] {
  // Only consider high-confidence matches — a low-confidence match likely
  // means IGDB's search picked the wrong game, so trusting the igdb_id to
  // merge across platforms would corrupt real history.
  const rows = rawSqlite.prepare(`
    SELECT igdb_id, title_id, name, match_confidence
      FROM console_title_igdb
     WHERE igdb_id IS NOT NULL
     ORDER BY igdb_id, title_id
  `).all() as Array<{ igdb_id: number; title_id: number; name: string | null; match_confidence: string | null }>;

  const grouped = new Map<number, Array<{ title_id: number; name: string; conf: string }>>();
  for (const r of rows) {
    const g = grouped.get(r.igdb_id) ?? [];
    g.push({ title_id: r.title_id, name: r.name ?? "", conf: r.match_confidence ?? "unknown" });
    grouped.set(r.igdb_id, g);
  }

  const cands: MergeCandidate[] = [];
  for (const [igdbId, group] of Array.from(grouped.entries())) {
    if (group.length < 2) continue;
    // Skip if ANY member is match_confidence='low' — trusting a bogus
    // igdb_id would corrupt history. Fix the low match first.
    if (group.some(g => g.conf === "low")) {
      console.log(`skip igdb_id=${igdbId} (${group.map(x => `${x.title_id}(${x.conf})`).join(",")}) — low-confidence member`);
      continue;
    }
    // Skip if ANY member is in the operator-curated remap list.
    if (group.some(g => MANUALLY_REMAPPED_TITLE_IDS.has(g.title_id))) {
      console.log(`skip igdb_id=${igdbId} — member in MANUALLY_REMAPPED_TITLE_IDS`);
      continue;
    }
    const sorted = [...group].sort((a, b) => a.title_id - b.title_id);
    cands.push({
      igdbId,
      canonicalTitleId: sorted[0].title_id,
      loserTitleIds: sorted.slice(1).map(x => x.title_id),
      names: sorted.map(x => x.name),
      matchConfidences: sorted.map(x => x.conf),
    });
  }
  return cands;
}

/**
 * For a given table, return the columns that participate in ANY unique
 * constraint (including the primary key) that references title_id.
 * We use this so the merge can DELETE conflicting loser rows before the
 * UPDATE runs and hits a UNIQUE-constraint failure. If no unique
 * constraint involves title_id, returns []; the UPDATE is safe as-is.
 *
 * SQLite reports:
 *   - PRAGMA index_list(<table>)             — every index (unique + not)
 *   - PRAGMA index_info(<index>)             — columns for that index
 *   - PRAGMA table_info(<table>)             — PK columns (pk > 0)
 */
function discoverUniqueColumnsIncludingTitleId(table: string): string[] {
  // Composite PK first — shows up in table_info.pk > 0.
  const info = rawSqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>;
  const pkCols = info.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
  if (pkCols.includes("title_id")) return pkCols;

  // Then any explicit UNIQUE index.
  const indexes = rawSqlite.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number }>;
  for (const idx of indexes) {
    if (!idx.unique) continue;
    const cols = (rawSqlite.prepare(`PRAGMA index_info(${idx.name})`).all() as Array<{ name: string }>).map(c => c.name);
    if (cols.includes("title_id")) return cols;
  }
  return [];
}

function executeMerge(cand: MergeCandidate, referencingTables: string[]): { ok: boolean; err?: string } {
  // One transaction per canonical id — an all-or-nothing rewrite. If it
  // fails halfway we roll back and leave the pair for the next tick.
  const canonical = cand.canonicalTitleId;
  const losers = cand.loserTitleIds;
  try {
    const tx = rawSqlite.transaction(() => {
      for (const loser of losers) {
        for (const table of referencingTables) {
          // console_title_igdb itself is special: title_id is the PK, so a
          // remap of the loser row would collide with the canonical row. We
          // just DELETE the loser row from console_title_igdb at the end.
          if (table === "console_title_igdb") continue;

          // Any table with a unique constraint that includes title_id would
          // fail the UPDATE if the canonical row already occupies the target
          // key. In practice this happens per-platform (e.g. window_estimates_daily
          // is (title_id, platform, window, as_of_date)) — the two title_ids
          // cover different platforms by construction, so a collision requires
          // the same platform to have been split across both title_ids, which
          // is exactly what we're fixing. Handle it safely: prefer the
          // canonical's existing row (delete the loser's dup) then update the rest.
          const uniqueCols = discoverUniqueColumnsIncludingTitleId(table);
          if (uniqueCols.length > 0) {
            const otherCols = uniqueCols.filter(c => c !== "title_id");
            if (otherCols.length > 0) {
              const joinExpr = otherCols.map(c => `l.${c} = c.${c}`).join(" AND ");
              // Delete loser rows whose non-title_id key already exists
              // under canonical for THIS table (all in one shot).
              rawSqlite.prepare(`
                DELETE FROM ${table} WHERE title_id = ? AND rowid IN (
                  SELECT l.rowid FROM ${table} l JOIN ${table} c
                    ON c.title_id = ? AND ${joinExpr}
                   WHERE l.title_id = ?
                )
              `).run(loser, canonical, loser);
            } else {
              // The unique constraint is on title_id alone (very rare —
              // basically only happens on PK-title_id tables like
              // console_title_igdb, already excluded above). If we ever
              // hit this, deleting the loser row entirely is correct
              // because canonical already has "the" row.
              rawSqlite.prepare(`DELETE FROM ${table} WHERE title_id = ?`).run(loser);
              continue;
            }
          }
          rawSqlite.prepare(`UPDATE ${table} SET title_id = ? WHERE title_id = ?`).run(canonical, loser);
        }
        rawSqlite.prepare(`DELETE FROM console_title_igdb WHERE title_id = ?`).run(loser);
      }
    });
    tx();
    return { ok: true };
  } catch (err: any) {
    return { ok: false, err: err?.message ?? String(err) };
  }
}

// ─── PASS 2: discover missing Steam SKUs from IGDB external_games ────────────

interface AddCandidate {
  titleId: number;
  igdbId: number;
  consoleName: string;
  steamAppId: string;
  steamName: string;
  msrpCents: number | null;
}

async function findSteamAddCandidates(): Promise<AddCandidate[]> {
  // Titles that (a) have an IGDB match, (b) high confidence, (c) NO Steam
  // row in platform_sku_map, and (d) have at least one paid platform SKU
  // so the leaderboard would actually surface them.
  const rows = rawSqlite.prepare(`
    SELECT cti.title_id, cti.igdb_id, cti.name
      FROM console_title_igdb cti
     WHERE cti.igdb_id IS NOT NULL
       AND cti.match_confidence = 'high'
       AND NOT EXISTS (
         SELECT 1 FROM platform_sku_map WHERE title_id = cti.title_id AND platform = 'steam'
       )
       AND EXISTS (
         SELECT 1 FROM platform_sku_map WHERE title_id = cti.title_id AND business_model = 'paid'
       )
     ORDER BY cti.title_id
     LIMIT ?
  `).all(MAX_STEAM_ADDS) as Array<{ title_id: number; igdb_id: number; name: string }>;

  const cands: AddCandidate[] = [];
  let processed = 0;
  for (const r of rows) {
    processed++;
    try {
      const ext = await fetchExternalGamesForIgdbId(r.igdb_id);
      await sleep(1000 / IGDB_RPS);
      const steamEntries = ext.filter(e => e.category === IGDB_CATEGORY_STEAM);
      if (steamEntries.length === 0) {
        console.log(`  ${r.title_id} "${r.name}": IGDB has no Steam external_game — skip`);
        continue;
      }
      // Verify each candidate via Steam appdetails. Take the first that
      // passes: paid, type=game, name matches.
      let picked: AddCandidate | null = null;
      for (const s of steamEntries) {
        const details = await fetchSteamAppDetails(s.uid);
        await sleep(1000 / STEAM_RPS);
        if (!details) {
          console.log(`  ${r.title_id} appid=${s.uid}: appdetails returned nothing`);
          continue;
        }
        if (details.is_free) {
          console.log(`  ${r.title_id} appid=${s.uid} "${details.name}": free-to-play — gated by collector, skip`);
          break;
        }
        if (details.type !== "game") {
          console.log(`  ${r.title_id} appid=${s.uid} "${details.name}": type=${details.type} not game, skip`);
          continue;
        }
        const conf = nameMatch(r.name, details.name);
        if (conf === "low") {
          console.log(`  ${r.title_id} appid=${s.uid}: name mismatch "${r.name}" vs "${details.name}", skip`);
          continue;
        }
        picked = {
          titleId: r.title_id,
          igdbId: r.igdb_id,
          consoleName: r.name,
          steamAppId: s.uid,
          steamName: details.name,
          msrpCents: details.price_overview?.initial ?? null,
        };
        break;
      }
      if (picked) {
        cands.push(picked);
        console.log(`  + ${picked.titleId} "${picked.consoleName}" -> steam appid=${picked.steamAppId} "${picked.steamName}"`);
      }
    } catch (err: any) {
      console.error(`  ${r.title_id} lookup error: ${err?.message ?? err}`);
    }
    if (processed % 25 === 0) console.log(`  … ${processed}/${rows.length} processed`);
  }
  return cands;
}

function executeSteamAdd(cand: AddCandidate): { ok: boolean; err?: string } {
  try {
    rawSqlite.prepare(`
      INSERT OR IGNORE INTO platform_sku_map
        (title_id, platform, external_sku, sku_role, business_model, msrp_usd_cents,
         business_model_source, is_manual_override, refreshed_at, created_at)
      VALUES (?, 'steam', ?, 'base', 'paid', ?,
              'auto_link_cross_platform', 1, datetime('now'), datetime('now'))
    `).run(cand.titleId, cand.steamAppId, cand.msrpCents);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, err: err?.message ?? String(err) };
  }
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("─── link-cross-platform-skus ───");
  console.log(`DRY_RUN=${DRY_RUN}  --allow-merges=${ALLOW_MERGES}  --no-steam-adds=${!ALLOW_STEAM_ADDS}  MAX_STEAM_ADDS=${MAX_STEAM_ADDS}`);

  if (REQUIRE_TWITCH_CREDS) {
    const clientId = storage.getSetting("twitch_client_id")?.value;
    const clientSecret = storage.getSetting("twitch_client_secret")?.value;
    if (!clientId || !clientSecret) {
      console.error("FATAL: twitch_client_id / twitch_client_secret not set in app_settings");
      process.exit(2);
    }
  }
  for (const t of ["platform_sku_map", "console_title_igdb"]) {
    const n = rawSqlite.prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?`
    ).get(t) as { n: number };
    if (n.n !== 1) { console.error(`FATAL: table ${t} missing`); process.exit(2); }
  }

  // ─── PASS 1: MERGE ─────────────────────────────────────────────────────
  console.log("\n─── PASS 1: cross-platform title_id merges (by shared igdb_id) ───");
  const mergeCands = findMergeCandidates();
  if (mergeCands.length === 0) {
    console.log("no merge candidates — every igdb_id maps to exactly one title_id");
  } else {
    console.log(`found ${mergeCands.length} merge candidates:`);
    for (const c of mergeCands) {
      console.log(`  igdb_id=${c.igdbId}: canonical=${c.canonicalTitleId} absorbs [${c.loserTitleIds.join(", ")}]`);
      c.names.forEach((n, i) => console.log(`    - title_id=${[c.canonicalTitleId, ...c.loserTitleIds][i]} name="${n}" conf=${c.matchConfidences[i]}`));
    }

    if (!ALLOW_MERGES) {
      console.log("\n(merges skipped — re-run with --allow-merges to execute)");
    } else if (DRY_RUN) {
      console.log("\n(DRY_RUN — no merges executed)");
    } else {
      const refTables = tablesReferencingTitleId();
      console.log(`\nremapping title_id across ${refTables.length} tables: ${refTables.join(", ")}`);
      let ok = 0, fail = 0;
      for (const c of mergeCands) {
        const res = executeMerge(c, refTables);
        if (res.ok) { ok++; console.log(`  ✓ merged ${c.loserTitleIds.join(",")} -> ${c.canonicalTitleId}`); }
        else { fail++; console.error(`  ✗ merge igdb_id=${c.igdbId}: ${res.err}`); }
      }
      console.log(`merges: ${ok} ok, ${fail} failed`);
      if (fail > 0) process.exitCode = 1;
    }
  }

  // ─── PASS 2: STEAM ADDS ────────────────────────────────────────────────
  if (!ALLOW_STEAM_ADDS) {
    console.log("\n(Pass 2 skipped — --no-steam-adds flag set)");
  } else {
    console.log("\n─── PASS 2: discover Steam SKUs missing from platform_sku_map ───");
    const addCands = await findSteamAddCandidates();
    console.log(`\nfound ${addCands.length} Steam SKUs to add`);
    if (DRY_RUN) {
      console.log("(DRY_RUN — no inserts executed)");
    } else {
      let ok = 0, fail = 0;
      for (const c of addCands) {
        const res = executeSteamAdd(c);
        if (res.ok) ok++;
        else { fail++; console.error(`  ✗ add title_id=${c.titleId} appid=${c.steamAppId}: ${res.err}`); }
      }
      console.log(`inserts: ${ok} ok, ${fail} failed`);
      if (fail > 0) process.exitCode = 1;
    }
  }

  console.log("\n─── done ───");
}

main().catch(err => {
  console.error(`FATAL: ${err?.message ?? err}`);
  process.exit(2);
});
