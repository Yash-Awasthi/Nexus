// SPDX-License-Identifier: Apache-2.0

// ── Core types ────────────────────────────────────────────────────────────────

export interface BroadcastMessage {
  id: string;
  subject: string;
  body: string;
  metadata?: Record<string, unknown>;
}

/** Recipient interface definition. */
export interface Recipient {
  id: string;
  email?: string;
  webhookUrl?: string;
  /** Arbitrary tags for audience segmentation. */
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/** Delivery status type alias. */
export type DeliveryStatus = "pending" | "delivered" | "failed";

/** Delivery record interface definition. */
export interface DeliveryRecord {
  messageId: string;
  recipientId: string;
  channel: string;
  status: DeliveryStatus;
  timestamp: number;
  error?: string;
}

/** Send result interface definition. */
export interface SendResult {
  recipientId: string;
  channel: string;
  success: boolean;
  error?: string;
}

// ── IBroadcastChannel ─────────────────────────────────────────────────────────

export interface IBroadcastChannel {
  readonly name: string;
  /** True if this channel can deliver to the given recipient. */
  canDeliver(recipient: Recipient): boolean;
  send(message: BroadcastMessage, recipient: Recipient): Promise<SendResult>;
}

// ── Audience segmentation ─────────────────────────────────────────────────────

export type SegmentFn = (recipient: Recipient) => boolean;

/** Audience segment. */
export class AudienceSegment {
  constructor(private readonly filter: SegmentFn) {}

  matches(recipient: Recipient): boolean {
    return this.filter(recipient);
  }

  /** Compose: recipient must satisfy both this AND other. */
  and(other: AudienceSegment): AudienceSegment {
    return new AudienceSegment((r) => this.matches(r) && other.matches(r));
  }

  /** Compose: recipient must satisfy this OR other. */
  or(other: AudienceSegment): AudienceSegment {
    return new AudienceSegment((r) => this.matches(r) || other.matches(r));
  }

  /** Negate. */
  not(): AudienceSegment {
    return new AudienceSegment((r) => !this.matches(r));
  }
}

/** Built-in segment: recipient has an email address. */
export const hasEmail = new AudienceSegment((r) => !!r.email);

/** Built-in segment: recipient has a webhook URL. */
export const hasWebhook = new AudienceSegment((r) => !!r.webhookUrl);

/** Built-in segment: recipient has a specific tag. */
export function hasTag(tag: string): AudienceSegment {
  return new AudienceSegment((r) => r.tags?.includes(tag) ?? false);
}

/** Built-in segment: matches all recipients. */
export const everyone = new AudienceSegment(() => true);

// ── Injectable types ──────────────────────────────────────────────────────────

export type FetchFn = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number; statusText: string }>;

/** Email sender interface definition. */
export interface EmailSender {
  send(opts: { to: string; subject: string; body: string }): Promise<void>;
}

// ── WebhookChannel ────────────────────────────────────────────────────────────

export class WebhookChannel implements IBroadcastChannel {
  readonly name = "webhook";

  constructor(
    private readonly fetch: FetchFn,
    private readonly opts: {
      contentType?: string;
      headers?: Record<string, string>;
      timeoutMs?: number;
    } = {},
  ) {}

  canDeliver(recipient: Recipient): boolean {
    return !!recipient.webhookUrl;
  }

  async send(message: BroadcastMessage, recipient: Recipient): Promise<SendResult> {
    if (!recipient.webhookUrl) {
      return { recipientId: recipient.id, channel: this.name, success: false, error: "No webhookUrl" };
    }
    try {
      const res = await this.fetch(recipient.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": this.opts.contentType ?? "application/json",
          ...this.opts.headers,
        },
        body: JSON.stringify({ messageId: message.id, subject: message.subject, body: message.body, metadata: message.metadata }),
      });
      if (!res.ok) {
        return { recipientId: recipient.id, channel: this.name, success: false, error: `HTTP ${res.status}: ${res.statusText}` };
      }
      return { recipientId: recipient.id, channel: this.name, success: true };
    } catch (err) {
      return { recipientId: recipient.id, channel: this.name, success: false, error: String(err) };
    }
  }
}

