export type PlayerWindow = "d7" | "d30" | "d90" | "m12" | "ltd";

export interface PassPlayerEvidence {
  appId: string;
  runtimeAppId: string;
  runtimeEvidenceUrl: string;
  runtimeVerifiedAt: string;
  runtimeValidUntil: string;
  calibrations: Array<{
    window: PlayerWindow;
    meanHoursPerPlayer: number;
    // Mean cumulative hours per distinct online active player IN THIS WINDOW,
    // including repeat sessions. Never session length or paid-parent playtime.
    population: "own_pass_online_active_players";
    validFrom: string;
    validUntil: string;
    sourceUrl: string;
    validationUrl: string;
    validatedAt: string;
  }>;
}

/**
 * Evidence-reviewed allowlist. Intentionally empty: no pass-specific playtime
 * calibration has passed independent validation as of 2026-09-23.
 * Add records only with own-runtime verification and documented holdout results.
 * No default playtime, demo multiplier, parent metrics, or review-derived labels.
 * Expired records fail closed. Changes use the normal reviewed PR workflow.
 */
export const PASS_PLAYER_EVIDENCE: readonly PassPlayerEvidence[] = [];
