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
 * Global first-month conversion multiplier for PRE-RELEASE Steam wishlist
 * counts. First-month unit forecast = pre-release wishlist ×
 * STEAM_WISHLIST_FIRST_MONTH_MULTIPLIER.
 *
 * 2026-08-11: Raised from 0.20 → 0.27 based on updated Saber cohort
 * conversion data. 2026-08-19: Raised again from 0.27 → 0.45 per updated
 * Saber cohort conversion data. Once a title has released, the wishlist
 * count fed to this formula is LOCKED at the pre-release snapshot (see
 * getForecastingWishlistCount in routes.ts).
 */
export const STEAM_WISHLIST_FIRST_MONTH_MULTIPLIER = 0.45;

/**
 * v3.32 (2026-08-19): Bull/Bear scenario multipliers for the Month-1
 * conversion toggle. Bull === the default STEAM_WISHLIST_FIRST_MONTH_MULTIPLIER
 * (0.45) and is the default display basis on cards and the PDP. Bear is a
 * conservative 0.18 the user can toggle on to see a downside scenario.
 * Both apply to the SAME locked wishlist/prepurchase inputs — only the
 * conversion rate changes.
 */
export const STEAM_WISHLIST_BULL_MULTIPLIER = STEAM_WISHLIST_FIRST_MONTH_MULTIPLIER;
export const STEAM_WISHLIST_BEAR_MULTIPLIER = 0.18;

/**
 * Console propagation dampening factor (v3.7, 2026-08-12).
 *
 * When Steam actuals reveal that a title over/underperformed its
 * wishlist-based forecast, PS5/Xbox/Switch forecasts get a partial share
 * of that lift. Cross-platform demand curves aren't identical, so we
 * halve the observed Steam lift by default until we have console-specific
 * actuals to confirm.
 *
 * Formula: consoleLift = 1 + CONSOLE_LIFT_DAMPENING * (steamLift - 1)
 * where steamLift = actualFirstMonth / wishlistBasedForecast.
 *
 * Example: Steam actual = 4x wishlist forecast -> steamLift = 4.
 * Console lift = 1 + 0.5 * (4 - 1) = 2.5.
 */
export const CONSOLE_LIFT_DAMPENING = 0.5;

