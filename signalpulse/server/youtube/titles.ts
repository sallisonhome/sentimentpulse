/**
 * YouTube Pulse — tracked-title configuration.
 *
 * Title universe (owner decision 2026-09-24): EVERY active SentimentPulse
 * game — Saber titles and the competitor titles set up under them as
 * parent/child — plus every SignalPulse product with a Steam App ID. All of
 * them get videos, stats and comments collected; the comment feed serves all
 * of them to SentimentPulse. The leaderboard shows Saber titles by default
 * (is_saber=1) with competitors behind a toggle.
 *
 * Identity: title_id = primary Steam App ID, the key both apps share.
 * SentimentPulse rows whose app id is an alias (demo/DLC) of another game are
 * folded into that game rather than tracked twice.
 *
 * Search/match configuration is seeded per Steam App ID below (reviewable in
 * code, like SentimentPulse's distinctive keywords); unknown titles fall back
 * to their cleaned, quoted name with require_companion on. Rows edited through
 * the ops config endpoint are marked config_source='manual' and never
 * overwritten by the seed.
 *
 * Overlapping names (MudRunner ⊂ "Expeditions: A MudRunner Game", SnowRunner ⊂
 * its DLC pack): a title automatically rejects videos whose TITLE contains a
 * longer phrase of another tracked title, so each video counts once, for the
 * most specific title.
 */
import type { YtDb } from "./db";

export interface TitleSeed {
  searchQuery: string;
  phrases: string[];
  excludeTerms?: string[];
  requireCompanion?: boolean;
}

