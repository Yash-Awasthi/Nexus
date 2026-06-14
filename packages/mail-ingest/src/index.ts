// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/mail-ingest — Mail ingestion pipeline.
 *
 * IMAP/SMTP polling → parse email body + attachments → route into the doc
 * pipeline as structured documents.  Closes the last major ingest channel.
 *
 * Architecture
 * ────────────
 *   MailIngestor       — polls for new emails and routes them.
 *   IImapClient        — injectable IMAP interface (real: node-imap; test: stub).
 *   parseEmail()       — extract body, attachments, headers from raw email.
 *   ParsedEmail        — normalised email representation.
 *   MailDocAdapter     — convert ParsedEmail → WorkflowDoc (for doc-workflows).
 *   IngestHandler      — callback invoked per parsed email.
 *
 * Test isolation
 * ─────────────
 *   All IMAP I/O is behind IImapClient.  Tests inject a StubImapClient that
 *   returns pre-seeded raw email strings without opening any network connection.
 *
 * Usage
 * ─────
 * ```ts
 * const ingestor = new MailIngestor({
 *   imap: realImapClient,
 *   handler: async (email) => { await docPipeline.process(toWorkflowDoc(email)); },
 * });
 * await ingestor.start();
 * // ... later
 * await ingestor.stop();
 * ```
 */

import { randomUUID } from "node:crypto";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MailAttachment {
  filename: string;
  mimeType: string;
  /** Base64-encoded content. */
  data: string;
  size: number;
}

export interface ParsedEmail {
  id: string;
  messageId?: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  attachments: MailAttachment[];
  date: Date;
  headers: Record<string, string>;
  raw: string;
}

// ── IMAP client interface ────────────────────────────────────────────────────

export interface ImapMessage {
  uid: number;
  /** RFC 2822 raw message as a string. */
  raw: string;
}

export interface IImapClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  fetchUnseen(mailbox?: string): Promise<ImapMessage[]>;
  markSeen(uids: number[], mailbox?: string): Promise<void>;
}

// ── Ingest handler ────────────────────────────────────────────────────────────

export type IngestHandler = (email: ParsedEmail) => Promise<void>;

// ── Raw email parser ──────────────────────────────────────────────────────────

const HEADER_LINE_RE = /^([A-Za-z-]+):\s*(.+)$/;
const BOUNDARY_RE = /boundary="?([^";]+)"?/i;
const MIME_PART_RE = /Content-Type:\s*([^;\r\n]+)/i;
const MIME_ENCODING_RE = /Content-Transfer-Encoding:\s*(\S+)/i;
const MIME_DISP_RE = /Content-Disposition:\s*(?:attachment|inline)[^;]*;\s*filename="?([^";\r\n]+)"?/i;
const ADDR_RE = /"?[^"<]+"?\s*<([^>]+)>|^([^\s,]+@[^\s,]+)/;

function extractAddress(raw: string): string {
  const m = ADDR_RE.exec(raw.trim());
  return m?.[1] ?? m?.[2] ?? raw.trim();
}

function extractAddresses(raw: string): string[] {
  return raw.split(/,\s*/).map(extractAddress).filter(Boolean);
}

/**
 * Parse a raw RFC 2822 / MIME email into structured form.
 * Handles simple single-part and basic MIME multipart messages.
 */
