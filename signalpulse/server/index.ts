import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { startWeeklyDigestCron } from "./leaderboard-digest";
import { startIngestionCron } from "./ingestion";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
    limit: "20mb", // large enough for wishlist backfill jobs
  }),
);

app.use(express.urlencoded({ extended: false }));

// v3.0 (2026-08-11): accept raw CSV bodies for the Steam sales upload route.
// Steamworks sales exports can grow large (years of daily-per-country rows),
// so give this a generous limit. Both text/csv and text/plain are accepted
// because browsers sometimes downgrade unknown MIME types.
app.use(express.text({
  type: ["text/csv", "text/plain", "application/vnd.ms-excel"],
  limit: "50mb",
}));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  // Phase 5: weekly Steam Leaderboard digest email (Mondays 07:00 America/New_York).
  // Started after registerRoutes so seedDefaultSettings() has already run and the
  // resend_api_key/resend_from/recipients tables exist by the time it could fire.
  startWeeklyDigestCron();

  // Daily ingestion (Wishlist + Sales Leaderboards, both auth paths, plus
  // followers/header art/IGDB hype/forecasts): 03:00 America/New_York.
  // This scheduler existed in ingestion.ts but was never invoked anywhere in
  // the codebase prior to 2026-08-13 (confirmed dead code via repo-wide
  // grep) -- there was no automated daily ingestion running at all.
  startIngestionCron();

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
