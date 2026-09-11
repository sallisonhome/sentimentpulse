/**
 * Enrich console_title_igdb rows with real IGDB metadata.
 *
 * Reads rows whose igdb_id IS NULL (never matched) OR whose refreshed_at
 * is older than STALE_DAYS (default 7). For each, calls refreshIgdbForTitle
 * with the current name and fills cover_url / artwork_url / slug / dates /
 * genres / dev+pub / rating (see server/signals/console/igdb.ts).
 *
 * Idempotent. Skips rows that were refreshed within STALE_DAYS unless
 * FORCE=1 is set. Rate-limit courtesy: 4 req/s (IGDB default).
 *
 * Uses `twitch_client_id` / `twitch_client_secret` from app_settings —
 * same credentials that power the Amazon PDP media pipeline in the
 * legacy server/igdb.ts module.
 *
 * Exit 0 unless everything failed. Individual per-title errors are logged
 * and counted, but do not fail the run: an unmatched name simply keeps
 * the leaderboard showing storefront-fallback text until the next attempt.
 */

import { rawSqlite, storage } from "../server/storage";
import { refreshIgdbForTitle } from "../server/signals/console/igdb";

const STALE_DAYS = parseInt(process.env.STALE_DAYS || "7", 10);
const FORCE = process.env.FORCE === "1";
const MAX_TITLES = parseInt(process.env.MAX_TITLES || "500", 10);
const REQ_PER_SEC = 4; // IGDB default rate limit
const SLEEP_MS = Math.ceil(1000 / REQ_PER_SEC);

interface Row { title_id: number; name: string | null; igdb_id: number | null; refreshed_at: string | null; }

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  // Precondition: twitch creds must be present, else this whole script is a no-op.
  const clientId = storage.getSetting("twitch_client_id")?.value;
  const clientSecret = storage.getSetting("twitch_client_secret")?.value;
  if (!clientId || !clientSecret) {
    console.error("FATAL: twitch_client_id / twitch_client_secret not set in app_settings. Configure them in the Settings UI, then re-run.");
    process.exit(2);
  }

  const cutoffIso = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Prioritize:
  //   1) rows that have a name but no IGDB match yet (fastest wins)
  //   2) then rows whose match is older than cutoff (weekly refresh)
  // Only touch titles that actually appear on the leaderboard — i.e. those
  // in platform_sku_map with business_model = 'paid'. Skipping the rest
  // keeps the daily budget tight.
  const rows = rawSqlite.prepare(`
    SELECT DISTINCT cti.title_id, cti.name, cti.igdb_id, cti.refreshed_at
      FROM console_title_igdb cti
      JOIN platform_sku_map psm ON psm.title_id = cti.title_id
     WHERE psm.business_model = 'paid'
       AND cti.name IS NOT NULL AND cti.name != ''
       AND (cti.igdb_id IS NULL OR ? OR cti.refreshed_at < ?)
     ORDER BY (cti.igdb_id IS NULL) DESC, cti.refreshed_at ASC NULLS FIRST
     LIMIT ?
  `).all(FORCE ? 1 : 0, cutoffIso, MAX_TITLES) as Row[];

  console.log(`[enrich-console-igdb] processing ${rows.length} titles (force=${FORCE}, stale>${STALE_DAYS}d, max=${MAX_TITLES})`);

  let matched = 0, unmatched = 0, cached = 0, errored = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.name) { unmatched++; continue; }
    try {
      const result = await refreshIgdbForTitle(r.title_id, r.name, FORCE);
      if (result.fromCache) cached++;
      else if (result.matched) matched++;
      else unmatched++;
      if ((i + 1) % 25 === 0) {
        console.log(`  progress: ${i + 1}/${rows.length}  matched=${matched} unmatched=${unmatched} cached=${cached} errored=${errored}`);
      }
    } catch (err: any) {
      errored++;
      console.error(`  err title_id=${r.title_id} name="${r.name}": ${err?.message || err}`);
      // If we're hitting rate limits or auth failures back-to-back, back off.
      if (errored > 10 && (errored / Math.max(1, i + 1)) > 0.5) {
        console.error("  too many errors — aborting to protect the IGDB app quota");
        break;
      }
    }
    // Steady 4 req/s regardless of cache hit — the guard is trivially cheap.
    await sleep(SLEEP_MS);
  }

  console.log(`[enrich-console-igdb] done: matched=${matched} unmatched=${unmatched} cached=${cached} errored=${errored}`);

  // Post-run sample so the workflow log shows real cover URLs landed.
  const sample = rawSqlite.prepare(`
    SELECT title_id, name, slug, substr(cover_url, 1, 80) AS cover_url_head
      FROM console_title_igdb
     WHERE igdb_id IS NOT NULL AND cover_url IS NOT NULL
     ORDER BY refreshed_at DESC LIMIT 5
  `).all();
  console.log(`[enrich-console-igdb] sample of enriched rows:`);
  for (const row of sample) console.log(`  ${JSON.stringify(row)}`);

  // Non-zero only if literally everything failed and nothing was matched.
  if (errored > 0 && matched === 0 && cached === 0) process.exit(1);
}

main().catch(err => {
  console.error(`[enrich-console-igdb] FATAL: ${err?.message || err}`);
  process.exit(2);
});
