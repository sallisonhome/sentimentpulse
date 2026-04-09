import express, { type Request, Response, NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { createStorage, initStorage } from "./storage";
import { runMigrations } from "./migrate";

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
  }),
);

app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// ── Password gate ─────────────────────────────────────────────────────────────
// Set APP_PASSWORD env var to enable. If not set, the gate is disabled (local dev).
const APP_PASSWORD = process.env.APP_PASSWORD;
const AUTH_COOKIE = "egs_auth";
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>EGS Trip Tracker — Sign In</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#e5e5e5;display:flex;align-items:center;justify-content:center;min-height:100vh}
    .card{background:#141414;border:1px solid #262626;border-radius:12px;padding:40px;width:100%;max-width:360px}
    h1{font-size:18px;font-weight:700;margin-bottom:4px;color:#fff}
    p{font-size:13px;color:#737373;margin-bottom:28px}
    label{display:block;font-size:12px;font-weight:500;color:#a3a3a3;margin-bottom:6px}
    input{width:100%;padding:10px 12px;background:#1f1f1f;border:1px solid #333;border-radius:8px;color:#fff;font-size:14px;outline:none}
    input:focus{border-color:#3b82f6}
    button{margin-top:16px;width:100%;padding:10px;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
    button:hover{background:#2563eb}
    .error{margin-top:12px;font-size:13px;color:#f87171;text-align:center}
  </style>
</head>
<body>
  <div class="card">
    <h1>EGS Trip Tracker</h1>
    <p>Enter the team password to continue</p>
    <form method="POST" action="/__auth/login">
      <label for="pw">Password</label>
      <input id="pw" name="password" type="password" autofocus autocomplete="current-password" />
      <button type="submit">Sign In</button>
      {{ERROR}}
    </form>
  </div>
</body>
</html>`;

if (APP_PASSWORD) {
  // Login form
  app.get("/__auth/login", (_req, res) => {
    res.send(LOGIN_HTML.replace("{{ERROR}}", ""));
  });

  // Login handler
  app.post("/__auth/login", (req, res) => {
    if (req.body?.password === APP_PASSWORD) {
      res.cookie(AUTH_COOKIE, APP_PASSWORD, {
        httpOnly: true,
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        sameSite: "lax",
      });
      res.redirect("/");
    } else {
      res.send(LOGIN_HTML.replace("{{ERROR}}", '<p class="error">Incorrect password — try again.</p>'));
    }
  });

  // Guard middleware — protects all routes except the login page itself
  app.use((req, res, next) => {
    if (req.path.startsWith("/__auth")) return next();
    if (req.cookies?.[AUTH_COOKIE] === APP_PASSWORD) return next();
    res.redirect("/__auth/login");
  });
}
// ─────────────────────────────────────────────────────────────────────────────

app.use(
  cors({
    origin: [
      "https://www.perplexity.ai",
      "https://sites.pplx.app",
      "https://egstripreports.com",
      /\.perplexity\.ai$/,
      /\.pplx\.app$/,
    ],
    credentials: true,
  }),
);

import { log } from "./log";
export { log } from "./log";

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
  // Log key presence at startup so we can diagnose missing env vars
  log(`ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? "SET (" + process.env.ANTHROPIC_API_KEY.slice(0,12) + "...)" : "*** NOT SET — AI extraction will fail ***"}`);

  // Initialize storage (Postgres if DATABASE_URL set, else in-memory)
  const storageInstance = await createStorage();
  initStorage(storageInstance);

  // Run DB migrations + seed if using Postgres
  if (process.env.DATABASE_URL) {
    await runMigrations();
  }

  await registerRoutes(httpServer, app);

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
  const port = parseInt(process.env.PORT || "5001", 10);
  const host = process.platform === "win32" ? "127.0.0.1" : "0.0.0.0";
  httpServer.listen(port, host, () => {
    log(`serving on port ${port}`);
  });
})();
