import express, { type Express } from "express";
import fs from "fs";
import path from "path";

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  app.use(express.static(distPath, {
    // Force UTF-8 on text assets. Without an explicit charset, some
    // mobile Safari builds decode `.js` / `.css` bodies as Latin-1,
    // which turns any real UTF-8 byte pair (e.g. `\xc2\xb7` for U+00B7
    // middle-dot) into either mojibake ("Â·") or a literal escape
    // rendering ("\u00b7") when React later stringifies the value.
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) {
        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      } else if (filePath.endsWith(".css")) {
        res.setHeader("Content-Type", "text/css; charset=utf-8");
      } else if (filePath.endsWith(".json")) {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
      } else if (filePath.endsWith(".svg")) {
        res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
      }
    },
  }));

  // fall through to index.html if the file doesn't exist
  app.use("/{*path}", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
