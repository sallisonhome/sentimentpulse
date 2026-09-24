import type { Express } from "express";
import rateLimit from "express-rate-limit";
import { rawSqlite, storage } from "./storage";
import { editionGroupKey } from "./routes-console-leaderboards";
import { metadataMatchesStorefront } from "./console-title-identity";
import { CCU_RATINGS_SOURCE, RATINGS_ONLY_SOURCES } from "./ratings-only-sku";
import { emptyCritics, ReviewsRatingsService, type RatingIdentity, type RatingSku } from "./reviews-ratings-service";
import { criticSearchTitle, ratingIdentity } from "./reviews-ratings-normalize";

type CatalogRow = RatingSku & { name: string | null; storeName: string | null; igdbName: string | null;
  igdbId: number | null; matchConfidence: string | null; releaseDate: string | null; storeReleaseDate: string | null };

function catalog(): CatalogRow[] {
  return rawSqlite.prepare(`SELECT p.title_id AS titleId,p.platform,p.external_sku AS externalSku,p.concept_id AS conceptId,
    COALESCE(NULLIF(c.store_name,''),CASE WHEN x.source <> 'seeded_from_cti' THEN x.name END,
      CASE WHEN c.match_confidence IS NOT 'low' THEN c.name END) AS name,
    c.store_name AS storeName,c.name AS igdbName,c.igdb_id AS igdbId,c.match_confidence AS matchConfidence,
    c.release_date AS releaseDate,c.store_release_date AS storeReleaseDate
    FROM platform_sku_map p LEFT JOIN console_title_igdb c ON c.title_id=p.title_id
    LEFT JOIN xbox_title_cache x ON p.platform='xbox' AND x.big_id=p.external_sku
    WHERE p.platform IN ('steam','ps5','xbox') AND (p.sku_role='base'
      OR (p.sku_role='ratings_only' AND p.is_manual_override=1
        AND p.business_model_source IN (${RATINGS_ONLY_SOURCES.map(() => "?").join(",")})))`)
    .all(...RATINGS_ONLY_SOURCES) as CatalogRow[];
}

function safeIgdbId(row: CatalogRow) {
  return row.matchConfidence !== "low" && metadataMatchesStorefront(row.storeName, row.igdbName) ? row.igdbId : null;
}

function familyKeys(row: CatalogRow): string[] {
  // Buying links use trusted IGDB spelling on Steam/PS (e.g. "II"),
  // while critic search needs the storefront spelling ("2"). Both are
  // verified aliases of this SKU, not permission to fuzzy-match other games.
  const names = [row.name];
  if (row.matchConfidence !== "low" && metadataMatchesStorefront(row.name, row.igdbName)
    && metadataMatchesStorefront(row.storeName, row.igdbName)) names.push(row.igdbName);
  return Array.from(new Set(names.map(editionGroupKey).filter(Boolean)));
}

function family(rows: CatalogRow[], lead: CatalogRow): CatalogRow[] {
  const keys = familyKeys(lead);
  const id = safeIgdbId(lead);
  return rows.filter(r => r.titleId === lead.titleId || (familyKeys(r).some(key => keys.includes(key))
    && !(id && safeIgdbId(r) && id !== safeIgdbId(r))));
}

function identity(rows: CatalogRow[]): RatingIdentity | null {
  const lead = rows.find(r => r.platform === "steam") ?? rows[0];
  if (!lead?.name) return null;
  const safe = lead.matchConfidence !== "low" && metadataMatchesStorefront(lead.storeName, lead.igdbName);
  // Native storefront spelling/date outrank enrichment for every platform.
  // IGDB can describe a later Ultimate Edition even when this is the base SKU.
  // The critic matcher removes only known packaging after identity resolution.
  const name = lead.storeName ? lead.storeName
    : safe && lead.igdbName ? lead.igdbName : lead.name;
  const steam = rows.find(r => r.platform === "steam" && /^[1-9]\d*$/.test(r.externalSku));
  const releaseDates = Array.from(new Set(rows.flatMap(row => [
    row.storeReleaseDate,
    row.matchConfidence !== "low" && row.storeName && row.igdbName
      && ratingIdentity(criticSearchTitle(row.storeName)) === ratingIdentity(criticSearchTitle(row.igdbName))
      ? row.releaseDate : null,
  ]).filter((d): d is string => !!d)));
  return { name, releaseDate: lead.storeReleaseDate ?? (safe ? lead.releaseDate : null),
    steamAppId: steam?.externalSku ?? null, releaseDates };
}

function corroboratedTitle(rows: CatalogRow[], name: string, releaseDate: string | null | undefined) {
  const date = releaseDate ? Date.parse(releaseDate) : NaN;
  if (!Number.isFinite(date)) return undefined;
  const candidates = rows.filter(r => {
    const candidateDate = Date.parse(r.storeReleaseDate ?? r.releaseDate ?? "");
    return familyKeys(r).includes(editionGroupKey(name))
      && Number.isFinite(candidateDate) && Math.abs(candidateDate - date) <= 370 * 86400_000;
  });
  const ids = new Set(candidates.map(safeIgdbId).filter(Boolean));
  return ids.size > 1 ? undefined : candidates[0];
}

