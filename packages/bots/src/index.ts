// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/bots — Slack and Microsoft Teams bot adapters.
 *
 * Architecture
 * ─────────────
 *   BotMessage    — normalized inbound message from any platform
 *   BotReply      — normalized outbound reply
 *   BotHandler    — injectable async function: BotMessage → BotReply
 *   SlackBotAdapter  — Slack Events API receiver + reply sender
 *   TeamsBotAdapter  — Teams Bot Framework activity receiver + reply sender
 *
 * Both adapters:
 *   • Accept an injectable `fetch` function for full testability (no real HTTP)
 *   • Accept optional `hooks` (AgentHooks) and emit task.before / task.after
 *     lifecycle events wrapping each BotHandler invocation
 *   • Collect and return structured errors rather than throwing on partial
 *     failures (e.g. handler succeeds but reply send fails)
 *
 * Security notes
 * ──────────────
 *   Slack: request signature verification via HMAC-SHA256 over
 *          `v0:${timestamp}:${rawBody}` with the app's signing secret.
 *          Pass `signingSecret` + raw request body to enableit.
 *          Verification is optional (skip in dev by omitting signingSecret).
 *
 *   Teams: simplified bearer-token auth. Production deployments should
 *          replace with full Azure AD / Bot Framework token validation.
 *
 * Sandbox note
 * ────────────
 *   Handlers run in-process. Use createDockerRunner() from @nexus/sandbox
 *   and invoke executeCode() inside your handler for untrusted code paths.
 *   See BotTriggerMode and allowedUserIds for coarse-grained access control.
 *
 * Usage
 * ─────
 * ```ts
 * import { SlackBotAdapter } from "@nexus/bots";
 *
 * const slack = new SlackBotAdapter({
 *   token: process.env.SLACK_BOT_TOKEN!,
 *   signingSecret: process.env.SLACK_SIGNING_SECRET,
 *   handler: async (msg) => ({ text: `Echo: ${msg.text}` }),
 * });
 *
 * // In your HTTP server:
 * app.post("/slack/events", async (req, res) => {
 *   const result = await slack.handleEvent(req.body, req.headers);
 *   res.json(result.challenge ? { challenge: result.challenge } : { ok: true });
 * });
 * ```
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";

// ── Error ─────────────────────────────────────────────────────────────────────

export type BotErrorCode =
  | "SIGNATURE_INVALID"
  | "PAYLOAD_INVALID"
  | "HANDLER_FAILED"
  | "SEND_FAILED"
  | "AUTH_FAILED"
  | "UNSUPPORTED_EVENT";

export class BotError extends Error {
  readonly code: BotErrorCode;
  readonly context?: Record<string, unknown>;

  constructor(code: BotErrorCode, message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = "BotError";
    this.code = code;
    this.context = context;
  }
}

// ── Shared message / reply types ──────────────────────────────────────────────

export type BotPlatform = "slack" | "teams";

/**
 * Normalized inbound message — all platform-specific fields flattened into
 * a common shape so handlers don't need to know which platform sent the msg.
 */
export interface BotMessage {
  /** Unique message ID (from platform or generated) */
  id: string;
  platform: BotPlatform;
  /** Channel / conversation ID */
  channelId: string;
  /** User / sender ID */
  userId: string;
  /** Stripped plain text body */
  text: string;
  /** Thread / reply chain identifier (platform-specific) */
  threadId?: string;
  /** Unix epoch milliseconds */
  timestamp: number;
  /** Full raw payload from the platform — available for advanced handlers */
  raw: unknown;
}

export interface BotReply {
  text: string;
  /** If set, the reply is sent into the same thread */
  threadId?: string;
  /** Arbitrary metadata forwarded to hooks */
  metadata?: Record<string, unknown>;
}

/**
 * Core handler function — receives a normalized BotMessage, returns a BotReply.
 * Wire in LibrarianAgent.recall, ResearcherAgent.research, or any async fn.
 */
export type BotHandler = (message: BotMessage) => Promise<BotReply>;

