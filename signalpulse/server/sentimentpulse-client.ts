/**
 * SentimentPulse REST client (in-droplet loopback).
 *
 * SentimentPulse runs on http://127.0.0.1:8000 on the same droplet as
 * SignalPulse (nginx routes /api/ → 8000, /signal/api/ → 5000, sharing the
 * same droplet). GET endpoints on SentimentPulse do not require auth, so we
 * can hit them directly from server code without a token.
 *
 * Used by the Amazon Retail module to hydrate competitor titles under each
 * Saber (parent) title so BSR + Buy Box tracking extends to the comp set
 * SentimentPulse already tracks.
 */
import { log } from "./index";

const SENTIMENTPULSE_BASE = process.env.SENTIMENTPULSE_BASE_URL ?? "http://127.0.0.1:8000";
const HTTP_TIMEOUT_MS = 8_000;

export interface SentimentPulseGame {
  id: number;
  publisher_id: number;
  steam_app_id: number;
  name: string;
  release_date: string | null;
  is_active: boolean;
}

export interface SentimentPulseCompetitor {
  id: number;
  name: string;
  steam_app_id: number;
  subreddits: string[] | null;
  release_date: string | null;
}

async function fetchJson<T>(path: string): Promise<T> {
  const url = `${SENTIMENTPULSE_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// List every SentimentPulse game (Saber-owned parents AND competitors —
// they all live in the same games table). Caller filters by is_active.
export async function listSentimentPulseGames(): Promise<SentimentPulseGame[]> {
  return fetchJson<SentimentPulseGame[]>("/api/games?is_active=true");
}

// List competitors for a single parent game. Returns [] if none.
export async function listCompetitorsForParent(
  parentGameId: number,
): Promise<SentimentPulseCompetitor[]> {
  try {
    return await fetchJson<SentimentPulseCompetitor[]>(
      `/api/games/${parentGameId}/competitors`,
    );
  } catch (err) {
    log(`sentimentpulse-client: competitors fetch for parent ${parentGameId} failed: ${err}`, "sp-client");
    return [];
  }
}

// Check whether SentimentPulse's own daily ingest is currently running. Used
// by the competitor-discovery job to defer if we would otherwise pile HTTP
// and DB-pool load on top of the ingest window (SentimentPulse ingest at
// 06:45 ET is historically the most fragile job — see main.py:118 lessons).
// Fails-open: returns false on any error so a transient status-endpoint
// glitch does not block the discovery job forever.
export async function isSentimentPulseIngestRunning(): Promise<boolean> {
  try {
    const status = await fetchJson<{ is_running?: boolean }>("/api/ingest/status");
    return status.is_running === true;
  } catch {
    return false;
  }
}

// Convenience: return all (parent_game_id, competitor) tuples across every
// SentimentPulse parent. This is what Amazon discovery consumes.
export async function listAllCompetitorRelationships(): Promise<
  Array<{ parentGameId: number; parentName: string; parentSteamAppId: number; competitor: SentimentPulseCompetitor }>
> {
  const games = await listSentimentPulseGames();
  const rows: Array<{
    parentGameId: number;
    parentName: string;
    parentSteamAppId: number;
    competitor: SentimentPulseCompetitor;
  }> = [];
  // Walk every game as a potential parent; the competitors endpoint returns
  // [] for games with no children, so this is cheap and self-terminating.
  for (const g of games) {
    const comps = await listCompetitorsForParent(g.id);
    for (const c of comps) {
      rows.push({
        parentGameId: g.id,
        parentName: g.name,
        parentSteamAppId: g.steam_app_id,
        competitor: c,
      });
    }
  }
  return rows;
}