export function registerReviewsRatingsRoutes(app: Express) {
  const service = new ReviewsRatingsService(rawSqlite, key => storage.getSetting(key)?.value);
  const limiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
  app.get("/api/reviews-ratings/:kind/:id", limiter, (req, res) => {
    const kind = String(req.params.kind);
    const id = String(req.params.id);
    if (!["steam", "title", "family", "product", "amazon"].includes(kind)
      || id.length > 200
      || (["steam", "title", "product"].includes(kind) && !/^[1-9]\d{0,9}$/.test(id))
      || (kind === "amazon" && !/^[A-Z0-9]{10}$/.test(id))) {
      return res.status(400).json({ error: "invalid_rating_identity" });
    }
    // Public only for known catalog titles/families or a Valve-verified app ID.
    // No user-supplied name/URL can cause arbitrary provider searches or SSRF.
    try {
      const rows = catalog();
      let members: CatalogRow[] = [];
      let game: RatingIdentity | null = null;
      if (kind === "title" || kind === "family") {
        const lead = kind === "title" ? rows.find(r => r.titleId === Number(id))
          : rows.find(r => familyKeys(r).includes(id));
        if (!lead) return res.status(404).json({ error: "title_not_found" });
        members = family(rows, lead);
        game = identity(members);
      } else if (kind === "product") {
        const product = storage.getProduct(Number(id));
        if (!product) return res.status(404).json({ error: "product_not_found" });
        const lead = rows.find(r => r.platform === "steam" && r.externalSku === product.steamAppId)
          ?? corroboratedTitle(rows, product.title, product.releaseDate);
        members = lead ? family(rows, lead) : [];
        game = identity(members) ?? { name: product.title, releaseDate: product.releaseDate,
          steamAppId: product.steamAppId && /^[1-9]\d*$/.test(product.steamAppId) ? product.steamAppId : null };
      } else if (kind === "amazon") {
        // A competitor pin's parent_product_id is the SABER parent, not the
        // competitor. Never transfer that parent's ratings onto a competitor.
        const pin = rawSqlite.prepare("SELECT product_id FROM amazon_asin_map WHERE asin=?").get(id) as any;
        const product = pin ? storage.getProduct(pin.product_id) : null;
        if (product) {
          const lead = rows.find(r => r.platform === "steam" && r.externalSku === product.steamAppId)
            ?? corroboratedTitle(rows, product.title, product.releaseDate);
          members = lead ? family(rows, lead) : [];
          game = identity(members) ?? { name: product.title, releaseDate: product.releaseDate, steamAppId: product.steamAppId };
        } else {
          const competitor = rawSqlite.prepare("SELECT name,steam_app_id FROM amazon_competitor_asin_map WHERE asin=? AND is_active=1")
            .get(id) as { name: string; steam_app_id: number | null } | undefined;
          if (competitor?.steam_app_id) {
            const appId = String(competitor.steam_app_id);
            const lead = rows.find(r => r.platform === "steam" && r.externalSku === appId);
            if (lead) { members = family(rows, lead); game = identity(members); }
            if (!game) {
              const resolved = service.steamIdentity(appId);
              if (!resolved.value && resolved.refreshing) {
                res.set("Cache-Control", "no-store");
                return res.json({ title: competitor.name, players: [], openCritic: emptyCritics("loading"), refreshing: true });
              }
              game = resolved.value;
            }
          }
        }
        // Unmapped physical listings may be bundles/accessories. No fuzzy
        // Amazon-title searches: expose unavailable, not the wrong game's data.
      } else {
        const lead = rows.find(r => r.platform === "steam" && r.externalSku === id);
        if (lead) {
          members = family(rows, lead);
          game = identity(members);
        }
        if (!game) {
          const resolved = service.steamIdentity(id);
          if (!resolved.value) {
            res.set("Cache-Control", "no-store");
            return res.json({ title: null, players: [], openCritic: emptyCritics(resolved.status),
              refreshing: resolved.refreshing });
          }
          game = resolved.value;
          const same = corroboratedTitle(rows, game.name, game.releaseDate);
          members = same ? family(rows, same) : [];
        }
        // Always keep Steam player scores tied to the requested exact App ID.
        game.steamAppId = id;
      }
      if (game) {
        // Explicit, reviewed exact-SKU links also cover later console ports,
        // F2P games and Steam apps outside the paid Buying universe.
        // No fuzzy title search or sales-family mutation is performed.
        const links = rawSqlite.prepare(`SELECT platform,external_sku,steam_app_id
          FROM verified_rating_links WHERE verification_source=?`).all(CCU_RATINGS_SOURCE) as
          Array<{platform:string;external_sku:string;steam_app_id:string}>;
        const appIds = new Set(links.filter(link => members.some(row =>
          row.platform === link.platform && row.externalSku === link.external_sku)).map(link => link.steam_app_id));
        const appId = game.steamAppId ?? (appIds.size === 1 ? Array.from(appIds)[0] : null);
        if (appId) {
          game.steamAppId = appId;
          const linked = rows.filter(row => links.some(link => link.steam_app_id === appId
            && link.platform === row.platform && link.external_sku === row.externalSku));
          members = [...members, ...linked.filter(row => !members.some(member =>
            member.platform === row.platform && member.externalSku === row.externalSku))];
        }
      }
      const result = game ? service.get(game, members)
        : { title: null, players: [], openCritic: emptyCritics("unavailable"), refreshing: false };
      res.set("Cache-Control", result.refreshing ? "no-store"
        : kind === "product" || kind === "amazon" ? "private, max-age=30" : "public, max-age=30");
      return res.json(result);
    } catch {
      // Avoid leaking raw SQL, provider error bodies, or secrets to public HMAP.
      return res.status(503).json({ error: "ratings_temporarily_unavailable" });
    }
  });
  return service;
}
