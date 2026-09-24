import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { CriticRating, PlayerRating, RatingStatus, ReviewsRatings } from "../shared/reviews-ratings";
import { count, criticSearchTitle, exactCandidates, normalizeCritics, ratingIdentity, score, steamAppDetails, steamSummary, verifyCriticIdentity } from "./reviews-ratings-normalize";
import { reviewedCriticAlias } from "./reviews-ratings-aliases";

export const OPENCRITIC_HOST = "best-opencritic-scraper-free-1000-calls.p.rapidapi.com";
const DAY = 86400_000;
const TTL = DAY;
const RETRY = 30 * 60_000;
type CacheRow = { value_json: string | null; fetched_at: number | null; checked_at: number; retry_at: number; status: RatingStatus };
export type RatingIdentity = { name: string; releaseDate: string | null; steamAppId: string | null; criticEligible?: boolean; releaseDates?: string[] };
export type RatingSku = { titleId: number; platform: string; externalSku: string; conceptId: string | null; name?: string | null };

export function emptyCritics(status: RatingStatus): CriticRating {
  return { status, provider: "omkarcloud", id: null, name: null, url: null,
    criticsRecommend: null, topCriticScore: null, rating: null, reviewCount: null, capturedAt: null };
}

export class ReviewsRatingsService {
  private pending = new Map<string, Promise<void>>();
  private now: () => number;
  constructor(
    private db: Database.Database,
    private setting: (key: string) => string | undefined,
    private request: typeof fetch = fetch,
    now: () => number = Date.now,
  ) {
    this.now = now;
    // Additive/idempotent; no edits to any sales signals or existing tables.
    db.exec(`
      CREATE TABLE IF NOT EXISTS review_rating_cache (
        cache_key TEXT PRIMARY KEY, value_json TEXT, fetched_at INTEGER,
        checked_at INTEGER NOT NULL, retry_at INTEGER NOT NULL, status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS opencritic_title_matches (
        identity_key TEXT PRIMARY KEY, opencritic_id INTEGER NOT NULL,
        matched_name TEXT NOT NULL, matched_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS opencritic_request_usage (
        id INTEGER PRIMARY KEY, requested_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS opencritic_request_usage_time ON opencritic_request_usage(requested_at);
      CREATE TABLE IF NOT EXISTS review_rating_provider_state (
        provider TEXT PRIMARY KEY, retry_at INTEGER NOT NULL, status TEXT NOT NULL, credential_tag TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS verified_rating_links (
        platform TEXT NOT NULL, external_sku TEXT NOT NULL,
        steam_app_id TEXT NOT NULL, store_name TEXT NOT NULL,
        source_url TEXT NOT NULL, verified_at TEXT NOT NULL,
        verification_source TEXT NOT NULL,
        PRIMARY KEY(platform,external_sku)
      );
    `);
  }

  private cached<T>(key: string, load: () => Promise<T>, ttl = TTL) {
    const now = this.now();
    let row = this.db.prepare("SELECT * FROM review_rating_cache WHERE cache_key=?").get(key) as CacheRow | undefined;
    const fresh = row?.fetched_at != null && now - row.fetched_at < ttl;
    const due = !row || (!fresh && now >= row.retry_at);
    if (due && !this.pending.has(key) && this.pending.size < 8) {
      const previous = row;
      const task = Promise.resolve().then(load).then(value => {
        const time = this.now();
        const status = value == null ? "not_found" : "ready";
        this.db.prepare(`INSERT INTO review_rating_cache VALUES(?,?,?,?,?,?)
          ON CONFLICT(cache_key) DO UPDATE SET value_json=excluded.value_json,
          fetched_at=excluded.fetched_at,checked_at=excluded.checked_at,retry_at=excluded.retry_at,status=excluded.status`)
          .run(key, value == null ? null : JSON.stringify(value), value == null ? null : time, time,
            time + (value == null ? 7 * DAY : ttl), status);
      }).catch((err: any) => {
        const state: RatingStatus = ["ambiguous", "budget_exhausted", "rate_limited", "unsupported"].includes(err?.message)
          ? err.message : "error";
        const time = this.now();
        this.db.prepare(`INSERT INTO review_rating_cache VALUES(?,?,?,?,?,?)
          ON CONFLICT(cache_key) DO UPDATE SET checked_at=excluded.checked_at,retry_at=excluded.retry_at,status=excluded.status`)
          .run(key, previous?.value_json ?? null, previous?.fetched_at ?? null, time, time + RETRY, state);
      }).finally(() => this.pending.delete(key));
      this.pending.set(key, task);
    }
    const value: T | null = row?.value_json ? JSON.parse(row.value_json) : null;
    return {
      value,
      capturedAt: row?.fetched_at != null ? new Date(row.fetched_at).toISOString() : null,
      status: (value != null ? (fresh ? "ready" : "stale")
        : this.pending.has(key) ? "loading" : row?.status ?? "loading") as RatingStatus,
      refreshing: this.pending.has(key) || due,
    };
  }