/** No-op handler — echoes the message text back. Useful as a test double. */
export const echoHandler: BotHandler = async (msg) => ({ text: `Echo: ${msg.text}` });

/** Silent handler — returns an empty reply without echoing anything. */
export const nullHandler: BotHandler = async (_msg) => ({ text: "" });

// ── Hook emitter (local re-declaration) ──────────────────────────────────────

export interface BotHooks {
  emit(
    event: string,
    payload: Record<string, unknown>,
  ): Promise<{ handled: number; aborted: boolean; errors: unknown[] }>;
}

// ── Injectable fetch ──────────────────────────────────────────────────────────

export type FetchFn = typeof fetch;

// ── Trigger mode ─────────────────────────────────────────────────────────────

/**
 * Controls which Slack messages invoke the handler.
 *
 *   "all"     — every non-bot channel message (backward-compatible default,
 *               noisy in active workspaces)
 *   "mention" — only messages that @mention the bot (requires botUserId)
 *   "command" — only messages whose text starts with "/" (slash commands)
 */
export type BotTriggerMode = "all" | "mention" | "command";

// ── Slack Bot Adapter ─────────────────────────────────────────────────────────

export interface SlackBotConfig {
  /** Slack Bot OAuth token (xoxb-…) */
  token: string;
  /**
   * Slack app signing secret for request verification.
   * When provided, `handleEvent` verifies the X-Slack-Signature header.
   * Omit in development/testing to skip verification.
   */
  signingSecret?: string;
  /** Handler to invoke for each inbound message */
  handler: BotHandler;
  /** Injectable fetch (defaults to global fetch) */
  fetch?: FetchFn;
  /** Optional hooks for task.before / task.after lifecycle events */
  hooks?: BotHooks;
  /** Bot display name used in hook payloads (default: "slack-bot") */
  name?: string;
  /**
   * Controls which messages trigger the handler.
   * Default: "all" (backward-compatible).
   * Use "mention" or "command" for production deployments to reduce noise.
   */
  triggerMode?: BotTriggerMode;
  /**
   * Bot's Slack user ID (e.g. "U0123456").
   * Required when triggerMode is "mention" — used to detect @mention patterns.
   */
  botUserId?: string;
  /**
   * Explicit allowlist of Slack user IDs permitted to invoke the handler.
   * When set, messages from users NOT in this set are silently dropped.
   * Leave undefined to allow all users.
   */
  allowedUserIds?: string[];
}

export interface SlackEventResult {
  /** Set on url_verification events — must be echoed back to Slack */
  challenge?: string;
  /** Whether a handler was invoked */
  handled: boolean;
  /** The BotReply from the handler, if invoked */
  reply?: BotReply;
  /** Non-fatal error description */
  error?: string;
  /** true when the send-reply HTTP call failed */
  sendFailed?: boolean;
}

// Slack Events API payload shapes (minimal)
interface SlackUrlVerification {
  type: "url_verification";
  challenge: string;
  token: string;
}

interface SlackEventCallback {
  type: "event_callback";
  event_id: string;
  event: {
    type: string;
    text?: string;
    channel?: string;
    user?: string;
    ts?: string;
    thread_ts?: string;
    bot_id?: string;
  };
}

type SlackPayload = SlackUrlVerification | SlackEventCallback | { type: string };

export class SlackBotAdapter {
  private readonly token: string;
  private readonly signingSecret?: string;
  private readonly handler: BotHandler;
  private readonly fetchFn: FetchFn;
  private readonly hooks?: BotHooks;
  private readonly name: string;
  private readonly triggerMode: BotTriggerMode;
  private readonly botUserId?: string;
  private readonly allowedUserIds?: ReadonlySet<string>;

  private static readonly API_BASE = "https://slack.com/api";

  constructor(config: SlackBotConfig) {
    this.token = config.token;
    this.signingSecret = config.signingSecret;
    this.handler = config.handler;
    this.fetchFn = config.fetch ?? fetch;
    this.hooks = config.hooks;
    this.name = config.name ?? "slack-bot";
    this.triggerMode = config.triggerMode ?? "all";
    this.botUserId = config.botUserId;
    this.allowedUserIds = config.allowedUserIds
      ? new Set(config.allowedUserIds)
      : undefined;
  }

