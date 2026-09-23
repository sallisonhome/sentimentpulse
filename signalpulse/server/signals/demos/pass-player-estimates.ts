import { rawSqlite } from "../../storage";
import { SHARED_RUNTIME_PASS_REFERENCES } from "../../../shared/friends-pass-reference";
import { PASS_PLAYER_GATES, type PassPlayerEstimate } from "../../../shared/pass-player-estimates";
import { PASS_PLAYER_EVIDENCE, type PassPlayerEvidence, type PlayerWindow } from "./pass-player-evidence";
import { estimatePassPlayers, passPlayerPeriod } from "./pass-player-model";

const sharedIds = new Set(SHARED_RUNTIME_PASS_REFERENCES.map(r => r.storeAppId));
export function loadPassPlayerEstimates(
  titles: Array<{ id: number; steam_app_id: string; release_date: string | null }>,
  window: PlayerWindow,
  evidence: readonly PassPlayerEvidence[] = PASS_PLAYER_EVIDENCE,
  now = Date.now(),
): Map<number, PassPlayerEstimate> {
  const result = new Map<number, PassPlayerEstimate>();
  const query = rawSqlite.prepare(`SELECT captured_at AS capturedAt, ccu FROM demo_ccu_snapshots
    WHERE demo_title_id=? AND captured_at>=? AND captured_at<=?
    ORDER BY captured_at LIMIT ?`);
  for (const title of titles) {
    const { start, end } = passPlayerPeriod(window, title.release_date, now);
    const sharedRuntime = sharedIds.has(title.steam_app_id);
    const margin = PASS_PLAYER_GATES.maxIntervalMinutes * 60_000;
    // Only this catalog row's own snapshots. No parent ID lookup or fallback.
    const samples = sharedRuntime || !Number.isFinite(start) ? [] : query.all(title.id,
      new Date(start - margin).toISOString(), new Date(Math.min(now, end + margin)).toISOString(),
      PASS_PLAYER_GATES.maxSamplesPerTitle + 1) as Array<{ capturedAt: string; ccu: number }>;
    const entries = evidence.filter(e => e.appId === title.steam_app_id);
    result.set(title.id, estimatePassPlayers({ appId: title.steam_app_id, window,
      releaseDate: title.release_date, samples, sharedRuntime, now,
      // Duplicate identity records fail closed, not first-record-wins.
      evidence: entries.length === 1 ? entries[0] : undefined }));
  }
  return result;
}
