/**
 * Steam Demos leaderboard — daily pipeline orchestrator (2026-09-22).
 *
 * IMPORTANT CONTEXT: every piece of the demos leaderboard backend (Saber
 * roster seed, public-hub discovery, review-history collector, CCU
 * collector, the review_delta_multiplier estimator, and now the
 * Steamworks ground-truth collector below) was built across this PR but
 * NEVER wired into a production schedule -- demo_titles is empty on the
 * live droplet today. Wiring only the new Steamworks-ground-truth piece
 * in isolation would be a no-op in production (nothing in demo_titles
 * for it to act on), so this orchestrator activates the full chain in
 * one place. See PR #109 for the pre-existing dormant modules.
 *
 * Order matters for the first few steps (each depends on the last) but
 * NOT between the estimator and the actuals collector -- see
 * computeDemoWindowActuals()'s doc comment for why either order
 * converges to the same correct final state.
 *
 *   1. seedSaberDemos()            -- idempotent upsert of Saber's own roster
 *   2. runDemosHubDiscovery()      -- finds new third-party demos from the public hub
 *   3. runDemosReviewHistoryCollector() -- review deltas for every active demo
 *   4. runDemosCcuCollector()      -- live concurrent-player snapshots
 *   5. computeDemoWindowEstimates() -- review_delta_multiplier estimate rows
 *   6. runDemosPortalCollector()   -- Saber-only Steamworks portal actuals
 *   7. computeDemoWindowActuals()  -- upgrades Saber demos' rows to steamworks_actual
 */

import { log } from "../../log";
import type { IngestionResult } from "../../ingestion";
import { seedSaberDemos } from "./saber-seed";
import { runDemosHubDiscovery } from "./discovery";
import { runDemosReviewHistoryCollector } from "./runner";
import { runDemosCcuCollector } from "./ccu";
import { computeDemoWindowEstimates } from "./estimator";
import { runDemosPortalCollector, computeDemoWindowActuals } from "./portal-actuals";

export interface DemosPipelineRunResult {
  seeded: number;
  discovery: Awaited<ReturnType<typeof runDemosHubDiscovery>>;
  reviewHistory: Awaited<ReturnType<typeof runDemosReviewHistoryCollector>>;
  ccu: Awaited<ReturnType<typeof runDemosCcuCollector>>;
  estimates: ReturnType<typeof computeDemoWindowEstimates>;
  portalActualsFetch: IngestionResult;
  actuals: ReturnType<typeof computeDemoWindowActuals>;
}

export async function runDemosDailyPipeline(): Promise<DemosPipelineRunResult> {
  log("Demos pipeline: starting full daily run...", "demos-pipeline");

  const seed = seedSaberDemos();
  log(`Demos pipeline: seeded=${seed.seeded}`, "demos-pipeline");

  const discovery = await runDemosHubDiscovery();
  log(`Demos pipeline: discovery new=${discovery.newlyDiscovered} known=${discovery.alreadyKnown} rejected=${discovery.rejectedNotDemo} failed=${discovery.failed}`, "demos-pipeline");

  const reviewHistory = await runDemosReviewHistoryCollector();
  log(`Demos pipeline: reviewHistory ingested=${reviewHistory.ingested} deactivated=${reviewHistory.deactivated} failed=${reviewHistory.failed}`, "demos-pipeline");

  const ccu = await runDemosCcuCollector();
  log(`Demos pipeline: ccu done`, "demos-pipeline");

  const estimates = computeDemoWindowEstimates();
  log(`Demos pipeline: estimates demosProcessed=${estimates.demosProcessed} rowsWritten=${estimates.rowsWritten}`, "demos-pipeline");

  const portalActualsFetch = await runDemosPortalCollector();
  log(`Demos pipeline: portal actuals fetch — ${portalActualsFetch.message}`, "demos-pipeline");

  const actuals = computeDemoWindowActuals();
  log(`Demos pipeline: actuals demosWithActuals=${actuals.demosWithActuals} rowsWritten=${actuals.rowsWritten}`, "demos-pipeline");

  return { seeded: seed.seeded, discovery, reviewHistory, ccu, estimates, portalActualsFetch, actuals };
}
