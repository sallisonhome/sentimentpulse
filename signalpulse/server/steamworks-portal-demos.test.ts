import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePortalHtml } from "./steamworks-portal";

// Fixture shapes mirror the existing paid-title period-box structure
// (see the "Steam units" / "Retail activations" rows this parser already
// handles in production), just with the free/demo-specific rows added.
// NOTE: exact Valve wording for these two rows is UNVERIFIED against a
// real Saber demo page (no Steamworks login available in this sandbox)
// -- see steamworks-portal.ts's field doc comment and
// server/signals/demos/portal-actuals.ts probeDemoPortal(). This test
// only proves the parser correctly extracts the label it's told to look
// for; it does not prove that label is what Valve actually renders.
test("parsePortalHtml extracts Complimentary units (period) and Lifetime free licenses when present", () => {
  const html = `
    <h1>Game: Clive Barker's Hellraiser: Revival Demo (5184670)</h1>
    <table>
      <tr><td>Lifetime free licenses</td><td>12,345</td></tr>
      <tr><td>Current players</td><td>832</td></tr>
    </table>
    <div>Clive Barker's Hellraiser: Revival Demo units sold, today ( view as .csv )</div>
    <table>
      <tr><th>Complimentary units</th><th>456</th></tr>
    </table>
  `;
  const parsed = parsePortalHtml(html, 5184670);
  assert.equal(parsed.lifetimeFreeLicenses, 12345);
  assert.equal(parsed.lifetimeFreeLicensesLabel, "Lifetime\\s+free\\s+licenses");
  assert.equal(parsed.periodComplimentaryUnits, 456);
  assert.equal(parsed.periodComplimentaryUnitsLabel, "(?:^|>)\\s*Complimentary\\s+units\\s*(?:<|$)");
  assert.equal(parsed.currentPlayers, 832);
});

test("parsePortalHtml falls back to the second-choice label when the primary one is absent", () => {
  const html = `
    <h1>Game: Some Demo (1234567)</h1>
    <table>
      <tr><td>Lifetime complimentary units</td><td>7,000</td></tr>
    </table>
    <table>
      <tr><th>Free licenses</th><th>90</th></tr>
    </table>
  `;
  const parsed = parsePortalHtml(html, 1234567);
  assert.equal(parsed.lifetimeFreeLicenses, 7000, "should fall through to the 'Lifetime complimentary units' candidate");
  assert.equal(parsed.periodComplimentaryUnits, 90, "should fall through to the 'Free licenses' candidate");
});

test("parsePortalHtml returns null (not zero, not a guess) when no free/comp section exists at all", () => {
  // A typical PAID title's page has none of these rows -- must stay null,
  // never silently default to 0 (which would look like a confirmed zero
  // download count rather than "field absent").
  const html = `
    <h1>Game: Warhammer 40,000: Space Marine 2 (2183900)</h1>
    <table><tr><td>Lifetime Steam units</td><td>1,234,567</td></tr></table>
  `;
  const parsed = parsePortalHtml(html, 2183900);
  assert.equal(parsed.lifetimeFreeLicenses, null);
  assert.equal(parsed.lifetimeFreeLicensesLabel, null);
  assert.equal(parsed.periodComplimentaryUnits, null);
  assert.equal(parsed.periodComplimentaryUnitsLabel, null);
});