  private async json(url: string, headers: Record<string, string> = {}) {
    const res = await this.request(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      const err: any = new Error(res.status === 429 ? "rate_limited" : "provider_error");
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  private async criticRequest(path: string, key: string) {
    const now = this.now();
    const tag = createHash("sha256").update(key).digest("hex").slice(0, 16);
    const circuit = this.db.prepare("SELECT * FROM review_rating_provider_state WHERE provider='omkarcloud'").get() as any;
    if (circuit?.credential_tag === tag && now < circuit.retry_at) throw new Error(circuit.status);
    // Rolling 31-day cap is conservative across billing-cycle boundaries.
    // Counts attempts, including failures and searches, atomically before I/O.
    const allowed = this.db.transaction(() => {
      this.db.prepare("DELETE FROM opencritic_request_usage WHERE requested_at < ?").run(now - 31 * DAY);
      const used = (this.db.prepare("SELECT COUNT(*) AS n FROM opencritic_request_usage").get() as any).n;
      if (used >= 900) return false;
      this.db.prepare("INSERT INTO opencritic_request_usage(requested_at) VALUES(?)").run(now);
      return true;
    })();
    if (!allowed) throw new Error("budget_exhausted");
    try {
      return await this.json(`https://${OPENCRITIC_HOST}${path}`, { "X-RapidAPI-Host": OPENCRITIC_HOST, "X-RapidAPI-Key": key });
    } catch (err: any) {
      if ([401, 403, 429].includes(err.status)) {
        this.db.prepare(`INSERT INTO review_rating_provider_state VALUES('omkarcloud',?,?,?)
          ON CONFLICT(provider) DO UPDATE SET retry_at=excluded.retry_at,status=excluded.status,credential_tag=excluded.credential_tag`)
          .run(now + RETRY, err.status === 429 ? "rate_limited" : "error", tag);
      }
      throw err;
    }
  }

  steamIdentity(appId: string) {
    // Versioned identity cache bypasses old envelope-key errors without
    // deleting successful review/critic caches or spending extra critic quota.
    return this.cached<RatingIdentity>(`steam_identity:v2:${appId}`, async () => {
      const raw = await this.json(`https://store.steampowered.com/api/appdetails?appids=${appId}&l=english`);
      const data = steamAppDetails(raw, appId);
      if (!data) return null as any;
      const release = Date.parse(data.release_date?.date ?? "");
      return {
        name: data.name,
        releaseDate: Number.isFinite(release) ? new Date(release).toISOString().slice(0, 10) : null,
        steamAppId: appId,
        criticEligible: data.type === "game" && !/\b(?:demo|friends?['’]?\s*pass|buddy\s*pass|playtest)\b/i.test(data.name),
      };
    }, 7 * DAY);
  }

  get(identity: RatingIdentity, skus: RatingSku[]): ReviewsRatings {
    const players: PlayerRating[] = [];
    let refreshing = false;
    if (identity.steamAppId) {
      const appId = identity.steamAppId;
      const cached = this.cached(`steam_reviews:${appId}`, async () => steamSummary(await this.json(
        `https://store.steampowered.com/appreviews/${appId}?json=1&language=all&purchase_type=steam&filter=all&num_per_page=0`,
      )));
      refreshing ||= cached.refreshing;
      const value = cached.value as ReturnType<typeof steamSummary> | null;
      players.push({
        source: "steam", label: "Steam Rating", value: value?.value ?? null, scale: 100,
        description: value?.description ?? null, count: value?.count ?? null,
        url: `https://store.steampowered.com/app/${appId}/#app_reviews_hash`,
        capturedAt: cached.capturedAt, status: value?.count === 0 ? "unavailable" : cached.status,
      });
    }
    for (const platform of ["ps5", "xbox"] as const) {
      const candidates = skus.filter(s => s.platform === platform);
      if (!candidates.length) continue;
      // Pick one latest title/concept observation; never average or sum regions.
      const ids = Array.from(new Set(candidates.map(s => s.titleId)));
      const row = this.db.prepare(`SELECT title_id,avg_rating,rating_count,capture_date,created_at
        FROM store_rating_signal_daily WHERE platform=? AND window_label='ltd'
        AND title_id IN (${ids.map(() => "?").join(",")})
        ORDER BY capture_date DESC,created_at DESC,id DESC LIMIT 1`).get(platform, ...ids) as any;
      const sku = candidates.find(s => s.titleId === row?.title_id) ?? candidates[0];
      const region = sku.externalSku.startsWith("EP") ? "en-gb" : sku.externalSku.startsWith("JP") ? "ja-jp"
        : sku.externalSku.startsWith("HP") ? "en-sg" : "en-us";
      const capturedAt = row?.capture_date ?? null;
      const value = row?.rating_count > 0 ? score(row.avg_rating, 5) : null;
      players.push({
        source: platform, label: platform === "ps5" ? "PS Store Player Rating" : "Xbox Store Player Rating",
        value, scale: 5,
        description: [platform === "ps5" && /-CUSA\d+_/.test(sku.externalSku) ? "PS4 listing on PlayStation Store" : null,
          sku.name && ratingIdentity(criticSearchTitle(sku.name)) !== ratingIdentity(criticSearchTitle(identity.name))
            ? `Console listing: ${sku.name}` : null].filter(Boolean).join(" · ") || null,
        count: count(row?.rating_count),
        url: platform === "ps5" ? `https://store.playstation.com/${region}/product/${encodeURIComponent(sku.externalSku)}`
          : `https://www.xbox.com/en-US/games/store/-/${encodeURIComponent(sku.externalSku)}`,
        capturedAt, status: value == null ? "unavailable"
          : !Number.isFinite(Date.parse(capturedAt)) || this.now() - Date.parse(capturedAt) > 2 * DAY ? "stale" : "ready",
      });
    }

    let openCritic: CriticRating;
    const key = this.setting("opencritic_rapidapi_key")?.trim()
      || (process.env.NODE_ENV !== "production" ? process.env.OPENCRITIC_RAPIDAPI_KEY?.trim() : undefined);
    if (identity.criticEligible === false || /\b(?:demo|friends?['’]?\s*pass|buddy\s*pass|playtest)\b/i.test(identity.name)) {
      openCritic = emptyCritics("unsupported");
    } else if (!key) {
      openCritic = emptyCritics("unconfigured");
    } else {
      const alias = reviewedCriticAlias(identity.steamAppId, identity.name);
      const searchName = alias?.name ?? criticSearchTitle(identity.name);
      const matchKey = `${ratingIdentity(searchName)}:${identity.releaseDate ?? "unknown"}`;
      const dates = Array.from(new Set([identity.releaseDate, alias?.releaseDate, ...(identity.releaseDates ?? [])].filter(Boolean))).sort();
      const evidenceTag = dates.length > 1 ? `:dates:${createHash("sha256").update(dates.join("|")).digest("hex").slice(0, 12)}` : "";
      const baseCacheKey = `opencritic:v2:${matchKey}`;
      const cacheKey = `${baseCacheKey}${evidenceTag}${alias ? `:alias:${alias.id}` : ""}`;
      // Keep valid existing scores; only old negative/ambiguous caches are
      // retried by the revised matcher. No broad production cache deletion.
      if (!alias) this.db.prepare(`INSERT OR IGNORE INTO review_rating_cache
        SELECT ?,value_json,fetched_at,checked_at,retry_at,status FROM review_rating_cache
        WHERE cache_key=? AND status='ready' AND value_json IS NOT NULL`)
        .run(cacheKey, `opencritic:${matchKey}`);
      if (!alias && cacheKey !== baseCacheKey) this.db.prepare(`INSERT OR IGNORE INTO review_rating_cache
        SELECT ?,value_json,fetched_at,checked_at,retry_at,status FROM review_rating_cache
        WHERE cache_key=? AND status='ready' AND value_json IS NOT NULL`).run(cacheKey, baseCacheKey);
      const cached = this.cached(cacheKey, async () => {
        let match = this.db.prepare("SELECT opencritic_id FROM opencritic_title_matches WHERE identity_key=?").get(matchKey) as any;
        const candidates = alias ? [{ id: alias.id }] : match ? [{ id: match.opencritic_id }]
          : exactCandidates(await this.criticRequest(`/games/search?query=${encodeURIComponent(searchName)}`, key), searchName,
            [identity.releaseDate, ...(identity.releaseDates ?? [])].filter((d): d is string => !!d));
        if (!candidates.length) return null as any;
        // Reused names (e.g. original/remake) are not resolved by result order.
        // Bound the spend, verify every candidate and require exactly one.
        if (candidates.length > 3) throw new Error("ambiguous");
        const verified: any[] = [];
        for (const candidate of candidates) {
          const raw = await this.criticRequest(`/games/details?game=${candidate.id}`, key);
          const reviewedTitleWide = alias?.titleWide && raw?.id === alias.id
            && ratingIdentity(raw?.name ?? "") === ratingIdentity(alias.name)
            && (raw?.steam_id == null || String(raw.steam_id) === identity.steamAppId);
          if (raw?.id === candidate.id && (reviewedTitleWide
            || verifyCriticIdentity(raw, searchName, identity.releaseDate, identity.steamAppId,
              [...(identity.releaseDates ?? []), ...(alias?.releaseDate ? [alias.releaseDate] : [])]))) {
            verified.push(raw);
          }
        }
        if (verified.length !== 1) throw new Error("ambiguous");
        const normalized = normalizeCritics(verified[0]);
        this.db.prepare(`INSERT INTO opencritic_title_matches VALUES(?,?,?,?)
          ON CONFLICT(identity_key) DO UPDATE SET opencritic_id=excluded.opencritic_id,matched_name=excluded.matched_name,matched_at=excluded.matched_at`)
          .run(matchKey, normalized.id, normalized.name, this.now());
        return normalized;
      });
      refreshing ||= cached.refreshing;
      openCritic = { ...emptyCritics(cached.status), ...(cached.value ?? {}),
        status: cached.status, capturedAt: cached.capturedAt };
    }
    return { title: identity.name, players, openCritic, refreshing };
  }

  // Lets integration tests await real background work, without sleeps.
  async settle() { await Promise.all(this.pending.values()); }
}
