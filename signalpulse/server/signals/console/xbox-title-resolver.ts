/**
 * server/signals/console/xbox-title-resolver.ts  (2026-09-12)
 *
 * SOURCE OF TRUTH for Xbox bigId → (name, art_url).
 *
 * The rule: once a bigId is landed in `xbox_title_cache` with a non-empty
 * name, that row is IMMUTABLE. No automated path writes over it, ever. This
 * eliminates the three failure modes that produced numeric-ID leaderboard
 * rows in production:
 *   (1) title_id collisions overwriting one bigId's name with another's,
 *   (2) transient displaycatalog outages writing NULL over a good name,
 *   (3) IGDB mismatches overwriting a store-truthed name.
 *
 * Three-source resolver (only for FIRST landing of a bigId):
 *
 *   1. SSR productSummaries  — xbox.com/en-US/games/browse/top-paid-games
 *      is server-rendered and embeds a `productSummaries` JSON object keyed
 *      by bigId with `title` and `images.boxArt.url`. This is the same data
 *      a shopper sees on the page. Highest trust; if a title is on the SSR
 *      page it is definitionally on the store.
 *
 *   2. displaycatalog      — displaycatalog.mp.microsoft.com/v7.0/products
 *      returns ProductTitle + LocalizedProperties.Images. This is the
 *      backing store both the SSR page and the Xbox app hydrate from.
 *
 *   3. marketplace PDP HTML — marketplace.xbox.com/en-US/Product/{bigId}
 *      final fallback: server-rendered PDP for a single bigId. If a bigId
 *      is truly retired both #1 and #2 will miss but the PDP still exists
 *      for a grace period.
 *
 * If all three miss, the bigId is added to `xbox_bigid_retry_queue` and a
 * background worker retries hourly for 24h then daily thereafter.
 *
 * On subsequent daily runs, an already-landed bigId is NOT re-resolved.
 * `last_verified_at` may be bumped for observability, but name/art are
 * frozen. If a name genuinely changed on the store, an operator runs
 * `scripts/xbox-force-refresh.ts` (not written here — future).
 */

import { rawSqlite } from "../../storage";

const SSR_TOP_PAID_URL = "https://www.xbox.com/en-US/games/browse/top-paid-games";
const DISPLAYCATALOG_URL = "https://displaycatalog.mp.microsoft.com/v7.0/products";
const MARKETPLACE_PDP_URL = "https://marketplace.xbox.com/en-US/Product";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const FETCH_TIMEOUT_MS = 15000;

export type ResolveSource = "ssr_productsummaries" | "displaycatalog" | "marketplace_pdp";

