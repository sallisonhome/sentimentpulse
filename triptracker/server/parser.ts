/**
 * AI-powered trip report parser using Claude.
 *
 * Given the raw text of an EGS BD/AM trip report, this module:
 *  1. Sends the text to Claude with a structured extraction prompt.
 *  2. Parses the JSON response into typed objects.
 *  3. Writes the extracted data into the database via `storage`.
 *
 * The parser is forgiving: it creates new companies / contacts / games /
 * platform-topics if they don't already exist, and re-uses existing ones
 * when a name match is found (case-insensitive).
 */

import Anthropic from "@anthropic-ai/sdk";
import { storage } from "./storage";
import { log } from "./log";

// ─── Types returned by Claude ────────────────────────────────────────────────

interface ParsedContact {
  name: string;
  title?: string;
  email?: string;
}

interface ParsedGame {
  title: string;
  egsStatus?: "launched" | "announced" | "under_discussion" | "not_coming" | "unknown";
  dealStatus?: "initial_outreach" | "in_negotiation" | "signed" | "lost";
  discussionSummary?: string;
  sentiment?: "positive" | "neutral" | "negative";
  projectedLaunchTiming?: string;
  keyQuotes?: string;
}

interface ParsedTopic {
  name: string;
  category?: "commercial" | "product" | "tech" | "marketing" | "operations";
  sentiment?: "positive" | "neutral" | "negative";
  feedbackSummary?: string;
  requestOrBlocker?: string;
  priority?: "low" | "medium" | "high";
}

interface ParsedMeeting {
  companyName: string;
  companyType?: "publisher" | "developer" | "mixed";
  companyRegion?: string;
  contacts: ParsedContact[];
  meetingDate?: string;         // YYYY-MM-DD
  startTime?: string;           // HH:MM
  location?: string;
  format?: "in_person" | "virtual" | "hybrid";
  overallSentiment: "positive" | "neutral" | "negative";
  summary: string;
  detailedNotes?: string;
  followUpActions?: string;
  games: ParsedGame[];
  topics: ParsedTopic[];
}

interface ParsedReport {
  meetings: ParsedMeeting[];
}

// ─── Claude extraction ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert at parsing Epic Games Store (EGS) business development and account management trip reports.
Given a raw trip report document, extract ALL meetings/interactions as individual records.

DOCUMENT TYPES — handle ALL of these, including the most informal:
1. Formal meeting-by-meeting reports: each company has its own clearly labelled section with full details.
2. Conference recap docs: interactions appear as sessions, panels, 1-on-1 meetings, booth visits, dinners, or brief bullet entries.
3. Mixed formats: some formal sections + some bullet-point summaries.
4. ULTRA-INFORMAL FIELD NOTES (very common): A company name appears as a standalone line or heading, followed by loose bullet points, sentence fragments, or slash-separated notes describing what was discussed. There are NO headers like "Meeting:", NO dates, and NO formal structure — just raw field notes taken at speed. TREAT EACH NAMED COMPANY BLOCK AS ONE MEETING RECORD.

CRITICAL — HOW TO RECOGNISE THE INFORMAL FORMAT:
If you see a pattern like:
  CompanyName
  - note about their games / portfolio / status
  - another observation or comment

  NextCompany
  - their note

→ Each company block = ONE meeting. Extract every block. NEVER return an empty meetings array if company names and notes are present.

INFORMAL FORMAT PARSING RULES:
- The company name is the first line / bold heading of each block.
- Everything after it (bullets, dashes, slashes, fragments) becomes detailedNotes for that meeting.
- Game titles or franchises mentioned in the notes → extract as games[] entries.
- "Up to them if they want to onboard" = neutral sentiment; open to EGS but non-committal.
- "Not interested" / "won't do" / "passed" / "declined" = negative sentiment.
- "Excited" / "keen" / "committed" / "signed" = positive sentiment.
- If no contact name is given, use an empty contacts array (do not invent names).
- Slash-separated text like "Sports games / Football Top 11 / mobile" = game portfolio description, not separate meetings.
- Write a concise 1-2 sentence summary field that synthesises the notes into a plain-English outcome statement.

