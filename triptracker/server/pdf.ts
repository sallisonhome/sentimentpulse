// ─────────────────────────────────────────────────────────────────────────────
// Executive Trip Report PDF generator (Saber Interactive branded, agency-poster feel)
//
// Renders a board-memo quality PDF from an event's executive summary + meetings.
// Uses pdfkit (pure-JS, no headless browser). Fonts are the built-in PDF standard
// Helvetica family, so no font files ship with the bundle.
//
// Public entry point:
//   generateEventExecPdf(eventId): Promise<Buffer>
//
// Data is hydrated through the existing storage getters. A second exported helper
// (renderExecPdfFromData) takes already-hydrated data so the generator can be unit
// tested / rendered offline from JSON fixtures without a live DB.
// ─────────────────────────────────────────────────────────────────────────────

import PDFDocument from "pdfkit";
import { storage } from "./storage";
import type {
  Event,
  EventExecutiveSummary,
  MeetingWithDetails,
  SourceDocument,
} from "@shared/schema";

// ─── Design tokens ───────────────────────────────────────────────────────────

const COLORS = {
  accent: "#B71C1C", // deep crimson — Saber brand-adjacent
  accentDark: "#7F1210", // darker crimson for the cover strip
  ink: "#1A1A1A", // charcoal body ink
  muted: "#5C5C5C", // secondary text
  faint: "#8A8A8A", // very light captions
  hairline: "#E0E0E0", // rules / dividers
  highlightTint: "#E8F5E9", // emerald 50
  highlightInk: "#1B5E20", // emerald 900-ish for tinted text
  highlightBorder: "#C8E6C9",
  negativeTint: "#FFEBEE", // red 50
  negativeInk: "#B71C1C",
  negativeBorder: "#FFCDD2",
  recTint: "#FFF8E1", // amber 50
  recInk: "#8D6E00",
  recBorder: "#FFECB3",
  green: "#2E7D32",
  red: "#C62828",
  amber: "#B7791F",
  white: "#FFFFFF",
  cardBg: "#FAFAFA",
} as const;

const FONTS = {
  regular: "Helvetica",
  bold: "Helvetica-Bold",
  oblique: "Helvetica-Oblique",
} as const;

// US Letter, 0.85in margins
const PAGE = { width: 612, height: 792 } as const;
const MARGIN = 0.85 * 72; // 61.2pt
const CONTENT_W = PAGE.width - MARGIN * 2;

// ─── Types for hydrated input ────────────────────────────────────────────────

export interface ExecPdfData {
  event: Pick<Event, "name" | "startDate" | "endDate" | "city" | "country">;
  summary: EventExecutiveSummary;
  meetings: MeetingWithDetails[];
  meetingCount: number;
  /** Optional friendlier title for the cover (falls back to a derived title). */
  coverTitleOverride?: string;
}

// ─── Text helpers ────────────────────────────────────────────────────────────

/** Strip [M-NNN] meeting citation tokens (single or grouped) from prose. */
export function stripCitations(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/\[(?:\s*M-\d{1,4}\s*[,;]?)+\]/g, "") // grouped [M-001, M-002]
    .replace(/\bM-\d{1,4}\b/g, "") // stray bare tokens
    .replace(/\s{2,}/g, " ") // collapse double spaces left behind
    .replace(/\s+([.,;:])/g, "$1") // fix space before punctuation
    .trim();
}

/** Split a prose paragraph into sentence-ish bullet points. */
function splitToBullets(text: string): string[] {
  const clean = stripCitations(text);
  if (!clean) return [];
  // Prefer explicit line breaks if present
  const byLine = clean
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (byLine.length > 1) return byLine;
  // Otherwise split on sentence boundaries, keeping abbreviations reasonably intact
  const sentences = clean.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || [clean];
  return sentences.map((s) => s.trim()).filter((s) => s.length > 0);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "\u2026";
}

function formatDateRange(startDate?: string | null, endDate?: string | null): string {
  if (!startDate) return "";
  const start = new Date(startDate + "T12:00:00");
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const sM = monthNames[start.getMonth()];
  const sD = start.getDate();
  const sY = start.getFullYear();
  if (!endDate || endDate === startDate) {
    return `${sM} ${sD}, ${sY}`;
  }
  const end = new Date(endDate + "T12:00:00");
  const eM = monthNames[end.getMonth()];
  const eD = end.getDate();
  const eY = end.getFullYear();
  if (sY === eY && start.getMonth() === end.getMonth()) {
    // January 19–20, 2026
    return `${sM} ${sD}\u2013${eD}, ${sY}`;
  }
  if (sY === eY) {
    // January 30 – February 2, 2026
    return `${sM} ${sD} \u2013 ${eM} ${eD}, ${sY}`;
  }
  return `${sM} ${sD}, ${sY} \u2013 ${eM} ${eD}, ${eY}`;
}

