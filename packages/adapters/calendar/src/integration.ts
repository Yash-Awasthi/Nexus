// SPDX-License-Identifier: Apache-2.0
// @ts-nocheck
import { google } from "googleapis";

function calAuth() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env["GOOGLE_CLIENT_EMAIL"],
      private_key: (process.env["GOOGLE_PRIVATE_KEY"] ?? "").replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/calendar"],
    clientOptions: { subject: process.env["GOOGLE_IMPERSONATE_EMAIL"] },
  });
  return google.calendar({ version: "v3", auth });
}

export async function listEvents(
  calendarId = "primary",
  timeMin?: string,
  timeMax?: string,
  maxResults = 20,
): Promise<{ id: string; summary: string; start: string; end: string; location?: string }[]> {
  const cal = calAuth();
  const now = new Date().toISOString();
  const res = await cal.events.list({
    calendarId,
    timeMin: timeMin ?? now,
    timeMax,
    maxResults,
    singleEvents: true,
    orderBy: "startTime",
  });
  return (res.data.items ?? []).map((e) => ({
    id: e.id ?? "",
    summary: e.summary ?? "",
    start: e.start?.dateTime ?? e.start?.date ?? "",
    end: e.end?.dateTime ?? e.end?.date ?? "",
    location: e.location ?? undefined,
  }));
}

export async function createEvent(opts: {
  summary: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  attendees?: string[];
  calendarId?: string;
}): Promise<{ id: string; htmlLink: string }> {
  const cal = calAuth();
  const res = await cal.events.insert({
    calendarId: opts.calendarId ?? "primary",
    requestBody: {
      summary: opts.summary,
      description: opts.description,
      location: opts.location,
      start: { dateTime: opts.start, timeZone: "Asia/Kolkata" },
      end: { dateTime: opts.end, timeZone: "Asia/Kolkata" },
      attendees: opts.attendees?.map((email) => ({ email })),
    },
  });
  return { id: res.data.id ?? "", htmlLink: res.data.htmlLink ?? "" };
}

export async function updateEvent(
  eventId: string,
  updates: { summary?: string; start?: string; end?: string; description?: string },
  calendarId = "primary",
): Promise<void> {
  const cal = calAuth();
  const requestBody: Record<string, unknown> = {};
  if (updates.summary) requestBody["summary"] = updates.summary;
  if (updates.description) requestBody["description"] = updates.description;
  if (updates.start) requestBody["start"] = { dateTime: updates.start, timeZone: "Asia/Kolkata" };
  if (updates.end) requestBody["end"] = { dateTime: updates.end, timeZone: "Asia/Kolkata" };
  await cal.events.patch({ calendarId, eventId, requestBody });
}

export async function deleteEvent(eventId: string, calendarId = "primary"): Promise<void> {
  await calAuth().events.delete({ calendarId, eventId });
}

export async function getFreeBusy(
  emails: string[],
  start: string,
  end: string,
): Promise<Record<string, { start: string; end: string }[]>> {
  const cal = calAuth();
  const res = await cal.freebusy.query({
    requestBody: {
      timeMin: start,
      timeMax: end,
      timeZone: "Asia/Kolkata",
      items: emails.map((id) => ({ id })),
    },
  });
  const result: Record<string, { start: string; end: string }[]> = {};
  for (const [email, cal_] of Object.entries(res.data.calendars ?? {})) {
    result[email] = (cal_.busy ?? []).map((b) => ({ start: b.start ?? "", end: b.end ?? "" }));
  }
  return result;
}
