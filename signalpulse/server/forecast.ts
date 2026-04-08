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
    adjustedPct: Math.round(mix[p] * 10000) / 100, // percentage with 2 decimal places
  }));
}

/**
 * Calculate dynamic forecasts from current wishlist/prepurchase counts.
 * Steam first month = wishlist × 0.20
 * PS5 first month = prepurchase × 8
 */
export function calculateDynamicForecasts(
  selectedPlatforms: string[],
  steamWishlistCount: number | null,
  ps5PrepurchaseCount: number | null
): { platform: string; forecastUnits: number }[] {
  const mix = getAdjustedPlatformMix(selectedPlatforms);
  const hasSteam = selectedPlatforms.includes("PC (Steam)");
  const hasPs5 = selectedPlatforms.includes("PS5");

  const steamDynamic = hasSteam && steamWishlistCount != null ? Math.round(steamWishlistCount * 0.20) : null;
  const ps5Dynamic = hasPs5 && ps5PrepurchaseCount != null ? Math.round(ps5PrepurchaseCount * 8) : null;

  let impliedTotal = 0;

  if (steamDynamic != null && ps5Dynamic != null) {
    const impliedFromSteam = mix["PC (Steam)"] > 0 ? steamDynamic / mix["PC (Steam)"] : 0;
    const impliedFromPs5 = mix["PS5"] > 0 ? ps5Dynamic / mix["PS5"] : 0;
    impliedTotal = (impliedFromSteam + impliedFromPs5) / 2;
  } else if (steamDynamic != null) {
    impliedTotal = mix["PC (Steam)"] > 0 ? steamDynamic / mix["PC (Steam)"] : 0;
  } else if (ps5Dynamic != null) {
    impliedTotal = mix["PS5"] > 0 ? ps5Dynamic / mix["PS5"] : 0;
  }

  return selectedPlatforms.map(p => {
    // For Steam and PS5, use the direct calculated values if available
    if (p === "PC (Steam)" && steamDynamic != null) {
      return { platform: p, forecastUnits: steamDynamic };
    }
    if (p === "PS5" && ps5Dynamic != null) {
      return { platform: p, forecastUnits: ps5Dynamic };
    }
    return { platform: p, forecastUnits: Math.round(impliedTotal * mix[p]) };
  });
}
