/**
 * Inbound email handler for SignalPulse.
 *
 * Ties into Resend's Inbound (receiving) webhook:
 *   https://resend.com/docs/dashboard/receiving/introduction
 *
 * v3.21 (2026-08-15): initial implementation.
 *
 * Flow
 * ----
 * 1. Resend receives an email to howmanyareplaying.com (or any configured
 *    receiving domain) → parses it → POSTs the JSON payload to our webhook
 *    /api/webhooks/resend-inbound.
 * 2. We verify the Svix signature (Resend uses Svix under the hood), store
 *    the message + attachments in SQLite, and:
 *    (a) Optionally forward the message via Resend to a personal inbox
 *        (steve.allison.home@gmail.com by default) so you can also read /
 *        reply from Gmail natively.
 *    (b) Return HTTP 200. The admin UI polls /api/inbound/messages.
 *
 * Threading
 * ---------
 * We compute a stable thread_key for every inbound message so a Rideshare
 * user's back-and-forth ends up grouped. Priority order:
 *   1. If the inbound message's In-Reply-To or References header matches a
 *      message_id we've already stored → use that stored row's thread_key.
 *   2. Else the message starts a new thread; thread_key = its own message_id.
 *
 * Reply
 * -----
 * When an admin composes a reply via /api/inbound/messages/:id/reply, we
 * call Resend's /emails endpoint with:
 *   In-Reply-To: <original message_id>
 *   References:  <original References + original message_id>
 *   Subject:     Re: <original subject>
 * so the reply lands in the same thread in the user's inbox.
 *
 * The reply is also stored as an outbound row in inbound_messages with
 * direction='outbound' and the same thread_key, so the admin UI shows the
 * full conversation.
 */
import type { Request, Response } from "express";
import crypto from "node:crypto";
import type { Storage } from "./storage";

const RESEND_URL = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 30_000;
const RESEND_USER_AGENT =
  "SignalPulse/1.0 (+https://github.com/sallisonhome/sentimentpulse)";

// ─── Types ────────────────────────────────────────────────────────────────

