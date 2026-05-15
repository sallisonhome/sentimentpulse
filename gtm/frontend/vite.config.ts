import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Site is served from /gtm/ in production. Use a relative base so that all
// asset URLs resolve correctly regardless of subpath depth.
export default defineConfig({
  plugins: [react()],
  base: "/gtm/",
  server: {
    port: 5173,
    host: "0.0.0.0",
    proxy: {
      "/gtm/api": {
        target: "http://104.236.239.46",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
