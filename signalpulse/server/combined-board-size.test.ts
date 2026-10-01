import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The combined cross-platform board is shown as a top 40 in SignalPulse and howmanyareplaying.
// The server must allow limit=40 and keep 20 as the default for other API consumers.
test("combined board allows 40 rows, defaults to 20, and the SignalPulse hub requests 40", () => {
  const server = readFileSync(new URL("./routes-console-leaderboards.ts", import.meta.url), "utf8");
  assert.match(server, /const limit = Math\.min\(40, Math\.max\(1, parseInt\(\(req\.query\.limit as string\) \|\| "20", 10\) \|\| 20\)\);/);
  const client = readFileSync(new URL("../client/src/pages/console-leaderboards.tsx", import.meta.url), "utf8");
  assert.match(client, /const MULTI_TOP_N = 40;/);
  assert.match(client, /useMultiplatformLeaderboard\(window, MULTI_TOP_N\)/);
});
