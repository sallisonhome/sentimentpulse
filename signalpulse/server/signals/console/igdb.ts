/**
 * IGDB enrichment for console leaderboards.
 *
 * Uses the Twitch OAuth2 flow (IGDB requires Twitch app credentials since 2020).
 * Credentials are read from app_settings keys:
 *   twitch_client_id
 *   twitch_client_secret
 * (Same keys the pre-existing server/igdb.ts module uses to enrich the
 * howmanyareplaying-style Amazon PDPs, so a single Twitch app powers both.)
 * The bearer token is cached in-process for its full TTL.
 *
 * Rate-limit courtesy: 4 req/s max, 500 rows per response max — IGDB defaults.
 * Weekly refresh cron populates `console_title_igdb`. Manual refresh is exposed
 * via POST /api/console/igdb/refresh/:titleId.
 *
 * We NEVER guess an IGDB match. Best-effort name search returns the top hit,
 * and the refreshed_at + returned igdb_id/slug lets an operator eyeball
 * mismatches. A follow-up phase will add a manual override table if needed.
 */

import { rawSqlite } from "../../storage";
import { log } from "../../log";
import { storage } from "../../storage";

let cachedToken: { access_token: string; expires_at: number } | null = null;

async function getToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expires_at > now + 60_000) return cachedToken.access_token;
  const clientId = storage.getSetting("twitch_client_id")?.value;
  const clientSecret = storage.getSetting("twitch_client_secret")?.value;
  if (!clientId || !clientSecret) {
    throw new Error("IGDB credentials missing: set twitch_client_id and twitch_client_secret in app_settings (Settings → API Keys)");
  }
  const url = `https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials`;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) throw new Error(`Twitch OAuth failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as { access_token: string; expires_in: number };
  cachedToken = { access_token: data.access_token, expires_at: now + data.expires_in * 1000 };
  return cachedToken.access_token;
}

interface IgdbGame {
  id: number;
  name: string;
  slug: string;
  summary?: string;
  first_release_date?: number;                 // unix seconds
  cover?: { image_id: string };
  artworks?: Array<{ image_id: string }>;
  screenshots?: Array<{ image_id: string }>;
  genres?: Array<{ name: string }>;
  themes?: Array<{ name: string }>;
  platforms?: Array<{ name: string }>;
  involved_companies?: Array<{ developer: boolean; publisher: boolean; company: { name: string } }>;
  rating?: number;
  rating_count?: number;
}

async function igdbQuery<T>(endpoint: string, body: string): Promise<T> {
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

function imageUrl(imageId: string | undefined, size: "cover_big" | "1080p" | "screenshot_med" = "cover_big"): string | null {
  if (!imageId) return null;
  return `https://images.igdb.com/igdb/image/upload/t_${size}/${imageId}.jpg`;
}

export interface IgdbRefreshResult {
  titleId: number;
  igdbId: number | null;
  slug: string | null;
  matched: boolean;
  fromCache: boolean;
}

/**
 * SKU-level IGDB overrides for known collisions where IGDB's `search`
 * endpoint returns the wrong top hit for a plain name query.
 *
 * Keyed by `${platform}:${external_sku}`. Discovered cases:
 *   - Steam 1245620 (base Elden Ring): IGDB search for "ELDEN RING" returns
 *     Elden Ring Nightreign as top hit (id 325591) because Nightreign is
 *     newer/more popular. Pin to id 119133 slug elden-ring.
 *   - PSN UP0700-PPSA04610_00-ELDENRING0000000 (base Elden Ring PS4/PS5):
 *     same collision as above.
 *
 * Bigger fix pending: use IGDB /external_games to look up by storefront
 * appid/product id directly instead of by name. See
 * docs/calibration-anchors-todo.md.
 */
const IGDB_SKU_OVERRIDES: Record<string, { igdbId: number; canonicalName: string }> = {
  "steam:1245620": { igdbId: 119133, canonicalName: "Elden Ring" },
  "ps5:UP0700-PPSA04610_00-ELDENRING0000000": { igdbId: 119133, canonicalName: "Elden Ring" },
};

function lookupOverrideForTitle(titleId: number): { igdbId: number; canonicalName: string } | null {
  const skus = rawSqlite.prepare(
    `SELECT platform, external_sku FROM platform_sku_map WHERE title_id = ?`,
  ).all(titleId) as Array<{ platform: string; external_sku: string }>;
  for (const s of skus) {
    const hit = IGDB_SKU_OVERRIDES[`${s.platform}:${s.external_sku}`];
    if (hit) return hit;
  }
  return null;
}

/**
 * Refresh IGDB metadata for one title. Skips refresh if the row was updated
 * within the last 7 days unless force=true.
 */
