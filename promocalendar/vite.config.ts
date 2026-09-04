import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  // Prod on the droplet serves the SPA at /promo/ via nginx alias. All
  // asset URLs in dist/index.html need the /promo/ prefix or the browser
  // will 404 on /assets/*. Local dev on port 5003 works because Express
  // mounts static files at both /promo/ and / (see server/static.ts).
  base: "/promo/",
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
