/**
 * TikTok Pulse — tracked-title configuration.
 *
 * Title universe (owner decision 2026-10-12): the six Saber titles
 * (Space Marine 2, Hellraiser Revival, Turok Origins, John Wick, MudRunner,
 * SnowRunner) plus every SentimentPulse competitor child under them, plus
 * every SignalPulse product with a Steam App ID.
 *
 * Identity: title_id = primary Steam App ID, the key both apps share.
 *
 * Each title has:
 *   - hashtags: TikTok hashtag slugs for EnsembleData /tt/hashtag/posts
 *   - keywords: phrases for EnsembleData /tt/keyword/search
 *   - phrases: distinctive phrases the relevance filter looks for in `desc`
 *
 * Overlapping names (MudRunner ⊂ Expeditions, SnowRunner ⊂ its DLC): a title
 * rejects a post whose `desc` contains a longer phrase of another tracked
 * title, so each post counts once, for the most specific title.
 */

import type { TtDb } from "./db";

export interface TitleSeed {
  /** TikTok hashtag slugs for EnsembleData /tt/hashtag/posts discovery. */
  hashtags: string[];
  /** Keyword phrases for EnsembleData /tt/keyword/search discovery. */
  keywords: string[];
  /** Distinctive phrases the relevance filter looks for in the post `desc`. */
  phrases: string[];
  /** Explicit owner opt-out from automatic TikTok collection; history is retained. */
  collectionEnabled?: boolean;
  excludeTerms?: string[];
  requireCompanion?: boolean;
  requiredTerms?: string[];
}

