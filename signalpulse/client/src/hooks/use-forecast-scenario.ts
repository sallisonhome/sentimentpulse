import * as React from "react";

// v3.36 (2026-08-20): per-product Bull/Bear forecast-scenario preference.
//
// "Bull" (0.45 Steam wishlist first-month conversion) is the locked
// default -- Bear (0.18) is an alternate, more conservative read on the
// same locked wishlist/prepurchase inputs.
//
// PRIOR (v3.32) BUG: The preference was stored under a single global
// localStorage key, which meant flipping Bull→Bear on one product's
// PDP or Dashboard card silently flipped every other product too.
// Steve reported this on 2026-08-20: "all titles set up in signal pulse
// are flipping to whatever I toggle to in the one product".
//
// FIX: key the preference by productId. Each product remembers its own
// scenario independently. Cards on the Dashboard read their own value,
// each PDP reads its own value, and toggling one has no effect on the
// others.
//
// A single legacy `signalpulse:forecastScenario` global key is still
// consulted as a FALLBACK for products that don't yet have a per-product
// value stored -- so users' historical choice is respected on the first
// render for each product, then diverges as they toggle each one.
export type ForecastScenario = "bull" | "bear";

const LEGACY_GLOBAL_KEY = "signalpulse:forecastScenario";
const PER_PRODUCT_KEY_PREFIX = "signalpulse:forecastScenario:";

function readLegacyGlobal(): ForecastScenario {
  if (typeof window === "undefined") return "bull";
  const v = window.localStorage.getItem(LEGACY_GLOBAL_KEY);
  return v === "bear" ? "bear" : "bull";
}

function readStored(productId: string | number): ForecastScenario {
  if (typeof window === "undefined") return "bull";
  const perProduct = window.localStorage.getItem(PER_PRODUCT_KEY_PREFIX + String(productId));
  if (perProduct === "bull" || perProduct === "bear") return perProduct;
  // Fallback to the legacy global preference so users' historical choice
  // still applies to products they haven't explicitly toggled.
  return readLegacyGlobal();
}

// Cross-tab/cross-component sync: plain React state alone wouldn't pick
// up a change made from a different mounted instance (Dashboard card vs
// its own PDP tab). Broadcast a custom event that carries the productId
// so only components watching THAT product update.
const EVENT_NAME = "signalpulse:forecast-scenario-changed";
interface ScenarioChangedDetail {
  productId: string;
}

export function useForecastScenario(
  productId: string | number,
): [ForecastScenario, (s: ForecastScenario) => void] {
  const key = String(productId);
  const [scenario, setScenarioState] = React.useState<ForecastScenario>(
    () => readStored(key),
  );

  // Re-read whenever productId changes (e.g., navigating from one PDP
  // to another) so the hook returns the right per-product value.
  React.useEffect(() => {
    setScenarioState(readStored(key));
  }, [key]);

  React.useEffect(() => {
    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<ScenarioChangedDetail>).detail;
      if (!detail || detail.productId !== key) return;
      setScenarioState(readStored(key));
    };
    const onStorage = (e: StorageEvent) => {
      // Only re-read if a key we care about changed. Ignore other keys
      // to avoid triggering N re-renders per storage event for N cards.
      if (
        e.key === PER_PRODUCT_KEY_PREFIX + key ||
        // Legacy global key changed — only affects products that don't
        // have their own per-product value yet.
        (e.key === LEGACY_GLOBAL_KEY &&
          window.localStorage.getItem(PER_PRODUCT_KEY_PREFIX + key) === null)
      ) {
        setScenarioState(readStored(key));
      }
    };
    window.addEventListener(EVENT_NAME, onCustom);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT_NAME, onCustom);
      window.removeEventListener("storage", onStorage);
    };
  }, [key]);

  const setScenario = React.useCallback(
    (s: ForecastScenario) => {
      window.localStorage.setItem(PER_PRODUCT_KEY_PREFIX + key, s);
      setScenarioState(s);
      window.dispatchEvent(
        new CustomEvent<ScenarioChangedDetail>(EVENT_NAME, {
          detail: { productId: key },
        }),
      );
    },
    [key],
  );

  return [scenario, setScenario];
}
