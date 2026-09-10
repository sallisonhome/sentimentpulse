/**
 * Tiny timestamped logger used across the server. Extracted from index.ts
 * so downstream modules (server/signals/console/*, scripts/verify-*.ts)
 * can import a leaf module and log without transitively booting the whole
 * express app.
 *
 * index.ts re-exports `log` from here to keep existing `import { log } from "./index"`
 * call sites working.
 */
export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  // eslint-disable-next-line no-console
  console.log(`${formattedTime} [${source}] ${message}`);
}