UNIVERSAL EXTRACTION RULES:
- Treat EVERY distinct company interaction as its own meeting record — even if it is a single bullet or a one-liner.
- For conference recaps, each company entry under any heading (1-on-1s, Other Meetings, Dinners, Sessions, etc.) = one meeting.
- Do NOT merge multiple companies into one meeting record.
- Do NOT skip any company mentioned, even if only a name + one sentence of context is given.
- NEVER return meetings: [] if company names appear in the document — that is always an error.
- For sentiment: positive = interested/committed/excited/favorable; negative = rejected/blocked/concerns/passed; neutral = unclear/mixed/informational/up-to-them.
- Map platform topics to canonical EGS names when possible (e.g. Revenue Share / Commercial Terms, Discovery & Featuring, Tools & SDK, Payments & Reporting, User Acquisition & Marketing, Free Games Program, Competitive Intel).
- For dates: infer the year from event context if only month/day is given. If no date is present at all, omit the field entirely.
- Omit optional fields that have no value rather than setting them to null.
- Return ONLY valid JSON — no markdown fences, no preamble, no trailing text.

EXAMPLE — given this ultra-informal input:
  Nordeus
  Sports games / Football Top 11 / mobile
  Up to them if they want to onboard now, we've spoken before

  Handy Games
  More games coming
  We've attempted a few times to strike free games deals - not interested

You MUST produce:
{
  "meetings": [
    {
      "companyName": "Nordeus",
      "companyType": "developer",
      "contacts": [],
      "overallSentiment": "neutral",
      "summary": "Brief conference touchpoint. Nordeus develops sports/mobile games including Football Top 11 and is open to EGS onboarding at their own pace.",
      "detailedNotes": "Sports games / Football Top 11 / mobile. Up to them if they want to onboard now, we've spoken before.",
      "games": [{ "title": "Football Top 11", "egsStatus": "under_discussion", "sentiment": "neutral", "discussionSummary": "Mobile sports game, open to onboarding but non-committal" }],
      "topics": []
    },
    {
      "companyName": "Handy Games",
      "companyType": "developer",
      "contacts": [],
      "overallSentiment": "negative",
      "summary": "Brief conference touchpoint. Handy Games has declined multiple previous free games deal approaches and remains uninterested.",
      "detailedNotes": "More games coming. We've attempted a few times to strike free games deals - not interested.",
      "games": [],
      "topics": [{ "name": "Free Games Program", "category": "commercial", "sentiment": "negative", "feedbackSummary": "Attempted multiple times, not interested", "priority": "low" }]
    }
  ]
}

Return a JSON object matching this exact schema:

