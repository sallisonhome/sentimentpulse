import type { Express } from "express";
import { getPassScenario, passScenarioCsv, ScenarioInputError } from "./signals/demos/pass-scenarios";

/** Inherits the same app authentication as DemoPulse. No public-read exemption. */
export function registerPassScenarioRoutes(app: Express) {
  app.get("/api/demos/pass-scenarios", (req, res, next) => {
    try {
      if (req.query.format !== undefined &&
          (typeof req.query.format !== "string" || !["json", "csv"].includes(req.query.format)))
        throw new ScenarioInputError("Invalid format");
      const result = getPassScenario(req.query);
      res.setHeader("Cache-Control", "private, no-store");
      if (req.query.format === "csv") {
        res.attachment(`pass-scenario-${result.title}-${result.selectedFrom}-${result.selectedThrough}.csv`)
          .type("text/csv").send(passScenarioCsv(result));
      } else res.json(result);
    } catch (error) {
      if (error instanceof ScenarioInputError) res.status(400).json({ error: error.message });
      else next(error);
    }
  });
}
