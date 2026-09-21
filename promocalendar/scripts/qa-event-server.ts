/** Read-only preview harness; never run against the production calendar DB. */
import express from "express";
import { resolve } from "node:path";
import { initSchema } from "../server/db";
import { registerRoutes } from "../server/routes";
import { startEventPerformanceRefresh } from "../server/event-performance";

if (!process.env.PROMOCALENDAR_DB_PATH?.startsWith("/tmp/")) {
  throw new Error("QA harness requires an explicit disposable /tmp/ database copy");
}
initSchema();
startEventPerformanceRefresh();
const child = express();
child.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});
child.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return res.status(403).json({ error: "Read-only QA preview" });
  next();
});
registerRoutes(child);
child.use(express.static(resolve("dist/public")));
child.use((req, res, next) => req.path.startsWith("/api") ? next() : res.sendFile(resolve("dist/public/index.html")));
const app = express();
app.use("/promo", child);
app.use(child);
app.listen(Number(process.env.PORT || 5103), "0.0.0.0");
