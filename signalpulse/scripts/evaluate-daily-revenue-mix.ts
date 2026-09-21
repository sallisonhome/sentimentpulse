import { evaluateDailyRevenueMix } from "../server/routes-console-leaderboards";
// Separate final phase: never apply against estimates before today's actual
// anchors have been written. Non-zero errors are visible to the daily service.
try {
  console.log("[revenue-mix-daily]",evaluateDailyRevenueMix());
} catch(error) {
  console.error("[revenue-mix-daily] failed",error);
  process.exitCode=1;
}
