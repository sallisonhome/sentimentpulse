/**
 * Daily playable-game-demo pipeline.
 *
 * Seed roster -> discover released game demos -> revalidate active roster
 * -> review history -> CCU -> non-Saber multiplier presentation,
 * plus dedicated Steamworks demo-download reports for Saber actuals.
 *
 * Complimentary units, free licenses and other activation categories are
 * NOT demo downloads. Neither the scheduled nor manual pipeline calls the
 * experimental portal collector or promotes those values to actuals.
 * The separate read-only portal probe remains an operator diagnostic.
 */
import { log } from "../../log";
import { seedSaberDemos } from "./saber-seed";
import { runDemosHubDiscovery } from "./discovery";
import { createDemoVerifier } from "./metadata";
import { runDemosReviewHistoryCollector } from "./runner";
import { runDemosCcuCollector } from "./ccu";
import { computeDemoWindowEstimates } from "./estimator";
import { rawSqlite } from "../../storage";
import { refreshDashboardDemoActuals } from "./download-actuals";
import { runFriendsPassPipeline } from "./friends-pass";
import { loadDemoCatalog } from "./catalog";

export interface DemosPipelineRunResult {
  seeded: number;
  discovery: Awaited<ReturnType<typeof runDemosHubDiscovery>>;
  eligibility: { eligible: number; excluded: number; failed: number };
  reviewHistory: Awaited<ReturnType<typeof runDemosReviewHistoryCollector>>;
  ccu: Awaited<ReturnType<typeof runDemosCcuCollector>>;
  estimates: ReturnType<typeof computeDemoWindowEstimates>;
  portalActualsFetch: { source: string; status: "skipped"; message: string };
  actuals: { demosWithActuals: number; rowsWritten: number };
  dashboardActuals: Awaited<ReturnType<typeof refreshDashboardDemoActuals>>;
  friendsPass: Awaited<ReturnType<typeof runFriendsPassPipeline>>;
}

export async function runDemosDailyPipeline(delayMs = 250): Promise<DemosPipelineRunResult> {
  log("Demos pipeline: released game demos only; license-category ingestion disabled", "demos-pipeline");
  const seed = seedSaberDemos();
  const friendsPass = await runFriendsPassPipeline(delayMs);
  // Independent of public availability: archived demos still have actuals.
  const dashboardActuals = await refreshDashboardDemoActuals();
  const verifier = createDemoVerifier(delayMs);
  const discovery = await runDemosHubDiscovery(delayMs, verifier);

  // Includes seeded/manual/previously discovered entries, not just today's
  // hub. Fail closed for this run on missing metadata or network errors,
  // without deactivating a demo due to a transient failure. Confirmed
  // non-game/unreleased identities leave metric views. Previously verified
  // demos that become unavailable remain tracked with retirement metadata.
  const eligibleAppIds = new Set<string>();
  const eligibility = { eligible: 0, excluded: 0, failed: 0 };
  const active = loadDemoCatalog("demo");
  const verified = await verifier.verify(active.map(demo => demo.steam_app_id));
  for (const demo of active) {
    const result = verified.get(demo.steam_app_id)!;
    if (result.error) {
      eligibility.failed += 1;
      // A metadata outage must not stop already-retired, accepted demos from
      // checking their own metric sources. It cannot enroll unknown identities.
      if(demo.is_active!==1)eligibleAppIds.add(demo.steam_app_id);
    }
    else if (result.demo) {
      eligibleAppIds.add(demo.steam_app_id);
      rawSqlite.prepare(`UPDATE demo_titles SET is_active=1,deactivated_at=NULL,tracking_excluded_reason=NULL,
        genre=?,release_date=?,availability_source=?,
        availability_source_url=?,availability_checked_at=? WHERE id=?`)
        .run(result.demo.genre, result.demo.releaseDate, result.demo.availabilitySource,
          result.demo.availabilitySourceUrl, result.demo.availabilityCheckedAt, demo.id);
    }
    else {
      eligibility.excluded += 1;
      const now = new Date().toISOString();
      const retired=result.reason==="unavailable"||result.reason==="date_unverified_no_download_offer";
      // Only prior accepted identities survive a takedown. Manual unknown
      // rows, paid games, software, DLC and upcoming SKUs never become demos.
      const known=demo.is_saber_published===1||!!demo.availability_source||
        !!rawSqlite.prepare("SELECT 1 FROM demo_window_estimates_daily WHERE demo_title_id=? LIMIT 1").get(demo.id);
      rawSqlite.prepare(`UPDATE demo_titles SET is_active=0,deactivated_at=COALESCE(deactivated_at,CASE WHEN is_active=1 THEN ? END),
        tracking_excluded_reason=?,last_checked_at=?,updated_at=? WHERE id=?`)
        .run(now,retired&&known?null:result.reason??"identity_unverified",now,now,demo.id);
      if(retired&&known)eligibleAppIds.add(demo.steam_app_id);
    }
  }
  eligibility.eligible = eligibleAppIds.size;

  const reviewHistory = await runDemosReviewHistoryCollector(delayMs, eligibleAppIds);
  const ccu = await runDemosCcuCollector(delayMs, eligibleAppIds);
  const estimates = computeDemoWindowEstimates(undefined, new Set(reviewHistory.succeededAppIds));
  const portalActualsFetch = {
    source: "demos_portal",
    status: "skipped" as const,
    message: "Disabled: complimentary units and free-license categories are not demo-download actuals",
  };
  const actuals = { demosWithActuals: 0, rowsWritten: 0 };
  log(`Demos pipeline: eligible=${eligibility.eligible} excluded=${eligibility.excluded} failed=${eligibility.failed}`, "demos-pipeline");
  return { seeded: seed.seeded, discovery, eligibility, reviewHistory, ccu, estimates, portalActualsFetch, actuals, dashboardActuals, friendsPass };
}
