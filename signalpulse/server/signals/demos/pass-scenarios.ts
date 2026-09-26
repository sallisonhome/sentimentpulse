import type { PassScenarioResult, PassScenarioTitle } from "../../../shared/pass-scenarios";
import { PASS_SCENARIO_SNAPSHOT as SNAPSHOT } from "./pass-scenario-snapshot";

const SOURCES = {
  lords: [
    { label: "Monthly CCU: Lords of the Fallen", url: "https://steamcharts.com/app/1501750" },
    { label: "Version 2.0 and pass launch", url: "https://news.xbox.com/en-us/2025/04/17/why-lords-of-the-fallen-version-2-0-is-worth-your-time/" },
    { label: "Sparse historical weekday evidence", url: "https://steamspy.com/app/1501750" },
  ],
  "it-takes-two": [
    { label: "Monthly CCU: main runtime", url: "https://steamcharts.com/app/1426210" },
    { label: "Monthly CCU: legacy pass client", url: "https://steamcharts.com/app/1504980" },
    { label: "EA client transition", url: "https://www.ea.com/games/it-takes-two/it-takes-two/news/steam-friends-and-deck-verified" },
    { label: "Current Friend’s Pass listing", url: "https://store.steampowered.com/app/2995920/It_Takes_Two_Friends_Pass/" },
  ],
};
export class ScenarioInputError extends Error {}
function stringParam(q: Record<string, unknown>, key: string, fallback: string) {
  const value = q[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value) throw new ScenarioInputError(`Invalid ${key}`);
  return value;
}
function choice(q: Record<string, unknown>, key: string, fallback: string, allowed: string[]) {
  const value = stringParam(q, key, fallback);
  if (!allowed.includes(value)) throw new ScenarioInputError(`Invalid ${key}`);
  return value;
}
/** Read-only, snapshot-scoped scenarios. Never imports storage or paid estimators. */
export function getPassScenario(query: Record<string, unknown> = {}): PassScenarioResult {
  const title = choice(query, "title", "lords", ["lords", "it-takes-two"]) as PassScenarioTitle;
  const all = SNAPSHOT.rows.filter(r => r.title === title);
  const months = all.map(r => r.month);
  const from = stringParam(query, "from", "2026-06"), through = stringParam(query, "through", "2026-08");
  if (!months.includes(from as typeof months[number]) || !months.includes(through as typeof months[number]) || from > through)
    throw new ScenarioInputError("Choose an ordered range of complete months within this title’s saved coverage");
  const attribution = Number(choice(query, "attribution", "0.5", ["0", "0.25", "0.5", "0.75", "1"]));
  const hosts = Number(choice(query, "hosts", "0.5", ["0", "0.5", "1"]));
  const lords = title === "lords";
  const points = all.filter(r => r.month >= from && r.month <= through).map(r => {
    const estimate = lords
      ? Math.max(0, r.observedRuntimeAvgCcu - (r.baselineAvgCcu ?? 0)) * attribution / (1 + hosts)
      : r.denominatorAvgCcu * SNAPSHOT.historicalShare;
    const low = lords ? 0 : Math.max(r.observedLegacyAvgCcu ?? 0, r.denominatorAvgCcu * SNAPSHOT.historicalLow);
    const high = lords ? r.broadHighAvgCcu : Math.max(low, r.denominatorAvgCcu * SNAPSHOT.historicalHigh);
    return { month: r.month, hours: r.hours, observedRuntimeAvgCcu: r.observedRuntimeAvgCcu,
      observedLegacyAvgCcu: r.observedLegacyAvgCcu, denominatorAvgCcu: r.denominatorAvgCcu,
      baselineAvgCcu: r.baselineAvgCcu, estimateAvgCcu: estimate,
      sensitivityLowAvgCcu: low, sensitivityHighAvgCcu: high, estimatedPlayerHours: estimate * r.hours };
  });
  const sum = (fn: (p: typeof points[number]) => number) => points.reduce((total, p) => total + fn(p), 0);
  const hours = sum(p => p.hours);
  return {
    status: "qualified_scenario", title, name: lords ? "Lords of the Fallen" : "It Takes Two",
    metric: lords ? "incremental_guest_equivalent_ccu" : "estimated_total_pass_client_ccu",
    metricLabel: lords ? "Incremental guest-equivalent average CCU" : "Estimated total pass-client average CCU",
    confidence: lords ? "very_low" : "low", observed: false, excludedFromActualsAndTotals: true,
    automaticDownstreamApplication: false,
    snapshotDate: SNAPSHOT.snapshotDate, sourceSha256: SNAPSHOT.sourceSha256, methodVersion: SNAPSHOT.methodVersion,
    availableFrom: months[0], availableThrough: months.at(-1)!, selectedFrom: from, selectedThrough: through,
    parameters: { passAttribution: lords ? attribution : null, incrementalHostsPerGuest: lords ? hosts : null,
      historicalShare: lords ? null : SNAPSHOT.historicalShare },
    summary: { hours, months: points.length, estimateAvgCcu: sum(p => p.estimatedPlayerHours) / hours,
      sensitivityLowAvgCcu: sum(p => p.sensitivityLowAvgCcu * p.hours) / hours,
      sensitivityHighAvgCcu: sum(p => p.sensitivityHighAvgCcu * p.hours) / hours,
      estimatedPlayerHours: sum(p => p.estimatedPlayerHours),
      playerHoursLow: sum(p => p.sensitivityLowAvgCcu * p.hours),
      playerHoursHigh: sum(p => p.sensitivityHighAvgCcu * p.hours) },
    sources: SOURCES[title],
    caveats: [
      "Historical snapshot through August 2026, not a live or daily-updated estimate. Incomplete or missing months are never zero-filled.",
      "Sensitivity bounds are not statistical confidence intervals. Average CCU and player-hours are not unique people, downloads, invitations or sales.",
      "Do not add these estimates to game totals that already contain pass activity. Downstream scenario use must retain metric scope, method, assumptions and bounds.",
      ...(lords ? [
        "Incremental activity only, not all pass participants. Attribution and incremental-host coefficients are planning assumptions, not fitted parameters.",
        "Selected baseline: March 2025 average CCU held constant. Alternate baselines can eliminate positive excess; broad sensitivity includes zero and maximum positive excess across tested models.",
        "Version 2.0, promotions and pass effects cannot be separated. The five-pre/four-post-week timing test found an existing weekend pattern, not a robust new pass-specific effect.",
      ] : [
        "26.1% reference share comes from the last 12 complete pre-transition months. Transferring it after the May 2024 client migration is unvalidated.",
        "Historical-mix sensitivity uses 22.7–32.9%; it is not a prediction interval. Legacy-client activity is included once, not added again.",
      ]),
    ], points,
  };
}

