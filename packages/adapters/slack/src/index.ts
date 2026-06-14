// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/adapter-slack — Slack Web API.
 * Task types: slack.post-message, slack.post-channel, slack.create-channel
 */

import {
  defineAdapter,
  requireEnv,
  AdapterHttpError,
  NexusAdapterError,
  type IExecutionContext,
} from "@nexus/plugin-sdk";

const SLACK_BASE = "https://slack.com/api";

export interface SlackPostMessageTask {
  taskType: "slack.post-message";
  channel: string;
  text: string;
  blocks?: unknown[];
  threadTs?: string;
  mrkdwn?: boolean;
}
export interface SlackPostChannelTask {
  taskType: "slack.post-channel";
  channelName: string;
  text: string;
  blocks?: unknown[];
}
export interface SlackCreateChannelTask {
  taskType: "slack.create-channel";
  name: string;
  isPrivate?: boolean;
}
export type SlackTask = SlackPostMessageTask | SlackPostChannelTask | SlackCreateChannelTask;
export interface SlackPostResult {
  ok: boolean;
  ts: string;
  channel: string;
}
export interface SlackCreateChannelResult {
  ok: boolean;
  channelId: string;
  channelName: string;
}

async function slackCall(
  endpoint: string,
  token: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${SLACK_BASE}/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new AdapterHttpError("nexus-adapter-slack", response.status, await response.text());
  const data = (await response.json()) as Record<string, unknown>;
  if (!data["ok"])
    throw new NexusAdapterError(
      `Slack API error: ${String(data["error"] ?? "unknown")}`,
      "SLACK_API_ERROR",
      data,
    );
  return data;
}

async function execute(
  task: SlackTask,
  ctx: IExecutionContext,
): Promise<SlackPostResult | SlackCreateChannelResult> {
  const token = requireEnv(ctx, "SLACK_BOT_TOKEN");

  if (task.taskType === "slack.post-message") {
    ctx.logger.info("slack.post-message", { channel: task.channel });
    const data = await slackCall("chat.postMessage", token, {
      channel: task.channel,
      text: task.text,
      ...(task.blocks ? { blocks: task.blocks } : {}),
      ...(task.threadTs ? { thread_ts: task.threadTs } : {}),
      mrkdwn: task.mrkdwn ?? true,
    });
    return { ok: true, ts: String(data["ts"] ?? ""), channel: String(data["channel"] ?? "") };
  }

  if (task.taskType === "slack.post-channel") {
    ctx.logger.info("slack.post-channel", { channelName: task.channelName });
    const data = await slackCall("chat.postMessage", token, {
      channel: `#${task.channelName}`,
      text: task.text,
      ...(task.blocks ? { blocks: task.blocks } : {}),
    });
    return { ok: true, ts: String(data["ts"] ?? ""), channel: String(data["channel"] ?? "") };
  }

  ctx.logger.info("slack.create-channel", { name: task.name });
  const data = await slackCall("conversations.create", token, {
    name: task.name,
    is_private: task.isPrivate ?? false,
  });
  const ch = data["channel"] as Record<string, unknown>;
  return { ok: true, channelId: String(ch["id"] ?? ""), channelName: String(ch["name"] ?? "") };
}

export const slackAdapter = defineAdapter<SlackTask, SlackPostResult | SlackCreateChannelResult>({
  name: "nexus-adapter-slack",
  version: "0.1.0",
  capabilities: ["communication.chat"],
  taskTypes: ["slack.post-message", "slack.post-channel", "slack.create-channel"],
  execute,
});
export default slackAdapter;
