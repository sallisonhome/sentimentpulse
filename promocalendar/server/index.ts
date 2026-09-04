import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { registerRoutes } from "./routes";
import { initSchema } from "./db";
import { serveStatic, setupVite } from "./static";
import { log } from "./log";

const PORT = Number(process.env.PORT || 5003);
const app = express();

app.use(cors());
app.use(cookieParser());

// Init the SQLite schema (idempotent).
initSchema();

// API routes
registerRoutes(app);

// Static / SPA
async function main() {
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    await setupVite(app);
  }

  app.listen(PORT, "0.0.0.0", () => {
    log(`promocalendar listening on :${PORT}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[partnerships] fatal", err);
  process.exit(1);
});
