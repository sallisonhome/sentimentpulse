import * as React from "react";

// v3.32 (2026-08-19): shared Bull/Bear forecast-scenario preference.
// "Bull" (0.45 Steam wishlist first-month conversion) is the existing
// locked default -- Bear (0.18) is an alternate, more conservative read
// on the same locked wishlist/prepurchase inputs. The choice is a single
// global preference (not per-card, not per-page) persisted in
// localStorage so it's remembered across the Dashboard and every PDP.
export type ForecastScenario = "bull" | "bear";

const STORAGE_KEY = "signalpulse:forecastScenario";

function readStored(): ForecastScenario {
  if (typeof window === "undefined") return "bull";
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === "bear" ? "bear" : "bull";
}

// Cross-tab/cross-component sync: plain React state alone wouldn't pick up
// a change made from a different mounted instance (Dashboard vs PDP), so
// broadcast via a custom event on write and listen for it everywhere.
const EVENT_NAME = "signalpulse:forecast-scenario-changed";

export function useForecastScenario(): [ForecastScenario, (s: ForecastScenario) => void] {
  const [scenario, setScenarioState] = React.useState<ForecastScenario>(() => readStored());

  React.useEffect(() => {
    const onChange = () => setScenarioState(readStored());
    window.addEventListener(EVENT_NAME, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(EVENT_NAME, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  const setScenario = React.useCallback((s: ForecastScenario) => {
    window.localStorage.setItem(STORAGE_KEY, s);
    setScenarioState(s);
    window.dispatchEvent(new Event(EVENT_NAME));
  }, []);

  return [scenario, setScenario];
}
