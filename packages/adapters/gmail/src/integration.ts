// SPDX-License-Identifier: Apache-2.0
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import { google } from "googleapis";

function gmailAuth() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env["GOOGLE_CLIENT_EMAIL"],
      private_key: (process.env["GOOGLE_PRIVATE_KEY"] ?? "").replace(/\\n/g, "\n"),
    },
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.modify",
    ],
    clientOptions: { subject: process.env["GOOGLE_IMPERSONATE_EMAIL"] },
  });
  return google.gmail({ version: "v1", auth });
}

function encodeMessage(to: string, subject: string, body: string, replyToId?: string): string {
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    ...(replyToId ? [`In-Reply-To: ${replyToId}`, `References: ${replyToId}`] : []),
  ].join("\r\n");
  return Buffer.from(`${headers}\r\n\r\n${body}`).toString("base64url");
}

export async function listEmails(
  query = "",
  maxResults = 20,
): Promise<{ id: string; subject: string; from: string; snippet: string; date: string }[]> {
  const gmail = gmailAuth();
  const list = await gmail.users.messages.list({ userId: "me", q: query, maxResults });
  const ids = list.data.messages ?? [];
  return Promise.all(
    ids.map(async (m) => {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: m.id!,
        format: "metadata",
        metadataHeaders: ["Subject", "From", "Date"],
      });
      const hdrs = msg.data.payload?.headers ?? [];
      return {
        id: m.id!,
        subject: hdrs.find((h) => h.name === "Subject")?.value ?? "",
        from: hdrs.find((h) => h.name === "From")?.value ?? "",
        date: hdrs.find((h) => h.name === "Date")?.value ?? "",
        snippet: msg.data.snippet ?? "",
      };
    }),
  );
}

export async function getEmail(
  id: string,
): Promise<{ subject: string; from: string; body: string }> {
  const gmail = gmailAuth();
  const msg = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  const hdrs = msg.data.payload?.headers ?? [];
  const rawBody = msg.data.payload?.parts?.[0]?.body?.data ?? "";
  return {
    subject: hdrs.find((h) => h.name === "Subject")?.value ?? "",
    from: hdrs.find((h) => h.name === "From")?.value ?? "",
    body: rawBody ? Buffer.from(rawBody, "base64").toString() : (msg.data.snippet ?? ""),
  };
}

export async function sendEmail(to: string, subject: string, body: string): Promise<string> {
  const gmail = gmailAuth();
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encodeMessage(to, subject, body) },
  });
  return res.data.id ?? "";
}

export async function replyEmail(
  messageId: string,
  to: string,
  subject: string,
  body: string,
): Promise<void> {
  const gmail = gmailAuth();
  const orig = await gmail.users.messages.get({ userId: "me", id: messageId, format: "minimal" });
  await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: encodeMessage(to, subject, body, messageId),
      threadId: orig.data.threadId ?? undefined,
    },
  });
}

export async function archiveEmail(messageId: string): Promise<void> {
  const gmail = gmailAuth();
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { removeLabelIds: ["INBOX"] },
  });
}
