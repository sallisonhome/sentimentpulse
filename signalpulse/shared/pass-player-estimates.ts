export type PassPlayerStatus = "available" | "shared_runtime" | "insufficient_history"
  | "runtime_unverified" | "calibration_required" | "calibration_expired"
  | "invalid_calibration" | "history_too_large";

export interface PassPlayerEstimate {
  players: number | null;
  status: PassPlayerStatus;
  periodStart: string | null;
  periodEnd: string;
  sampleCount: number;
  coveragePercent: number;
  playerHours: number | null;
  meanHoursPerPlayer: number | null;
  calibrationSourceUrl: string | null;
  validationUrl: string | null;
  method: "own_pass_ccu_player_hours_v1";
}

export const PASS_PLAYER_STATUS_LABELS: Record<PassPlayerStatus, string> = {
  available: "Estimated active players",
  shared_runtime: "Shared runtime",
  insufficient_history: "Insufficient CCU history",
  runtime_unverified: "Runtime not verified",
  calibration_required: "Playtime calibration needed",
  calibration_expired: "Calibration expired",
  invalid_calibration: "Calibration inconsistent",
  history_too_large: "History needs aggregation",
};

// Operational coverage gates, NOT a claim of model validation.
export const PASS_PLAYER_GATES = {
  maxIntervalMinutes: 30,
  minCoveragePercent: 95,
  minDailyCoveragePercent: 90,
  minCompleteDays: 7,
  maxSamplesPerTitle: 600_000,
} as const;