// Keyed by Steam App ID (stable across product renames).
export const TITLE_SEEDS: Record<string, TitleSeed> = {
  "2183900": { searchQuery: '"space marine 2"', phrases: ["space marine 2", "space marine ii", "warhammer 40000 space marine 2", "spacemarine2"] },
  "1551980": { searchQuery: '"hellraiser revival"', phrases: ["hellraiser revival", "hellraiser: revival"] },
  "1486920": { searchQuery: '"tempest rising"', phrases: ["tempest rising"] },
  "699130": {
    searchQuery: '"world war z" game',
    phrases: ["world war z", "world war z aftermath", "wwz aftermath"],
    excludeTerms: ["brad pitt", "movie", "film", "audiobook", "book review", "max brooks"],
    requireCompanion: true,
  },
  "2157830": { searchQuery: '"toxic commando"', phrases: ["toxic commando"] },
  "2208810": { searchQuery: '"jurassic park survival"', phrases: ["jurassic park survival", "jurassic park: survival"] },
  "2366590": { searchQuery: '"rideshare simulator"', phrases: ["rideshare simulator", "rideshare stimulator"], requireCompanion: true },
  "2947860": {
    searchQuery: '"john wick" game',
    phrases: ["john wick"],
    excludeTerms: ["chapter 4", "chapter 5", "ballerina", "movie", "film", "box office", "hex", "the continental", "fortnite", "payday", "hitman"],
    requireCompanion: true,
  },
  "581320": { searchQuery: '"insurgency sandstorm"', phrases: ["insurgency sandstorm", "insurgency: sandstorm"] },
  "2487300": {
    searchQuery: '"docked" game',
    phrases: ["docked"],
    excludeTerms: ["switch 2", "nintendo switch", "handheld", "steam deck", "docked mode", "docked vs", "vs docked", "dock"],
    requireCompanion: true,
  },
  "1465360": { searchQuery: "snowrunner", phrases: ["snowrunner", "snow runner"] },
  "1575990": { searchQuery: '"twisted tower"', phrases: ["twisted tower"], requireCompanion: true },
  "4716160": { searchQuery: '"hitman classic trilogy"', phrases: ["hitman classic trilogy"] },
  "2104890": { searchQuery: "roadcraft", phrases: ["roadcraft", "road craft"] },
  "2141130": { searchQuery: '"road kings" game', phrases: ["road kings"], excludeTerms: ["motorcycle club", "mc", "harley"], requireCompanion: true },
  "2477340": {
    searchQuery: '"expeditions" mudrunner',
    phrases: ["expeditions a mudrunner game", "expeditions: a mudrunner game", "mudrunner expeditions", "expeditions mudrunner", "expeditions a mudrunner"],
  },
  "2095420": { searchQuery: "busbound", phrases: ["busbound", "bus bound"], requireCompanion: true },
  "2487330": { searchQuery: '"stuntman hollywood"', phrases: ["stuntman hollywood", "stuntman: hollywood"] },
  "1967610": { searchQuery: '"turok origins"', phrases: ["turok origins", "turok: origins"] },
  // ── SentimentPulse titles (Saber catalogue + competitor children), 2026-09-24 ──
  "976730": { searchQuery: '"master chief collection"', phrases: ["master chief collection", "halo mcc", "halomcc"] },
  "1064270": { searchQuery: '"halo 2 anniversary"', phrases: ["halo 2 anniversary", "halo 2a", "halo2anniversary"] },
  "1064271": { searchQuery: '"halo 3" mcc', phrases: ["halo 3"], excludeTerms: ["odst"] },
  "1064221": { searchQuery: '"halo ce anniversary"', phrases: ["halo ce anniversary", "halo combat evolved anniversary", "combat evolved anniversary", "halo cea"] },
  "1449280": { searchQuery: '"ghostbusters" remastered video game', phrases: ["ghostbusters the video game remastered", "ghostbusters remastered", "ghostbusters video game remastered"] },
  "2096600": { searchQuery: '"crysis 2 remastered"', phrases: ["crysis 2 remastered"] },
  "2096610": { searchQuery: '"crysis 3 remastered"', phrases: ["crysis 3 remastered"] },
  "212410": {
    searchQuery: '"inversion" game',
    phrases: ["inversion game", "inversion gameplay", "inversion walkthrough", "inversion xbox 360", "inversion ps3", "inversion pc"],
    requireCompanion: true,
  },
  "10130": { searchQuery: 'timeshift game', phrases: ["timeshift", "time shift game"], excludeTerms: ["tv", "samsung", "lg", "dvr", "linux", "backup", "restore"], requireCompanion: true },
  "488690": { searchQuery: '"mx nitro"', phrases: ["mx nitro", "mxnitro"] },
  "675010": { searchQuery: 'mudrunner', phrases: ["mudrunner", "mud runner"], excludeTerms: ["expeditions"] },
  "780290": { searchQuery: 'gloomhaven video game', phrases: ["gloomhaven"], excludeTerms: ["board game", "boardgame", "unboxing", "tabletop"], requireCompanion: true },
  "1839940": { searchQuery: '"dakar desert rally"', phrases: ["dakar desert rally", "dakardesertrally"] },
  "1471650": { searchQuery: '"the knightling"', phrases: ["the knightling", "knightling"] },
  "2233120": { searchQuery: '"a quiet place the road ahead"', phrases: ["a quiet place the road ahead", "quiet place the road ahead", "quiet place road ahead"] },
  "3777660": { searchQuery: 'snowrunner mercedes-benz dual pack', phrases: ["snowrunner mercedes benz", "mercedes benz trucks dual pack", "mercedes benz dual pack"], requireCompanion: true },
  // competitor children
  "2924540": { searchQuery: '"crazy taxi world tour"', phrases: ["crazy taxi world tour", "crazytaxiworldtour"] },
  "1271700": { searchQuery: '"hot wheels unleashed"', phrases: ["hot wheels unleashed", "hotwheelsunleashed"], excludeTerms: ["unleashed 2", "turbocharged", "toy", "unboxing", "diecast"] },
  "3010850": { searchQuery: '"gears of war e-day"', phrases: ["gears of war e day", "gears e day", "gears of war eday", "gearsofwareday"] },
  "3448650": { searchQuery: '"aliens fireteam elite 2"', phrases: ["aliens fireteam elite 2", "fireteam elite 2"] },
  "1757350": {
    searchQuery: '"ILL" mundfish',
    phrases: ["ill game", "ill gameplay", "ill trailer", "ill mundfish", "mundfish ill", "ill team clout", "ill horror game"],
    requireCompanion: true,
  },
  "1636440": { searchQuery: '"silent hill townfall"', phrases: ["silent hill townfall", "silenthilltownfall"] },
  "3219630": {
    searchQuery: '"halloween the game"',
    phrases: ["halloween the game", "halloween video game", "halloween game michael myers", "halloween boss team"],
    excludeTerms: ["costume", "movie", "film", "party game", "kids"],
    requireCompanion: true,
  },
};

/** One tracked title before seeding (merged from SentimentPulse + SignalPulse). */
export interface TitleSource {
  steamAppId: string;
  name: string;
  releaseDate: string | null;
  isSaber: boolean;
  parentSteamAppId: string | null;
  sentimentpulseGameId: number | null;
  signalpulseProductId: number | null;
  source: "sentimentpulse" | "signalpulse" | "both";
}

export interface ProductLite { id: number; title: string; steamAppId: string | null; releaseDate: string | null }
export interface SentimentPulseGameLite {
  id: number; steam_app_id: number; name: string; release_date: string | null;
  is_active: boolean; alias_steam_app_ids?: number[] | null;
}

