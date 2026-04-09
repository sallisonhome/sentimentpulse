import type { Express } from "express";
import type { Server } from "http";
import multer from "multer";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import { storage } from "./storage";
import { parseAndIngest, generateExecSummary, type ParseResult } from "./parser";
import { log } from "./log";
import {
  insertEventSchema, insertMeetingSchema, insertCompanySchema,
  insertContactSchema, insertGameSchema, insertMeetingGameSchema,
  insertPlatformTopicSchema, insertMeetingTopicSchema,
  insertEventExecutiveSummarySchema, insertSourceDocumentSchema,
} from "@shared/schema";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Convert empty strings to null for all fields — prevents DB type errors on optional fields
function nullifyEmpty(obj: Record<string, any>): Record<string, any> {
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, v === "" ? null : v])
  );
}

/**
 * Determine the correct parsingStatus after an AI extraction run.
 * - "success"          → meetings were created (even if some minor errors)
 * - "partially_parsed" → no meetings created but no hard crash (Claude ran, found nothing;
 *                        keeps Re-extract button visible so the user can retry)
 * - "failed"           → should only be set on catch (Claude/API crash), never here
 */
function resolveParseStatus(
  result: ParseResult
): "success" | "partially_parsed" {
  return result.meetingsCreated > 0 ? "success" : "partially_parsed";
}

/**
 * Build the human-readable parsing log line shown on the source-doc card.
 */
function buildParseLog(result: ParseResult): string {
  const parts = [
    `AI extraction complete.`,
    `Meetings: ${result.meetingsCreated}`,
    `Companies: ${result.companiesCreated}`,
    `Contacts: ${result.contactsCreated}`,
    `Games: ${result.gamesCreated}`,
    `Topics: ${result.topicsCreated}`,
    ...(result.errors.length ? [`Errors: ${result.errors.join("; ")}`] : []),
  ];
  return parts.join(" \u00b7 ");
}

/**
 * Trigger exec summary generation after a parse.
 * Always checks the event's total meeting count — not just what this run created —
 * so a re-extract that finds 0 NEW meetings still regenerates the summary if
 * the event already has meetings from a prior upload.
 */
async function maybeGenerateExecSummary(eventId: number): Promise<void> {
  try {
    const evt = await storage.getEventById(eventId);
    if (!evt) return;
    const allMeetings = await storage.getMeetingsByEvent(eventId);
    if (allMeetings.length > 0) {
      await generateExecSummary(eventId, evt.name);
    }
  } catch (err: any) {
    log(`[routes] exec summary trigger failed for event=${eventId}: ${err.message}`, "express");
  }
}

