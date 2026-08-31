import express, { type Express } from "express";
import path from "path";
import fs from "fs";
import type { ViteDevServer } from "vite";

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

  // SPA fallback. Express 5 (path-to-regexp v8) rejects RegExp routes on
  // .get(), so we install an explicit middleware that only responds when the
  // path is not an API path and no route handled it yet.
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(distDir, "index.html"));
  });
}

/**
 * Dev-mode: attach Vite's middleware for HMR + on-the-fly TSX compilation.
 * Only imported dynamically so production builds don't pull in Vite.
 */
export async function setupVite(app: Express): Promise<void> {
  const { createServer } = await import("vite");
  const viteConfig = (await import("../vite.config.ts")).default;

  const vite: ViteDevServer = await createServer({
    ...viteConfig,
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
  });

  app.use(vite.middlewares);

  app.use(async (req, res, next) => {
    if (req.method !== "GET") return next();
    if (req.path.startsWith("/api")) return next();
    try {
      const url = req.originalUrl;
      const template = fs.readFileSync(
        path.resolve(import.meta.dirname, "..", "client", "index.html"),
        "utf-8",
      );
      const html = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(html);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}