export interface ResolvedTitle {
  bigId: string;
  name: string;
  artUrl: string | null;
  source: ResolveSource;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Cache getter — reads name/art out of xbox_title_cache. This is what the
 * leaderboard route calls. Never triggers a network fetch; if the bigId
 * isn't cached the row is filtered out of the leaderboard upstream.
 */
export function getCachedXboxTitle(bigId: string): { name: string; artUrl: string | null } | null {
  const row = rawSqlite.prepare(
    `SELECT name, art_url FROM xbox_title_cache WHERE big_id = ?`,
  ).get(bigId) as { name: string; art_url: string | null } | undefined;
  return row ? { name: row.name, artUrl: row.art_url ?? null } : null;
}

export function getCachedXboxTitles(bigIds: string[]): Map<string, { name: string; artUrl: string | null }> {
  const out = new Map<string, { name: string; artUrl: string | null }>();
  if (bigIds.length === 0) return out;
  const placeholders = bigIds.map(() => "?").join(",");
  const rows = rawSqlite.prepare(
    `SELECT big_id, name, art_url FROM xbox_title_cache WHERE big_id IN (${placeholders})`,
  ).all(...bigIds) as Array<{ big_id: string; name: string; art_url: string | null }>;
  for (const r of rows) out.set(r.big_id, { name: r.name, artUrl: r.art_url ?? null });
  return out;
}

/**
 * Land a set of bigIds. For each:
 *   - already in xbox_title_cache → no-op (name/art are immutable)
 *   - not yet cached → try the 3 resolvers; on success insert into cache
 *     AND remove any retry-queue row. On complete failure, upsert into
 *     xbox_bigid_retry_queue.
 *
 * Idempotent, safe to call every day for the full top-100 list.
 */
export async function landXboxBigIds(bigIds: string[]): Promise<LandResult> {
  const now = new Date().toISOString();
  const nowMs = Date.now();

  const existingSet = new Set(
    (rawSqlite.prepare(
      `SELECT big_id FROM xbox_title_cache WHERE big_id IN (${bigIds.map(() => "?").join(",")})`,
    ).all(...bigIds) as Array<{ big_id: string }>).map(r => r.big_id),
  );
  const toResolve = bigIds.filter(b => !existingSet.has(b));

  const result: LandResult = {
    total: bigIds.length,
    alreadyLanded: existingSet.size,
    newlyLanded: 0,
    queuedForRetry: 0,
    landedBySource: { ssr_productsummaries: 0, displaycatalog: 0, marketplace_pdp: 0 },
    verifiedBumped: 0,
  };

  // 1. Batch-fetch SSR productSummaries once. Covers the visible top-25 of
  //    xbox.com's server-rendered top-paid page. Any bigId not in that set
  //    falls through to displaycatalog per-bigId.
  const ssrSummaries = await fetchSsrProductSummaries().catch(err => {
    logResolver(`ssr batch fetch failed: ${err instanceof Error ? err.message : err}`);
    return new Map<string, { title: string; artUrl: string | null }>();
  });

  const landStmt = rawSqlite.prepare(
    `INSERT INTO xbox_title_cache (big_id, name, art_url, source, first_landed_at, last_verified_at, verified_count)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(big_id) DO NOTHING`,
  );
  const bumpStmt = rawSqlite.prepare(
    `UPDATE xbox_title_cache SET last_verified_at = ?, verified_count = verified_count + 1 WHERE big_id = ?`,
  );
  const dropRetryStmt = rawSqlite.prepare(`DELETE FROM xbox_bigid_retry_queue WHERE big_id = ?`);
  const queueStmt = rawSqlite.prepare(
    `INSERT INTO xbox_bigid_retry_queue (big_id, first_sighted_at, last_attempt_at, next_attempt_at, attempts_count, last_error)
     VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(big_id) DO UPDATE SET
       last_attempt_at = excluded.last_attempt_at,
       next_attempt_at = excluded.next_attempt_at,
       attempts_count  = xbox_bigid_retry_queue.attempts_count + 1,
       last_error      = excluded.last_error`,
  );

  // Optional: bump last_verified_at for already-cached bigIds we see today.
  for (const bigId of bigIds) {
    if (!existingSet.has(bigId)) continue;
    bumpStmt.run(now, bigId);
    result.verifiedBumped++;
  }

  for (const bigId of toResolve) {
    let landed: ResolvedTitle | null = null;
    let lastErr = "";

    // Source 1 — SSR page hit (top-25 only).
    const ssrHit = ssrSummaries.get(bigId);
    if (ssrHit && ssrHit.title.trim().length > 0) {
      landed = {
        bigId, name: ssrHit.title.trim(), artUrl: ssrHit.artUrl,
        source: "ssr_productsummaries",
      };
    }

    // Source 2 — displaycatalog per-bigId.
    if (!landed) {
      try {
        const dc = await fetchDisplaycatalogTitle(bigId);
        if (dc && dc.name.trim().length > 0) {
          landed = { bigId, name: dc.name.trim(), artUrl: dc.artUrl, source: "displaycatalog" };
        } else {
          lastErr = "displaycatalog: empty ProductTitle";
        }
      } catch (e) {
        lastErr = `displaycatalog: ${e instanceof Error ? e.message : e}`;
      }
      await sleep(200);
    }

    // Source 3 — marketplace PDP HTML.
    if (!landed) {
      try {
        const pdp = await fetchMarketplacePdpTitle(bigId);
        if (pdp && pdp.name.trim().length > 0) {
          landed = { bigId, name: pdp.name.trim(), artUrl: pdp.artUrl, source: "marketplace_pdp" };
        } else if (!lastErr) {
          lastErr = "marketplace_pdp: empty title";
        }
      } catch (e) {
        if (!lastErr) lastErr = `marketplace_pdp: ${e instanceof Error ? e.message : e}`;
      }
      await sleep(200);
    }

    if (landed) {
      landStmt.run(landed.bigId, landed.name, landed.artUrl, landed.source, now, now);
      dropRetryStmt.run(bigId);
      result.newlyLanded++;
      result.landedBySource[landed.source]++;
      logResolver(`landed bigId=${bigId} source=${landed.source} → "${landed.name}"`);
    } else {
      // Compute next_attempt_at with hourly-for-24h-then-daily backoff.
      const existing = rawSqlite.prepare(
        `SELECT first_sighted_at, attempts_count FROM xbox_bigid_retry_queue WHERE big_id = ?`,
      ).get(bigId) as { first_sighted_at: string; attempts_count: number } | undefined;
      const firstSighted = existing?.first_sighted_at ?? now;
      const hoursSinceFirst = (nowMs - new Date(firstSighted).getTime()) / 3_600_000;
      const nextDelayMs = hoursSinceFirst < 24 ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
      const nextAt = new Date(nowMs + nextDelayMs).toISOString();
      queueStmt.run(bigId, firstSighted, now, nextAt, lastErr || "all sources missed");
      result.queuedForRetry++;
      logResolver(`unlanded bigId=${bigId} — queued for retry at ${nextAt} (reason: ${lastErr})`);
    }
  }

  return result;
}

export interface LandResult {
  total: number;
  alreadyLanded: number;
  newlyLanded: number;
  queuedForRetry: number;
  landedBySource: Record<ResolveSource, number>;
  verifiedBumped: number;
}

/**
 * Retry-queue drainer. Called by the hourly worker. Returns per-bigId
 * outcomes. Only touches bigIds whose next_attempt_at is due (<= now).
 */
export async function drainXboxRetryQueue(): Promise<{
  attempted: number;
  landed: number;
  stillQueued: number;
}> {
  const now = new Date().toISOString();
  const due = rawSqlite.prepare(
    `SELECT big_id FROM xbox_bigid_retry_queue WHERE next_attempt_at <= ?`,
  ).all(now) as Array<{ big_id: string }>;
  if (due.length === 0) return { attempted: 0, landed: 0, stillQueued: 0 };
  const bigIds = due.map(r => r.big_id);
  const res = await landXboxBigIds(bigIds);
  return {
    attempted: due.length,
    landed: res.newlyLanded,
    stillQueued: res.queuedForRetry,
  };
}

// ─── Source #1 — SSR productSummaries ────────────────────────────────────────

/**
 * Fetch xbox.com/en-US/games/browse/top-paid-games and extract the embedded
 * `productSummaries` JSON keyed by bigId. Returns a Map<bigId, {title, art}>.
 * Covers the ~25 SSR-visible entries only (page 2+ is client-rendered).
 */
async function fetchSsrProductSummaries(): Promise<Map<string, { title: string; artUrl: string | null }>> {
  const out = new Map<string, { title: string; artUrl: string | null }>();
  const html = await fetchText(SSR_TOP_PAID_URL);
  const idx = html.indexOf('"productSummaries":{');
  if (idx < 0) return out;
  const startBrace = html.indexOf("{", idx + '"productSummaries":'.length - 1);
  // Depth-match to find the closing brace.
  let depth = 0, end = startBrace, inStr = false, esc = false;
  for (; end < html.length; end++) {
    const c = html[end];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { end++; break; } }
  }
  const raw = html.slice(startBrace, end);
  let data: Record<string, { title?: string; images?: { boxArt?: { url?: string } } }>;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    logResolver(`ssr productSummaries JSON parse failed: ${e instanceof Error ? e.message : e}`);
    return out;
  }
  for (const [bigId, entry] of Object.entries(data)) {
    const title = entry?.title ?? "";
    const artUrl = entry?.images?.boxArt?.url ?? null;
    if (title) out.set(bigId, { title, artUrl });
  }
  return out;
}

