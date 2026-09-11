/**
 * Enrich Xbox is_gamepass flags on platform_sku_map by asking IGDB.
 *
 * IGDB exposes Xbox Game Pass presence via the deprecated but still-populated
 * ExternalGameCategoryEnum value 54 ("xbox_game_pass_ultimate_cloud") on the
 * /external_games endpoint. Every IGDB game that has ANY external_game row with
 * category = 54 is (per IGDB) currently on Game Pass on at least one tier.
 *
 * Contract with the estimator:
 * - We only mark rows we can confirm. If IGDB says "not on GP" we do NOT clear
 *   the flag — the hand-curated seed (seed-xbox-gamepass-flags.ts) may have
 *   set it based on operator knowledge that IGDB is missing. Additive-only.
 * - Xbox rows only. PlayStation Plus / Nintendo Switch Online enrichment can
 *   slot into the same estimator machinery later; today the estimator only
 *   reads xbox rows.
 *
 * Runs after enrich-console-igdb.ts so we know console_title_igdb.igdb_id is
 * populated for as many titles as possible. Rows without an igdb_id are
 * skipped and left to the hand-curated seed.
 *
 * Idempotent. Rerun daily as part of signalpulse-seed-console-data.yml.
 *
 * Env:
 *   MAX_TITLES  - cap on titles to look up per run (default 400).
 *   FORCE=1     - also re-check titles already flagged is_gamepass=1.
 *                 Without FORCE, we still call IGDB for them to detect a churn
 *                 (title left GP) but the current logic is additive-only, so
 *                 this flag mostly affects logging.
 */

/* eslint-disable no-console */

import { rawSqlite, storage } from "../server/storage";

const MAX_TITLES = parseInt(process.env.MAX_TITLES || "400", 10);
const REQ_PER_SEC = 4;
const SLEEP_MS = Math.ceil(1000 / REQ_PER_SEC);

// From igdbapi.proto / api-docs.igdb.com/#external-game-category-enum
const IGDB_CATEGORY_XBOX_GAME_PASS = 54;

interface Row { title_id: number; name: string | null; igdb_id: number | null; is_gamepass: number; }

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

// Local Twitch OAuth flow — mirrors server/signals/console/igdb.ts. Kept
// inline so this script has no extra module wiring; the two modules can
// safely hold independent token caches, they just both cost one token
// per hour of activity.
let cachedToken: { access_token: string; expires_at: number } | null = null;

async function getToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expires_at > now + 60_000) return cachedToken.access_token;
  const clientId = storage.getSetting("twitch_client_id")?.value;
  const clientSecret = storage.getSetting("twitch_client_secret")?.value;
  if (!clientId || !clientSecret) throw new Error("twitch_client_id / twitch_client_secret missing in app_settings");
  const url = `https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials`;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) throw new Error(`Twitch OAuth failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as { access_token: string; expires_in: number };
  cachedToken = { access_token: data.access_token, expires_at: now + data.expires_in * 1000 };
  return cachedToken.access_token;
}

async function igdb<T>(endpoint: string, body: string): Promise<T> {
  const token = await getToken();
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

async function main() {
  const db = rawSqlite;

  // Every xbox SKU that maps to an IGDB-matched title. Grouped by title_id
  // because a game with multiple xbox SKUs (base + deluxe + PS4/PS5 crossgen)
  // shares the same GP status.
  const rows = db.prepare(`
    SELECT DISTINCT p.title_id,
           cti.name,
           cti.igdb_id,
           MAX(p.is_gamepass) AS is_gamepass
      FROM platform_sku_map p
      JOIN console_title_igdb cti ON cti.title_id = p.title_id
     WHERE p.platform = 'xbox'
       AND p.business_model = 'paid'
       AND cti.igdb_id IS NOT NULL
     GROUP BY p.title_id
     ORDER BY p.title_id ASC
     LIMIT ?
  `).all(MAX_TITLES) as Row[];

  console.log(`[enrich-xbox-gamepass-flags] checking ${rows.length} IGDB-matched xbox titles (cat=${IGDB_CATEGORY_XBOX_GAME_PASS} → is_gamepass=1)`);

  const updateSku = db.prepare(
    `UPDATE platform_sku_map SET is_gamepass = 1 WHERE title_id = ? AND platform = 'xbox' AND is_gamepass = 0`
  );

  let onGp = 0, notOnGp = 0, alreadyFlagged = 0, newlyFlagged = 0, errored = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      // One /external_games query per title. Batching would be more efficient
      // (up to 500 ids per call with `where game = (…)`), but at 4 req/s and
      // ~400 titles a run we're comfortably under a minute and the simple
      // per-title form keeps the response shape trivial. If MAX_TITLES grows,
      // switch to the batched form (see IGDB Apicalypse `where … in (…)`).
      const body = `fields game,category,uid,name; where game = ${r.igdb_id} & category = ${IGDB_CATEGORY_XBOX_GAME_PASS}; limit 5;`;
      const hits = await igdb<Array<{ game: number; category: number; uid: string; name?: string }>>("external_games", body);
      const isGp = Array.isArray(hits) && hits.length > 0;

      if (isGp) {
        onGp++;
        if (r.is_gamepass === 1) {
          alreadyFlagged++;
        } else {
          const info = updateSku.run(r.title_id);
          newlyFlagged += info.changes;
          console.log(`  gp+ title_id=${r.title_id} igdb_id=${r.igdb_id} "${r.name}" — ${info.changes} sku row(s) newly flagged (uid=${hits[0].uid || "?"})`);
        }
      } else {
        notOnGp++;
      }

      if ((i + 1) % 25 === 0) {
        console.log(`  progress: ${i + 1}/${rows.length}  gp=${onGp} (${newlyFlagged} newly flagged) not_gp=${notOnGp} err=${errored}`);
      }
    } catch (err: any) {
      errored++;
      console.error(`  err title_id=${r.title_id} igdb_id=${r.igdb_id} "${r.name}": ${err?.message || err}`);
      if (errored > 10 && errored / Math.max(1, i + 1) > 0.5) {
        console.error("  too many errors — aborting to protect the IGDB quota");
        break;
      }
    }
    await sleep(SLEEP_MS);
  }

  const totalGp = (db.prepare(
    `SELECT COUNT(DISTINCT title_id) AS n FROM platform_sku_map WHERE platform = 'xbox' AND is_gamepass = 1`
  ).get() as { n: number }).n;

  console.log(`[enrich-xbox-gamepass-flags] done: on_gp=${onGp} (already=${alreadyFlagged} newly=${newlyFlagged}) not_on_gp=${notOnGp} errored=${errored}`);
  console.log(`[enrich-xbox-gamepass-flags] platform_sku_map now shows ${totalGp} distinct xbox titles with is_gamepass=1`);

  if (errored > 0 && newlyFlagged === 0 && alreadyFlagged === 0) process.exit(1);
}

main().catch(err => {
  console.error(`[enrich-xbox-gamepass-flags] FATAL: ${err?.message || err}`);
  process.exit(2);
});
