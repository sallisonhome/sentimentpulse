/** Scoped, conservative model policy, NOT an actual-sales anchor.
 * FC 26's reviews cannot independently justify an
 * unconstrained Steam -> console uplift. Keep the existing sports mix, but
 * require its scale not to exceed any available same-period native model.
 * All five periods are in scope. Never change raw evidence, coefficients or
 * accumulator state. The long-window extension can be disabled independently.
 * Evidence: https://help.ea.com/en/articles/ea-sports-fc/playstation-plus-monthly-games/
 * https://news.xbox.com/en-us/2026/06/18/ea-play-fc-26/
 */
export const RECENT_FAMILY_VERSION = "fc26_recent_family_consistency_v1";
export const LONG_FAMILY_VERSION = "fc26_long_family_consistency_v1";
export const RECENT_FAMILY_CAVEAT =
  "Cross-platform consistency estimate: conservatively limited by same-period platform models while retaining the sports platform mix. Modeled sales, not verified purchases or a measured subscription adjustment.";
export function recentFamilyApplies(family: string, window: string) {
  return family === "ea sports fc 26" &&
    (["d7", "d30", "d90"].includes(window) ||
      (process.env.FC26_LONG_FAMILY_ENABLED !== "0" && ["m12", "ltd"].includes(window)));
}
export type NativePeer = {
  platform: string; revenue: number | null; windowUsed: string | null;
  ratio: number; protected: boolean; method?: string;
};
export function recentFamilyScale(input: {
  family: string; window: string; steamRevenue: number | null;
  steamWindow: string | null; peers: NativePeer[];
}) {
  if (!recentFamilyApplies(input.family, input.window) ||
      input.steamRevenue == null || !Number.isFinite(input.steamRevenue) ||
      input.steamRevenue <= 0 || input.steamWindow !== input.window) return null;
  if (input.peers.some(p=>p.protected)) return null;
  const peers = input.peers.filter(p => p.windowUsed === input.window &&
    !/backfill-(steam-pace|peer-ratio)/.test(p.method??"") &&
    p.revenue != null && Number.isFinite(p.revenue) && p.revenue > 0 &&
    Number.isFinite(p.ratio) && p.ratio > 0);
  if (!peers.length) return null; // missing evidence is not a zero-sales cap
  const ceilings = peers.map(p => ({...p, steamEquivalentUsd: p.revenue! / p.ratio}));
  const limiting = ceilings.reduce((a,b) => a.steamEquivalentUsd <= b.steamEquivalentUsd ? a : b);
  const revenue = Math.min(input.steamRevenue, limiting.steamEquivalentUsd);
  return {version: ["m12", "ltd"].includes(input.window) ? LONG_FAMILY_VERSION : RECENT_FAMILY_VERSION, window: input.window,
    revenue, originalSteamRevenueUsd: input.steamRevenue, factor: revenue / input.steamRevenue,
    limitingPlatform: limiting.platform, nativeModels: ceilings,
    caveat: RECENT_FAMILY_CAVEAT, applied: revenue < input.steamRevenue};
}