// ── EmailChannel ──────────────────────────────────────────────────────────────

export class EmailChannel implements IBroadcastChannel {
  readonly name = "email";

  constructor(private readonly sender: EmailSender) {}

  canDeliver(recipient: Recipient): boolean {
    return !!recipient.email;
  }

  async send(message: BroadcastMessage, recipient: Recipient): Promise<SendResult> {
    if (!recipient.email) {
      return { recipientId: recipient.id, channel: this.name, success: false, error: "No email" };
    }
    try {
      await this.sender.send({
        to: recipient.email,
        subject: message.subject,
        body: message.body,
      });
      return { recipientId: recipient.id, channel: this.name, success: true };
    } catch (err) {
      return { recipientId: recipient.id, channel: this.name, success: false, error: String(err) };
    }
  }
}

// ── NullChannel ───────────────────────────────────────────────────────────────

/** Records all sends without actually delivering. Useful for tests. */
export class NullChannel implements IBroadcastChannel {
  readonly name: string;
  readonly sent: Array<{ message: BroadcastMessage; recipient: Recipient }> = [];
  private readonly _canDeliver: (r: Recipient) => boolean;

  constructor(name = "null", canDeliver: (r: Recipient) => boolean = () => true) {
    this.name = name;
    this._canDeliver = canDeliver;
  }

  canDeliver(recipient: Recipient): boolean {
    return this._canDeliver(recipient);
  }

  async send(message: BroadcastMessage, recipient: Recipient): Promise<SendResult> {
    this.sent.push({ message, recipient });
    return { recipientId: recipient.id, channel: this.name, success: true };
  }

  clear(): void {
    this.sent.length = 0;
  }
}

// ── BroadcastDispatcher ───────────────────────────────────────────────────────

export class BroadcastDispatcher {
  private readonly _channels: IBroadcastChannel[] = [];
  private readonly _recipients = new Map<string, Recipient>();
  private readonly _deliveries: DeliveryRecord[] = [];

  addChannel(channel: IBroadcastChannel): void {
    this._channels.push(channel);
  }

  addRecipient(recipient: Recipient): void {
    this._recipients.set(recipient.id, recipient);
  }

  removeRecipient(id: string): boolean {
    return this._recipients.delete(id);
  }

  listRecipients(): Recipient[] {
    return Array.from(this._recipients.values());
  }

  /**
   * Broadcast a message to all eligible recipients.
   * @param message  The message to send.
   * @param segment  If provided, only recipients matching this segment receive it.
   * @returns Delivery records for all send attempts.
   */
  async broadcast(
    message: BroadcastMessage,
    segment?: AudienceSegment,
  ): Promise<DeliveryRecord[]> {
    const batch: DeliveryRecord[] = [];

    for (const recipient of this._recipients.values()) {
      if (segment && !segment.matches(recipient)) continue;

      for (const channel of this._channels) {
        if (!channel.canDeliver(recipient)) continue;

        const result = await channel.send(message, recipient);
        const record: DeliveryRecord = {
          messageId: message.id,
          recipientId: recipient.id,
          channel: channel.name,
          status: result.success ? "delivered" : "failed",
          timestamp: Date.now(),
          error: result.error,
        };
        batch.push(record);
        this._deliveries.push(record);
      }
    }

    return batch;
  }

  /** Return delivery records, optionally filtered by messageId. */
  getDeliveries(messageId?: string): DeliveryRecord[] {
    return messageId
      ? this._deliveries.filter((d) => d.messageId === messageId)
      : [...this._deliveries];
  }

  clearDeliveries(): void {
    this._deliveries.length = 0;
  }
}

// ── BroadcastError ────────────────────────────────────────────────────────────

export class BroadcastError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "BroadcastError";
    this.code = code;
  }
}