export function cleanTitleName(name: string): string {
  return (name || "")
    .replace(/[™®©]/g, "")
    .replace(/^(clive barker's|john carpenter's|untitled)\s+/i, "")
    .replace(/\s+game$/i, (m) => (/^untitled/i.test(name) ? "" : m))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Merge the two title lists. spGames === null means SentimentPulse could not
 * be reached: callers must then leave existing SentimentPulse-sourced rows
 * alone (see syncTitles `authoritative`).
 */
export function buildTitleSources(
  products: ProductLite[],
  spGames: SentimentPulseGameLite[] | null,
  competitorParent: Map<number, number>, // competitor games.id → parent games.id
): TitleSource[] {
  const out = new Map<string, TitleSource>();
  const games = (spGames ?? []).filter((g) => g.is_active);
  const aliasOf = new Map<string, string>();
  for (const g of games) for (const a of g.alias_steam_app_ids ?? []) if (String(a) !== String(g.steam_app_id)) aliasOf.set(String(a), String(g.steam_app_id));
  const byGameId = new Map(games.map((g) => [g.id, g]));
  for (const g of games) {
    const app = String(g.steam_app_id);
    if (aliasOf.has(app)) continue; // demo/DLC folded under its main game
    const parentId = competitorParent.get(g.id);
    const parent = parentId != null ? byGameId.get(parentId) : undefined;
    out.set(app, {
      steamAppId: app, name: cleanTitleName(g.name), releaseDate: g.release_date ?? null,
      isSaber: parentId == null, parentSteamAppId: parent ? String(parent.steam_app_id) : null,
      sentimentpulseGameId: g.id, signalpulseProductId: null, source: "sentimentpulse",
    });
  }
  for (const p of products) {
    if (!p.steamAppId) continue;
    const app = aliasOf.get(p.steamAppId) ?? p.steamAppId;
    const cur = out.get(app);
    if (cur) {
      cur.name = p.title || cur.name; // SignalPulse product names are curated
      cur.releaseDate = p.releaseDate || cur.releaseDate;
      cur.signalpulseProductId = p.id;
      cur.isSaber = true;              // a SignalPulse product is a Saber title
      cur.parentSteamAppId = null;
      cur.source = "both";
    } else {
      out.set(app, {
        steamAppId: app, name: p.title, releaseDate: p.releaseDate ?? null, isSaber: true, parentSteamAppId: null,
        sentimentpulseGameId: null, signalpulseProductId: p.id, source: "signalpulse",
      });
    }
  }
  return Array.from(out.values());
}

export function seedFor(t: { steamAppId: string | null; name: string }): TitleSeed {
  const s = t.steamAppId ? TITLE_SEEDS[t.steamAppId] : undefined;
  if (s) return s;
  const n = cleanTitleName(t.name).toLowerCase();
  return { searchQuery: `"${n}"`, phrases: [n], requireCompanion: true };
}

/** Earliest date discovery searches: release − 4 years, never before 2017-01-01. */
export function backfillFloor(releaseDate: string | null): string {
  const d = new Date(`${(releaseDate || "").slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "2017-01-01";
  d.setUTCFullYear(d.getUTCFullYear() - 4);
  const iso = d.toISOString().slice(0, 10);
  return iso < "2017-01-01" ? "2017-01-01" : iso;
}

function normPhrase(s: string) {
  return s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Longer phrases of OTHER titles that contain one of this title's phrases (whole words). */
export function specificityExcludes(own: string[], others: string[][]): string[] {
  const mine = own.map(normPhrase).filter(Boolean);
  const out = new Set<string>();
  for (const list of others) for (const raw of list) {
    const p = normPhrase(raw);
    if (!p || mine.includes(p)) continue;
    if (mine.some((m) => p.length > m.length && ` ${p} `.includes(` ${m} `))) out.add(p);
  }
  return Array.from(out).sort();
}

/**
 * Upsert tracked titles. When `authoritative` is true (SentimentPulse list
 * was fetched), titles not in `sources` are disabled; when false only the
 * given titles are upserted and nothing is disabled.
 */
export function syncTitles(db: YtDb, sources: TitleSource[], now = new Date(), authoritative = true): number {
  const existing = new Map<number, { config_source: string }>(
    (db.prepare("SELECT title_id, config_source FROM yt_titles").all() as any[]).map((r) => [r.title_id, r]),
  );
  const seeds = new Map(sources.map((t) => [t.steamAppId, seedFor(t)]));
  const upsert = db.prepare(`
    INSERT INTO yt_titles (title_id, title, steam_app_id, is_saber, parent_title_id, sentimentpulse_game_id,
      signalpulse_product_id, title_source, search_query, phrases, exclude_terms, title_excludes,
      require_companion, enabled, backfill_floor, config_source, updated_at)
    VALUES (@title_id, @title, @steam_app_id, @is_saber, @parent_title_id, @sentimentpulse_game_id,
      @signalpulse_product_id, @title_source, @search_query, @phrases, @exclude_terms, @title_excludes,
      @require_companion, 1, @backfill_floor, 'seed', @updated_at)
    ON CONFLICT(title_id) DO UPDATE SET
      title=excluded.title, steam_app_id=excluded.steam_app_id, is_saber=excluded.is_saber,
      parent_title_id=excluded.parent_title_id, sentimentpulse_game_id=excluded.sentimentpulse_game_id,
      signalpulse_product_id=excluded.signalpulse_product_id, title_source=excluded.title_source,
      enabled=1, title_excludes=excluded.title_excludes, updated_at=excluded.updated_at,
      search_query=CASE WHEN yt_titles.config_source='seed' THEN excluded.search_query ELSE yt_titles.search_query END,
      phrases=CASE WHEN yt_titles.config_source='seed' THEN excluded.phrases ELSE yt_titles.phrases END,
      exclude_terms=CASE WHEN yt_titles.config_source='seed' THEN excluded.exclude_terms ELSE yt_titles.exclude_terms END,
      require_companion=CASE WHEN yt_titles.config_source='seed' THEN excluded.require_companion ELSE yt_titles.require_companion END,
      backfill_floor=CASE WHEN yt_titles.config_source='seed' THEN excluded.backfill_floor ELSE yt_titles.backfill_floor END`);
  // phrases of every enabled title (incl. manual ones) drive the specificity excludes
  const allPhrases = new Map<number, string[]>();
  for (const r of db.prepare("SELECT title_id, phrases, config_source FROM yt_titles WHERE enabled=1").all() as any[]) allPhrases.set(r.title_id, JSON.parse(r.phrases));
  for (const t of sources) {
    const id = Number(t.steamAppId);
    if (existing.get(id)?.config_source !== "manual") allPhrases.set(id, seeds.get(t.steamAppId)!.phrases);
  }
  let n = 0;
  const tx = db.transaction(() => {
    for (const t of sources) {
      const id = Number(t.steamAppId);
      if (!Number.isInteger(id) || id <= 0) continue;
      const s = seeds.get(t.steamAppId)!;
      const own = allPhrases.get(id) ?? s.phrases;
      const others = Array.from(allPhrases.entries()).filter(([k]) => k !== id).map(([, v]) => v);
      upsert.run({
        title_id: id, title: t.name, steam_app_id: t.steamAppId, is_saber: t.isSaber ? 1 : 0,
        parent_title_id: t.parentSteamAppId ? Number(t.parentSteamAppId) : null,
        sentimentpulse_game_id: t.sentimentpulseGameId, signalpulse_product_id: t.signalpulseProductId, title_source: t.source,
        search_query: s.searchQuery, phrases: JSON.stringify(s.phrases), exclude_terms: JSON.stringify(s.excludeTerms ?? []),
        title_excludes: JSON.stringify(specificityExcludes(own, others)),
        require_companion: s.requireCompanion ? 1 : 0, backfill_floor: backfillFloor(t.releaseDate), updated_at: now.toISOString(),
      });
      n++;
    }
    if (authoritative) {
      const ids = sources.map((t) => Number(t.steamAppId)).filter((x) => Number.isInteger(x) && x > 0);
      if (ids.length) db.prepare(`UPDATE yt_titles SET enabled=0 WHERE title_id NOT IN (${ids.map(() => "?").join(",")})`).run(...ids);
    }
  });
  tx();
  return n;
}

export interface TitleRow {
  title_id: number;
  title: string;
  steam_app_id: string | null;
  search_query: string;
  phrases: string;
  exclude_terms: string;
  require_companion: number;
  enabled: number;
  backfill_floor: string;
  backfill_oldest: string | null;
  last_incremental_at: string | null;
  config_source: string;
  title_excludes: string;
  is_saber: number;
  parent_title_id: number | null;
}

export function matchConfigOf(t: TitleRow) {
  return {
    phrases: JSON.parse(t.phrases) as string[],
    excludeTerms: JSON.parse(t.exclude_terms) as string[],
    titleExcludes: JSON.parse(t.title_excludes || "[]") as string[],
    requireCompanion: !!t.require_companion,
  };
}