export async function refreshIgdbForTitle(titleId: number, name: string, force: boolean = false): Promise<IgdbRefreshResult> {
  // Only cache-skip a row that has ALREADY matched IGDB — a bootstrap row
  // written by discovery has refreshed_at=now but igdb_id=NULL and still
  // needs a real match on the next enrichment tick. Skipping those would
  // permanently strand every discovery-fresh row without a cover.
  const existing = rawSqlite.prepare(
    `SELECT refreshed_at, igdb_id FROM console_title_igdb WHERE title_id = ?`
  ).get(titleId) as { refreshed_at: string; igdb_id: number | null } | undefined;
  if (existing && existing.igdb_id != null && !force) {
    const ageMs = Date.now() - new Date(existing.refreshed_at).getTime();
    if (ageMs < 7 * 24 * 60 * 60 * 1000) {
      return { titleId, igdbId: existing.igdb_id, slug: null, matched: true, fromCache: true };
    }
  }

  // Check SKU-level override before hitting IGDB search. When a known
  // collision SKU is bound to this title, pin the IGDB lookup to the
  // correct id (fetched by id, not by name).
  const override = lookupOverrideForTitle(titleId);
  let hits: IgdbGame[] | null = null;
  if (override) {
    const byId = `fields id,name,slug,summary,first_release_date,cover.image_id,artworks.image_id,screenshots.image_id,genres.name,themes.name,platforms.name,involved_companies.developer,involved_companies.publisher,involved_companies.company.name,rating,rating_count; where id = ${override.igdbId}; limit 1;`;
    hits = await igdbQuery<IgdbGame[]>("games", byId);
    log(`igdb: applied SKU override for titleId=${titleId} → igdb_id=${override.igdbId} (${override.canonicalName})`);
  } else {
    // Query IGDB — search by name, take top hit
    const escaped = name.replace(/"/g, '\\"');
    const query = `search "${escaped}"; fields id,name,slug,summary,first_release_date,cover.image_id,artworks.image_id,screenshots.image_id,genres.name,themes.name,platforms.name,involved_companies.developer,involved_companies.publisher,involved_companies.company.name,rating,rating_count; limit 1;`;
    hits = await igdbQuery<IgdbGame[]>("games", query);
  }
  if (!Array.isArray(hits) || hits.length === 0) {
    // Write empty row so we don't keep retrying on the same tick
    const nowIso = new Date().toISOString();
    rawSqlite.prepare(`
      INSERT INTO console_title_igdb (title_id, igdb_id, slug, name, refreshed_at, created_at)
      VALUES (?, NULL, NULL, ?, ?, ?)
      ON CONFLICT(title_id) DO UPDATE SET refreshed_at = excluded.refreshed_at
    `).run(titleId, name, nowIso, nowIso);
    return { titleId, igdbId: null, slug: null, matched: false, fromCache: false };
  }
  const g = hits[0];
  const nowIso = new Date().toISOString();
  const releaseIso = g.first_release_date ? new Date(g.first_release_date * 1000).toISOString().slice(0, 10) : null;
  const cover = imageUrl(g.cover?.image_id, "cover_big");
  const artwork = imageUrl(g.artworks?.[0]?.image_id, "1080p");
  const screenshots = (g.screenshots || []).slice(0, 6).map(s => imageUrl(s.image_id, "screenshot_med")).filter(Boolean);
  const genres = (g.genres || []).map(x => x.name);
  const themes = (g.themes || []).map(x => x.name);
  const platforms = (g.platforms || []).map(x => x.name);
  const developers = (g.involved_companies || []).filter(c => c.developer).map(c => c.company.name);
  const publishers = (g.involved_companies || []).filter(c => c.publisher).map(c => c.company.name);

  rawSqlite.prepare(`
    INSERT INTO console_title_igdb
      (title_id, igdb_id, slug, name, summary, release_date, cover_url, artwork_url,
       screenshots_json, genres_json, themes_json, platforms_json, developers_json, publishers_json,
       rating, rating_count, refreshed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(title_id) DO UPDATE SET
      igdb_id = excluded.igdb_id, slug = excluded.slug, name = excluded.name,
      summary = excluded.summary, release_date = excluded.release_date,
      cover_url = excluded.cover_url, artwork_url = excluded.artwork_url,
      screenshots_json = excluded.screenshots_json, genres_json = excluded.genres_json,
      themes_json = excluded.themes_json, platforms_json = excluded.platforms_json,
      developers_json = excluded.developers_json, publishers_json = excluded.publishers_json,
      rating = excluded.rating, rating_count = excluded.rating_count,
      refreshed_at = excluded.refreshed_at
  `).run(
    titleId, g.id, g.slug, g.name, g.summary || null, releaseIso, cover, artwork,
    JSON.stringify(screenshots), JSON.stringify(genres), JSON.stringify(themes),
    JSON.stringify(platforms), JSON.stringify(developers), JSON.stringify(publishers),
    g.rating || null, g.rating_count || null, nowIso, nowIso,
  );

  log(`igdb: refreshed titleId=${titleId} → igdb_id=${g.id} (${g.slug})`);
  return { titleId, igdbId: g.id, slug: g.slug, matched: true, fromCache: false };
}
