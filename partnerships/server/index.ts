import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { createServer } from "http";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { log } from "./log";

const app = express();
const httpServer = createServer(app);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);

// Lightweight request logger (mirrors triptracker / signalpulse pattern)
app.use((req, _res, next) => {
  const start = Date.now();
  const path = req.path;
  _res.on("finish", () => {
    if (path.startsWith("/api")) {
      log(`${req.method} ${path} ${_res.statusCode} ${Date.now() - start}ms`);
    }
  });
  next();
});

async function main() {
  await registerRoutes(app);

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log(`error: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  });

  // Static serving in production; Vite dev middleware would go here if we
  // ever want single-process dev. For now `npm run dev` runs the API only,
  // and the Vite client is run separately via `vite` during dev.
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  const host = process.env.HOST || "127.0.0.1";
  const port = parseInt(process.env.PORT || "5002", 10);

  httpServer.listen(port, host, () => {
    log(`partnerships listening on http://${host}:${port}`);
  });
}

main().catch((err) => {
  log(`fatal: ${err.message}`);
  process.exit(1);
});