export function passScenarioCsv(result: PassScenarioResult): string {
  const columns = ["title","month","metric","estimate_avg_ccu","sensitivity_low_avg_ccu","sensitivity_high_avg_ccu",
    "estimated_player_hours","player_hours_low","player_hours_high","month_hours","observed_runtime_avg_ccu",
    "observed_legacy_avg_ccu","denominator_avg_ccu","baseline_avg_ccu","assumed_pass_attribution",
    "assumed_incremental_hosts_per_guest","historical_transfer_share","confidence","observed",
    "excluded_from_actuals_and_totals","automatic_downstream_application","snapshot_date","method_version",
    "source_sha256","sources","caveats"];
  const escape = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [columns, ...result.points.map(p => [
    result.name,p.month,result.metric,p.estimateAvgCcu,p.sensitivityLowAvgCcu,p.sensitivityHighAvgCcu,
    p.estimatedPlayerHours,p.sensitivityLowAvgCcu*p.hours,p.sensitivityHighAvgCcu*p.hours,p.hours,
    p.observedRuntimeAvgCcu,p.observedLegacyAvgCcu,p.denominatorAvgCcu,p.baselineAvgCcu,
    result.parameters.passAttribution,result.parameters.incrementalHostsPerGuest,result.parameters.historicalShare,
    result.confidence,false,true,false,result.snapshotDate,result.methodVersion,result.sourceSha256,
    result.sources.map(s=>s.url).join(" | "),result.caveats.join(" | "),
  ])].map(row => row.map(escape).join(",")).join("\r\n") + "\r\n";
}