// ─── Source #2 — displaycatalog ──────────────────────────────────────────────

async function fetchDisplaycatalogTitle(bigId: string): Promise<{ name: string; artUrl: string | null } | null> {
  const url = `${DISPLAYCATALOG_URL}/${encodeURIComponent(bigId)}?market=US&languages=en-us`;
  const json = await fetchJsonHttp(url);
  // Response shape: { Product: {...} } or a bare product; handle both.
  const product = (json as { Product?: unknown }).Product ?? json;
  if (!product || typeof product !== "object") return null;
  const p = product as {
    LocalizedProperties?: Array<{ ProductTitle?: string; Images?: Array<{ ImagePurpose?: string; Uri?: string; Height?: number; Width?: number }> }>;
    ProductTitle?: string;
  };
  const localized = p.LocalizedProperties?.[0];
  const name = localized?.ProductTitle ?? p.ProductTitle ?? "";
  if (!name) return null;
  const artUrl = pickDisplaycatalogArt(localized?.Images ?? []);
  return { name, artUrl };
}

function pickDisplaycatalogArt(images: Array<{ ImagePurpose?: string; Uri?: string; Height?: number; Width?: number }>): string | null {
  // Prefer BoxArt / Poster; fall back to any Uri present.
  const preferred = ["BoxArt", "Poster", "SuperHeroArt", "FeaturePromotionalSquareArt"];
  for (const purpose of preferred) {
    const hit = images.find(im => im.ImagePurpose === purpose && im.Uri);
    if (hit?.Uri) return normalizeArtUrl(hit.Uri);
  }
  const any = images.find(im => im.Uri);
  return any?.Uri ? normalizeArtUrl(any.Uri) : null;
}

