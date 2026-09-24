/**
 * YouTube Pulse — per-title video relevance (pure, unit-tested).
 *
 * Precision over recall, mirroring SentimentPulse's contamination rules
 * (lessons.md 2026-07-24): a video only counts toward a Saber title when
 *   1. one of the title's distinctive phrases appears in the VIDEO TITLE
 *      (hashtag / no-space forms such as #spacemarine2 count for phrases of
 *      8+ compact characters), and
 *   2. no exclude term appears in the title or the first 400 description chars, and
 *   3. for ambiguous names (require_companion) the API-reported category is
 *      Gaming (categoryId 20) AND a game-context term is present.
 *      Non-ambiguous names need Gaming category OR a game-context term.
 *
 * Description-only mentions never admit: compilation / "top 10 games" videos
 * would otherwise inflate a title's views with unrelated content.
 * The category used is the one returned by the API, never inferred.
 */

export interface TitleMatchConfig {
  phrases: string[];
  excludeTerms: string[];
  /** Checked against the video title only: phrases of more specific tracked titles. */
  titleExcludes?: string[];
  requireCompanion: boolean;
}

export interface VideoTextInput {
  title: string;
  description?: string | null;
  categoryId?: string | null;
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
  return cp.length >= 8 && compactText.includes(cp);
}

function containsTerm(normText: string, term: string): boolean {
  const t = normalize(term);
  return !!t && ` ${normText} `.includes(` ${t} `);
}

export function matchVideo(cfg: TitleMatchConfig, v: VideoTextInput): MatchResult {
  const title = normalize(v.title);
  const titleCompact = compact(v.title);
  const desc = normalize((v.description || "").slice(0, 400));
  const phrase = cfg.phrases.find((p) => containsPhrase(title, titleCompact, p));
  if (!phrase) return { admit: false, reason: "no distinctive phrase in video title" };

  const moreSpecific = (cfg.titleExcludes ?? []).find((p) => containsPhrase(title, titleCompact, p));
  if (moreSpecific) return { admit: false, reason: `belongs to more specific title "${moreSpecific}"` };

  const excluded = cfg.excludeTerms.find((t) => containsTerm(title, t) || containsTerm(desc, t));
  if (excluded) return { admit: false, reason: `exclude term "${excluded}"` };

  const isGaming = v.categoryId === "20";
  const companion = GAME_CONTEXT_TERMS.find((t) => containsTerm(title, t) || containsTerm(desc, t));
  if (cfg.requireCompanion) {
    if (!isGaming) return { admit: false, reason: "ambiguous title: category is not Gaming" };
    if (!companion) return { admit: false, reason: "ambiguous title: no game-context term" };
    return { admit: true, reason: `title phrase "${phrase}" + Gaming category + "${companion}"` };
  }
  if (!isGaming && !companion) return { admit: false, reason: "not Gaming category and no game-context term" };
  return { admit: true, reason: `title phrase "${phrase}"${isGaming ? " + Gaming category" : ` + "${companion}"`}` };
}

/** ISO 8601 duration (PT1H2M3S / P1DT2H) → seconds. Returns null when unparseable. */
export function parseIsoDuration(d: string | null | undefined): number | null {
  if (!d) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(d);
  if (!m) return null;
  const [, days, h, mi, s] = m;
  return (+(days || 0)) * 86400 + (+(h || 0)) * 3600 + (+(mi || 0)) * 60 + (+(s || 0));
}

/**
 * "Short-form (≤3 min)": a SignalPulse classification from API duration, not
 * YouTube's Shorts flag (the Data API does not expose one). Shorts can run up
 * to 180s since 2024-10-15. Live/upcoming broadcasts are never short-form.
 */
export const SHORT_FORM_MAX_SECONDS = 180;
export function isShortForm(durationS: number | null, liveBroadcast?: string | null): boolean {
  if (durationS == null || durationS <= 0) return false;
  if (liveBroadcast && liveBroadcast !== "none") return false;
  return durationS <= SHORT_FORM_MAX_SECONDS;
}
