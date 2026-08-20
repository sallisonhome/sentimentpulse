import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ForecastScenario } from "@/hooks/use-forecast-scenario";

// v3.32 (2026-08-19): shared Bull/Bear segmented control used on both the
// Dashboard (one page-level instance controlling every card) and each PDP
// (controls that title's Dynamic Pre-Launch Forecasts table). Bull = 45%
// Steam wishlist first-month conversion (the existing locked default);
// Bear = 18%, a more conservative read on the exact same locked inputs.
export function ForecastScenarioToggle({
  value,
  onChange,
  className,
}: {
  value: ForecastScenario;
  onChange: (v: ForecastScenario) => void;
  className?: string;
}) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      variant="outline"
      value={value}
      onValueChange={(v) => {
        if (v === "bull" || v === "bear") onChange(v);
      }}
      className={className}
      data-testid="toggle-forecast-scenario"
    >
      <ToggleGroupItem
        value="bull"
        aria-label="Bull forecast: 45% wishlist conversion"
        className="text-xs font-semibold data-[state=on]:bg-emerald-500/15 data-[state=on]:text-emerald-700 dark:data-[state=on]:text-emerald-400"
        data-testid="toggle-forecast-bull"
      >
        Bull 45%
      </ToggleGroupItem>
      <ToggleGroupItem
        value="bear"
        aria-label="Bear forecast: 18% wishlist conversion"
        className="text-xs font-semibold data-[state=on]:bg-red-500/15 data-[state=on]:text-red-600 dark:data-[state=on]:text-red-400"
        data-testid="toggle-forecast-bear"
      >
        Bear 18%
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