/** Shape of a Resend `email.received` webhook payload. */
interface ResendInboundEvent {
  type?: string;
  data?: {
    email_id?: string;
    message_id?: string;
    subject?: string;
    from?: string;
    to?: string[];
    cc?: string[];
    text?: string;
    html?: string;
    headers?: Record<string, string>;
    attachments?: Array<{
      filename?: string;
      content_type?: string;
      size?: number;
      url?: string;
    }>;
    created_at?: string;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Extract the bare email from a "Name <email@x>" string. */
function extractBareEmail(addr: string | undefined): string {
  if (!addr) return "";
  const m = addr.match(/<([^>]+)>/);
  return (m ? m[1] : addr).trim().toLowerCase();
}

/** Get the first ~200 chars of plain text for the inbox list snippet. */
function makeSnippet(text: string): string {
  if (!text) return "";
  // Strip common quoted-reply markers so the snippet shows fresh content
  const stripped = text
    .split(/\n(On .+ wrote:|-----Original Message-----)/i)[0]
    .replace(/^>.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length <= 200 ? stripped : stripped.slice(0, 197) + "…";
}

/** Compute the stable thread_key for a new inbound message. */
function computeThreadKey(
  storage: Storage,
  ownMessageId: string,
  inReplyTo: string | undefined,
  referencesHdr: string | undefined,
): string {
  // Prefer In-Reply-To if we've already stored that message.
  const candidates: string[] = [];
  if (inReplyTo) candidates.push(inReplyTo.trim());
  if (referencesHdr) {
    for (const r of referencesHdr.split(/\s+/)) {
      const trimmed = r.trim();
      if (trimmed) candidates.push(trimmed);
    }
  }
  for (const cand of candidates) {
    const parent = storage.getInboundByMessageId(cand);
    if (parent) return parent.thread_key;
  }
  // New thread — its own message_id becomes the thread_key.
  return ownMessageId;
}

/**
 * Verify the Svix (Resend) webhook signature. Resend sends three headers:
 *   svix-id, svix-timestamp, svix-signature
 * The signed payload is `${id}.${timestamp}.${rawBody}` and we compare
 * against the base64 HMAC-SHA256 in svix-signature (which is space-separated
 * versioned signatures like "v1,<sig1> v1,<sig2>").
 */
function verifySvixSignature(
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): boolean {
  if (!secret) return true; // Verification disabled when no secret is set.
  const id = String(headers["svix-id"] || headers["Svix-Id"] || "");
  const ts = String(headers["svix-timestamp"] || headers["Svix-Timestamp"] || "");
  const sig = String(headers["svix-signature"] || headers["Svix-Signature"] || "");
  if (!id || !ts || !sig) return false;

  // The signing secret from Resend/Svix is prefixed "whsec_"; the actual
  // HMAC key is base64-decoded from the rest.
  const key = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const keyBytes = Buffer.from(key, "base64");

  const toSign = `${id}.${ts}.${rawBody}`;
  const expected = crypto
    .createHmac("sha256", keyBytes)
    .update(toSign)
    .digest("base64");

  // svix-signature may contain multiple space-separated "v1,<sig>" entries.
  const provided = sig.split(" ").map((p) => p.split(",")[1]).filter(Boolean);
  return provided.some((p) =>
    crypto.timingSafeEqual(
      Buffer.from(p, "utf-8"),
      Buffer.from(expected, "utf-8"),
    ),
  );
}

// ─── Resend send helper ───────────────────────────────────────────────────

interface SendArgs {
  apiKey: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

async function sendViaResend(
  args: SendArgs,
): Promise<{ ok: boolean; status: number; body: string; messageId?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);
  try {
    const payload: Record<string, unknown> = {
      from: args.from,
      to: args.to,
      subject: args.subject,
    };
    if (args.cc && args.cc.length > 0) payload.cc = args.cc;
    if (args.html) payload.html = args.html;
    if (args.text) payload.text = args.text;
    if (args.replyTo) payload.reply_to = args.replyTo;
    if (args.headers) payload.headers = args.headers;

    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": RESEND_USER_AGENT,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await res.text();
    let messageId: string | undefined;
    try {
      const j = JSON.parse(body);
      // Resend returns { id: "<uuid>" } on success; the outbound
      // Message-ID header is deterministic based on that id.
      messageId = j?.id;
    } catch {
      /* not JSON */
    }
    return { ok: res.ok, status: res.status, body, messageId };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Webhook handler ──────────────────────────────────────────────────────

/**
 * POST /api/webhooks/resend-inbound
 *
 * The router must mount this with `express.raw({ type: 'application/json' })`
 * so the raw body is available on `req.body` (Buffer) for signature
 * verification. This handler decodes the buffer itself.
 */
export async function handleResendInboundWebhook(
  req: Request,
  res: Response,
  storage: Storage,
): Promise<void> {
  const rawBuf =
    Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
  const rawBody = rawBuf.toString("utf-8");

  const secret = storage.getSetting("resend_inbound_signing_secret")?.value || "";
  if (
    !verifySvixSignature(
      rawBody,
      req.headers as Record<string, string | string[] | undefined>,
      secret,
    )
  ) {
    res.status(401).json({ error: "invalid_signature" });
    return;
  }

  let event: ResendInboundEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    res.status(400).json({ error: "invalid_json" });
    return;
  }

  if (event.type !== "email.received" || !event.data) {
    // Not an inbound message — ack and ignore.
    res.status(200).json({ ok: true, ignored: event.type });
    return;
  }

  const d = event.data;
  const messageId = d.message_id || "";
  const emailId = d.email_id || "";

  if (!messageId || !emailId) {
    res.status(400).json({ error: "missing_message_id_or_email_id" });
    return;
  }

  // Dedup: if we've already seen this email_id, ack and skip.
  if (storage.getInboundByResendEmailId(emailId)) {
    res.status(200).json({ ok: true, dedup: true });
    return;
  }

  const headers = d.headers || {};
  const inReplyTo = headers["in-reply-to"] || headers["In-Reply-To"];
  const referencesHdr = headers["references"] || headers["References"];
  const threadKey = computeThreadKey(storage, messageId, inReplyTo, referencesHdr);

  const bodyText = d.text || "";
  const bodyHtml = d.html || "";
  const fromAddr = d.from || "";
  const fromEmail = extractBareEmail(fromAddr);
  const to = d.to || [];
  const cc = d.cc || [];
  const subject = d.subject || "(no subject)";
  const nowIso = new Date().toISOString();
  const receivedAt = d.created_at || nowIso;

  const stored = storage.insertInboundMessage({
    resend_email_id: emailId,
    message_id: messageId,
    in_reply_to: inReplyTo || null,
    references_hdr: referencesHdr || null,
    thread_key: threadKey,
    subject,
    from_addr: fromAddr,
    from_email: fromEmail,
    to_addrs: JSON.stringify(to),
    cc_addrs: JSON.stringify(cc),
    body_text: bodyText,
    body_html: bodyHtml,
    snippet: makeSnippet(bodyText || bodyHtml.replace(/<[^>]+>/g, " ")),
    raw_json: JSON.stringify(event),
    is_read: 0,
    is_archived: 0,
    direction: "inbound",
    outbound_status: null,
    outbound_error: null,
    received_at: receivedAt,
    created_at: nowIso,
  });

  // Attachments — just record metadata + download URL for now.
  for (const att of d.attachments || []) {
    storage.insertInboundAttachment({
      message_id: stored.id,
      filename: att.filename || "attachment",
      content_type: att.content_type || null,
      size_bytes: att.size ?? null,
      download_url: att.url || null,
      created_at: nowIso,
    });
  }

  // Fire-and-forget forwarding to the admin's personal inbox (best effort;
  // failures are logged but do not block the 200 to Resend).
  void forwardToPersonalInbox(storage, stored.id).catch((err) => {
    console.error("[inbound-email] forward failed", err);
  });

  res.status(200).json({ ok: true, id: stored.id, thread_key: threadKey });
}

// ─── Forwarding ───────────────────────────────────────────────────────────

/**
 * Forward a stored inbound message to the admin's personal inbox so they
 * can also read / reply from Gmail natively. Reply-To is set to the original
 * sender so hitting reply in Gmail replies to the user, not to your own inbox.
 */
export async function forwardToPersonalInbox(
  storage: Storage,
  inboundMessageId: number,
): Promise<{ ok: boolean; reason: string }> {
  const msg = storage.getInboundMessage(inboundMessageId);
  if (!msg) return { ok: false, reason: "message_not_found" };
  if (msg.direction !== "inbound")
    return { ok: false, reason: "not_an_inbound_message" };

  const enabled =
    (storage.getSetting("resend_inbound_forward_enabled")?.value || "true") ===
    "true";
  if (!enabled) return { ok: false, reason: "forwarding_disabled" };

  const forwardTo = (
    storage.getSetting("resend_inbound_forward_to")?.value || ""
  ).trim();
  if (!forwardTo) return { ok: false, reason: "forward_to_not_set" };

  const apiKey = storage.getSetting("resend_api_key")?.value || "";
  if (!apiKey) return { ok: false, reason: "resend_api_key_not_set" };

  const fromDomain =
    storage.getSetting("resend_from")?.value || "onboarding@resend.dev";

  const headerBlock =
    `From: ${msg.from_addr}\n` +
    `To: ${msg.to_addrs}\n` +
    (msg.cc_addrs && msg.cc_addrs !== "[]" ? `Cc: ${msg.cc_addrs}\n` : "") +
    `Subject: ${msg.subject}\n` +
    `Date: ${msg.received_at}\n` +
    `Message-ID: ${msg.message_id}\n`;

  const textBody =
    `---------- Forwarded from SignalPulse Inbox ----------\n` +
    headerBlock +
    `\n` +
    (msg.body_text || "(no plain-text body — see HTML version)");

  const htmlBody =
    `<div style="font-family:sans-serif;color:#666;font-size:12px;` +
    `border-bottom:1px solid #ddd;padding-bottom:8px;margin-bottom:12px">` +
    `Forwarded from SignalPulse Inbox` +
    `</div>` +
    `<div style="font-family:sans-serif;font-size:13px;color:#333;` +
    `margin-bottom:12px;padding:8px;background:#f7f7f7;border-radius:4px">` +
    `<b>From:</b> ${escapeHtml(msg.from_addr)}<br>` +
    `<b>To:</b> ${escapeHtml(msg.to_addrs)}<br>` +
    (msg.cc_addrs && msg.cc_addrs !== "[]"
      ? `<b>Cc:</b> ${escapeHtml(msg.cc_addrs)}<br>`
      : "") +
    `<b>Subject:</b> ${escapeHtml(msg.subject)}<br>` +
    `<b>Date:</b> ${escapeHtml(msg.received_at)}` +
    `</div>` +
    (msg.body_html ||
      `<pre style="white-space:pre-wrap;font-family:sans-serif">` +
        escapeHtml(msg.body_text) +
        `</pre>`);

  const result = await sendViaResend({
    apiKey,
    from: fromDomain,
    to: [forwardTo],
    subject: `[SignalPulse Inbox] Fwd: ${msg.subject}`,
    html: htmlBody,
    text: textBody,
    // The magic bit: Gmail's "Reply" replies to the ORIGINAL sender, not to you.
    replyTo: msg.from_email,
    headers: {
      // Preserve the original Message-ID so if you reply from Gmail, the
      // reply threads correctly in the user's inbox too.
      "In-Reply-To": msg.message_id,
      References: msg.references_hdr
        ? `${msg.references_hdr} ${msg.message_id}`
        : msg.message_id,
      "X-SignalPulse-Original-Message-Id": msg.message_id,
      "X-SignalPulse-Inbound-Id": String(msg.id),
    },
  });

  if (!result.ok) {
    console.error(
      `[inbound-email] forward to ${forwardTo} failed HTTP ${result.status}: ${result.body}`,
    );
    return { ok: false, reason: `resend_send_failed_${result.status}` };
  }
  return { ok: true, reason: "forwarded" };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Reply via admin UI ───────────────────────────────────────────────────

/**
 * Send a reply from the SignalPulse admin UI. Threads correctly by setting
 * In-Reply-To + References to the original message's Message-ID. Stores
 * the outgoing reply as an outbound row so the thread view shows the full
 * conversation.
 */
export async function sendReply(
  storage: Storage,
  originalId: number,
  args: { to?: string; cc?: string[]; subject?: string; body: string },
): Promise<{ ok: boolean; error?: string; outbound_id?: number }> {
  const orig = storage.getInboundMessage(originalId);
  if (!orig) return { ok: false, error: "original_not_found" };

  const apiKey = storage.getSetting("resend_api_key")?.value || "";
  if (!apiKey) return { ok: false, error: "resend_api_key_not_set" };

  const fromDomain =
    storage.getSetting("resend_from")?.value || "onboarding@resend.dev";

  const to = args.to || orig.from_email;
  const subject =
    args.subject ||
    (orig.subject.toLowerCase().startsWith("re:")
      ? orig.subject
      : `Re: ${orig.subject}`);

  const references = orig.references_hdr
    ? `${orig.references_hdr} ${orig.message_id}`
    : orig.message_id;

  const nowIso = new Date().toISOString();

  const result = await sendViaResend({
    apiKey,
    from: fromDomain,
    to: [to],
    cc: args.cc,
    subject,
    text: args.body,
    html: args.body
      .split("\n")
      .map((line) => `<p>${escapeHtml(line)}</p>`)
      .join(""),
    headers: {
      "In-Reply-To": orig.message_id,
      References: references,
    },
  });

  const outbound = storage.insertInboundMessage({
    resend_email_id: result.messageId || `outbound-${nowIso}-${originalId}`,
    // We don't know Resend's generated Message-ID until we fetch the email
    // back; a placeholder based on the Resend send-id keeps the schema happy.
    message_id: `<signalpulse-reply-${result.messageId || Date.now()}@howmanyareplaying.com>`,
    in_reply_to: orig.message_id,
    references_hdr: references,
    thread_key: orig.thread_key,
    subject,
    from_addr: fromDomain,
    from_email: extractBareEmail(fromDomain),
    to_addrs: JSON.stringify([to]),
    cc_addrs: JSON.stringify(args.cc || []),
    body_text: args.body,
    body_html: "",
    snippet: makeSnippet(args.body),
    raw_json: JSON.stringify({ resend_response: result.body }),
    is_read: 1,
    is_archived: 0,
    direction: "outbound",
    outbound_status: result.ok ? "sent" : "failed",
    outbound_error: result.ok ? null : `HTTP ${result.status}: ${result.body}`,
    received_at: nowIso,
    created_at: nowIso,
  });

  return result.ok
    ? { ok: true, outbound_id: outbound.id }
    : {
        ok: false,
        error: `resend_send_failed_${result.status}`,
        outbound_id: outbound.id,
      };
}