function formatShortDate(dateStr?: string | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T12:00:00");
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${m[d.getMonth()]} ${d.getDate()}`;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function execReportFilename(event: { name: string; startDate?: string | null }): string {
  const base = slugify(coverTitle(event.name, event.startDate ?? null)) || "trip";
  return `${base}-trip-report.pdf`;
}

const SENTIMENT_COLORS: Record<string, string> = {
  positive: COLORS.green,
  neutral: COLORS.amber,
  negative: COLORS.red,
};

// ─── Layout engine ───────────────────────────────────────────────────────────
//
// A thin wrapper around a PDFKit document that tracks the current Y cursor,
// draws footers/headers, and provides higher-level "block" primitives that
// automatically page-break. PDFKit's own auto-page-add is disabled (we manage
// pages manually) so footers land correctly and section headers never orphan.

interface Ctx {
  doc: PDFKit.PDFDocument;
  eventName: string;
  pageNo: number; // 1-based; cover is page 1 but shows no number/footer
  contentPages: number; // how many content pages emitted (for "page N of M")
}

class Layout {
  doc: PDFKit.PDFDocument;
  eventName: string;
  y: number;
  pageCount = 0; // total physical pages incl. cover
  contentPageNumbers: number[] = []; // physical page indices that get a footer

  constructor(doc: PDFKit.PDFDocument, eventName: string) {
    this.doc = doc;
    this.eventName = eventName;
    this.y = MARGIN;
  }

  get bottomLimit(): number {
    return PAGE.height - MARGIN;
  }

  /** Start a fresh content page (footer applied later in a second pass). */
  newContentPage() {
    this.doc.addPage();
    // The Layout engine is the sole page-break authority (via bottomLimit).
    // Neutralize pdfkit's own bottom-margin auto-paging so a stray text() call
    // near the page edge never inserts an unexpected blank page.
    this.doc.page.margins.bottom = 0;
    this.pageCount++;
    this.contentPageNumbers.push(this.pageCount);
    this.y = MARGIN;
  }

  /** Ensure at least `needed` vertical space remains; else break to a new page. */
  ensure(needed: number) {
    if (this.y + needed > this.bottomLimit) {
      this.newContentPage();
    }
  }

  moveDown(pts: number) {
    this.y += pts;
  }
}

// ─── Drawing primitives ──────────────────────────────────────────────────────

function drawEyebrow(L: Layout, text: string, color = COLORS.accent) {
  const { doc } = L;
  L.ensure(28);
  doc
    .font(FONTS.bold)
    .fontSize(10)
    .fillColor(color)
    // pdfkit letter spacing via characterSpacing
    .text(text.toUpperCase(), MARGIN, L.y, {
      width: CONTENT_W,
      characterSpacing: 1.1,
    });
  L.y = doc.y + 4;
  // accent underline rule
  doc
    .moveTo(MARGIN, L.y)
    .lineTo(MARGIN + 34, L.y)
    .lineWidth(2)
    .strokeColor(color)
    .stroke();
  L.y += 10;
}

/** Big section title that opens a new page. */
function openSection(L: Layout, title: string, kicker?: string) {
  L.newContentPage();
  const { doc } = L;
  // crimson kicker bar
  doc
    .rect(MARGIN, L.y, 34, 6)
    .fill(COLORS.accent);
  L.y += 16;
  doc
    .font(FONTS.bold)
    .fontSize(22)
    .fillColor(COLORS.ink)
    .text(title, MARGIN, L.y, { width: CONTENT_W });
  L.y = doc.y + 4;
  if (kicker) {
    doc
      .font(FONTS.regular)
      .fontSize(10.5)
      .fillColor(COLORS.muted)
      .text(kicker, MARGIN, L.y, { width: CONTENT_W, lineGap: 2 });
    L.y = doc.y + 4;
  }
  // full-width hairline under the title
  doc
    .moveTo(MARGIN, L.y + 2)
    .lineTo(PAGE.width - MARGIN, L.y + 2)
    .lineWidth(0.75)
    .strokeColor(COLORS.hairline)
    .stroke();
  L.y += 18;
}

/** A body prose paragraph. */
function drawProse(L: Layout, text: string, opts: { size?: number; color?: string } = {}) {
  const clean = stripCitations(text);
  if (!clean) return;
  const size = opts.size ?? 11;
  const color = opts.color ?? COLORS.ink;
  const { doc } = L;
  doc.font(FONTS.regular).fontSize(size).fillColor(color);
  const height = doc.heightOfString(clean, { width: CONTENT_W, lineGap: 4.5 });
  // If it doesn't fit and we're not near the top, break; otherwise let pdfkit
  // flow across pages via manual splitting.
  drawFlowingText(L, clean, { size, color, lineGap: 4.5, font: FONTS.regular });
}

/**
 * Draw text that may need to flow across multiple pages. PDFKit will happily
 * write past the bottom margin, so we measure line-by-line and page-break
 * ourselves at word-wrap boundaries.
 */
function drawFlowingText(
  L: Layout,
  text: string,
  opts: { size: number; color: string; lineGap: number; font: string; indent?: number; width?: number },
) {
  const { doc } = L;
  const width = opts.width ?? CONTENT_W;
  const x = MARGIN + (opts.indent ?? 0);
  doc.font(opts.font).fontSize(opts.size);
  const lineHeight = doc.currentLineHeight() + opts.lineGap;

  // Greedy word wrap
  const words = text.split(/\s+/);
  let line = "";
  const flushLine = (str: string) => {
    L.ensure(lineHeight);
    doc
      .font(opts.font)
      .fontSize(opts.size)
      .fillColor(opts.color)
      .text(str, x, L.y, { width, lineBreak: false });
    L.y += lineHeight;
  };
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (doc.widthOfString(test) > width && line) {
      flushLine(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) flushLine(line);
}

/** A tinted callout box (highlights / negatives / recommendations). */
function drawTintedBlock(
  L: Layout,
  label: string,
  body: string,
  tint: string,
  border: string,
  labelColor: string,
) {
  const clean = stripCitations(body);
  if (!clean) return;
  const { doc } = L;
  const padX = 12;
  const padY = 10;
  const innerW = CONTENT_W - padX * 2;

  // Measure body height at 10.5pt with lineGap
  doc.font(FONTS.regular).fontSize(10.5);
  const bodyH = doc.heightOfString(clean, { width: innerW, lineGap: 3.5 });
  const labelH = 16;
  const boxH = padY * 2 + labelH + bodyH;

  // If the whole block fits, draw as a unit. If not (long), still draw the box
  // top on this page and let text flow — but to keep it clean we page-break the
  // entire block if it doesn't fit and we're past 40% down the page.
  if (L.y + boxH > L.bottomLimit && L.y > MARGIN + 60) {
    L.newContentPage();
  }

  const startY = L.y;
  // Draw background + left accent bar. Guard height to remaining page.
  const drawH = Math.min(boxH, L.bottomLimit - startY);
  doc.roundedRect(MARGIN, startY, CONTENT_W, boxH, 5).fill(tint);
  doc.rect(MARGIN, startY, 3.5, boxH).fill(labelColor);
  doc.roundedRect(MARGIN, startY, CONTENT_W, boxH, 5).lineWidth(0.75).stroke(border);

  // Label
  doc
    .font(FONTS.bold)
    .fontSize(9)
    .fillColor(labelColor)
    .text(label.toUpperCase(), MARGIN + padX, startY + padY, {
      width: innerW,
      characterSpacing: 0.8,
    });
  // Body
  doc
    .font(FONTS.regular)
    .fontSize(10.5)
    .fillColor(COLORS.ink)
    .text(clean, MARGIN + padX, startY + padY + labelH, {
      width: innerW,
      lineGap: 3.5,
    });

  L.y = startY + boxH + 12;
}

/** Numbered list item styled as an agency card (opportunities / issues). */
function drawNumberedCard(
  L: Layout,
  index: number,
  text: string,
  accent: string,
  shape: "circle" | "square",
) {
  const clean = stripCitations(text);
  if (!clean) return;
  const { doc } = L;
  const badgeSize = 22;
  const gap = 12;
  const textX = MARGIN + badgeSize + gap;
  const textW = CONTENT_W - badgeSize - gap;

  doc.font(FONTS.regular).fontSize(11);
  const textH = doc.heightOfString(clean, { width: textW, lineGap: 3 });
  const cardH = Math.max(badgeSize + 6, textH + 14);

  if (L.y + cardH > L.bottomLimit) {
    L.newContentPage();
  }

  const startY = L.y;
  // subtle card background
  doc.roundedRect(MARGIN, startY, CONTENT_W, cardH, 5).fill(COLORS.cardBg);
  doc.roundedRect(MARGIN, startY, CONTENT_W, cardH, 5).lineWidth(0.5).stroke(COLORS.hairline);

  // number badge
  const badgeY = startY + 7;
  if (shape === "circle") {
    doc.circle(MARGIN + 11 + 2, badgeY + badgeSize / 2, badgeSize / 2).fill(accent);
  } else {
    doc.roundedRect(MARGIN + 2, badgeY, badgeSize, badgeSize, 3).fill(accent);
  }
  doc
    .font(FONTS.bold)
    .fontSize(11)
    .fillColor(COLORS.white)
    .text(String(index), MARGIN + 2, badgeY + 5.5, { width: badgeSize + 2, align: "center" });

  // body
  doc
    .font(FONTS.regular)
    .fontSize(11)
    .fillColor(COLORS.ink)
    .text(clean, textX, startY + 7, { width: textW, lineGap: 3 });

  L.y = startY + cardH + 8;
}

/** Amber bullet (Big Ideas). */
function drawBullet(L: Layout, text: string) {
  const clean = stripCitations(text);
  if (!clean) return;
  const { doc } = L;
  const bulletX = MARGIN + 4;
  const textX = MARGIN + 18;
  const textW = CONTENT_W - 18;

  doc.font(FONTS.regular).fontSize(11);
  const textH = doc.heightOfString(clean, { width: textW, lineGap: 3.5 });

  if (L.y + textH > L.bottomLimit) L.newContentPage();

  const startY = L.y;
  // amber diamond marker
  doc.save();
  doc.translate(bulletX + 3, startY + 7).rotate(45);
  doc.rect(-3, -3, 6, 6).fill(COLORS.amber);
  doc.restore();

  doc
    .font(FONTS.regular)
    .fontSize(11)
    .fillColor(COLORS.ink)
    .text(clean, textX, startY, { width: textW, lineGap: 3.5 });
  L.y = doc.y + 9;
}

// ─── Action table ────────────────────────────────────────────────────────────

function drawActionTable(
  L: Layout,
  actions: { action: string; owner: string; dueDate?: string | null }[],
) {
  const { doc } = L;
  // Columns: Action (flex), Owner, Due
  const ownerW = 96;
  const dueW = 96;
  const actionW = CONTENT_W - ownerW - dueW;
  const cellPad = 8;

  // Header row
  const drawHeader = () => {
    L.ensure(28);
    const hY = L.y;
    doc.rect(MARGIN, hY, CONTENT_W, 24).fill(COLORS.ink);
    doc.font(FONTS.bold).fontSize(9).fillColor(COLORS.white);
    doc.text("ACTION", MARGIN + cellPad, hY + 7.5, { width: actionW - cellPad, characterSpacing: 0.5 });
    doc.text("OWNER", MARGIN + actionW + cellPad, hY + 7.5, { width: ownerW - cellPad, characterSpacing: 0.5 });
    doc.text("DUE", MARGIN + actionW + ownerW + cellPad, hY + 7.5, { width: dueW - cellPad, characterSpacing: 0.5 });
    L.y = hY + 24;
  };

  drawHeader();

  actions.forEach((a, i) => {
    const action = stripCitations(a.action);
    const owner = a.owner || "\u2014";
    const due = a.dueDate && a.dueDate.trim() ? a.dueDate : "\u2014";

    doc.font(FONTS.regular).fontSize(10);
    const aH = doc.heightOfString(action, { width: actionW - cellPad * 2, lineGap: 2.5 });
    const oH = doc.heightOfString(owner, { width: ownerW - cellPad * 2, lineGap: 2.5 });
    const dH = doc.heightOfString(due, { width: dueW - cellPad * 2, lineGap: 2.5 });
    const rowH = Math.max(aH, oH, dH) + cellPad * 2;

    if (L.y + rowH > L.bottomLimit) {
      L.newContentPage();
      drawHeader();
    }

    const rowY = L.y;
    // zebra striping
    if (i % 2 === 1) {
      doc.rect(MARGIN, rowY, CONTENT_W, rowH).fill(COLORS.cardBg);
    }
    // cell text
    doc.font(FONTS.regular).fontSize(10).fillColor(COLORS.ink);
    doc.text(action, MARGIN + cellPad, rowY + cellPad, { width: actionW - cellPad * 2, lineGap: 2.5 });
    doc.font(FONTS.bold).fontSize(9.5).fillColor(COLORS.accent);
    doc.text(owner, MARGIN + actionW + cellPad, rowY + cellPad, { width: ownerW - cellPad * 2, lineGap: 2.5 });
    doc.font(FONTS.regular).fontSize(9.5).fillColor(COLORS.muted);
    doc.text(due, MARGIN + actionW + ownerW + cellPad, rowY + cellPad, { width: dueW - cellPad * 2, lineGap: 2.5 });

    // bottom hairline
    doc.moveTo(MARGIN, rowY + rowH).lineTo(PAGE.width - MARGIN, rowY + rowH).lineWidth(0.5).strokeColor(COLORS.hairline).stroke();
    L.y = rowY + rowH;
  });

  // column separators over the whole table would require tracking; skip for a
  // cleaner horizontal-rule table look.
  L.y += 6;
}

// ─── Meeting cards (two-column) ──────────────────────────────────────────────

function meetingTopicsLine(m: MeetingWithDetails): string {
  const topics = (m.topics ?? [])
    .map((t) => t.topic?.name)
    .filter(Boolean) as string[];
  return topics.join(" \u00b7 ");
}

function meetingAttendeesLine(m: MeetingWithDetails): string {
  const names = (m.contacts ?? [])
    .map((c) => c.contact?.name)
    .filter(Boolean) as string[];
  return names.join(", ");
}

function drawMeetingColumns(L: Layout, meetings: MeetingWithDetails[]) {
  const { doc } = L;
  const colGap = 18;
  const colW = (CONTENT_W - colGap) / 2;
  const colX = [MARGIN, MARGIN + colW + colGap];

  // Sort by date then company name
  const sorted = [...meetings].sort((a, b) => {
    const da = a.meetingDate ?? "";
    const db = b.meetingDate ?? "";
    if (da !== db) return da < db ? -1 : 1;
    const na = a.company?.name ?? "";
    const nb = b.company?.name ?? "";
    return na.localeCompare(nb);
  });

  // Column packing: we fill left column then right column per page-height band.
  // Simpler robust approach: alternate columns keeping independent Y cursors,
  // resetting on page break.
  let col = 0;
  let colY = [L.y, L.y];

  const measureCard = (m: MeetingWithDetails): number => {
    const name = m.company?.name ?? "Internal Meeting";
    const attendees = meetingAttendeesLine(m);
    const topics = meetingTopicsLine(m);
    const notes = truncate(stripCitations(m.summary ?? ""), 240);

    let h = 10; // top pad
    doc.font(FONTS.bold).fontSize(10.5);
    h += doc.heightOfString(name, { width: colW - 20 - 10, lineGap: 1 });
    h += 3; // meta line
    doc.fontSize(8);
    if (attendees) h += doc.heightOfString(attendees, { width: colW - 20, lineGap: 1 }) + 2;
    if (topics) h += doc.heightOfString(topics, { width: colW - 20, lineGap: 1 }) + 2;
    if (notes) {
      doc.font(FONTS.regular).fontSize(8.5);
      h += doc.heightOfString(notes, { width: colW - 20, lineGap: 2 }) + 4;
    }
    h += 10; // bottom pad
    return h;
  };

  const drawCard = (m: MeetingWithDetails, x: number, yTop: number, h: number) => {
    const innerX = x + 10;
    const innerW = colW - 20;
    const name = m.company?.name ?? "Internal Meeting";
    const attendees = meetingAttendeesLine(m);
    const topics = meetingTopicsLine(m);
    const notes = truncate(stripCitations(m.summary ?? ""), 240);
    const sent = (m.overallSentiment ?? "neutral").toLowerCase();
    const dotColor = SENTIMENT_COLORS[sent] ?? COLORS.muted;

    // card bg
    doc.roundedRect(x, yTop, colW, h, 4).fill(COLORS.cardBg);
    doc.roundedRect(x, yTop, colW, h, 4).lineWidth(0.5).stroke(COLORS.hairline);

    let cy = yTop + 10;
    // sentiment dot + company name
    doc.circle(innerX + 3, cy + 5, 3.2).fill(dotColor);
    doc
      .font(FONTS.bold)
      .fontSize(10.5)
      .fillColor(COLORS.ink)
      .text(name, innerX + 12, cy, { width: innerW - 12, lineGap: 1 });
    cy = doc.y + 1;

    // meta line: date · sentiment · format
    const metaBits = [
      formatShortDate(m.meetingDate),
      sent.charAt(0).toUpperCase() + sent.slice(1),
      m.format ? m.format.replace(/_/g, " ") : "",
    ].filter(Boolean);
    doc
      .font(FONTS.bold)
      .fontSize(7.5)
      .fillColor(dotColor)
      .text(metaBits.join("  \u00b7  "), innerX, cy, { width: innerW, characterSpacing: 0.3 });
    cy = doc.y + 3;

    if (attendees) {
      doc.font(FONTS.oblique).fontSize(8).fillColor(COLORS.muted)
        .text(attendees, innerX, cy, { width: innerW, lineGap: 1 });
      cy = doc.y + 2;
    }
    if (topics) {
      doc.font(FONTS.bold).fontSize(8).fillColor(COLORS.accent)
        .text(topics, innerX, cy, { width: innerW, lineGap: 1 });
      cy = doc.y + 2;
    }
    if (notes) {
      doc.font(FONTS.regular).fontSize(8.5).fillColor(COLORS.ink)
        .text(notes, innerX, cy, { width: innerW, lineGap: 2 });
    }
  };

  for (const m of sorted) {
    const h = measureCard(m);
    // choose the shorter column
    col = colY[0] <= colY[1] ? 0 : 1;
    // page break if the shorter column can't fit
    if (colY[col] + h > L.bottomLimit) {
      // if the other column has room, try it
      const other = col === 0 ? 1 : 0;
      if (colY[other] + h <= L.bottomLimit) {
        col = other;
      } else {
        L.newContentPage();
        colY = [L.y, L.y];
        col = 0;
      }
    }
    drawCard(m, colX[col], colY[col], h);
    colY[col] += h + 10;
    L.y = Math.max(colY[0], colY[1]);
  }
  L.y = Math.max(colY[0], colY[1]);
}

// ─── Cover page ──────────────────────────────────────────────────────────────

function drawCover(doc: PDFKit.PDFDocument, data: ExecPdfData) {
  const { event, meetingCount } = data;

  // Top brand strip
  const stripH = 54;
  doc.rect(0, 0, PAGE.width, stripH).fill(COLORS.accentDark);
  doc.rect(0, stripH, PAGE.width, 4).fill(COLORS.accent);
  doc
    .font(FONTS.bold)
    .fontSize(12)
    .fillColor(COLORS.white)
    .text("SABER INTERACTIVE", MARGIN, stripH / 2 - 6, {
      characterSpacing: 2.5,
    });

  // Center block
  const centerY = PAGE.height * 0.34;
  // eyebrow
  doc
    .font(FONTS.bold)
    .fontSize(11)
    .fillColor(COLORS.accent)
    .text("EXECUTIVE TRIP REPORT", MARGIN, centerY, {
      width: CONTENT_W,
      characterSpacing: 2,
    });

  // Title — derive a friendlier display title
  const displayTitle = data.coverTitleOverride?.trim() || coverTitle(event.name, event.startDate);
  doc
    .font(FONTS.bold)
    .fontSize(44)
    .fillColor(COLORS.ink)
    .text(displayTitle, MARGIN, centerY + 24, { width: CONTENT_W, lineGap: 2 });

  let y = doc.y + 10;

  // accent rule
  doc.rect(MARGIN, y, 60, 4).fill(COLORS.accent);
  y += 20;

  // date range · city · country
  const dateStr = formatDateRange(event.startDate, event.endDate);
  const locBits = [event.city, event.country].filter(Boolean).join(", ");
  const line1 = [dateStr, locBits].filter(Boolean).join("   \u00b7   ");
  doc
    .font(FONTS.regular)
    .fontSize(14)
    .fillColor(COLORS.muted)
    .text(line1, MARGIN, y, { width: CONTENT_W });
  y = doc.y + 10;

  // metadata line
  doc
    .font(FONTS.regular)
    .fontSize(10.5)
    .fillColor(COLORS.faint)
    .text(`${meetingCount} meetings tracked \u00b7 Executive Trip Report`, MARGIN, y, {
      width: CONTENT_W,
    });

  // Bottom-left generated stamp
  const genDate = new Date();
  const stamp = `Generated ${genDate.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  })}  \u00b7  v1.0`;
  // subtle bottom brand hairline
  doc
    .moveTo(MARGIN, PAGE.height - MARGIN - 14)
    .lineTo(PAGE.width - MARGIN, PAGE.height - MARGIN - 14)
    .lineWidth(0.75)
    .strokeColor(COLORS.hairline)
    .stroke();
  doc
    .font(FONTS.regular)
    .fontSize(8.5)
    .fillColor(COLORS.faint)
    // v1.1: pin the stamp above the bottom margin, keep the flow cursor OFF so
    // pdfkit doesn't auto-add a page after this text. Previously the cursor
    // landed ~2pt past the page boundary and pdfkit inserted a nearly-empty
    // second page between the cover and the executive summary.
    .text(stamp, MARGIN, PAGE.height - MARGIN - 12, {
      width: CONTENT_W,
      lineBreak: false,
      continued: false,
      height: 12,
    });
  // Force the next section to begin on a NEW page rather than continuing
  // wherever the stamp left the cursor.
  doc.flushPages && doc.flushPages();
}

/**
 * Produce a cleaner cover title from the raw event name.
 * Strips leading "Test Report ..."-style prefixes and, when a recognizable event
 * label (e.g. "PGC London") is present, appends the event year.
 */
export function coverTitle(name: string, startDate?: string | null): string {
  let t = (name || "").trim();
  // Strip an internal prefix like "Test Report Using EGS Trip - "
  const dashIdx = t.indexOf(" - ");
  if (dashIdx !== -1 && /report|trip|test|using/i.test(t.slice(0, dashIdx))) {
    t = t.slice(dashIdx + 3).trim();
  }
  // Append the year if not already present and we have a start date
  const year = startDate ? new Date(startDate + "T12:00:00").getFullYear() : null;
  if (year && !new RegExp(`\\b${year}\\b`).test(t)) {
    t = `${t} ${year}`;
  }
  return t || name;
}

// ─── Footers (second pass) ───────────────────────────────────────────────────

function applyFooters(doc: PDFKit.PDFDocument, eventName: string) {
  const range = doc.bufferedPageRange(); // { start, count }
  const total = range.count;
  const contentTotal = total - 1; // exclude cover
  for (let i = range.start; i < range.start + total; i++) {
    if (i === range.start) continue; // cover: no footer
    doc.switchToPage(i);
    // Neutralize the bottom margin so writing footer text near the page edge
    // does not trigger pdfkit's auto page-break (which would insert blank pages).
    doc.page.margins.bottom = 0;
    const contentIndex = i - range.start; // 1-based content page number
    const footerY = PAGE.height - MARGIN + 14;
    // hairline
    doc
      .moveTo(MARGIN, footerY - 6)
      .lineTo(PAGE.width - MARGIN, footerY - 6)
      .lineWidth(0.5)
      .strokeColor(COLORS.hairline)
      .stroke();
    // left: event name (truncated)
    doc
      .font(FONTS.regular)
      .fontSize(8)
      .fillColor(COLORS.faint)
      .text(truncate(eventName, 60), MARGIN, footerY, {
        width: CONTENT_W * 0.7,
        lineBreak: false,
      });
    // right: page N of M
    doc
      .font(FONTS.regular)
      .fontSize(8)
      .fillColor(COLORS.faint)
      .text(`Page ${contentIndex} of ${contentTotal}`, MARGIN + CONTENT_W * 0.7, footerY, {
        width: CONTENT_W * 0.3,
        align: "right",
        lineBreak: false,
      });
  }
}

// ─── Issue merge logic (topRisks + negatives, deduped) ───────────────────────

function buildIssues(summary: EventExecutiveSummary): string[] {
  const risks = (summary.topRisks ?? []).map((r) => stripCitations(r)).filter(Boolean);
  const negativesProse = stripCitations(summary.negatives ?? "");
  const issues = [...risks];

  if (negativesProse) {
    // Split negatives into sentences and add ones not already substantially
    // covered by an existing risk (naive token-overlap dedupe).
    const sentences = splitToBullets(negativesProse);
    for (const s of sentences) {
      if (!s || s.length < 25) continue;
      const overlap = risks.some((r) => tokenOverlap(r, s) > 0.4);
      if (!overlap) issues.push(s);
    }
  }
  return issues;
}

function tokenOverlap(a: string, b: string): number {
  const norm = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 3),
    );
  const sa = norm(a);
  const sb = norm(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let common = 0;
  Array.from(sa).forEach((w) => {
    if (sb.has(w)) common++;
  });
  return common / Math.min(sa.size, sb.size);
}

// ─── Main render ─────────────────────────────────────────────────────────────

export function renderExecPdfFromData(data: ExecPdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "LETTER",
        margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
        bufferPages: true, // needed for the footer second pass
        autoFirstPage: false,
        info: {
          Title: `${data.event.name} — Executive Trip Report`,
          Author: "Saber Interactive — Trip Tracker",
          Subject: "Executive Trip Report",
        },
      });

      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const { event, summary, meetings } = data;

      // ── Page 1: Cover ──
      doc.addPage();
      // v1.1: neutralize pdfkit's auto-paging on the cover so the bottom
      // 'Generated ... v1.0' stamp cannot overflow the page and trigger a
      // spurious blank page 2. (Same treatment newContentPage applies to
      // subsequent content pages.)
      doc.page.margins.bottom = 0;
      drawCover(doc, data);

      const L = new Layout(doc, event.name);
      L.pageCount = 1; // cover counted

      // ── Executive Summary (macro themes prose) ──
      openSection(L, "Executive Summary", "Strategic read-out from the event");
      if (summary.macroThemes) {
        drawEyebrow(L, "Macro Themes");
        drawProse(L, summary.macroThemes);
        L.moveDown(8);
      }

      // ── Highlights / Key Negatives / Recommendations — on their own page ──
      // v1.2 (user request): the three tinted callouts share a dedicated page
      // so the amber Recommendations block never orphans onto a page by itself.
      // Only open the new page if at least one of the three has content.
      const hasCallout =
        !!summary.highlights || !!summary.negatives || !!summary.recommendations;
      if (hasCallout) {
        openSection(
          L,
          "Highlights, Negatives & Recommendations",
          "What worked, what didn't, and what to do about it",
        );
        if (summary.highlights) {
          drawTintedBlock(
            L,
            "Highlights",
            summary.highlights,
            COLORS.highlightTint,
            COLORS.highlightBorder,
            COLORS.green,
          );
        }
        if (summary.negatives) {
          drawTintedBlock(
            L,
            "Key Negatives",
            summary.negatives,
            COLORS.negativeTint,
            COLORS.negativeBorder,
            COLORS.red,
          );
        }
        if (summary.recommendations) {
          drawTintedBlock(
            L,
            "Recommendations",
            summary.recommendations,
            COLORS.recTint,
            COLORS.recBorder,
            COLORS.amber,
          );
        }
      }

      // ── Key Opportunities ──
      const opps = (summary.topOpportunities ?? []).filter(Boolean);
      if (opps.length) {
        openSection(L, "Key Opportunities", "Highest-value openings surfaced at the event");
        opps.forEach((o, i) => drawNumberedCard(L, i + 1, o, COLORS.green, "circle"));
      }

      // ── Key Issues (topRisks + negatives merged) ──
      const issues = buildIssues(summary);
      if (issues.length) {
        openSection(L, "Key Issues", "Risks and blockers requiring attention");
        issues.forEach((r, i) => drawNumberedCard(L, i + 1, r, COLORS.red, "square"));
      }

      // ── Big Ideas (recommendations → bullets) ──
      const bigIdeas = summary.recommendations ? splitToBullets(summary.recommendations) : [];
      if (bigIdeas.length) {
        openSection(L, "Big Ideas", "Strategic moves recommended out of the event");
        bigIdeas.forEach((b) => drawBullet(L, b));
      }

      // ── Action Items ──
      const actions = summary.topActions ?? [];
      if (actions.length) {
        openSection(L, "Action Items", "Owned next steps with due dates");
        drawActionTable(L, actions);
      }

      // ── Per-Meeting Summaries ──
      if (meetings && meetings.length) {
        openSection(
          L,
          "Per-Meeting Summaries",
          `${meetings.length} meetings tracked at the event`,
        );
        drawMeetingColumns(L, meetings);
      }

      // ── Footers ──
      applyFooters(doc, event.name);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Hydrate an event's data from storage and render the executive PDF.
 * Throws if the event or its executive summary does not exist.
 */
export async function generateEventExecPdf(eventId: number): Promise<Buffer> {
  const event = await storage.getEventById(eventId);
  if (!event) {
    throw Object.assign(new Error(`Event ${eventId} not found`), { statusCode: 404 });
  }
  const summary = await storage.getExecSummaryByEvent(eventId);
  if (!summary) {
    throw Object.assign(new Error(`No executive summary for event ${eventId}`), {
      statusCode: 404,
    });
  }
  const meetings = await storage.getMeetingsByEvent(eventId);

  return renderExecPdfFromData({
    event,
    summary,
    meetings,
    meetingCount: meetings.length,
  });
}
