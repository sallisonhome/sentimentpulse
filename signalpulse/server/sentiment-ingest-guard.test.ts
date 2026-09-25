import test from "node:test";
import assert from "node:assert/strict";
import { sentimentIngestionIdle } from "./sentiment-ingest-guard";

test("monthly discovery only proceeds on an explicit idle state", async () => {
  for (const [data, expected] of [
    [{ is_running: false }, true], [{ is_running: true }, false], [{}, false],
  ] as const) {
    assert.equal(await sentimentIngestionIdle(
      (async () => new Response(JSON.stringify(data))) as typeof fetch,
    ), expected);
  }
});
test("dependency errors fail closed", async () => {
  assert.equal(await sentimentIngestionIdle(
    (async () => new Response("", { status: 503 })) as typeof fetch,
  ), false);
  assert.equal(await sentimentIngestionIdle(
    (async () => { throw new Error("timeout"); }) as typeof fetch,
  ), false);
});
