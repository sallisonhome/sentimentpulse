import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePortalHtml } from "./steamworks-portal";

// Fixture shapes mirror the LIVE page structure observed via the routed
// read-only probe against appid 5184670 on 2026-10-17: the "Lifetime free
// licenses" label cell embeds Valve's tooltip ("A free license is a grant
// of a product to a user, but does not necessarily mean the user has
// downloaded the product."), whose prose commas broke the old shared
// extractor (it captured the comma inside "to a user, but" as a
// "number"). The fixtures verify the FIXED row-scoped extractor against
// that live-observed shape; the live VALUE (493,430 at probe time) is
// re-verified against production post-deploy via the probe endpoint.
test("parsePortalHtml extracts Lifetime free licenses when the label cell carries comma-bearing tooltip prose (live-observed shape)", () => {
  const html = `
    <h1>Game: Clive Barker's Hellraiser: Revival Demo (5184670)</h1>
    <table>
      <tr>
        <td>Lifetime free licenses <a href="#" class="tooltip">(?)<span>A free license is a grant of a product to a user, but does not necessarily mean the user has downloaded the product.</span></a></td>
        <td align=right>493,430</td>
      </tr>
      <tr><td>Lifetime unique users</td><td align=right>312,353</td></tr>
    </table>
  `;
  const parsed = parsePortalHtml(html, 5184670);
  assert.equal(parsed.lifetimeFreeLicenses, 493430, "must take the adjacent value cell, not a comma from the tooltip prose");
  assert.equal(parsed.reportAppId, 5184670, "report identity must come from the page's own h1");
});

test("parsePortalHtml accepts plain-digit and comma-grouped counts for the free/comp rows", () => {
  const plain = `
    <h1>Game: Demo (1111)</h1>
    <table><tr><td>Lifetime free licenses</td><td>493430</td></tr></table>
    <table><tr><th>Complimentary units</th><th>1004</th></tr></table>
  `;
  const parsed = parsePortalHtml(plain, 1111);
  assert.equal(parsed.lifetimeFreeLicenses, 493430, "unformatted counts must parse");
  assert.equal(parsed.periodComplimentaryUnits, 1004);
  const grouped = `
    <h1>Game: Demo (1111)</h1>
    <table><tr><td>Lifetime free licenses</td><td>1,004,296</td></tr></table>
  `;
  assert.equal(parsePortalHtml(grouped, 1111).lifetimeFreeLicenses, 1004296);
});

test("parsePortalHtml rejects ambiguity: two matching lifetime-free-license rows return null, never a silent pick", () => {
  const html = `
    <h1>Game: Demo (2222)</h1>
    <table>
      <tr><td>Lifetime free licenses</td><td>900</td></tr>
      <tr><td>Lifetime free licenses</td><td>1,000</td></tr>
    </table>
  `;
  const parsed = parsePortalHtml(html, 2222);
  assert.equal(parsed.lifetimeFreeLicenses, null, "ambiguous rows must fail closed");
  assert.equal(parsed.lifetimeFreeLicensesLabel, null);
});

test("parsePortalHtml does NOT substitute unverified labels: absence of the verified wording returns null", () => {
  // The live page shows free licenses (493K) and complimentary units
  // (494K) as DIFFERENT totals -- falling back from the verified
  // "Lifetime free licenses" wording to a "complimentary units"/
  // "activations" phrasing would report the wrong metric as verified.
  const html = `
    <h1>Game: Some Demo (1234567)</h1>
    <table>
      <tr><td>Lifetime complimentary units</td><td>7,000</td></tr>
    </table>
    <table>
      <tr><th>Free licenses</th><th>90</th></tr>
      <tr><th>Demo activations</th><th>30</th></tr>
    </table>
  `;
  const parsed = parsePortalHtml(html, 1234567);
  assert.equal(parsed.lifetimeFreeLicenses, null, "must not fall back to 'Lifetime complimentary units'");
  assert.equal(parsed.periodComplimentaryUnits, null, "must not fall back to 'Free licenses'/'Demo activations'");
});

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
  assert.equal(parsed.lifetimeFreeLicensesLabel, "^Lifetime\\s+free\\s+licenses");
  assert.equal(parsed.periodComplimentaryUnits, 456);
  assert.equal(parsed.periodComplimentaryUnitsLabel, "^Complimentary\\s+units");
  assert.equal(parsed.currentPlayers, 832);
});

test("parsePortalHtml accepts a valid zero and fails closed on a missing or non-numeric adjacent value cell", () => {
  // Zero is a legitimate observed value, not an absence.
  const zeroHtml = `
    <h1>Game: Fresh Demo (1111)</h1>
    <table><tr><td>Lifetime free licenses</td><td align=right>0</td></tr></table>
  `;
  assert.equal(parsePortalHtml(zeroHtml, 1111).lifetimeFreeLicenses, 0);

  // Label present but no adjacent value cell at all -> null, never a guess.
  const missingHtml = `
    <h1>Game: Broken Demo (2222)</h1>
    <table><tr><td>Lifetime free licenses</td></tr></table>
  `;
  assert.equal(parsePortalHtml(missingHtml, 2222).lifetimeFreeLicenses, null);

  // Adjacent cell is prose (label row with no numeric value cell) -> null.
  const proseHtml = `
    <h1>Game: Odd Demo (3333)</h1>
    <table>
      <tr>
        <td>Lifetime free licenses <span>A free license is a grant of a product to a user, but does not necessarily mean the user has downloaded the product.</span></td>
        <td>n/a</td>
      </tr>
    </table>
  `;
  assert.equal(parsePortalHtml(proseHtml, 3333).lifetimeFreeLicenses, null);
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
