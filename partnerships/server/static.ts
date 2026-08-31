import express, { type Express } from "express";
import path from "path";
import fs from "fs";

/**
 * Serve the built Vite client from dist/public.
 *
 * In production behind nginx, nginx serves static assets directly from
 * /opt/sentimentpulse/partnerships/dist/public. This is a belt-and-braces
 * fallback for the systemd process so `curl 127.0.0.1:5002/` returns
 * something sensible without nginx.
 */
export function serveStatic(app: Express): void {
  const distDir = path.resolve(import.meta.dirname, "..", "dist", "public");

  if (!fs.existsSync(distDir)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[partnerships] dist/public not found at ${distDir} — skipping static serve. Run \`npm run build\` first.`,
    );
    return;
  }

  app.use(express.static(distDir));

  // SPA fallback for any non-API route
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}