/**
 * Calculate dynamic forecasts from current wishlist/prepurchase counts.
 *
 * PC (Steam): Always driven by wishlist data
 *   - First Month = wishlist × STEAM_WISHLIST_FIRST_MONTH_MULTIPLIER (0.45)
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
  ps5PrepurchaseCount: number | null,
  /**
   * v3.7 (2026-08-12): post-release Steam actuals — observed first-month
   * base units. When provided and > 0, we use this instead of the wishlist
   * multiplier for the Steam Dyn track, AND apply a dampened lift to
   * console platforms via CONSOLE_LIFT_DAMPENING. Pass null pre-release
   * or when actuals are insufficient (<30 days post-release).
   */
  steamActualFirstMonthUnits?: number | null,
  /**
   * v3.8 (2026-08-12): Steam cumulative BASE units to-date. Only used as a
   * fallback when no `baselineSteam` snapshot is available yet (v3.28
   * superseded the normal path — see below). Pass null pre-release.
   */
  steamActualCumulativeUnits?: number | null,
  /**
   * v3.28 (2026-08-19): Steam first-YEAR actual BASE units (T+365d window).
   * When provided along with `baselineSteam`, re-anchors the LT projection
   * off the first-year/baseline ratio instead of the first-month ratio.
   * Pass null before T+365d or when actuals are insufficient.
   */
  steamActualFirstYearUnits?: number | null,
  /**
   * v3.28 (2026-08-19): the LOCKED Dynamic Pre-Launch Forecast for Steam —
   * read from the immutable `launchForecastSnapshot` row (wishlist ×
   * multiplier, captured once at first-observed-release and never
   * recomputed). This is the reference the Dynamic Actuals-Driven Forecast
   * projects up/down from at each milestone crossing, and the baseline
   * every delta (dashboard + PDP) is measured against. Pass null/undefined
   * when no snapshot exists yet (falls back to the legacy clamp below so
   * behavior degrades gracefully rather than going blank).
   */
  baselineSteam?: { firstMonth: number | null; firstYear: number | null; lifetime: number | null } | null,
  /**
   * v3.32 (2026-08-19): Bull/Bear scenario toggle — overrides the Month-1
   * wishlist conversion rate. Defaults to STEAM_WISHLIST_FIRST_MONTH_MULTIPLIER
   * (Bull/0.45) so every existing call site is unaffected unless it
   * explicitly opts into a different scenario (e.g. STEAM_WISHLIST_BEAR_MULTIPLIER).
   */
  firstMonthMultiplier: number = STEAM_WISHLIST_FIRST_MONTH_MULTIPLIER,
): DynamicForecastResult[] {
  const mix = getAdjustedPlatformMix(selectedPlatforms);
  const hasSteam = selectedPlatforms.includes("PC (Steam)");
  const hasPs5 = selectedPlatforms.includes("PS5");
  const hasPs5Prepurchase = hasPs5 && ps5PrepurchaseCount != null && ps5PrepurchaseCount > 0;

  // ── PC (Steam): actuals-first, wishlist-fallback (v3.7) ────────────────────
  // When post-release Steam actuals are available, they drive the Steam
  // 1st-Mo track. Otherwise fall back to wishlist × multiplier.
  const wishlistBasedSteamFirstMonth = hasSteam && steamWishlistCount != null
    ? Math.round(steamWishlistCount * firstMonthMultiplier)
    : null;

  const useActuals = hasSteam
    && steamActualFirstMonthUnits != null
    && steamActualFirstMonthUnits > 0;

  // v3.28 (2026-08-19): Dynamic Actuals-Driven Forecast — milestone
  // ratio-scaling against the LOCKED Dynamic Pre-Launch Forecast baseline,
  // replacing the old "LT = max(cumulative, firstMonth)" clamp (which
  // always produced a 0% delta once actuals existed). At T+30d we scale
  // the whole baseline by (actual firstMonth / baseline firstMonth); at
  // T+365d we re-anchor using (actual firstYear / baseline firstYear).
  const hasBaseline = baselineSteam != null
    && baselineSteam.firstMonth != null && baselineSteam.firstMonth > 0
    && baselineSteam.firstYear != null && baselineSteam.firstYear > 0
    && baselineSteam.lifetime != null && baselineSteam.lifetime > 0;

  let steamFirstMonth: number | null;
  let steamFirstYear: number | null;
  let steamLifetime: number | null;
  let steamLift: number;

  if (useActuals && hasBaseline) {
    const ratio1 = steamActualFirstMonthUnits! / baselineSteam!.firstMonth!;
    steamLift = ratio1;
    steamFirstMonth = steamActualFirstMonthUnits!;

    const hasFirstYearActual = steamActualFirstYearUnits != null && steamActualFirstYearUnits > 0;
    if (hasFirstYearActual) {
      const ratio2 = steamActualFirstYearUnits! / baselineSteam!.firstYear!;
      steamFirstYear = steamActualFirstYearUnits!;
      steamLifetime = Math.round(baselineSteam!.lifetime! * ratio2);
    } else {
      steamFirstYear = Math.round(baselineSteam!.firstYear! * ratio1);
      steamLifetime = Math.round(baselineSteam!.lifetime! * ratio1);
    }
  } else if (useActuals) {
    // Fallback: actuals exist but no locked baseline yet (e.g. a title
    // released with zero pre-release wishlist history, or a transitional
    // state before the next dashboard load backfills the snapshot).
    // Degrade to the legacy clamp so this can't silently go blank.
    steamFirstMonth = steamActualFirstMonthUnits!;
    const useCumulative = steamActualCumulativeUnits != null && steamActualCumulativeUnits > 0;
    steamLifetime = useCumulative
      ? Math.max(steamActualCumulativeUnits!, steamFirstMonth!)
      : steamFirstMonth * 4;
    steamFirstYear = useCumulative && steamLifetime != null
      ? Math.round(steamFirstMonth! + (steamLifetime - steamFirstMonth!) * 0.7)
      : steamFirstMonth * 2;
    steamLift = (wishlistBasedSteamFirstMonth != null && wishlistBasedSteamFirstMonth > 0)
      ? (steamActualFirstMonthUnits! / wishlistBasedSteamFirstMonth)
      : 1;
  } else {
    // Pre-release, or no actuals at all: pure wishlist formula.
    steamFirstMonth = wishlistBasedSteamFirstMonth;
    steamFirstYear = steamFirstMonth != null ? steamFirstMonth * 2 : null;
    steamLifetime = steamFirstMonth != null ? steamFirstMonth * 4 : null;
    steamLift = 1;
  }

  const consoleLift = 1 + CONSOLE_LIFT_DAMPENING * (steamLift - 1);

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
        // PC: driven by Steam signals. v3.8: cumulative actuals set LT,
        // 1st Yr interpolates between 1st Mo and LT.
        return {
          platform: p,
          firstMonth: steamFirstMonth,
          firstYear: steamFirstYear ?? steamFirstMonth * 2,
          lifetime: steamLifetime ?? steamFirstMonth * 4,
        };
      }
      if (p === "PS5") {
        // PS5 prepurchase is its own signal, but if Steam actuals imply the
        // whole title over/underperformed, apply the dampened lift.
        return {
          platform: p,
          firstMonth: Math.round(ps5FirstMonth! * consoleLift),
          firstYear: Math.round(ps5FirstYear! * consoleLift),
          lifetime: Math.round(ps5Lt! * consoleLift),
        };
      }
      // Other consoles: proportional to PS5 by console mix, dampened lift on top.
      const thisPct = consoleMix[p] || 0;
      const ratio = ps5ConsolePct > 0 ? thisPct / ps5ConsolePct : 0;
      return {
        platform: p,
        firstMonth: Math.round((ps5FirstMonth ?? 0) * ratio * consoleLift),
        firstYear: Math.round((ps5FirstYear ?? 0) * ratio * consoleLift),
        lifetime: Math.round((ps5Lt ?? 0) * ratio * consoleLift),
      };
    });
  }

  // ── Fallback: no PS5 prepurchase — global platform mix approach ───────────
  // v3.7 dampening: consoles derive from the WISHLIST implied total
  // (not the actuals-inflated Steam number), then get the dampened lift
  // on top. This way Steam +300% doesn't automatically become PS5 +300%.
  const steamDynamic = steamFirstMonth;
  const wishlistImpliedTotal = (wishlistBasedSteamFirstMonth != null
      && mix["PC (Steam)"] > 0)
    ? wishlistBasedSteamFirstMonth / mix["PC (Steam)"]
    : 0;

  return selectedPlatforms.map(p => {
    if (p === "PC (Steam)" && steamDynamic != null) {
      // v3.8: Steam uses its own values. LT and 1st Yr use cumulative-
      // aware projections when actuals present; else fall back to *4/*2.
      return {
        platform: p,
        firstMonth: steamDynamic,
        firstYear: steamFirstYear ?? steamDynamic * 2,
        lifetime: steamLifetime ?? steamDynamic * 4,
      };
    }
    // Non-Steam platforms: base off wishlist-implied total then apply
    // dampened lift (consoleLift = 1 when no actuals, so behavior is
    // identical to legacy path pre-release).
    const platformBase = Math.round(wishlistImpliedTotal * mix[p]);
    const firstMonth = Math.round(platformBase * consoleLift);
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

/**
 * v3.32 (2026-08-19): Bull/Bear Month-1 conversion scenario pair.
 *
 * Computes the SAME pure wishlist-formula forecast (no post-release
 * actuals influence — this is the Track 1 "Dynamic Pre-Launch Forecast"
 * mechanism only) at both the Bull (0.45) and Bear (0.18) conversion
 * rates, from identical locked inputs. Used both for the pre-release
 * live preview (inputs = current wishlist/prepurchase counts) and the
 * post-release locked snapshot (inputs = the snapshot's frozen
 * steamWishlistCountAtLaunch / ps5PrepurchaseCountAtLock columns) so the
 * UI toggle has an identical shape to switch between either way.
 */
export interface ForecastScenario {
  totalFirstMonth: number;
  totalFirstYear: number;
  totalLifetime: number;
  steamFirstMonth: number | null;
  steamFirstYear: number | null;
  steamLifetime: number | null;
  perPlatformForecasts: DynamicForecastResult[];
}

export interface ForecastScenarioPair {
  bull: ForecastScenario;
  bear: ForecastScenario;
}

function buildScenario(
  selectedPlatforms: string[],
  steamWishlistCount: number | null,
  ps5PrepurchaseCount: number | null,
  multiplier: number,
): ForecastScenario {
  const dynamic = calculateDynamicForecastsFull(
    selectedPlatforms,
    steamWishlistCount,
    ps5PrepurchaseCount,
    null, // steamActualFirstMonthUnits — pure wishlist formula only
    null, // steamActualCumulativeUnits
    null, // steamActualFirstYearUnits
    null, // baselineSteam
    multiplier,
  );
  const steamRow = dynamic.find(d => d.platform === "PC (Steam)") ?? null;
  return {
    totalFirstMonth: dynamic.reduce((s, d) => s + d.firstMonth, 0),
    totalFirstYear: dynamic.reduce((s, d) => s + d.firstYear, 0),
    totalLifetime: dynamic.reduce((s, d) => s + d.lifetime, 0),
    steamFirstMonth: steamRow?.firstMonth ?? null,
    steamFirstYear: steamRow?.firstYear ?? null,
    steamLifetime: steamRow?.lifetime ?? null,
    perPlatformForecasts: dynamic,
  };
}

export function computeForecastScenarios(
  selectedPlatforms: string[],
  steamWishlistCount: number | null,
  ps5PrepurchaseCount: number | null,
): ForecastScenarioPair {
  return {
    bull: buildScenario(selectedPlatforms, steamWishlistCount, ps5PrepurchaseCount, STEAM_WISHLIST_BULL_MULTIPLIER),
    bear: buildScenario(selectedPlatforms, steamWishlistCount, ps5PrepurchaseCount, STEAM_WISHLIST_BEAR_MULTIPLIER),
  };
}
