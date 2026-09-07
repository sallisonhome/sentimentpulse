// Regression coverage for the 2026-09-04 incident: the Promo Calendar's
// /next-up endpoint was changed to exclude in-flight campaigns, and this
// client was still reading from it, so every "On Promo" chip silently went
// empty for ~3 days despite live sales. The fix switched to /live-now
// (v3.30, 2026-09-05). These tests pin that contract so a future refactor
// can't accidentally point this client back at /next-up, and pin the
// contract-violation guard added in the 2026-09-07 hardening pass so a
// future upstream shape change fails LOUDLY instead of silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getActivePromosFor,
  getPromoCalendarHealth,
  __resetPromoCalendarCache,
  __resetPromoCalendarHealth,
} from "./promo-calendar-client";

// A known mapped Steam AppID (Space Marine 2) so promoCodeForSteamAppId
// resolves and the client actually issues a fetch.
const MAPPED_APP_ID = 2183900;

function withMockedFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as any;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test("getActivePromosFor calls /live-now, never /next-up", async () => {
  __resetPromoCalendarCache();
  __resetPromoCalendarHealth();
  let calledUrl = "";
  await withMockedFetch(
    (async (url: string) => {
      calledUrl = String(url);
      return new Response(
        JSON.stringify({ calendar: "saber", game_code: "SM2", today: "2026-09-07", beats: [] }),
        { status: 200 },
      );
    }) as any,
    () => getActivePromosFor(MAPPED_APP_ID, "2026-09-07"),
  );
  assert.match(calledUrl, /\/live-now(\?|$)/, `expected /live-now, got: ${calledUrl}`);
  assert.doesNotMatch(calledUrl, /\/next-up/, `must never call /next-up, got: ${calledUrl}`);
});

test("active beats from /live-now are returned without requiring an is_active filter", async () => {
  __resetPromoCalendarCache();
  __resetPromoCalendarHealth();
  const result = await withMockedFetch(
    (async () =>
      new Response(
        JSON.stringify({
          calendar: "saber",
          game_code: "SM2",
          today: "2026-09-07",
          beats: [
            { campaign_id: 1, game_code: "SM2", game_label: "SM2", platform: "Steam", program: "Sale", start_date: "2026-09-03", end_date: "2026-09-14", max_discount_pct: 0.7, days_until_start: -4, is_active: true },
          ],
        }),
        { status: 200 },
      )) as any,
    () => getActivePromosFor(MAPPED_APP_ID, "2026-09-07"),
  );
  assert.deepEqual(result, [{ platform: "Steam", end_date: "2026-09-14" }]);
  assert.equal(getPromoCalendarHealth().lastErrorKind, null, "a successful call must not leave a stale error recorded");
});

test("a 200 response missing the beats array is treated as a loud contract violation, not a silent empty", async () => {
  __resetPromoCalendarCache();
  __resetPromoCalendarHealth();
  const result = await withMockedFetch(
    (async () =>
      // Simulates exactly the kind of drift that caused the incident: the
      // upstream endpoint's response shape changed and no longer has `beats`.
      new Response(JSON.stringify({ calendar: "saber", game_code: "SM2", today: "2026-09-07" }), { status: 200 })) as any,
    () => getActivePromosFor(MAPPED_APP_ID, "2026-09-07"),
  );
  assert.deepEqual(result, [], "must still fail safe to an empty array so pages don't break");
  const health = getPromoCalendarHealth();
  assert.equal(health.lastErrorKind, "contract_shape");
  assert.ok(health.lastErrorMessage?.includes("beats"));
});

test("a non-2xx response is tracked as an http_status failure, not silently swallowed", async () => {
  __resetPromoCalendarCache();
  __resetPromoCalendarHealth();
  await withMockedFetch(
    (async () => new Response("", { status: 503 })) as any,
    () => getActivePromosFor(MAPPED_APP_ID, "2026-09-07"),
  );
  const health = getPromoCalendarHealth();
  assert.equal(health.lastErrorKind, "http_status");
  assert.equal(health.consecutiveFailures, 1);
});

test("a network error is tracked as a network failure and resolves to []", async () => {
  __resetPromoCalendarCache();
  __resetPromoCalendarHealth();
  const result = await withMockedFetch(
    (async () => {
      throw new Error("ECONNREFUSED");
    }) as any,
    () => getActivePromosFor(MAPPED_APP_ID, "2026-09-07"),
  );
  assert.deepEqual(result, []);
  assert.equal(getPromoCalendarHealth().lastErrorKind, "network");
});

test("a subsequent success resets consecutiveFailures back to 0", async () => {
  __resetPromoCalendarCache();
  __resetPromoCalendarHealth();
  await withMockedFetch((async () => new Response("", { status: 503 })) as any, () =>
    getActivePromosFor(MAPPED_APP_ID, "2026-09-07"),
  );
  assert.equal(getPromoCalendarHealth().consecutiveFailures, 1);

  __resetPromoCalendarCache(); // bypass the 60s cache from the failed call above
  await withMockedFetch(
    (async () =>
      new Response(JSON.stringify({ calendar: "saber", game_code: "SM2", today: "2026-09-07", beats: [] }), { status: 200 })) as any,
    () => getActivePromosFor(MAPPED_APP_ID, "2026-09-07"),
  );
  assert.equal(getPromoCalendarHealth().consecutiveFailures, 0);
});
