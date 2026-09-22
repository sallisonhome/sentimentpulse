/**
 * Daily playable-game-demo pipeline.
 *
 * Seed roster -> discover released game demos -> revalidate active roster
 * -> review history -> CCU -> single multiplier estimate.
 *
 * Complimentary units, free licenses and other activation categories are
 * NOT demo downloads. Neither the scheduled nor manual pipeline calls the
 * experimental portal collector or promotes those values to actuals.
 * The separate read-only portal probe remains an operator diagnostic.
 */
import { log } from "../../log";
import { seedSaberDemos } from "./saber-seed";
import { runDemosHubDiscovery, verifyDemoAppId } from "./discovery";
import { loadActiveDemoTitles, runDemosReviewHistoryCollector } from "./runner";
import { runDemosCcuCollector } from "./ccu";
import { computeDemoWindowEstimates } from "./estimator";

export interface DemosPipelineRunResult {
  seeded: number;
  discovery: Awaited<ReturnType<typeof runDemosHubDiscovery>>;
  eligibility: { eligible: number; excluded: number; failed: number };
  reviewHistory: Awaited<ReturnType<typeof runDemosReviewHistoryCollector>>;
  ccu: Awaited<ReturnType<typeof runDemosCcuCollector>>;
  estimates: ReturnType<typeof computeDemoWindowEstimates>;
  portalActualsFetch: { source: string; status: "skipped"; message: string };
  actuals: { demosWithActuals: number; rowsWritten: number };
}

export async function runDemosDailyPipeline(delayMs = 250): Promise<DemosPipelineRunResult> {
  log("Demos pipeline: released game demos only; license-category ingestion disabled", "demos-pipeline");
  const seed = seedSaberDemos();
  const discovery = await runDemosHubDiscovery(delayMs);

  // Includes seeded/manual/previously discovered entries, not just today's
  // hub. Fail closed for this run on missing metadata or network errors,
  // without permanently deactivating a demo due to a transient failure.
  const eligibleAppIds = new Set<string>();
  const eligibility = { eligible: 0, excluded: 0, failed: 0 };
  for (const demo of loadActiveDemoTitles()) {
    try {
      if (await verifyDemoAppId(demo.steam_app_id)) eligibleAppIds.add(demo.steam_app_id);
      else eligibility.excluded += 1;
    } catch {
      eligibility.failed += 1;
    }
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  eligibility.eligible = eligibleAppIds.size;

  const reviewHistory = await runDemosReviewHistoryCollector(delayMs, eligibleAppIds);
  const ccu = await runDemosCcuCollector(delayMs, eligibleAppIds);
  const estimates = computeDemoWindowEstimates(undefined, eligibleAppIds);
  const portalActualsFetch = {
    source: "demos_portal",
    status: "skipped" as const,
    message: "Disabled: complimentary units and free-license categories are not demo-download actuals",
  };
  const actuals = { demosWithActuals: 0, rowsWritten: 0 };
  log(`Demos pipeline: eligible=${eligibility.eligible} excluded=${eligibility.excluded} failed=${eligibility.failed}`, "demos-pipeline");
  return { seeded: seed.seeded, discovery, eligibility, reviewHistory, ccu, estimates, portalActualsFetch, actuals };
}
