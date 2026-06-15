// SPDX-License-Identifier: Apache-2.0
/**
 * Bot webhook routes — Slack and Teams event adapters.
 *
 * POST /bots/slack/events     — Slack Events API webhook (URL verification + message events)
 * POST /bots/teams/activity   — Bot Framework / Teams activity webhook
 *
 * Both adapters forward BotMessage → the gateway route (POST /api/v1/gateway/messages)
 * and stream the reply back to the platform via the adapter's reply mechanism.
 *
 * Configuration via env vars:
 *   SLACK_BOT_TOKEN       — xoxb-… token for sending Slack messages
 *   SLACK_SIGNING_SECRET  — for request signature verification
 *   SLACK_BOT_APP_ID      — Slack App ID (optional, for filtering)
 *   TEAMS_BOT_APP_ID      — Bot Framework app ID
 *   TEAMS_BOT_APP_PASSWORD — Bot Framework app password
 *
 * When SLACK_BOT_TOKEN is absent, the Slack adapter runs in echo mode (no
 * outbound API calls). Teams likewise.
 */

import {
  SlackBotAdapter,
  TeamsBotAdapter,
  type BotMessage,
  type BotReply,
} from "@nexus/bots";
import type { FastifyInstance } from "fastify";

// ── Singleton adapters ────────────────────────────────────────────────────────

/**
 * BotHandler — forwards message text to POST /gateway/messages and returns
 * assistant reply as BotReply. Internal HTTP call to localhost (same process).
 */
const _gatewayHandler = async (msg: BotMessage): Promise<BotReply> => {
  const apiBase = `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
  const apiKey  = process.env.API_KEY ?? process.env.NEXUS_INTERNAL_KEY ?? "dev";

  try {
    const resp = await fetch(`${apiBase}/api/v1/gateway/messages`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model:    "nexus/smart",
        messages: [{ role: "user", content: msg.text }],
        system:   msg.metadata?.["system"] as string | undefined,
        stream:   false,
      }),
    });

    if (!resp.ok) {
      return { text: `[Error ${resp.status}] Gateway unavailable — please try again.` };
    }

    const data = await resp.json() as {
      content?: Array<{ type: string; text?: string }>;
    };

    const text = data.content?.find((c) => c.type === "text")?.text ?? "(no response)";
    return { text };
  } catch {
    return { text: "Gateway is temporarily unavailable." };
  }
};

const _slackAdapter = new SlackBotAdapter({
  token:         process.env.SLACK_BOT_TOKEN ?? "",
  signingSecret: process.env.SLACK_SIGNING_SECRET ?? "",
  appId:         process.env.SLACK_BOT_APP_ID,
  triggerMode:   "mention",
  handler:       _gatewayHandler,
});

const _teamsAdapter = new TeamsBotAdapter({
  appId:       process.env.TEAMS_BOT_APP_ID ?? "",
  appPassword: process.env.TEAMS_BOT_APP_PASSWORD ?? "",
  handler:     _gatewayHandler,
});

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function botsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /bots/slack/events
   *
   * Slack Events API webhook endpoint. Handles:
   *   • url_verification challenge (no auth required, Slack owns this)
   *   • event_callback: message/app_mention → SlackBotAdapter → gateway → reply
   *
   * Slack signature verification is performed by SlackBotAdapter when
   * SLACK_SIGNING_SECRET is configured.
   */
  app.post<{
    Body: Record<string, unknown>;
    Headers: { "x-slack-request-timestamp"?: string; "x-slack-signature"?: string };
  }>("/bots/slack/events", async (request, reply) => {
    const body = request.body;
    const rawBody = JSON.stringify(body); // signature verification uses raw body

    // handleEvent(body, headers) — flat header map
    const result = await _slackAdapter.handleEvent(body, {
      "x-slack-request-timestamp": request.headers["x-slack-request-timestamp"] ?? "",
      "x-slack-signature":         request.headers["x-slack-signature"] ?? "",
      "x-slack-raw-body":          rawBody,
    });

    if (result.challenge) {
      return reply.send({ challenge: result.challenge });
    }

    if (result.error) {
      return reply.code(400).send({ error: result.error });
    }

    // Slack expects a 200 within 3 s; reply immediately and process asynchronously
    reply.code(200).send({ ok: true });
  });

  /**
   * POST /bots/teams/activity
   *
   * Microsoft Bot Framework / Teams activity webhook.
   * Teams sends Activity objects; the adapter extracts the message and replies
   * via the service URL in the activity.
   */
  app.post<{
    Body: Record<string, unknown>;
    Headers: { authorization?: string };
  }>("/bots/teams/activity", async (request, reply) => {
    const result = await _teamsAdapter.handleActivity(request.body);

    if (result.error) {
      return reply.code(400).send({ error: result.error });
    }

    return reply.send({ ok: true, handled: result.handled });
  });
}