export function registerRoutes(httpServer: Server, app: Express): Server {

  // ── Users ──
  app.get("/api/users", async (_req, res) => {
    const users = await storage.getUsers();
    res.json(users);
  });

  // ── Events ──
  app.get("/api/events", async (_req, res) => {
    const events = await storage.getEvents();
    res.json(events);
  });

  app.get("/api/events/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    const event = await storage.getEventWithStats(id);
    if (!event) return res.status(404).json({ message: "Event not found" });
    res.json(event);
  });

  app.post("/api/events", async (req, res) => {
    const parsed = insertEventSchema.safeParse(nullifyEmpty(req.body));
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const event = await storage.createEvent(parsed.data);
    res.status(201).json(event);
  });

  app.patch("/api/events/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    const event = await storage.updateEvent(id, req.body);
    res.json(event);
  });

  app.delete("/api/events/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    await storage.deleteEvent(id);
    res.status(204).send();
  });

  // ── Event Attendees ──
  app.get("/api/events/:id/attendees", async (req, res) => {
    const id = parseInt(req.params.id);
    const attendees = await storage.getEventAttendees(id);
    res.json(attendees);
  });

  // ── Meetings ──
  app.get("/api/events/:eventId/meetings", async (req, res) => {
    const eventId = parseInt(req.params.eventId);
    const meetings = await storage.getMeetingsByEvent(eventId);
    res.json(meetings);
  });

  app.get("/api/meetings/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    const meeting = await storage.getMeetingById(id);
    if (!meeting) return res.status(404).json({ message: "Meeting not found" });
    res.json(meeting);
  });

  app.post("/api/meetings", async (req, res) => {
    const parsed = insertMeetingSchema.safeParse(nullifyEmpty(req.body));
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const meeting = await storage.createMeeting(parsed.data);
    res.status(201).json(meeting);
  });

  app.patch("/api/meetings/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    const meeting = await storage.updateMeeting(id, req.body);
    res.json(meeting);
  });

  app.delete("/api/meetings/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    await storage.deleteMeeting(id);
    res.status(204).send();
  });

  // ── Companies ──
  app.get("/api/companies", async (_req, res) => {
    const companies = await storage.getCompanies();
    res.json(companies);
  });

  app.post("/api/companies", async (req, res) => {
    const parsed = insertCompanySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const company = await storage.createCompany(parsed.data);
    res.status(201).json(company);
  });

  // ── Contacts ──
  app.get("/api/companies/:companyId/contacts", async (req, res) => {
    const companyId = parseInt(req.params.companyId);
    const contacts = await storage.getContactsByCompany(companyId);
    res.json(contacts);
  });

  app.post("/api/contacts", async (req, res) => {
    const parsed = insertContactSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const contact = await storage.createContact(parsed.data);
    res.status(201).json(contact);
  });

  // ── Games ──
  app.get("/api/games", async (_req, res) => {
    const games = await storage.getGames();
    res.json(games);
  });

  app.get("/api/games/touchpoints", async (_req, res) => {
    const games = await storage.getGamesWithTouchpoints();
    res.json(games);
  });

  app.post("/api/games", async (req, res) => {
    const parsed = insertGameSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const game = await storage.createGame(parsed.data);
    res.status(201).json(game);
  });

  app.patch("/api/games/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    const game = await storage.updateGame(id, req.body);
    res.json(game);
  });

  // ── Meeting Games ──
  app.post("/api/meetings/:meetingId/games", async (req, res) => {
    const meetingId = parseInt(req.params.meetingId);
    const parsed = insertMeetingGameSchema.safeParse({ ...req.body, meetingId });
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const mg = await storage.addMeetingGame(parsed.data);
    res.status(201).json(mg);
  });

  app.delete("/api/meeting-games/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    await storage.removeMeetingGame(id);
    res.status(204).send();
  });

  // ── Platform Topics ──
  app.get("/api/platform-topics", async (_req, res) => {
    const topics = await storage.getPlatformTopics();
    res.json(topics);
  });

  app.get("/api/platform-topics/stats", async (_req, res) => {
    const topics = await storage.getTopicsWithStats();
    res.json(topics);
  });

  // All meeting-topic entries for a specific topic (drill-down)
  app.get("/api/platform-topics/:id/entries", async (req, res) => {
    const topicId = parseInt(req.params.id);
    const entries = await storage.getMeetingTopicEntries(topicId);
    res.json(entries);
  });

  // All meeting-game entries for a specific game (drill-down)
  app.get("/api/games/:id/entries", async (req, res) => {
    const gameId = parseInt(req.params.id);
    const entries = await storage.getMeetingGameEntries(gameId);
    res.json(entries);
  });

  app.post("/api/platform-topics", async (req, res) => {
    const parsed = insertPlatformTopicSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const topic = await storage.createPlatformTopic(parsed.data);
    res.status(201).json(topic);
  });

  // ── Meeting Topics ──
  app.post("/api/meetings/:meetingId/topics", async (req, res) => {
    const meetingId = parseInt(req.params.meetingId);
    const parsed = insertMeetingTopicSchema.safeParse({ ...req.body, meetingId });
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const mt = await storage.addMeetingTopic(parsed.data);
    res.status(201).json(mt);
  });

  app.delete("/api/meeting-topics/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    await storage.removeMeetingTopic(id);
    res.status(204).send();
  });

  // ── Executive Summaries ──
  app.get("/api/events/:eventId/executive-summary", async (req, res) => {
    const eventId = parseInt(req.params.eventId);
    const summary = await storage.getExecSummaryByEvent(eventId);
    if (!summary) return res.status(404).json({ message: "No executive summary found" });
    res.json(summary);
  });

  app.put("/api/events/:eventId/executive-summary", async (req, res) => {
    const eventId = parseInt(req.params.eventId);
    const parsed = insertEventExecutiveSummarySchema.safeParse({ ...req.body, eventId });
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const summary = await storage.upsertExecSummary(parsed.data);
    res.json(summary);
  });

  // ── Global Summary ──
  app.get("/api/global-summary", async (_req, res) => {
    const summary = await storage.getLatestGlobalSummary();
    res.json(summary ?? null);
  });

  // ── Source Documents ──
  app.get("/api/events/:eventId/source-documents", async (req, res) => {
    const eventId = parseInt(req.params.eventId);
    const docs = await storage.getSourceDocumentsByEvent(eventId);
    res.json(docs);
  });

  app.post("/api/source-documents", async (req, res) => {
    const parsed = insertSourceDocumentSchema.safeParse(nullifyEmpty(req.body));
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const doc = await storage.createSourceDocument(parsed.data);
    const rawText = parsed.data.rawText ?? "";
    const updated = await storage.updateSourceDocument(doc.id, {
      parsingStatus: rawText ? "pending" : "success",
      parsingLog: rawText
        ? "AI extraction queued..."
        : `Ingested at ${new Date().toISOString()}. Source type: ${doc.sourceType}.`,
      rawTextExcerpt: (rawText || parsed.data.rawTextExcerpt || "").slice(0, 400),
    });
    // Auto-parse if there's text
    if (rawText) {
      (async () => {
        try {
          const result = await parseAndIngest(doc.id, doc.eventId, rawText);
          await storage.updateSourceDocument(doc.id, {
            parsingStatus: resolveParseStatus(result),
            parsingLog: buildParseLog(result),
          });
          await maybeGenerateExecSummary(doc.eventId);
        } catch (err: any) {
          await storage.updateSourceDocument(doc.id, {
            parsingStatus: "failed",
            parsingLog: `AI extraction failed: ${err.message}`,
          });
        }
      })();
    }
    res.status(201).json(updated);
  });

  // ── Google Doc fetch endpoint ──
  app.post("/api/fetch-google-doc", async (req, res) => {
    try {
      const { url, eventId, uploadedByUserId = 1 } = req.body;
      if (!url || !eventId) return res.status(400).json({ message: "url and eventId are required" });

      // Convert any Google Docs URL to plain text export URL
      const docIdMatch = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
      if (!docIdMatch) return res.status(400).json({ message: "Could not extract Google Doc ID from URL" });
      const docId = docIdMatch[1];
      const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;

      const response = await fetch(exportUrl);
      if (!response.ok) {
        if (response.status === 403 || response.status === 401) {
          return res.status(400).json({ message: "Document is not publicly shared. Set sharing to 'Anyone with the link can view' and try again." });
        }
        return res.status(400).json({ message: `Failed to fetch document: ${response.statusText}` });
      }

      const rawText = await response.text();
      const doc = await storage.createSourceDocument({
        eventId: parseInt(eventId),
        sourceType: "google_doc",
        externalUrl: url,
        uploadedByUserId: parseInt(uploadedByUserId),
        parsingStatus: "pending",
        parsingLog: `Google Doc fetched. ${rawText.length} characters. AI extraction queued...`,
        rawText,
        rawTextExcerpt: rawText.slice(0, 400),
      });

      // Auto-parse
      const eid = parseInt(eventId);
      ;(async () => {
        try {
          const result = await parseAndIngest(doc.id, eid, rawText);
          await storage.updateSourceDocument(doc.id, {
            parsingStatus: resolveParseStatus(result),
            parsingLog: buildParseLog(result),
          });
          await maybeGenerateExecSummary(eid);
        } catch (err: any) {
          await storage.updateSourceDocument(doc.id, {
            parsingStatus: "failed",
            parsingLog: `AI extraction failed: ${err.message}`,
          });
        }
      })();

      res.status(201).json({ ...doc, characterCount: rawText.length });
    } catch (err: any) {
      console.error("Google Doc fetch error:", err);
      res.status(500).json({ message: err.message ?? "Failed to fetch Google Doc" });
    }
  });

  // ── File upload endpoint (Word / PDF / text) ──
  app.post("/api/upload-document", upload.single("file"), async (req, res) => {
    try {
      const file = req.file;
      const eventId = parseInt(req.body.eventId);
      const uploadedByUserId = req.body.uploadedByUserId ? parseInt(req.body.uploadedByUserId) : 1;

      if (!file) return res.status(400).json({ message: "No file provided" });
      if (!eventId) return res.status(400).json({ message: "eventId is required" });

      const isWord = file.originalname.match(/\.docx?$/i);
      const isPdf = file.originalname.match(/\.pdf$/i);
      const isText = file.originalname.match(/\.(txt|md)$/i);

      let rawText = "";
      let parsingLog = "";
      let parsingStatus: "success" | "partially_parsed" | "failed" = "success";
      const sourceType = isWord ? "word_file" : isPdf ? "pdf_file" : "other";

      if (isWord) {
        try {
          const result = await mammoth.extractRawText({ buffer: file.buffer });
          rawText = result.value;
          parsingLog = `Word document extracted successfully. ${rawText.length} characters. Warnings: ${result.messages.length}`;
        } catch (err: any) {
          parsingStatus = "partially_parsed";
          parsingLog = `Word extraction failed: ${err.message}`;
        }
      } else if (isText) {
        rawText = file.buffer.toString("utf-8");
        parsingLog = `Plain text file read. ${rawText.length} characters.`;
      } else if (isPdf) {
        try {
          const result = await pdfParse(file.buffer);
          rawText = result.text;
          parsingLog = `PDF extracted successfully. ${rawText.length} characters across ${result.numpages} page(s).`;
        } catch (err: any) {
          parsingStatus = "partially_parsed";
          parsingLog = `PDF extraction failed: ${err.message}. Try pasting the text manually.`;
        }
      } else {
        parsingStatus = "partially_parsed";
        parsingLog = `Unknown file type: ${file.mimetype}. Stored metadata only.`;
      }

      const doc = await storage.createSourceDocument({
        eventId,
        sourceType,
        originalFileName: file.originalname,
        uploadedByUserId,
        parsingStatus: rawText ? "pending" : parsingStatus,
        parsingLog: rawText ? `${parsingLog} AI extraction queued...` : parsingLog,
        rawText: rawText || null,
        rawTextExcerpt: rawText.slice(0, 400) || `[${file.originalname} — ${(file.size / 1024).toFixed(0)} KB]`,
      });

      // Auto-parse extracted text
      if (rawText) {
        ;(async () => {
          try {
            const result = await parseAndIngest(doc.id, eventId, rawText);
            await storage.updateSourceDocument(doc.id, {
              parsingStatus: resolveParseStatus(result),
              parsingLog: buildParseLog(result),
            });
            await maybeGenerateExecSummary(eventId);
          } catch (err: any) {
            await storage.updateSourceDocument(doc.id, {
              parsingStatus: "failed",
              parsingLog: `AI extraction failed: ${err.message}`,
            });
          }
        })();
      }

      res.status(201).json({ ...doc, characterCount: rawText.length });
    } catch (err: any) {
      console.error("Upload error:", err);
      res.status(500).json({ message: err.message ?? "Upload failed" });
    }
  });

  app.patch("/api/source-documents/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    const doc = await storage.updateSourceDocument(id, req.body);
    res.json(doc);
  });

  app.delete("/api/source-documents/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      log(`[routes] DELETE source-document id=${id}`, "express");
      await storage.deleteSourceDocument(id);
      res.status(204).send();
    } catch (err: any) {
      console.error("Delete source document error:", err);
      res.status(500).json({ message: err.message ?? "Delete failed" });
    }
  });

  // ── AI Parse endpoint — triggers LLM extraction on a source document ──
  app.post("/api/source-documents/:id/parse", async (req, res) => {
    const id = parseInt(req.params.id);
    const doc = await storage.getSourceDocumentById(id);
    if (!doc) return res.status(404).json({ message: "Document not found" });
    if (!doc.rawText) return res.status(400).json({ message: "Document has no raw text to parse" });

    // Mark as pending immediately
    await storage.updateSourceDocument(id, {
      parsingStatus: "pending",
      parsingLog: "AI extraction in progress...",
    });

    // Run async so client gets immediate 202 response
    (async () => {
      try {
        const result = await parseAndIngest(id, doc.eventId, doc.rawText!);
        await storage.updateSourceDocument(id, {
          parsingStatus: resolveParseStatus(result),
          parsingLog: buildParseLog(result),
        });
        await maybeGenerateExecSummary(doc.eventId);
      } catch (err: any) {
        log(`[parse] error doc=${id}: ${err.message}`, "parser");
        await storage.updateSourceDocument(id, {
          parsingStatus: "failed",
          parsingLog: `AI extraction failed: ${err.message}`,
        });
      }
    })();

    res.status(202).json({ message: "Parsing started", documentId: id });
  });

  // ── Dashboard aggregates ──
  app.get("/api/dashboard", async (_req, res) => {
    const [gamesWithTP, topicsWithStats, events] = await Promise.all([
      storage.getGamesWithTouchpoints(),
      storage.getTopicsWithStats(),
      storage.getEvents(),
    ]);
    res.json({ gamesWithTouchpoints: gamesWithTP, topicsWithStats, events });
  });

  return httpServer;
}
