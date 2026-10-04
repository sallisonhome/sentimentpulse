// Run the real console leaderboard route (report mode) in-process against ./data.db and summarise the
// chart-consistency annotations. Read-only on the database it runs in; intended for a COPY (see
// deploy/signalpulse-recompute.sh estimate-preview). Output is one JSON object per line prefixed CHART.
//
//   tsx scripts/preview-chart-report.ts <label>
process.env.CHART_CONSISTENCY_MODE = "report";
import express from "express";
import { registerConsoleLeaderboardRoutes } from "../server/routes-console-leaderboards";

const label = process.argv[2] ?? "db";
const app = express();
registerConsoleLeaderboardRoutes(app);
const server = app.listen(0, "127.0.0.1", async () => {
  const port = (server.address() as any).port;
  try {
    for (const platform of ["xbox", "ps5"]) for (const window of ["d7", "d30"]) {
      const res = await fetch(`http://127.0.0.1:${port}/api/console/leaderboards/${platform}?window=${window}&limit=100`);
      const body: any = await res.json();
      const rows: any[] = body.titles ?? [];
      const ann = rows.filter(r => r.chartConsistency);
      const byBound: Record<string, number> = {};
      for (const r of ann) byBound[r.chartConsistency.bound] = (byBound[r.chartConsistency.bound] ?? 0) + 1;
      const usable = rows.filter(r => (r.unitsMid ?? 0) > 0).length;
      const units = rows.reduce((s, r) => s + (r.unitsMid ?? 0), 0);
      console.log("CHART " + JSON.stringify({ label, platform, window, status: res.status, rows: rows.length, usable, units: Math.round(units), annotated: ann.length, byBound }));
    }
  } finally { server.close(); process.exit(0); }
});
