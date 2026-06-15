// SPDX-License-Identifier: Apache-2.0
/**
 * platform-adapters — Telegram + Slack messaging adapters for Nexus.
 *
 * Provides a unified PlatformAdapter interface that parallels @nexus/discord-bot.
 *
 * Adapters:
 *   • TelegramAdapter — handles Telegram Bot API webhook Update payloads
 *   • SlackAdapter    — handles Slack Events API payloads (Block Kit + text)
 *   • AdapterFactory  — create adapter by platform name string
 */

// ── Shared types ──────────────────────────────────────────────────────────────

export type Platform = "telegram" | "slack" | "discord";

/** Incoming message interface definition. */
export interface IncomingMessage {
  platform: Platform;
  userId: string;
  chatId: string;
  text: string;
  raw: unknown;
}

/** Outgoing message interface definition. */
export interface OutgoingMessage {
  chatId: string;
  text?: string;
  /** Platform-specific blocks / attachments */
  blocks?: unknown[];
  parseMode?: "Markdown" | "HTML" | "plain";
}

/** Send result interface definition. */
export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/** Platform adapter interface definition. */
export interface PlatformAdapter {
  readonly platform: Platform;
  parse(rawPayload: unknown): IncomingMessage | null;
  send(msg: OutgoingMessage): Promise<SendResult>;
}

// ── HTTP sender (injectable) ───────────────────────────────────────────────────

export interface HttpSender {
  post(url: string, body: unknown, headers: Record<string, string>): Promise<unknown>;
}

/** Mock http sender. */
export class MockHttpSender implements HttpSender {
  readonly calls: { url: string; body: unknown }[] = [];
  private result: unknown = { ok: true };

  setResult(r: unknown): this {
    this.result = r;
    return this;
  }

  async post(url: string, body: unknown, _h: Record<string, string>): Promise<unknown> {
    this.calls.push({ url, body });
    return this.result;
  }
}

// ── TelegramAdapter ───────────────────────────────────────────────────────────

export interface TelegramConfig {
  botToken: string;
  baseUrl?: string;
}

/** Telegram update interface definition. */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string };
    chat: { id: number; type: string };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number; username?: string };
    message?: { chat: { id: number } };
    data?: string;
  };
}

/** Telegram adapter. */
export class TelegramAdapter implements PlatformAdapter {
  readonly platform = "telegram" as const;
  private config: Required<TelegramConfig>;
  private sender: HttpSender;

  constructor(config: TelegramConfig, sender?: HttpSender) {
    this.config = { ...config, baseUrl: config.baseUrl ?? "https://api.telegram.org" };
    this.sender = sender ?? this.makeDefaultSender();
  }

  private makeDefaultSender(): HttpSender {
    return {
      post: async (url, body) => {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        return r.json();
      },
    };
  }

  parse(rawPayload: unknown): IncomingMessage | null {
    const update = rawPayload as TelegramUpdate;
    if (!update) return null;

    // Text message
    if (update.message?.text !== undefined) {
      const msg = update.message;
      return {
        platform: this.platform,
        userId: String(msg.from?.id ?? "unknown"),
        chatId: String(msg.chat.id),
        text: msg.text ?? "",
        raw: update,
      };
    }

    // Callback query (inline keyboard button)
    if (update.callback_query) {
      const cb = update.callback_query;
      return {
        platform: this.platform,
        userId: String(cb.from.id),
        chatId: String(cb.message?.chat.id ?? "0"),
        text: cb.data ?? "",
        raw: update,
      };
    }

    return null;
  }

  async send(msg: OutgoingMessage): Promise<SendResult> {
    const url = `${this.config.baseUrl}/bot${this.config.botToken}/sendMessage`;
    const body: Record<string, unknown> = {
      chat_id: msg.chatId,
      text: msg.text ?? "",
    };
    if (msg.parseMode && msg.parseMode !== "plain") {
      body["parse_mode"] = msg.parseMode;
    }
    try {
      const raw = (await this.sender.post(url, body, {})) as {
        ok?: boolean;
        result?: { message_id?: number };
      };
      return {
        success: raw.ok === true,
        messageId: raw.result?.message_id !== undefined ? String(raw.result.message_id) : undefined,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ── SlackAdapter ──────────────────────────────────────────────────────────────

export interface SlackConfig {
  botToken: string;
  signingSecret?: string;
  baseUrl?: string;
}

/** Slack event payload interface definition. */
export interface SlackEventPayload {
  type: string;
  event?: {
    type: string;
    user?: string;
    channel?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
  };
  // Slash command shape
  command?: string;
  user_id?: string;
  channel_id?: string;
  text?: string;
}

/** Slack adapter. */
export class SlackAdapter implements PlatformAdapter {
  readonly platform = "slack" as const;
  private config: Required<SlackConfig>;
  private sender: HttpSender;

  constructor(config: SlackConfig, sender?: HttpSender) {
    this.config = {
      ...config,
      signingSecret: config.signingSecret ?? "",
      baseUrl: config.baseUrl ?? "https://slack.com/api",
    };
    this.sender = sender ?? this.makeDefaultSender();
  }

  private makeDefaultSender(): HttpSender {
    return {
      post: async (url, body, headers) => {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
          body: JSON.stringify(body),
        });
        return r.json();
      },
    };
  }

  parse(rawPayload: unknown): IncomingMessage | null {
    const payload = rawPayload as SlackEventPayload;
    if (!payload) return null;

    // Events API — message event
    if (payload.type === "event_callback" && payload.event?.type === "message") {
      const ev = payload.event;
      if (!ev.user || !ev.channel) return null;
      return {
        platform: this.platform,
        userId: ev.user,
        chatId: ev.channel,
        text: ev.text ?? "",
        raw: payload,
      };
    }

    // Slash command
    if (payload.command) {
      return {
        platform: this.platform,
        userId: payload.user_id ?? "unknown",
        chatId: payload.channel_id ?? "unknown",
        text: `${payload.command} ${payload.text ?? ""}`.trim(),
        raw: payload,
      };
    }

    return null;
  }

  async send(msg: OutgoingMessage): Promise<SendResult> {
    const body: Record<string, unknown> = {
      channel: msg.chatId,
      text: msg.text ?? "",
    };
    if (msg.blocks) body["blocks"] = msg.blocks;

    try {
      const raw = (await this.sender.post(`${this.config.baseUrl}/chat.postMessage`, body, {
        Authorization: `Bearer ${this.config.botToken}`,
      })) as { ok?: boolean; ts?: string; error?: string };
      return {
        success: raw.ok === true,
        messageId: raw.ts,
        error: raw.error,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ── AdapterFactory ─────────────────────────────────────────────────────────────

export type AdapterConfig =
  | ({ platform: "telegram" } & TelegramConfig)
  | ({ platform: "slack" } & SlackConfig);

/** Create adapter. */
export function createAdapter(config: AdapterConfig, sender?: HttpSender): PlatformAdapter {
  switch (config.platform) {
    case "telegram":
      return new TelegramAdapter(config, sender);
    case "slack":
      return new SlackAdapter(config, sender);
    default:
      throw new Error(`Unknown platform: ${(config as { platform: string }).platform}`);
  }
}