{
  "meetings": [
    {
      "companyName": "string — the publisher/developer company interacted with",
      "companyType": "publisher | developer | mixed",
      "companyRegion": "APAC | EMEA | NA | LATAM | Global (infer from context)",
      "contacts": [
        { "name": "string", "title": "string?", "email": "string?" }
      ],
      "meetingDate": "YYYY-MM-DD — omit if unknown",
      "startTime": "HH:MM — omit if unknown",
      "location": "venue/city — omit if unknown",
      "format": "in_person | virtual | hybrid",
      "overallSentiment": "positive | neutral | negative",
      "summary": "1-2 sentence plain-English summary of the interaction and outcome",
      "detailedNotes": "full notes from the document for this interaction — preserve all detail verbatim",
      "followUpActions": "comma-separated follow-up actions — omit if none",
      "games": [
        {
          "title": "game title",
          "egsStatus": "launched | announced | under_discussion | not_coming | unknown",
          "dealStatus": "initial_outreach | in_negotiation | signed | lost",
          "discussionSummary": "what was discussed about this game",
          "sentiment": "positive | neutral | negative",
          "projectedLaunchTiming": "e.g. Q4 2026 — omit if unknown",
          "keyQuotes": "direct quotes from the contact — omit if none"
        }
      ],
      "topics": [
        {
          "name": "platform topic name",
          "category": "commercial | product | tech | marketing | operations",
          "sentiment": "positive | neutral | negative",
          "feedbackSummary": "what was said",
          "requestOrBlocker": "specific request or blocker — omit if none",
          "priority": "low | medium | high"
        }
      ]
    }
  ]
}`;

// Max characters to send to Claude — prevents OOM on very large documents.
// 60k chars ≈ ~15k tokens of input, well within Claude's 1M context window.
const MAX_INPUT_CHARS = 120_000;

async function callClaude(rawText: string): Promise<ParsedReport> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY environment variable is not set");
  const client = new Anthropic({ apiKey });

  // Truncate if needed to avoid OOM
  const truncated = rawText.length > MAX_INPUT_CHARS
    ? rawText.slice(0, MAX_INPUT_CHARS) + "\n\n[Document truncated for processing]"
    : rawText;

  if (rawText.length > MAX_INPUT_CHARS) {
    log(`[parser] document truncated from ${rawText.length} to ${MAX_INPUT_CHARS} chars`, "parser");
  }

  // Use streaming to avoid Anthropic's 10-minute non-streaming timeout
  let text = "";
  const stream = await client.messages.stream({
    model: "claude-sonnet-4-6",
    max_tokens: 64000,
    messages: [
      {
        role: "user",
        content: `Parse the following EGS trip report and extract all structured data:\n\n---\n${truncated}\n---`,
      },
    ],
    system: SYSTEM_PROMPT,
  });
  for await (const chunk of stream) {
    if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
      text += chunk.delta.text;
    }
  }

  // Strip any accidental markdown fences
  const cleaned = text.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();

  // Extract just the JSON object in case Claude added extra text
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  const jsonStr = jsonMatch ? jsonMatch[0] : cleaned;

  try {
    return JSON.parse(jsonStr) as ParsedReport;
  } catch {
    // Response was likely truncated mid-JSON (max_tokens hit).
    // Try to salvage fully-formed meeting objects before the cutoff.
    const salvaged = salvageTruncatedJSON(jsonStr);
    if (salvaged && salvaged.meetings.length > 0) {
      log(`[parser] JSON was truncated — salvaged ${salvaged.meetings.length} complete meeting(s)`, "parser");
      return salvaged;
    }
    throw new Error(`Claude returned invalid JSON: ${cleaned.slice(0, 200)}`);
  }
}

/**
 * When Claude truncates mid-response, extract all complete meeting objects
 * that appear before the cutoff by finding balanced braces.
 */
function salvageTruncatedJSON(raw: string): ParsedReport | null {
  try {
    // Find the meetings array start
    const arrStart = raw.indexOf('"meetings"');
    if (arrStart === -1) return null;
    const bracketStart = raw.indexOf("[", arrStart);
    if (bracketStart === -1) return null;

    const meetings: ParsedMeeting[] = [];
    let i = bracketStart + 1;
    while (i < raw.length) {
      // Skip whitespace between objects
      while (i < raw.length && /\s|,/.test(raw[i])) i++;
      if (raw[i] !== "{") break;

      // Find the end of this meeting object by counting braces
      let depth = 0;
      let j = i;
      while (j < raw.length) {
        if (raw[j] === "{") depth++;
        else if (raw[j] === "}") {
          depth--;
          if (depth === 0) { j++; break; }
        }
        j++;
      }

      if (depth !== 0) break; // incomplete object — stop here

      try {
        const obj = JSON.parse(raw.slice(i, j)) as ParsedMeeting;
        if (obj.companyName) meetings.push(obj);
      } catch {
        break; // malformed object — stop
      }
      i = j;
    }

    return meetings.length > 0 ? { meetings } : null;
  } catch {
    return null;
  }
}

// ─── Helper: find-or-create helpers ──────────────────────────────────────────

async function findOrCreateCompany(
  name: string,
  type?: "publisher" | "developer" | "mixed",
  region?: string
): Promise<number> {
  const all = await storage.getCompanies();
  const existing = all.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing.id;
  const created = await storage.createCompany({
    name,
    companyType: type ?? "developer",
    region: region ?? null,
    notes: null,
  });
  return created.id;
}

async function findOrCreateContact(
  companyId: number,
  name: string,
  title?: string,
  email?: string
): Promise<number> {
  const all = await storage.getContactsByCompany(companyId);
  const existing = all.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing.id;
  const created = await storage.createContact({
    companyId,
    name,
    title: title ?? null,
    email: email ?? null,
    phone: null,
    notes: null,
  });
  return created.id;
}

async function findOrCreateGame(
  title: string,
  companyId: number,
  egsStatus?: string
): Promise<number> {
  const all = await storage.getGames();
  const existing = all.find((g) => g.title.toLowerCase() === title.toLowerCase());
  if (existing) return existing.id;
  const validStatus = ["launched", "announced", "under_discussion", "not_coming", "unknown"];
  const created = await storage.createGame({
    title,
    developerCompanyId: companyId,
    publisherCompanyId: companyId,
    currentEgsStatus: validStatus.includes(egsStatus ?? "") ? (egsStatus as any) : "unknown",
    notes: null,
  });
  return created.id;
}

async function findOrCreateTopic(
  name: string,
  category?: string
): Promise<number> {
  const all = await storage.getPlatformTopics();
  const existing = all.find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing.id;
  const validCats = ["commercial", "product", "tech", "marketing", "operations"];
  const created = await storage.createPlatformTopic({
    name,
    category: validCats.includes(category ?? "") ? (category as any) : "product",
    description: null,
  });
  return created.id;
}

// ─── Main parse function ──────────────────────────────────────────────────────

export interface ParseResult {
  meetingsCreated: number;
  companiesCreated: number;
  contactsCreated: number;
  gamesCreated: number;
  topicsCreated: number;
  errors: string[];
}

export async function parseAndIngest(
  sourceDocumentId: number,
  eventId: number,
  rawText: string
): Promise<ParseResult> {
  const result: ParseResult = {
    meetingsCreated: 0,
    companiesCreated: 0,
    contactsCreated: 0,
    gamesCreated: 0,
    topicsCreated: 0,
    errors: [],
  };

  // Track new company/game/topic counts by checking before vs after
  const companiesBefore = (await storage.getCompanies()).length;
  const gamesBefore = (await storage.getGames()).length;
  const topicsBefore = (await storage.getPlatformTopics()).length;

  let parsed: ParsedReport;
  try {
    parsed = await callClaude(rawText);
  } catch (err: any) {
    result.errors.push(`LLM parse error: ${err.message}`);
    return result;
  }

  if (!parsed.meetings || parsed.meetings.length === 0) {
    // Don't hard-fail — the file uploaded fine, Claude just couldn't find meetings.
    // Returning with 0 meetingsCreated lets routes.ts mark status as "partially_parsed"
    // so the Re-extract button stays visible and the user can retry.
    result.errors.push("AI could not identify any company interactions in this document. Try re-extracting, or check that the document contains meeting/company notes.");
    return result;
  }

  for (const pm of parsed.meetings) {
    try {
      // Company
      const companyId = await findOrCreateCompany(
        pm.companyName,
        pm.companyType,
        pm.companyRegion
      );

      // Meeting
      const meeting = await storage.createMeeting({
        eventId,
        companyId,
        meetingDate: pm.meetingDate ?? null,
        startTime: pm.startTime ?? null,
        endTime: null,
        location: pm.location ?? null,
        format: pm.format ?? "in_person",
        overallSentiment: pm.overallSentiment ?? "neutral",
        summary: pm.summary ?? "",
        detailedNotes: pm.detailedNotes ?? null,
        followUpActions: pm.followUpActions ?? null,
        followUpOwnerUserId: null,
        followUpDueDate: null,
      });
      result.meetingsCreated++;

      // Contacts
      for (const pc of pm.contacts ?? []) {
        const contactId = await findOrCreateContact(
          companyId,
          pc.name,
          pc.title,
          pc.email
        );
        result.contactsCreated++;
        await storage.addMeetingContact({
          meetingId: meeting.id,
          contactId,
          roleInMeeting: "Attendee",
        });
      }

      // Games
      for (const pg of pm.games ?? []) {
        const gameId = await findOrCreateGame(pg.title, companyId, pg.egsStatus);
        result.gamesCreated++;
        const validSentiments = ["positive", "neutral", "negative"];
        const validDealStatuses = ["initial_outreach", "in_negotiation", "signed", "lost"];
        await storage.addMeetingGame({
          meetingId: meeting.id,
          gameId,
          gameSpecificSentiment: validSentiments.includes(pg.sentiment ?? "") ? (pg.sentiment as any) : "neutral",
          discussionSummary: pg.discussionSummary ?? null,
          dealStatus: validDealStatuses.includes(pg.dealStatus ?? "") ? (pg.dealStatus as any) : null,
          projectedLaunchTiming: pg.projectedLaunchTiming ?? null,
          keyQuotes: pg.keyQuotes ?? null,
        });
      }

      // Platform Topics
      for (const pt of pm.topics ?? []) {
        const topicId = await findOrCreateTopic(pt.name, pt.category);
        result.topicsCreated++;
        const validSentiments = ["positive", "neutral", "negative"];
        const validPriorities = ["low", "medium", "high"];
        await storage.addMeetingTopic({
          meetingId: meeting.id,
          topicId,
          sentiment: validSentiments.includes(pt.sentiment ?? "") ? (pt.sentiment as any) : "neutral",
          feedbackSummary: pt.feedbackSummary ?? null,
          requestOrBlocker: pt.requestOrBlocker ?? null,
          priority: validPriorities.includes(pt.priority ?? "") ? (pt.priority as any) : "medium",
        });
      }
    } catch (err: any) {
      result.errors.push(`Meeting "${pm.companyName}": ${err.message}`);
    }
  }

  const companiesAfter = (await storage.getCompanies()).length;
  const gamesAfter = (await storage.getGames()).length;
  const topicsAfter = (await storage.getPlatformTopics()).length;

  result.companiesCreated = companiesAfter - companiesBefore;
  result.gamesCreated = gamesAfter - gamesBefore;
  result.topicsCreated = topicsAfter - topicsBefore;

  log(
    `[parser] doc=${sourceDocumentId} meetings=${result.meetingsCreated} companies=${result.companiesCreated} contacts=${result.contactsCreated} games=${result.gamesCreated} topics=${result.topicsCreated} errors=${result.errors.length}`,
    "parser"
  );

  return result;
}

// ─── Exec Summary generation ──────────────────────────────────────────────────

const EXEC_SUMMARY_PROMPT = `You are an expert analyst summarizing Epic Games Store (EGS) business development trip reports.
Given a list of meetings extracted from a trip report, generate an executive summary.

