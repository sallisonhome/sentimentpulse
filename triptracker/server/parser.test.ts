/**
 * Smoke test for Confirm-or-Omit layer 3 helpers in parser.ts.
 *
 * Not wired into a test runner (the project has none today) — run directly
 * with `npx tsx server/parser.test.ts` for a CI-like signal.  Exits with
 * status 1 on any failure so it can be added to a future test script.
 */
import { __test_only } from "./parser";

const { extractCitations, stripUncitedSentences, filterCitedItems, filterCitedActions, buildMeetingBlocks } = __test_only;

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failures++;
    console.error(`  \u2717 ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("extractCitations");
{
  const out = extractCitations("Nexon confirmed Vindictus [M-001]. Devolver passed [M-002, M-003].");
  check("extracts compound + single", out.has("M-001") && out.has("M-002") && out.has("M-003") && out.size === 3);

  const out2 = extractCitations("Bare token M-007 should NOT match outside brackets.");
  check("ignores bare tokens outside brackets", out2.size === 0);

  const out3 = extractCitations("");
  check("empty string returns empty set", out3.size === 0);
}

console.log("\nstripUncitedSentences");
{
  const cmap = {
    "M-001": { meetingId: 11, companyName: "Nexon", sentiment: "positive" },
    "M-002": { meetingId: 12, companyName: "Devolver", sentiment: "negative" },
  };
  const text = "Nexon committed to EGS [M-001]. Acme also signed a deal. Devolver passed [M-002].";
  const out = stripUncitedSentences(text, cmap);
  check("drops uncited middle sentence", out.includes("Nexon committed") && out.includes("Devolver passed") && !out.includes("Acme also signed"));

  const text2 = "Bogus claim [M-999].";
  check("drops sentence citing only invalid tokens", stripUncitedSentences(text2, cmap) === "");

  check("passes through when citation_map is empty", stripUncitedSentences(text, {}) === text);
}

console.log("\nfilterCitedItems");
{
  const cmap = { "M-001": { meetingId: 1, companyName: "X", sentiment: "positive" } };
  const items = ["Real opportunity [M-001]", "Invented opportunity"];
  const out = filterCitedItems(items, cmap);
  check("drops items without citation", out.length === 1 && out[0].includes("Real opportunity"));

  const items2 = ["Cites invalid [M-999]"];
  check("drops items with only invalid citations", filterCitedItems(items2, cmap).length === 0);

  check("empty items returns empty array", filterCitedItems([], cmap).length === 0);
  check("undefined items returns empty array", filterCitedItems(undefined, cmap).length === 0);
}

console.log("\nfilterCitedActions");
{
  const cmap = { "M-001": { meetingId: 1, companyName: "X", sentiment: "positive" } };
  const actions = [
    { action: "Send proposal [M-001]", owner: "Alex", dueDate: "2026-07-01" },
    { action: "Invent a deadline", owner: "Sam" },
  ];
  const out = filterCitedActions(actions, cmap);
  check("drops uncited actions", out.length === 1 && out[0].action.includes("Send proposal"));
  check("preserves owner + dueDate", out[0].owner === "Alex" && out[0].dueDate === "2026-07-01");
}

console.log("\nbuildMeetingBlocks");
{
  const meetings = [
    { id: 11, overallSentiment: "positive", summary: "Signed", detailedNotes: "Vindictus", company: { name: "Nexon" } },
    { id: 12, overallSentiment: "negative", summary: "Passed",   detailedNotes: "Low UA", company: { name: "Devolver" } },
  ];
  const { annotated, citationMap, promptBlock } = buildMeetingBlocks(meetings);
  check("assigns sequential M-NNN tokens", annotated[0].cite === "M-001" && annotated[1].cite === "M-002");
  check("citation_map keyed by token", citationMap["M-001"].meetingId === 11 && citationMap["M-002"].meetingId === 12);
  check("prompt block includes both", promptBlock.includes("[M-001]") && promptBlock.includes("Nexon") && promptBlock.includes("Devolver"));
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nAll tests passed.");
