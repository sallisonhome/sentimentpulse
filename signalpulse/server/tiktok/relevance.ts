/**
 * TikTok Pulse — per-title video relevance (pure, unit-tested).
 *
 * Mirrors YouTube Pulse's relevance.ts: precision over recall. A TikTok video
 * only counts toward a tracked title when
 *   1. one of the title's distinctive phrases appears in the video `desc`
 *      (hashtag / no-space forms of 8+ compact characters count), and
 *   2. no exclude term appears in `desc`, and
 *   3. for ambiguous names (require_companion) a game-context term is present.
 *      Non-ambiguous names need a game-context term to be present.
 *
 * TikTok has no `categoryId` in the EnsembleData response, so the YouTube
 * `categoryId === "20"` shortcut is unavailable. `requireCompanion` therefore
 * means "game-context term is required" rather than "Gaming category or
 * game-context term". For a title with `requireCompanion: true`, the absence
 * of a game-context term is a rejection reason.
 */

export interface TitleMatchConfig {
  phrases: string[];
  excludeTerms: string[];
  titleExcludes?: string[];
  requiredTerms?: string[];
  requireCompanion: boolean;
}

export interface VideoTextInput {
  desc: string;
}

export type MatchResult =
  | { admit: true; reason: string }
  | { admit: false; reason: string };

export const GAME_CONTEXT_TERMS = [
  "game", "gameplay", "trailer", "walkthrough", "playthrough", "review", "gaming",
  "ps5", "ps4", "playstation", "xbox", "pc", "steam", "let's play", "lets play",
  "part 1", "dlc", "update", "patch", "mod", "mods", "co-op", "coop", "multiplayer",
  "beta", "demo", "early access", "reveal", "announcement", "gamescom",
  "summer game fest", "game awards", "saber interactive", "boss", "build", "guide",
  "tips", "first look", "impressions", "4k", "60fps", "full game", "no commentary",
  "speedrun", "no return", "permadeath", "no hit", "speed run",
];

export function normalize(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(s: string): string {
  return normalize(s).replace(/[^a-z0-9]/g, "");
}

function containsPhrase(normText: string, compactText: string, phrase: string): boolean {
  const p = normalize(phrase);
  if (!p) return false;
  if (` ${normText} `.includes(` ${p} `)) return true;
  const cp = compact(phrase);
  return cp.length >= 8 && normText.split(" ").includes(cp);
}

function containsTerm(normText: string, term: string): boolean {
  const t = normalize(term);
  const c = compact(term);
  return !!t && (` ${normText} `.includes(` ${t} `) ||
    ` ${normText} `.includes(` ${t}'s `) ||
    (c.length >= 5 && normText.split(" ").includes(c)));
}

export const RELEVANCE_VERSION = 1;

export function matchVideo(cfg: TitleMatchConfig, v: VideoTextInput): MatchResult {
  const desc = normalize((v.desc || "").slice(0, 400));
  const descCompact = compact(v.desc || "");
  const phrase = cfg.phrases.find((p) => containsPhrase(desc, descCompact, p));
  if (!phrase) return { admit: false, reason: "no distinctive phrase in desc" };

  const moreSpecific = (cfg.titleExcludes ?? []).find((p) => containsPhrase(desc, descCompact, p));
  if (moreSpecific) return { admit: false, reason: `belongs to more specific title "${moreSpecific}"` };

  const excluded = cfg.excludeTerms.find((t) => containsTerm(desc, t));
  if (excluded) return { admit: false, reason: `exclude term "${excluded}"` };
  if (cfg.requiredTerms?.length && !cfg.requiredTerms.some((t) => containsTerm(desc, t))) {
    return { admit: false, reason: "missing title-specific identity context" };
  }

  const companion = GAME_CONTEXT_TERMS.find((t) => containsTerm(desc, t));
  if (cfg.requireCompanion) {
    if (!companion) return { admit: false, reason: "ambiguous title: no game-context term" };
    return { admit: true, reason: `desc phrase "${phrase}" + "${companion}"` };
  }
  if (!companion) return { admit: false, reason: "no game-context term" };
  return { admit: true, reason: `desc phrase "${phrase}" + "${companion}"` };
}