// Keyed by Steam App ID.
export const TITLE_SEEDS: Record<string, TitleSeed> = {
  // ── Six Saber parents (owner decision 2026-10-12) ──
  // Space Marine 2
  "2183900": {
    hashtags: ["spacemarine2", "spacemarine2game", "spacemarine2gameplay", "warhammer40k"],
    keywords: ["space marine 2", "warhammer space marine 2"],
    phrases: ["space marine 2", "space marine ii", "warhammer 40000 space marine 2", "spacemarine2"],
  },
  // Hellraiser Revival
  "1551980": {
    hashtags: ["hellraiser", "hellraiserrevival", "hellraisergame"],
    keywords: ["hellraiser revival", "hellraiser game"],
    phrases: ["hellraiser revival", "hellraiser: revival", "hellraiser game"],
    excludeTerms: ["movie", "film", "parker posey", "clive barker", "pinhead movie", "hbo"],
    requireCompanion: true,
  },
  // Turok Origins
  "1967610": {
    hashtags: ["turok", "turokorigins", "turokoriginsgame"],
    keywords: ["turok origins", "turok origins gameplay"],
    phrases: ["turok origins", "turok: origins"],
  },
  // John Wick (Saber game)
  "2947860": {
    hashtags: ["johnwick", "johnwickgame", "johnwickgameplay"],
    keywords: ["john wick game", "john wick saber"],
    phrases: ["john wick"],
    excludeTerms: [
      "chapter 4", "chapter 5", "ballerina", "movie", "film", "box office", "hex",
      "fortnite", "payday", "hitman", "blackwood", "gunman contracts", "roblox",
      "gta", "gta 5", "battlefield", "bf6", "spine", "bodycam", "max payne",
      "resident evil", "resident evil requiem", "leon kennedy", "r6", "r6siege", "vr", "simulator",
    ],
    requiredTerms: ["saber", "saber interactive"],
    requireCompanion: true,
  },
  // MudRunner
  "675010": {
    hashtags: ["mudrunner", "mudrunnergame", "mudrunnergameplay"],
    keywords: ["mudrunner", "mudrunner gameplay"],
    phrases: ["mudrunner", "mud runner"],
    excludeTerms: ["expeditions"],
  },
  // SnowRunner
  "1465360": {
    hashtags: ["snowrunner", "snowrunnergame", "snowrunnergameplay"],
    keywords: ["snowrunner", "snowrunner gameplay"],
    phrases: ["snowrunner", "snow runner"],
  },

  // ── Saber DLC children under the six parents ──
  // Expeditions: A MudRunner Game
  "2477340": {
    hashtags: ["expeditions", "expeditionsmudrunner", "expeditionsgame"],
    keywords: ["expeditions mudrunner", "expeditions a mudrunner game"],
    phrases: ["expeditions a mudrunner game", "expeditions: a mudrunner game", "mudrunner expeditions",
      "expeditions mudrunner", "expeditions a mudrunner"],
  },
  // SnowRunner Mercedes-Benz Dual Pack
  "3777660": {
    hashtags: ["snowrunner", "snowrunnerdlc"],
    keywords: ["snowrunner mercedes benz"],
    phrases: ["snowrunner mercedes benz", "mercedes benz trucks dual pack", "mercedes benz dual pack"],
    requireCompanion: true,
  },

  // ── SentimentPulse competitor children under the six parents ──
  // These are seeded from the SentimentPulse catalogue at sync time; this
  // block is a curated seed for titles with well-known TikTok presence.
  // Halo MCC (competitor child of Space Marine 2 family via Saber catalog)
  "976730": {
    hashtags: ["halo", "halomcc", "masterchiefcollection"],
    keywords: ["halo master chief collection", "halo mcc"],
    phrases: ["master chief collection", "halo mcc", "halomcc"],
  },
  // Halo 2 Anniversary
  "1064270": {
    hashtags: ["halo2", "halo2anniversary"],
    keywords: ["halo 2 anniversary", "halo 2a"],
    phrases: ["halo 2 anniversary", "halo 2a", "halo2anniversary"],
  },
  // Halo 3
  "1064271": {
    hashtags: ["halo3", "halo3mcc"],
    keywords: ["halo 3", "halo 3 mcc"],
    phrases: ["halo 3"],
    excludeTerms: ["odst"],
  },
  // Halo CE Anniversary
  "1064221": {
    hashtags: ["haloce", "haloceanniversary"],
    keywords: ["halo ce anniversary", "halo combat evolved anniversary"],
    phrases: ["halo ce anniversary", "halo combat evolved anniversary", "combat evolved anniversary", "halo cea"],
  },
  // Ghostbusters Remastered
  "1449280": {
    hashtags: ["ghostbusters", "ghostbustersthevideogame"],
    keywords: ["ghostbusters remastered", "ghostbusters video game remastered"],
    phrases: ["ghostbusters the video game remastered", "ghostbusters remastered", "ghostbusters video game remastered"],
  },
  // Crysis 2 Remastered
  "2096600": {
    hashtags: ["crysis2", "crysis2remastered"],
    keywords: ["crysis 2 remastered"],
    phrases: ["crysis 2 remastered"],
  },
  // Crysis 3 Remastered
  "2096610": {
    hashtags: ["crysis3", "crysis3remastered"],
    keywords: ["crysis 3 remastered"],
    phrases: ["crysis 3 remastered"],
  },
  // Inversion
  "212410": {
    hashtags: ["inversion", "inversiongame"],
    keywords: ["inversion game", "inversion gameplay"],
    phrases: ["inversion game", "inversion gameplay", "inversion walkthrough"],
    requireCompanion: true,
  },
  // TimeShift
  "10130": {
    hashtags: ["timeshift"],
    keywords: ["timeshift game", "time shift game"],
    phrases: ["timeshift", "time shift game"],
    excludeTerms: ["tv", "samsung", "lg", "dvr", "linux", "backup", "restore"],
    requireCompanion: true,
  },
  // MX Nitro
  "488690": {
    hashtags: ["mxnitro"],
    keywords: ["mx nitro"],
    phrases: ["mx nitro", "mxnitro"],
  },
  // Gloomhaven
  "780290": {
    hashtags: ["gloomhaven"],
    keywords: ["gloomhaven video game"],
    phrases: ["gloomhaven"],
    excludeTerms: ["board game", "boardgame", "unboxing", "tabletop"],
    requireCompanion: true,
  },
  // Dakar Desert Rally
  "1839940": {
    hashtags: ["dakar", "dakardesertrally"],
    keywords: ["dakar desert rally"],
    phrases: ["dakar desert rally", "dakardesertrally"],
  },
  // The Knightling
  "1471650": {
    hashtags: ["knightling", "theknightling"],
    keywords: ["the knightling"],
    phrases: ["the knightling", "knightling"],
  },
  // A Quiet Place: The Road Ahead
  "2233120": {
    hashtags: ["aquietplace", "aquietplacetheroadahead"],
    keywords: ["a quiet place the road ahead"],
    phrases: ["a quiet place the road ahead", "quiet place the road ahead", "quiet place road ahead"],
  },
  // Toxic Commando
  "2157830": {
    hashtags: ["toxiccommando"],
    keywords: ["toxic commando"],
    phrases: ["toxic commando"],
  },
  // Jurassic Park Survival
  "2208810": {
    hashtags: ["jurassicpark", "jurassicparksurvival"],
    keywords: ["jurassic park survival"],
    phrases: ["jurassic park survival", "jurassic park: survival"],
  },
  // Rideshare Simulator
  "2366590": {
    hashtags: ["rideshare", "ridesharesimulator"],
    keywords: ["rideshare simulator"],
    phrases: ["rideshare simulator", "rideshare stimulator"],
    requireCompanion: true,
  },
  // World War Z
  "699130": {
    hashtags: ["worldwarz", "worldwarzgame", "wwz"],
    keywords: ["world war z game", "wwz aftermath"],
    phrases: ["world war z", "world war z aftermath", "wwz aftermath"],
    excludeTerms: ["brad pitt", "movie", "film", "audiobook", "book review", "max brooks"],
    requireCompanion: true,
  },
  // Insurgency: Sandstorm
  "581320": {
    hashtags: ["insurgencysandstorm", "insurgency"],
    keywords: ["insurgency sandstorm"],
    phrases: ["insurgency sandstorm", "insurgency: sandstorm"],
  },
  // RoadCraft
  "2104890": {
    hashtags: ["roadcraft"],
    keywords: ["roadcraft"],
    phrases: ["roadcraft", "road craft"],
  },
  // Hitman Classic Trilogy
  "4716160": {
    hashtags: ["hitman", "hitmanclassictrilogy"],
    keywords: ["hitman classic trilogy"],
    phrases: ["hitman classic trilogy"],
  },
  // Twisted Tower
  "1575990": {
    hashtags: ["twistedtower"],
    keywords: ["twisted tower"],
    phrases: ["twisted tower"],
    requireCompanion: true,
  },
  // Road Kings
  "2141130": {
    hashtags: ["roadkings"],
    keywords: ["road kings game"],
    phrases: ["road kings"],
    excludeTerms: ["motorcycle club", "harley", "off road kings", "dayz"],
    requireCompanion: true,
  },
  // BusBound
  "2095420": {
    hashtags: ["busbound"],
    keywords: ["busbound"],
    phrases: ["busbound", "bus bound"],
    requireCompanion: true,
  },
  // Stuntman Hollywood
  "2487330": {
    hashtags: ["stuntman", "stuntmanhollywood"],
    keywords: ["stuntman hollywood"],
    phrases: ["stuntman hollywood", "stuntman: hollywood"],
  },
  // Docked
  "2487300": {
    hashtags: ["docked", "dockedgame"],
    keywords: ["docked game"],
    phrases: ["docked"],
    excludeTerms: ["switch 2", "nintendo switch", "nintendo switch 2", "handheld", "steam deck",
      "docked mode", "docked vs", "vs docked", "chess", "call of duty"],
    requiredTerms: ["saber", "port", "ports", "port wake", "crane", "cranes", "cargo", "container",
      "containers", "logistics", "contraband", "deep waters", "docks", "dockworker", "terminal"],
    requireCompanion: true,
  },
  // Tempest Rising
  "1486920": {
    hashtags: ["tempestrising"],
    keywords: ["tempest rising"],
    phrases: ["tempest rising"],
  },
  // ── YouTube-only opt-outs do NOT carry to TikTok; the owner decides separately. ──
};

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
    if (aliasOf.has(app)) continue;
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
      cur.name = p.title || cur.name;
      cur.releaseDate = p.releaseDate || cur.releaseDate;
      cur.signalpulseProductId = p.id;
      cur.isSaber = true;
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
  return { hashtags: [n.replace(/[^a-z0-9]/g, "")], keywords: [n], phrases: [n], requireCompanion: true };
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