Return ONLY a valid JSON object with these exact fields (no markdown fences, no extra text):

{
  "macroThemes": "2-4 sentence narrative of the overarching themes and market signals from this event",
  "highlights": "2-4 sentence summary of the most positive outcomes, strong leads, and wins",
  "negatives": "2-4 sentence summary of rejections, blockers, risks, and concerns raised",
  "recommendations": "2-4 sentence list of recommended next steps and priorities for the team",
  "topOpportunities": ["opportunity 1", "opportunity 2", "opportunity 3"],
  "topRisks": ["risk 1", "risk 2", "risk 3"],
  "topActions": [
    { "action": "specific action", "owner": "team or person", "dueDate": "optional date or null" }
  ]
}

Rules:
- Base everything strictly on the meeting data provided.
- topOpportunities and topRisks should be arrays of 2-4 concise strings each.
- topActions should be 2-5 specific, actionable items.
- Omit dueDate from action items if not clearly mentioned in the data.`;

export async function generateExecSummary(
  eventId: number,
  eventName: string
): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log(`[parser] skipping exec summary — no ANTHROPIC_API_KEY`, "parser");
    return;
  }

  try {
    // Gather all meetings with details for this event
    const allMeetings = await storage.getMeetingsByEvent(eventId);
    if (allMeetings.length === 0) {
      log(`[parser] skipping exec summary for event=${eventId} — no meetings`, "parser");
      return;
    }

    // Serialize meeting data for Claude
    const meetingsSummary = allMeetings.map(m => {
      const parts: string[] = [];
      parts.push(`Company: ${(m as any).company?.name ?? "Unknown"}`);
      parts.push(`Sentiment: ${m.overallSentiment}`);
      if (m.summary) parts.push(`Summary: ${m.summary}`);
      if (m.detailedNotes) parts.push(`Notes: ${m.detailedNotes.slice(0, 800)}`);
      if (m.followUpActions) parts.push(`Follow-ups: ${m.followUpActions}`);
      return parts.join(" | ");
    }).join("\n---\n");

    const client = new Anthropic({ apiKey });
    // Use streaming to avoid Anthropic's 10-minute non-streaming timeout
    let text = "";
    const stream = await client.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: EXEC_SUMMARY_PROMPT,
      messages: [
        {
          role: "user",
          content: `Generate an executive summary for the event "${eventName}" based on these ${allMeetings.length} meetings:\n\n${meetingsSummary}`,
        },
      ],
    });
    for await (const chunk of stream) {
      if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
        text += chunk.delta.text;
      }
    }

    const cleaned = text.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? jsonMatch[0] : cleaned;

    const parsed = JSON.parse(jsonStr);

    await storage.upsertExecSummary({
      eventId,
      macroThemes: parsed.macroThemes ?? null,
      highlights: parsed.highlights ?? null,
      negatives: parsed.negatives ?? null,
      recommendations: parsed.recommendations ?? null,
      topOpportunities: parsed.topOpportunities ?? null,
      topRisks: parsed.topRisks ?? null,
      topActions: parsed.topActions ?? null,
    });

    log(`[parser] exec summary generated for event=${eventId}`, "parser");
  } catch (err: any) {
    log(`[parser] exec summary generation failed for event=${eventId}: ${err.message}`, "parser");
  }
}