export function parseEmail(raw: string, uid?: number): ParsedEmail {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const headers: Record<string, string> = {};
  let i = 0;

  // Parse headers (continue until blank line)
  while (i < lines.length && lines[i] !== "") {
    const line = lines[i] ?? "";
    const m = HEADER_LINE_RE.exec(line);
    if (m) {
      const key = m[1]?.toLowerCase() ?? "";
      headers[key] = m[2] ?? "";
    }
    i++;
  }
  i++; // skip blank line

  const body = lines.slice(i).join("\n");

  // MIME boundary extraction
  const contentType = headers["content-type"] ?? "";
  const boundaryMatch = BOUNDARY_RE.exec(contentType);
  const boundary = boundaryMatch?.[1];

  let bodyText = "";
  let bodyHtml: string | undefined;
  const attachments: MailAttachment[] = [];

  if (boundary) {
    // Split into parts
    const parts = body.split(new RegExp(`--${escapeRegex(boundary)}(?:--)?`));
    for (const part of parts) {
      if (!part.trim() || part.trim() === "--") continue;
      const partLines = part.replace(/\r\n/g, "\n").split("\n");
      const partHeaders: Record<string, string> = {};
      let j = 0;
      while (j < partLines.length && partLines[j] !== "") {
        const h = HEADER_LINE_RE.exec(partLines[j] ?? "");
        if (h) partHeaders[(h[1] ?? "").toLowerCase()] = h[2] ?? "";
        j++;
      }
      j++;
      const partBody = partLines.slice(j).join("\n").trim();
      const partType = (MIME_PART_RE.exec(partHeaders["content-type"] ?? "")?.[1] ?? "text/plain").trim();
      const encoding = MIME_ENCODING_RE.exec(part)?.[1]?.toLowerCase() ?? "7bit";
      const filename = MIME_DISP_RE.exec(part)?.[1]?.trim();

      if (filename) {
        const data = encoding === "base64" ? partBody.replace(/\s/g, "") : Buffer.from(partBody).toString("base64");
        attachments.push({ filename, mimeType: partType, data, size: data.length });
      } else if (partType.startsWith("text/html")) {
        bodyHtml = partBody;
      } else {
        bodyText = partBody;
      }
    }
  } else {
    // Simple single-part message
    const encoding = headers["content-transfer-encoding"]?.toLowerCase() ?? "7bit";
    bodyText = encoding === "base64" ? Buffer.from(body.trim(), "base64").toString("utf8") : body;
  }

  const dateStr = headers["date"] ?? "";
  const date = dateStr ? new Date(dateStr) : new Date();

  return {
    id: randomUUID(),
    messageId: headers["message-id"],
    from: extractAddress(headers["from"] ?? ""),
    to: extractAddresses(headers["to"] ?? ""),
    cc: extractAddresses(headers["cc"] ?? ""),
    subject: headers["subject"] ?? "(no subject)",
    bodyText,
    bodyHtml,
    attachments,
    date: isNaN(date.getTime()) ? new Date() : date,
    headers,
    raw,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Doc adapter ───────────────────────────────────────────────────────────────

export interface WorkflowDoc {
  id: string;
  source?: string;
  content: string;
  format?: string;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: number;
}

/**
 * Convert a ParsedEmail into a WorkflowDoc for the doc-workflows pipeline.
 */
export function toWorkflowDoc(email: ParsedEmail): WorkflowDoc {
  return {
    id: email.id,
    source: `mailto:${email.from}`,
    content: email.bodyText || email.bodyHtml || "",
    format: email.bodyHtml ? "html" : "text",
    tags: ["email"],
    metadata: {
      from: email.from,
      to: email.to,
      cc: email.cc,
      subject: email.subject,
      date: email.date.toISOString(),
      messageId: email.messageId,
      attachmentCount: email.attachments.length,
      attachments: email.attachments.map((a) => ({ filename: a.filename, mimeType: a.mimeType, size: a.size })),
      source: "mail-ingest",
    },
    createdAt: email.date.getTime(),
  };
}

// ── MailIngestor ──────────────────────────────────────────────────────────────

export interface MailIngestorConfig {
  imap: IImapClient;
  handler: IngestHandler;
  mailbox?: string;
  pollIntervalMs?: number;
  /** Callback on error (default: console.error) */
  onError?: (err: Error) => void;
  now?: () => number;
}

export class MailIngestor {
  private readonly imap: IImapClient;
  private readonly handler: IngestHandler;
  private readonly mailbox: string;
  private readonly pollIntervalMs: number;
  private readonly onError: (err: Error) => void;
  private readonly now: () => number;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private running = false;
  private emailsProcessed = 0;

  constructor(config: MailIngestorConfig) {
    this.imap = config.imap;
    this.handler = config.handler;
    this.mailbox = config.mailbox ?? "INBOX";
    this.pollIntervalMs = config.pollIntervalMs ?? 60_000;
    this.onError = config.onError ?? ((e) => { console.error("[mail-ingest]", e.message); });
    this.now = config.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.imap.connect();
    await this._poll();
    this._schedulePoll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    await this.imap.disconnect();
  }

  get stats(): { emailsProcessed: number } {
    return { emailsProcessed: this.emailsProcessed };
  }

  /** Trigger a manual poll (useful for tests). */
  async poll(): Promise<number> {
    return this._poll();
  }

  private async _poll(): Promise<number> {
    let count = 0;
    try {
      const messages = await this.imap.fetchUnseen(this.mailbox);
      const uids: number[] = [];

      for (const msg of messages) {
        try {
          const email = parseEmail(msg.raw, msg.uid);
          await this.handler(email);
          uids.push(msg.uid);
          count++;
          this.emailsProcessed++;
        } catch (err) {
          this.onError(err instanceof Error ? err : new Error(String(err)));
        }
      }

      if (uids.length > 0) {
        await this.imap.markSeen(uids, this.mailbox).catch((e: Error) => this.onError(e));
      }
    } catch (err) {
      this.onError(err instanceof Error ? err : new Error(String(err)));
    }
    return count;
  }

  private _schedulePoll(): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(async () => {
      await this._poll();
      this._schedulePoll();
    }, this.pollIntervalMs);
  }
}

// ── Stub IMAP client for tests ────────────────────────────────────────────────

export interface StubImapOptions {
  messages?: ImapMessage[];
  connectError?: string;
  fetchError?: string;
}

export class StubImapClient implements IImapClient {
  private readonly messages: ImapMessage[];
  private readonly connectError: string | undefined;
  private readonly fetchError: string | undefined;
  private readonly seen = new Set<number>();
  connected = false;

  constructor(opts: StubImapOptions = {}) {
    this.messages = opts.messages ?? [];
    this.connectError = opts.connectError;
    this.fetchError = opts.fetchError;
  }

  async connect(): Promise<void> {
    if (this.connectError) throw new Error(this.connectError);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async fetchUnseen(_mailbox?: string): Promise<ImapMessage[]> {
    if (this.fetchError) throw new Error(this.fetchError);
    return this.messages.filter((m) => !this.seen.has(m.uid));
  }

  async markSeen(uids: number[], _mailbox?: string): Promise<void> {
    for (const uid of uids) this.seen.add(uid);
  }
}