  /** Returns true when the message text matches the configured trigger mode. */
  private _matchesTrigger(text: string): boolean {
    switch (this.triggerMode) {
      case "mention":
        // Matches <@UXXXXXXXX> mention format
        return this.botUserId
          ? text.includes(`<@${this.botUserId}>`)
          : true; // no botUserId configured — pass through
      case "command":
        return text.trimStart().startsWith("/");
      case "all":
      default:
        return true;
    }
  }

  /**
   * Process an inbound Slack Events API payload.
   *
   * @param body    Parsed JSON body from the request
   * @param headers Optional HTTP headers — used for signature verification
   */
  async handleEvent(
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<SlackEventResult> {
    // ── Signature verification ──────────────────────────────────────────────
    if (this.signingSecret) {
      const verified = this._verifySlackSignature(
        headers["x-slack-signature"] ?? headers["X-Slack-Signature"] ?? "",
        headers["x-slack-request-timestamp"] ??
          headers["X-Slack-Request-Timestamp"] ??
          "",
        typeof body === "string" ? body : JSON.stringify(body),
      );
      if (!verified) {
        throw new BotError("SIGNATURE_INVALID", "Slack request signature is invalid");
      }
    }

    // ── Parse payload ───────────────────────────────────────────────────────
    const payload = (typeof body === "string" ? JSON.parse(body) : body) as SlackPayload;

    // ── URL verification challenge ──────────────────────────────────────────
    if (payload.type === "url_verification") {
      const uv = payload as SlackUrlVerification;
      return { challenge: uv.challenge, handled: false };
    }

    // ── Event callback ──────────────────────────────────────────────────────
    if (payload.type !== "event_callback") {
      return { handled: false, error: `Unsupported event type: ${payload.type}` };
    }

    const ec = payload as SlackEventCallback;
    const ev = ec.event;

    // Ignore bot messages (prevent loops)
    if (ev.bot_id || ev.type !== "message") {
      return { handled: false };
    }

    const text = (ev.text ?? "").trim();
    if (!text) {
      return { handled: false, error: "Empty message text" };
    }

    const msg: BotMessage = {
      id: ec.event_id,
      platform: "slack",
      channelId: ev.channel ?? "",
      userId: ev.user ?? "",
      text,
      threadId: ev.thread_ts ?? ev.ts,
      timestamp: ev.ts ? Math.floor(parseFloat(ev.ts) * 1000) : Date.now(),
      raw: ec,
    };

    // ── Trigger mode gate ───────────────────────────────────────────────────
    if (!this._matchesTrigger(text)) {
      return { handled: false };
    }

    // ── User allowlist gate ─────────────────────────────────────────────────
    if (this.allowedUserIds && !this.allowedUserIds.has(msg.userId)) {
      return { handled: false };
    }

    // ── Invoke handler ──────────────────────────────────────────────────────
    await this._emitHook("task.before", {
      bot: this.name,
      platform: "slack",
      channelId: msg.channelId,
      userId: msg.userId,
    });

    let reply: BotReply;
    try {
      reply = await this.handler(msg);
    } catch (cause) {
      throw new BotError("HANDLER_FAILED", `Handler threw: ${String(cause)}`, {
        channelId: msg.channelId,
      });
    }

    await this._emitHook("task.after", {
      bot: this.name,
      platform: "slack",
      channelId: msg.channelId,
      replyLength: reply.text.length,
    });

    // ── Send reply ──────────────────────────────────────────────────────────
    let sendFailed = false;
    if (reply.text && ev.channel) {
      try {
        await this._sendSlackMessage(ev.channel, reply.text, reply.threadId ?? ev.ts);
      } catch {
        sendFailed = true;
      }
    }

    return { handled: true, reply, sendFailed };
  }

  /**
   * Send a message to a Slack channel directly (outside event handling).
   */
  async send(
    channelId: string,
    text: string,
    opts: { threadTs?: string } = {},
  ): Promise<void> {
    await this._sendSlackMessage(channelId, text, opts.threadTs);
  }

  private async _sendSlackMessage(
    channel: string,
    text: string,
    threadTs?: string,
  ): Promise<void> {
    const body: Record<string, unknown> = { channel, text };
    if (threadTs) body["thread_ts"] = threadTs;

    const res = await this.fetchFn(`${SlackBotAdapter.API_BASE}/chat.postMessage`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new BotError("SEND_FAILED", `Slack API returned ${res.status}`, {
        channel,
        status: res.status,
      });
    }

    const json = (await res.json()) as { ok: boolean; error?: string };
    if (!json.ok) {
      throw new BotError("SEND_FAILED", `Slack API error: ${json.error ?? "unknown"}`, {
        channel,
      });
    }
  }

  private _verifySlackSignature(
    signature: string,
    timestamp: string,
    rawBody: string,
  ): boolean {
    if (!signature || !timestamp) return false;
    // Reject stale requests (> 5 minutes)
    const ts = parseInt(timestamp, 10);
    if (isNaN(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

    const baseString = `v0:${timestamp}:${rawBody}`;
    const hmac = createHmac("sha256", this.signingSecret!);
    hmac.update(baseString);
    const computed = `v0=${hmac.digest("hex")}`;

    try {
      return timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
    } catch {
      return false;
    }
  }

  private async _emitHook(event: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.hooks) return;
    try {
      await this.hooks.emit(event, payload);
    } catch {
      // Non-fatal
    }
  }
}

// ── Teams Bot Adapter ─────────────────────────────────────────────────────────

export interface TeamsBotConfig {
  /**
   * Teams Bot Framework service URL (from incoming activity's serviceUrl field).
   * Used as the base for reply calls.
   * Default: "https://smba.trafficmanager.net/apis"
   */
  serviceUrl?: string;
  /** Teams App ID (Microsoft App ID) */
  appId: string;
  /**
   * Teams App Password — used to acquire a Bearer token for reply calls.
   * In tests, pass any string and use a mock fetch.
   */
  appPassword: string;
  /** Handler to invoke for each inbound message */
  handler: BotHandler;
  /** Injectable fetch (defaults to global fetch) */
  fetch?: FetchFn;
  /** Optional hooks */
  hooks?: BotHooks;
  /** Bot display name (default: "teams-bot") */
  name?: string;
}

export interface TeamsActivityResult {
  /** Whether the handler was invoked */
  handled: boolean;
  reply?: BotReply;
  error?: string;
  sendFailed?: boolean;
}

// Teams Bot Framework Activity shapes (minimal)
interface TeamsActivity {
  type: string;
  id?: string;
  text?: string;
  timestamp?: string;
  serviceUrl?: string;
  channelId?: string;
  from?: { id: string; name?: string };
  conversation?: { id: string; isGroup?: boolean };
  channelData?: { teamsChannelId?: string };
}

export class TeamsBotAdapter {
  private readonly serviceUrl: string;
  private readonly appId: string;
  private readonly appPassword: string;
  private readonly handler: BotHandler;
  private readonly fetchFn: FetchFn;
  private readonly hooks?: BotHooks;
  private readonly name: string;

  private static readonly TOKEN_URL =
    "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";

  constructor(config: TeamsBotConfig) {
    this.serviceUrl =
      config.serviceUrl ?? "https://smba.trafficmanager.net/apis";
    this.appId = config.appId;
    this.appPassword = config.appPassword;
    this.handler = config.handler;
    this.fetchFn = config.fetch ?? fetch;
    this.hooks = config.hooks;
    this.name = config.name ?? "teams-bot";
  }

  /**
   * Process an inbound Teams Bot Framework activity.
   */
  async handleActivity(body: unknown): Promise<TeamsActivityResult> {
    // ── Parse ───────────────────────────────────────────────────────────────
    let activity: TeamsActivity;
    try {
      activity = (typeof body === "string" ? JSON.parse(body) : body) as TeamsActivity;
    } catch {
      throw new BotError("PAYLOAD_INVALID", "Teams activity body is not valid JSON");
    }

    // Only handle message activities
    if (activity.type !== "message") {
      return { handled: false, error: `Unsupported activity type: ${activity.type}` };
    }

    const text = (activity.text ?? "").trim();
    if (!text) {
      return { handled: false, error: "Empty activity text" };
    }

    // Prefer teamsChannelId from channelData, fall back to conversation.id
    const channelId =
      activity.channelData?.teamsChannelId ??
      activity.conversation?.id ??
      "";

    const tsMs = activity.timestamp
      ? new Date(activity.timestamp).getTime()
      : Date.now();

    const msg: BotMessage = {
      id: activity.id ?? randomUUID(),
      platform: "teams",
      channelId,
      userId: activity.from?.id ?? "",
      text,
      threadId: activity.conversation?.id,
      timestamp: tsMs,
      raw: activity,
    };

    // ── Hook: task.before ────────────────────────────────────────────────────
    await this._emitHook("task.before", {
      bot: this.name,
      platform: "teams",
      channelId: msg.channelId,
      userId: msg.userId,
    });

    // ── Invoke handler ───────────────────────────────────────────────────────
    let reply: BotReply;
    try {
      reply = await this.handler(msg);
    } catch (cause) {
      throw new BotError("HANDLER_FAILED", `Handler threw: ${String(cause)}`, {
        channelId: msg.channelId,
      });
    }

    await this._emitHook("task.after", {
      bot: this.name,
      platform: "teams",
      channelId: msg.channelId,
      replyLength: reply.text.length,
    });

    // ── Send reply ───────────────────────────────────────────────────────────
    let sendFailed = false;
    const svcUrl = activity.serviceUrl ?? this.serviceUrl;
    const conversationId = activity.conversation?.id;

    if (reply.text && conversationId) {
      try {
        const token = await this._acquireToken();
        await this._sendTeamsReply(svcUrl, conversationId, activity.id, token, reply.text);
      } catch {
        sendFailed = true;
      }
    }

    return { handled: true, reply, sendFailed };
  }

  private async _acquireToken(): Promise<string> {
    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.appId,
      client_secret: this.appPassword,
      scope: "https://api.botframework.com/.default",
    });

    const res = await this.fetchFn(TeamsBotAdapter.TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!res.ok) {
      throw new BotError("AUTH_FAILED", `Token endpoint returned ${res.status}`);
    }

    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) {
      throw new BotError("AUTH_FAILED", "Token response missing access_token");
    }
    return json.access_token;
  }

  private async _sendTeamsReply(
    serviceUrl: string,
    conversationId: string,
    activityId: string | undefined,
    token: string,
    text: string,
  ): Promise<void> {
    const base = serviceUrl.replace(/\/$/, "");
    const url = activityId
      ? `${base}/v3/conversations/${conversationId}/activities/${activityId}`
      : `${base}/v3/conversations/${conversationId}/activities`;

    const res = await this.fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "message", text }),
    });

    if (!res.ok) {
      throw new BotError("SEND_FAILED", `Teams reply API returned ${res.status}`, {
        conversationId,
        status: res.status,
      });
    }
  }

  private async _emitHook(event: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.hooks) return;
    try {
      await this.hooks.emit(event, payload);
    } catch {
      // Non-fatal
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Generate a valid Slack HMAC-SHA256 signature for testing.
 *
 * ```ts
 * const { signature, timestamp } = signSlackRequest(body, signingSecret);
 * await adapter.handleEvent(body, { "x-slack-signature": signature, "x-slack-request-timestamp": timestamp });
 * ```
 */
export function signSlackRequest(
  rawBody: string,
  signingSecret: string,
  timestamp?: number,
): { signature: string; timestamp: string } {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const baseString = `v0:${ts}:${rawBody}`;
  const hmac = createHmac("sha256", signingSecret);
  hmac.update(baseString);
  return { signature: `v0=${hmac.digest("hex")}`, timestamp: String(ts) };
}
