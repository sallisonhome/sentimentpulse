/** Qualified scenario contract. Never a measured-users or download contract. */
export type PassScenarioTitle = "lords" | "it-takes-two";
export interface PassScenarioPoint {
  month: string;
  hours: number;
  observedRuntimeAvgCcu: number;
  observedLegacyAvgCcu: number | null;
  denominatorAvgCcu: number;
  baselineAvgCcu: number | null;
  estimateAvgCcu: number;
  sensitivityLowAvgCcu: number;
  sensitivityHighAvgCcu: number;
  estimatedPlayerHours: number;
}
export interface PassScenarioResult {
  status: "qualified_scenario";
  title: PassScenarioTitle;
  name: string;
  metric: "incremental_guest_equivalent_ccu" | "estimated_total_pass_client_ccu";
  metricLabel: string;
  confidence: "low" | "very_low";
  observed: false;
  excludedFromActualsAndTotals: true;
  automaticDownstreamApplication: false;
  snapshotDate: string;
  methodVersion: string;
  sourceSha256: string;
  availableFrom: string;
  availableThrough: string;
  selectedFrom: string;
  selectedThrough: string;
  parameters: { passAttribution: number | null; incrementalHostsPerGuest: number | null;
    historicalShare: number | null };
  summary: { estimateAvgCcu: number; sensitivityLowAvgCcu: number; sensitivityHighAvgCcu: number;
    estimatedPlayerHours: number; playerHoursLow: number; playerHoursHigh: number;
    hours: number; months: number };
  sources: Array<{ label: string; url: string }>;
  caveats: string[];
  points: PassScenarioPoint[];
}