// ─── Source #3 — marketplace PDP HTML ────────────────────────────────────────

async function fetchMarketplacePdpTitle(bigId: string): Promise<{ name: string; artUrl: string | null } | null> {
  const url = `${MARKETPLACE_PDP_URL}/${encodeURIComponent(bigId)}`;
  const html = await fetchText(url);
  // Try OpenGraph tags first — most reliable on Microsoft's SSR pages.
  const ogTitle = matchMetaContent(html, /property=["']og:title["']/i);
  const ogImage = matchMetaContent(html, /property=["']og:image["']/i);
  if (ogTitle) return { name: ogTitle, artUrl: ogImage ? normalizeArtUrl(ogImage) : null };
  // Fallback: <title>
  const titleTag = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  if (titleTag?.[1]) return { name: cleanTitleTag(titleTag[1]), artUrl: ogImage ? normalizeArtUrl(ogImage) : null };
  return null;
}

function matchMetaContent(html: string, propRe: RegExp): string | null {
  const idxRe = new RegExp(`<meta[^>]*${propRe.source}[^>]*content=["']([^"']+)["']`, "i");
  const alt = new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*${propRe.source}`, "i");
  const m = html.match(idxRe) ?? html.match(alt);
  return m?.[1] ?? null;
}
function cleanTitleTag(t: string): string {
  return t.replace(/\s*[|\-–]\s*(Xbox|Microsoft Store).*$/i, "").trim();
}

// ─── HTTP + logging helpers ──────────────────────────────────────────────────

async function fetchText(url: string): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
      signal: ctl.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} at ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonHttp(url: string): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept": "application/json", "MS-CV": "signalpulse.xbox-resolver" },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeArtUrl(u: string): string {
  // displaycatalog / marketplace URLs are sometimes protocol-relative.
  if (u.startsWith("//")) return `https:${u}`;
  return u;
}
function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
function logResolver(msg: string): void {
  const line = `[xbox-title-resolver] ${new Date().toISOString()} ${msg}`;
  console.log(line);
}
