// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/adapter-gmail — Gmail REST API.
 * Task types: gmail.send, gmail.list, gmail.read
 */

import {
  defineAdapter,
  requireEnv,
  AdapterHttpError,
  type IExecutionContext,
} from "@nexus/plugin-sdk";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailSendTask {
  taskType: "gmail.send";
  to: string | string[];
  subject: string;
  body: string;
  cc?: string[];
  replyToMessageId?: string;
}
export interface GmailListTask {
  taskType: "gmail.list";
  query?: string;
  maxResults?: number;
  labelIds?: string[];
}
export interface GmailReadTask {
  taskType: "gmail.read";
  messageId: string;
}
export type GmailTask = GmailSendTask | GmailListTask | GmailReadTask;
export interface GmailSendResult {
  id: string;
  threadId: string;
}
export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  body: string;
}
export interface GmailListResult {
  messages: { id: string; threadId: string; snippet: string }[];
  resultSizeEstimate: number;
}

function makeRfc2822(task: GmailSendTask): string {
  const to = Array.isArray(task.to) ? task.to.join(", ") : task.to;
  const cc = task.cc?.join(", ");
  const lines = [
    `To: ${to}`,
    `Subject: ${task.subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    ...(cc ? [`Cc: ${cc}`] : []),
    ...(task.replyToMessageId
      ? [`In-Reply-To: ${task.replyToMessageId}`, `References: ${task.replyToMessageId}`]
      : []),
    "",
    task.body,
  ];
  return lines.join("\r\n");
}

async function execute(
  task: GmailTask,
  ctx: IExecutionContext,
): Promise<GmailSendResult | GmailListResult | GmailMessage> {
  const token = requireEnv(ctx, "GMAIL_ACCESS_TOKEN");

  if (task.taskType === "gmail.send") {
    ctx.logger.info("gmail.send", { to: task.to, subject: task.subject });
    const raw = Buffer.from(makeRfc2822(task)).toString("base64url");
    const response = await fetch(`${GMAIL_BASE}/messages/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    if (!response.ok)
      throw new AdapterHttpError("nexus-adapter-gmail", response.status, await response.text());
    return response.json() as Promise<GmailSendResult>;
  }

  if (task.taskType === "gmail.list") {
    ctx.logger.info("gmail.list", { query: task.query });
    const url = new URL(`${GMAIL_BASE}/messages`);
    if (task.query) url.searchParams.set("q", task.query);
    if (task.labelIds?.length) url.searchParams.set("labelIds", task.labelIds.join(","));
    url.searchParams.set("maxResults", String(task.maxResults ?? 20));
    const response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok)
      throw new AdapterHttpError("nexus-adapter-gmail", response.status, await response.text());
    return response.json() as Promise<GmailListResult>;
  }

  // gmail.read
  ctx.logger.info("gmail.read", { messageId: task.messageId });
  const response = await fetch(`${GMAIL_BASE}/messages/${task.messageId}?format=full`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok)
    throw new AdapterHttpError("nexus-adapter-gmail", response.status, await response.text());
  const data = (await response.json()) as {
    id: string;
    threadId: string;
    snippet: string;
    payload: { headers: { name: string; value: string }[]; body: { data?: string } };
  };
  const headers = Object.fromEntries(
    data.payload.headers.map((h) => [h.name.toLowerCase(), h.value]),
  );
  const body = data.payload.body.data
    ? Buffer.from(data.payload.body.data, "base64").toString()
    : data.snippet;
  return {
    id: data.id,
    threadId: data.threadId,
    subject: headers["subject"] ?? "",
    from: headers["from"] ?? "",
    date: headers["date"] ?? "",
    snippet: data.snippet,
    body,
  };
}

export const gmailAdapter = defineAdapter<
  GmailTask,
  GmailSendResult | GmailListResult | GmailMessage
>({
  name: "nexus-adapter-gmail",
  version: "0.1.0",
  capabilities: ["communication.email"],
  taskTypes: ["gmail.send", "gmail.list", "gmail.read"],
  execute,
});
export default gmailAdapter;
