/**
 * A concurrency observation is a lower bound on lifetime users, NOT a fitted
 * downloads/review ratio. Keep it separate from the provisional review model.
 * Never use lifetime CCU as a floor for downloads in a partial-lifespan window.
 */
export const DEMO_DOWNLOAD_MULTIPLIER = { low: 30, mid: 65.5, high: 100 } as const;
// User-selected live review scenario, NOT a newly verified calibration.
export const NON_SABER_DOWNLOAD_TRIAL = 130;
export function demoDownloadMultiplier(isSaberPublished: boolean): number {
  return isSaberPublished ? DEMO_DOWNLOAD_MULTIPLIER.mid : NON_SABER_DOWNLOAD_TRIAL;
}
export function demoReviewEstimate(
  reviewDelta: number | null, storedEstimate: number | null, method: string | null,
  isSaberPublished: boolean,
): number | null {
  if (method === "steamworks_actual") return storedEstimate;
  // Re-resolve existing review data at read time, so a trial never needs a
  // production ingestion or a destructive rewrite of historical raw rows.
  return reviewDelta === null ? storedEstimate : Math.round(reviewDelta * demoDownloadMultiplier(isSaberPublished));
}
export const DEMO_CALIBRATION = {
  id: "hellraiser_anchor_v1",
  appId: "5184670",
  downloads: 100_000,
  reviews: 1_527,
  reportingCutoff: null,
  status: "provisional_single_anchor",
  nonSaberTrial: { multiplier: NON_SABER_DOWNLOAD_TRIAL, status: "user_selected_trial" },
} as const;

const DAYS = { d7: 7, d30: 30, d90: 90, m12: 365, ltd: null } as const;

export function reconcileDemoDownloads(input: {
  window: keyof typeof DAYS;
  releaseDate: string | null;
  reviewEstimate: number | null;
  lifetimeReviewEstimate: number | null;
  method: string | null;
  observedPeak: number | null;
  nowMs?: number;
}) {
  const now = input.nowMs ?? Date.now();
  const release = input.releaseDate ? Date.parse(`${input.releaseDate}T00:00:00Z`) : NaN;
  const days = DAYS[input.window];
  // Midnight is deliberately conservative where only a release date is known.
  const fullLifespan = days === null || (Number.isFinite(release) &&
    release <= now && release >= now - days * 86_400_000);
  const peak = input.observedPeak != null && Number.isFinite(input.observedPeak) &&
    input.observedPeak > 0 ? input.observedPeak : null;
  const lifetimeModelBelowPeak = peak !== null &&
    input.lifetimeReviewEstimate !== null && input.lifetimeReviewEstimate < peak;
  const isObservedMinimum = input.method !== "steamworks_actual" && fullLifespan &&
    peak !== null && (input.reviewEstimate === null || input.reviewEstimate < peak);
  return {
    unitsMid: isObservedMinimum ? peak : input.reviewEstimate,
    reviewEstimate: input.reviewEstimate,
    isObservedMinimum,
    lifetimeModelBelowPeak,
    method: isObservedMinimum ? "observed_ccu_lower_bound" : input.method,
  };
}
