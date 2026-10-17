/**
 * Daily playable-game-demo pipeline.
 *
 * Seed roster -> discover released game demos -> revalidate active roster
 * -> review history -> CCU -> non-Saber multiplier presentation,
 * plus dedicated Steamworks demo-download reports for Saber actuals.
 *
 * 2026-10-17: the Saber portal collector also records daily free-licenses
 * snapshots (demo_portal_daily) as a SEPARATE licenses metric. Those
 * values never enter demo_window_estimates_daily or any download-semantics
 * table, and ranking stays download-based. computeDemoWindowActuals()
 * remains deliberately unwired (see portal-actuals.ts).
 */
import { log } from "../../log";
import { seedSaberDemos, SABER_DEMO_ROSTER } from "./saber-seed";
import { runDemosHubDiscovery } from "./discovery";
import { createDemoVerifier } from "./metadata";
import { runDemosReviewHistoryCollector } from "./runner";
import { runDemosCcuCollector } from "./ccu";
import { computeDemoWindowEstimates } from "./estimator";
import { rawSqlite, storage } from "../../storage";
import { refreshDashboardDemoActuals } from "./download-actuals";
import { runDemosPortalCollector } from "./portal-actuals";
import { runFriendsPassPipeline } from "./friends-pass";
import { loadDemoCatalog } from "./catalog";
import { HistoryBudget, refreshRecentDemoReports } from "./history-backfill";

export interface DemosPipelineRunResult {
  seeded: number;
  discovery: Awaited<ReturnType<typeof runDemosHubDiscovery>>;
  eligibility: { eligible: number; excluded: number; failed: number };
  reviewHistory: Awaited<ReturnType<typeof runDemosReviewHistoryCollector>>;
  ccu: Awaited<ReturnType<typeof runDemosCcuCollector>>;
  estimates: ReturnType<typeof computeDemoWindowEstimates>;
  portalActualsFetch: Awaited<ReturnType<typeof runDemosPortalCollector>>;
  actuals: { demosWithActuals: number; rowsWritten: number };
  dashboardActuals: Awaited<ReturnType<typeof refreshDashboardDemoActuals>>;
  datedActuals: Awaited<ReturnType<typeof refreshRecentDemoReports>>;
  friendsPass: Awaited<ReturnType<typeof runFriendsPassPipeline>>;
}

export async function runDemosDailyPipeline(delayMs = 250): Promise<DemosPipelineRunResult> {
  log("Demos pipeline: released game demos; licenses collected as a separate metric", "demos-pipeline");
  const seed = seedSaberDemos();
  const friendsPass = await runFriendsPassPipeline(delayMs);
  // Independent of public availability: archived demos still have actuals.
  const dashboardActuals = await refreshDashboardDemoActuals();
  // Licenses snapshots (demo_portal_daily). Failure-isolated: a licenses
  // collection error must never prevent the rest of the pipeline.
  let portalActualsFetch: Awaited<ReturnType<typeof runDemosPortalCollector>>;
  try {
    portalActualsFetch = await runDemosPortalCollector();
  } catch (err: any) {
    portalActualsFetch = { source: "demos_portal", status: "error", message: String(err?.message ?? err).slice(0, 300) };
  }
  log(`Demos portal licenses: ${JSON.stringify(portalActualsFetch)}`, "demos-pipeline");
  const datedActuals = await refreshRecentDemoReports(rawSqlite,loadDemoCatalog("demo"),
    new Set(SABER_DEMO_ROSTER.map(d=>d.steamAppId)),storage.getSteamworksSession("default")?.cookieValue,
    new HistoryBudget(48,120000,delayMs));
  log(`Demo dated reports: ${JSON.stringify(datedActuals)}`,"demos-pipeline");
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
  // Deliberately zero: licenses never become download actuals. Kept as an
  // explicit field so callers can see nothing was promoted.
  const actuals = { demosWithActuals: 0, rowsWritten: 0 };
  log(`Demos pipeline: eligible=${eligibility.eligible} excluded=${eligibility.excluded} failed=${eligibility.failed}`, "demos-pipeline");
  return { seeded: seed.seeded, discovery, eligibility, reviewHistory, ccu, estimates, portalActualsFetch, actuals, dashboardActuals, datedActuals, friendsPass };
}
