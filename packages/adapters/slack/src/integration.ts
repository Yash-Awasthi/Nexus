// SPDX-License-Identifier: Apache-2.0
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import type { KnownBlock } from "@slack/web-api";
import { WebClient } from "@slack/web-api";

let _client: WebClient | null = null;

export function slack(): WebClient {
  if (!_client) {
    const token = process.env["SLACK_BOT_TOKEN"];
    if (!token) throw new Error("SLACK_BOT_TOKEN not set");
    _client = new WebClient(token);
  }
  return _client;
}

export async function postMessage(channel: string, text: string): Promise<string> {
  const res = await slack().chat.postMessage({ channel, text });
  return res.ts ?? "";
}

export async function postBlocks(channel: string, blocks: unknown[], text = ""): Promise<string> {
  const res = await slack().chat.postMessage({
    channel,
    text,
    blocks: blocks as KnownBlock[],
  });
  return res.ts ?? "";
}

export async function replyInThread(
  channel: string,
  threadTs: string,
  text: string,
): Promise<void> {
  await slack().chat.postMessage({ channel, text, thread_ts: threadTs });
}

export async function listChannels(): Promise<{ id: string; name: string }[]> {
  const res = await slack().conversations.list({ limit: 200 });
  return (res.channels ?? []).map((c) => ({ id: c.id ?? "", name: c.name ?? "" }));
}

export async function getChannelMessages(
  channel: string,
  limit = 20,
): Promise<{ ts: string; user: string; text: string }[]> {
  const res = await slack().conversations.history({ channel, limit });
  return (res.messages ?? []).map((m) => ({
    ts: m.ts ?? "",
    user: m.user ?? "unknown",
    text: (m.text ?? "").slice(0, 500),
  }));
}

export async function createChannel(name: string): Promise<{ id: string; name: string }> {
  const res = await slack().conversations.create({ name, is_private: false });
  return { id: res.channel?.id ?? "", name: res.channel?.name ?? "" };
}

export async function inviteToChannel(channel: string, users: string[]): Promise<void> {
  await slack().conversations.invite({ channel, users: users.join(",") });
}

export async function addReaction(channel: string, ts: string, name: string): Promise<void> {
  await slack().reactions.add({ channel, timestamp: ts, name });
}

export async function lookupUserByEmail(
  email: string,
): Promise<{ id: string; name: string } | null> {
  try {
    const res = await slack().users.lookupByEmail({ email });
    return { id: res.user?.id ?? "", name: res.user?.name ?? "" };
  } catch {
    return null;
  }
}
