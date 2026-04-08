import { PLATFORM_BASE_MIX } from "@shared/schema";

/**
 * Calculate adjusted platform percentages based on selected platforms.
 * If not all 5 platforms are selected, redistribute proportionally.
 */
export function getAdjustedPlatformMix(selectedPlatforms: string[]): Record<string, number> {
  const sumBase = selectedPlatforms.reduce((sum, p) => sum + (PLATFORM_BASE_MIX[p] || 0), 0);
  const adjusted: Record<string, number> = {};
  for (const p of selectedPlatforms) {
    const base = PLATFORM_BASE_MIX[p] || 0;
    adjusted[p] = sumBase > 0 ? base / sumBase : 0;
  }
  return adjusted;
}

/**
 * Mode B: Auto-generate forecasts from Steam + PS5 inputs.
 * Returns forecast units for each selected platform.
 */
export function autoGenerateForecasts(
  selectedPlatforms: string[],
  steamForecast: number,
  ps5Forecast: number
): { platform: string; forecastUnits: number; adjustedPct: number }[] {
  const mix = getAdjustedPlatformMix(selectedPlatforms);
  const hasSteam = selectedPlatforms.includes("PC (Steam)");
  const hasPs5 = selectedPlatforms.includes("PS5");

  let impliedTotal = 0;

  if (hasSteam && hasPs5) {
    const impliedFromSteam = mix["PC (Steam)"] > 0 ? steamForecast / mix["PC (Steam)"] : 0;
    const impliedFromPs5 = mix["PS5"] > 0 ? ps5Forecast / mix["PS5"] : 0;
    impliedTotal = (impliedFromSteam + impliedFromPs5) / 2;
  } else if (hasSteam) {
    impliedTotal = mix["PC (Steam)"] > 0 ? steamForecast / mix["PC (Steam)"] : 0;
  } else if (hasPs5) {
    impliedTotal = mix["PS5"] > 0 ? ps5Forecast / mix["PS5"] : 0;
  }

  return selectedPlatforms.map(p => ({
    platform: p,
    forecastUnits: Math.round(impliedTotal * mix[p]),
    adjustedPct: Math.round(mix[p] * 10000) / 100,
  }));
}

/**
 * Get the console-only platform mix (excluding PC).
 * Used to distribute PS5 prepurchase-driven forecasts to other consoles.
 */
function getConsoleMix(selectedPlatforms: string[]): Record<string, number> {
  const consolePlatforms = selectedPlatforms.filter(p => p !== "PC (Steam)");
  const sumBase = consolePlatforms.reduce((sum, p) => sum + (PLATFORM_BASE_MIX[p] || 0), 0);
  const mix: Record<string, number> = {};
  for (const p of consolePlatforms) {
    const base = PLATFORM_BASE_MIX[p] || 0;
    mix[p] = sumBase > 0 ? base / sumBase : 0;
  }
  return mix;
}

/**
 * Dynamic forecast results per platform with all three timeframes.
 */
export interface DynamicForecastResult {
  platform: string;
  firstMonth: number;
  firstYear: number;
  lifetime: number;
}

/**
 * Calculate dynamic forecasts from current wishlist/prepurchase counts.
 *
 * PC (Steam): Always driven by wishlist data
 *   - First Month = wishlist × 0.20
 *   - 1 Year = First Month × 2
 *   - LT = 1 Year × 2
 *
 * PS5 with prepurchase data:
 *   - LT = prepurchase × 8 (this IS the lifetime forecast)
 *   - 1 Year = LT / 2
 *   - First Month = 1 Year / 2
 *   - Other consoles (Xbox, Switch) = proportional share of total console
 *     based on original platform mix ratios
 *
 * PS5 without prepurchase data:
 *   - Falls back to global platform mix formula (same as PC-driven approach)
 */