/** Apply explicit owner opt-outs only; never alter retained source data. */
export function applyCollectionExclusions(db: TtDb): void {
  const disable = db.prepare("UPDATE tt_titles SET enabled=0 WHERE title_id=? AND enabled<>0");
  for (const [id, seed] of Object.entries(TITLE_SEEDS)) {
    if (seed.collectionEnabled === false) disable.run(Number(id));
  }
}

/**
 * Upsert tracked titles. Authoritative sync disables missing titles; partial
 * sync preserves them. Explicit collection opt-outs apply in either case.
 */
export function syncTitles(db: TtDb, sources: TitleSource[], now = new Date(), authoritative = true): number {
  applyCollectionExclusions(db);
  const existing = new Map<number, { config_source: string }>(
    (db.prepare("SELECT title_id, config_source FROM tt_titles").all() as any[]).map((r) => [r.title_id, r]),
  );
  const seeds = new Map(sources.map((t) => [t.steamAppId, seedFor(t)]));
  const upsert = db.prepare(`
    INSERT INTO tt_titles (title_id, title, steam_app_id, is_saber, parent_title_id, sentimentpulse_game_id,
      signalpulse_product_id, title_source, hashtags, keywords, phrases, exclude_terms, title_excludes,
      required_terms, require_companion, enabled, backfill_floor, config_source, updated_at)
    VALUES (@title_id, @title, @steam_app_id, @is_saber, @parent_title_id, @sentimentpulse_game_id,
      @signalpulse_product_id, @title_source, @hashtags, @keywords, @phrases, @exclude_terms, @title_excludes,
      @required_terms, @require_companion, @enabled, @backfill_floor, 'seed', @updated_at)
    ON CONFLICT(title_id) DO UPDATE SET
      title=excluded.title, steam_app_id=excluded.steam_app_id, is_saber=excluded.is_saber,
      parent_title_id=excluded.parent_title_id, sentimentpulse_game_id=excluded.sentimentpulse_game_id,
      signalpulse_product_id=excluded.signalpulse_product_id, title_source=excluded.title_source,
      enabled=excluded.enabled, title_excludes=excluded.title_excludes, updated_at=excluded.updated_at,
      hashtags=CASE WHEN tt_titles.config_source='seed' THEN excluded.hashtags ELSE tt_titles.hashtags END,
      keywords=CASE WHEN tt_titles.config_source='seed' THEN excluded.keywords ELSE tt_titles.keywords END,
      phrases=CASE WHEN tt_titles.config_source='seed' THEN excluded.phrases ELSE tt_titles.phrases END,
      exclude_terms=CASE WHEN tt_titles.config_source='seed' THEN excluded.exclude_terms ELSE tt_titles.exclude_terms END,
      required_terms=CASE WHEN tt_titles.config_source='seed' THEN excluded.required_terms ELSE tt_titles.required_terms END,
      require_companion=CASE WHEN tt_titles.config_source='seed' THEN excluded.require_companion ELSE tt_titles.require_companion END,
      backfill_floor=CASE WHEN tt_titles.config_source='seed' THEN excluded.backfill_floor ELSE tt_titles.backfill_floor END`);
  const allPhrases = new Map<number, string[]>();
  for (const r of db.prepare("SELECT title_id, phrases, config_source FROM tt_titles WHERE enabled=1").all() as any[]) allPhrases.set(r.title_id, JSON.parse(r.phrases));
  for (const t of sources) {
    const id = Number(t.steamAppId);
    if (seeds.get(t.steamAppId)!.collectionEnabled === false) continue;
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
        hashtags: JSON.stringify(s.hashtags), keywords: JSON.stringify(s.keywords),
        phrases: JSON.stringify(s.phrases), exclude_terms: JSON.stringify(s.excludeTerms ?? []),
        title_excludes: JSON.stringify(specificityExcludes(own, others)),
        required_terms: JSON.stringify(s.requiredTerms ?? []),
        enabled: s.collectionEnabled === false ? 0 : 1,
        require_companion: s.requireCompanion ? 1 : 0, backfill_floor: backfillFloor(t.releaseDate), updated_at: now.toISOString(),
      });
      n++;
    }
    if (authoritative) {
      const ids = sources.map((t) => Number(t.steamAppId)).filter((x) => Number.isInteger(x) && x > 0);
      if (ids.length) db.prepare(`UPDATE tt_titles SET enabled=0 WHERE title_id NOT IN (${ids.map(() => "?").join(",")})`).run(...ids);
    }
  });
  tx();
  return n;
}

export interface TitleRow {
  title_id: number;
  title: string;
  steam_app_id: string | null;
  hashtags: string;
  keywords: string;
  phrases: string;
  exclude_terms: string;
  require_companion: number;
  enabled: number;
  backfill_floor: string;
  backfill_oldest: string | null;
  last_incremental_at: string | null;
  config_source: string;
  title_excludes: string;
  required_terms: string;
  is_saber: number;
  parent_title_id: number | null;
}

export function matchConfigOf(t: TitleRow) {
  return {
    phrases: JSON.parse(t.phrases) as string[],
    excludeTerms: JSON.parse(t.exclude_terms) as string[],
    titleExcludes: JSON.parse(t.title_excludes || "[]") as string[],
    requiredTerms: JSON.parse(t.required_terms || "[]") as string[],
    requireCompanion: !!t.require_companion,
  };
}
