import { PASS_PLAYER_GATES, type PassPlayerEstimate, type PassPlayerStatus } from "../../../shared/pass-player-estimates";
import type { PassPlayerEvidence, PlayerWindow } from "./pass-player-evidence";

const HOUR = 3_600_000, DAY = 24 * HOUR;
const DAYS = { d7: 7, d30: 30, d90: 90, m12: 365 } as const;
const MAX_INTERVAL = PASS_PLAYER_GATES.maxIntervalMinutes * 60_000;
export interface PassCcuSample { capturedAt: string; ccu: number }

/** Completed UTC days only. No partial-today output, launch extrapolation,
 * or assigning a historical lifetime peak to a rolling-period population. */
export function passPlayerPeriod(window: PlayerWindow, releaseDate: string | null, now = Date.now()) {
  const end = Math.floor(now / DAY) * DAY;
  const release = releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(releaseDate)
    ? Date.parse(`${releaseDate}T00:00:00Z`) : NaN;
  const validRelease = Number.isFinite(release) && new Date(release).toISOString().slice(0, 10) === releaseDate;
  const start = window === "ltd" ? validRelease ? release : NaN
    : Math.max(end - DAYS[window] * DAY, validRelease ? release : -Infinity);
  return { start, end };
}

export function estimatePassPlayers(input: {
  appId: string; window: PlayerWindow; releaseDate: string | null;
  samples: readonly PassCcuSample[]; sharedRuntime: boolean;
  evidence?: PassPlayerEvidence; now?: number; truncated?: boolean;
}): PassPlayerEstimate {
  const now = input.now ?? Date.now();
  const { start, end } = passPlayerPeriod(input.window, input.releaseDate, now);
  const result: PassPlayerEstimate = {
    players: null, status: "insufficient_history",
    periodStart: Number.isFinite(start) ? new Date(start).toISOString() : null,
    periodEnd: new Date(end).toISOString(), sampleCount: 0, coveragePercent: 0,
    playerHours: null, meanHoursPerPlayer: null, calibrationSourceUrl: null,
    validationUrl: null, method: "own_pass_ccu_player_hours_v1",
  };
  const unavailable = (status: PassPlayerStatus) => ({ ...result, status });
  if (input.sharedRuntime) return unavailable("shared_runtime");
  if (input.truncated || input.samples.length > PASS_PLAYER_GATES.maxSamplesPerTitle) return unavailable("history_too_large");
  if (!Number.isFinite(start) || end - start < PASS_PLAYER_GATES.minCompleteDays * DAY) return result;

  const times = new Map<number, number>();
  for (const sample of input.samples) {
    const time = Date.parse(sample.capturedAt);
    if (!Number.isFinite(time) || !Number.isSafeInteger(sample.ccu) || sample.ccu < 0) return result;
    if (time > now || time < start - MAX_INTERVAL || time > end + MAX_INTERVAL) continue;
    if (times.has(time) && times.get(time) !== sample.ccu) return result; // conflicting observations
    times.set(time, sample.ccu);
  }
  const points = Array.from(times).sort((a, b) => a[0] - b[0]);
  result.sampleCount = points.filter(([t]) => t >= start && t < end).length;
  const dailyCoverage = new Array(Math.ceil((end - start) / DAY)).fill(0);
  let covered = 0, playerHours = 0, peak = 0;
  for (const [t, ccu] of points) if (t >= start && t < end) peak = Math.max(peak, ccu);
  for (let i = 1; i < points.length; i++) {
    const [t0, c0] = points[i - 1], [t1, c1] = points[i];
    if (t1 - t0 > MAX_INTERVAL) continue; // never bridge missing history
    const lo = Math.max(t0, start), hi = Math.min(t1, end);
    if (hi <= lo) continue;
    const value = (t: number) => c0 + (c1 - c0) * (t - t0) / (t1 - t0);
    playerHours += (value(lo) + value(hi)) / 2 * (hi - lo) / HOUR;
    covered += hi - lo;
    for (let t = lo; t < hi;) {
      const day = Math.floor((t - start) / DAY);
      const until = Math.min(hi, start + (day + 1) * DAY);
      dailyCoverage[day] += until - t; t = until;
    }
  }
  result.coveragePercent = Math.round(covered / (end - start) * 10000) / 100;
  // Test unrounded coverage. A single poorly covered day is not hidden by an
  // otherwise dense long period. Missing intervals contribute neither hours nor 0.
  if (covered / (end - start) < PASS_PLAYER_GATES.minCoveragePercent / 100 ||
      dailyCoverage.some(ms => ms / DAY < PASS_PLAYER_GATES.minDailyCoveragePercent / 100)) return result;
  result.playerHours = Math.round(playerHours * 100) / 100;

  const evidence = input.evidence;
  const https = (url: string) => { try { return new URL(url).protocol === "https:"; } catch { return false; } };
  if (!evidence || evidence.appId !== input.appId || evidence.runtimeAppId !== input.appId ||
      !https(evidence.runtimeEvidenceUrl) ||
      !(Date.parse(evidence.runtimeVerifiedAt) <= now) ||
      !(Date.parse(evidence.runtimeValidUntil) >= now)) return unavailable("runtime_unverified");
  const matches = evidence.calibrations.filter(c => c.window === input.window);
  if (!matches.length) return unavailable("calibration_required");
  const active = matches.filter(c => Date.parse(c.validFrom) <= end && Date.parse(c.validUntil) >= now);
  if (!active.length) return unavailable("calibration_expired");
  if (active.length !== 1) return unavailable("invalid_calibration"); // ambiguous applicability
  const c = active[0];
  if (c.population !== "own_pass_online_active_players" || !Number.isFinite(c.meanHoursPerPlayer) ||
      c.meanHoursPerPlayer <= 0 || c.meanHoursPerPlayer > (end - start) / HOUR ||
      !https(c.sourceUrl) || !https(c.validationUrl) ||
      !(Date.parse(c.validatedAt) <= now)) return unavailable("invalid_calibration");
  const players = Math.round(playerHours / c.meanHoursPerPlayer);
  if (!Number.isSafeInteger(players) || players < peak) return unavailable("invalid_calibration");
  return { ...result, players, status: "available", meanHoursPerPlayer: c.meanHoursPerPlayer,
    calibrationSourceUrl: c.sourceUrl, validationUrl: c.validationUrl };
}