export function calculateDynamicForecastsFull(
  selectedPlatforms: string[],
  steamWishlistCount: number | null,
  ps5PrepurchaseCount: number | null
): DynamicForecastResult[] {
  const mix = getAdjustedPlatformMix(selectedPlatforms);
  const hasSteam = selectedPlatforms.includes("PC (Steam)");
  const hasPs5 = selectedPlatforms.includes("PS5");
  const hasPs5Prepurchase = hasPs5 && ps5PrepurchaseCount != null && ps5PrepurchaseCount > 0;

  // ── PC (Steam): always wishlist-driven ─────────────────────────────────────
  const steamFirstMonth = hasSteam && steamWishlistCount != null
    ? Math.round(steamWishlistCount * 0.20)
    : null;

  // ── PS5 with prepurchase: LT-first approach ────────────────────────────────
  // prepurchase × 8 = LT forecast, then work backwards
  const ps5Lt = hasPs5Prepurchase ? Math.round(ps5PrepurchaseCount! * 8) : null;
  const ps5FirstYear = ps5Lt != null ? Math.round(ps5Lt / 2) : null;
  const ps5FirstMonth = ps5FirstYear != null ? Math.round(ps5FirstYear / 2) : null;

  // ── Determine implied totals for each timeframe ────────────────────────────
  // When PS5 prepurchase is active:
  //   - PC uses wishlist formula independently
  //   - PS5 uses prepurchase formula independently
  //   - Other consoles (Xbox, Switch) are proportional to PS5 based on
  //     their share of total console mix
  // When PS5 prepurchase is NOT active:
  //   - Fall back to the original global implied total approach

  if (hasPs5Prepurchase) {
    // PS5 prepurchase is driving console forecasts
    const consoleMix = getConsoleMix(selectedPlatforms);
    const ps5ConsolePct = consoleMix["PS5"] || 1;

    return selectedPlatforms.map(p => {
      if (p === "PC (Steam)" && steamFirstMonth != null) {
        // PC: independently driven by wishlists
        return {
          platform: p,
          firstMonth: steamFirstMonth,
          firstYear: steamFirstMonth * 2,
          lifetime: steamFirstMonth * 4,
        };
      }
      if (p === "PS5") {
        return {
          platform: p,
          firstMonth: ps5FirstMonth!,
          firstYear: ps5FirstYear!,
          lifetime: ps5Lt!,
        };
      }
      // Other consoles: proportional to PS5 based on console mix
      const thisPct = consoleMix[p] || 0;
      const ratio = ps5ConsolePct > 0 ? thisPct / ps5ConsolePct : 0;
      return {
        platform: p,
        firstMonth: Math.round((ps5FirstMonth ?? 0) * ratio),
        firstYear: Math.round((ps5FirstYear ?? 0) * ratio),
        lifetime: Math.round((ps5Lt ?? 0) * ratio),
      };
    });
  }

  // ── Fallback: no PS5 prepurchase — use global platform mix approach ────────
  // This is the original formula: implied total from available signals,
  // then distribute by platform mix percentages
  const steamDynamic = steamFirstMonth;
  let impliedTotal = 0;

  if (steamDynamic != null) {
    impliedTotal = mix["PC (Steam)"] > 0 ? steamDynamic / mix["PC (Steam)"] : 0;
  }

  return selectedPlatforms.map(p => {
    const firstMonth = p === "PC (Steam)" && steamDynamic != null
      ? steamDynamic
      : Math.round(impliedTotal * mix[p]);
    return {
      platform: p,
      firstMonth,
      firstYear: firstMonth * 2,
      lifetime: firstMonth * 4,
    };
  });
}

/**
 * Legacy wrapper: returns first-month figures only.
 * Used by existing code that calculates 1yr and LT with simple multipliers.
 */
export function calculateDynamicForecasts(
  selectedPlatforms: string[],
  steamWishlistCount: number | null,
  ps5PrepurchaseCount: number | null
): { platform: string; forecastUnits: number }[] {
  const full = calculateDynamicForecastsFull(selectedPlatforms, steamWishlistCount, ps5PrepurchaseCount);
  return full.map(f => ({ platform: f.platform, forecastUnits: f.firstMonth }));
}
