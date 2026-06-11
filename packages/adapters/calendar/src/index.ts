// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/adapter-calendar — Google Calendar REST API.
 * Task types: calendar.create-event, calendar.list-events, calendar.delete-event
 */

import {
  defineAdapter,
  requireEnv,
  AdapterHttpError,
  type IExecutionContext,
} from "@nexus/plugin-sdk";

const CAL_BASE = "https://www.googleapis.com/calendar/v3";

export interface CalendarCreateEventTask {
  taskType: "calendar.create-event";
  calendarId?: string;
  summary: string;
  description?: string;
  start: string; // ISO 8601
  end: string; // ISO 8601
  attendees?: string[];
  timeZone?: string;
}

export interface CalendarListEventsTask {
  taskType: "calendar.list-events";
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
  maxResults?: number;
}

export interface CalendarDeleteEventTask {
  taskType: "calendar.delete-event";
  calendarId?: string;
  eventId: string;
}

export type CalendarTask =
  | CalendarCreateEventTask
  | CalendarListEventsTask
  | CalendarDeleteEventTask;

export interface CalendarEventResult {
  id: string;
  summary: string;
  htmlLink: string;
  start: string;
  end: string;
}

export interface CalendarListResult {
  events: CalendarEventResult[];
  nextPageToken?: string;
}

async function execute(
  task: CalendarTask,
  ctx: IExecutionContext,
): Promise<CalendarEventResult | CalendarListResult | { ok: boolean }> {
  const token = requireEnv(ctx, "GOOGLE_ACCESS_TOKEN");
  const calendarId = encodeURIComponent(
    ("calendarId" in task ? task.calendarId : undefined) ?? "primary",
  );

  if (task.taskType === "calendar.create-event") {
    ctx.logger.info("calendar.create-event", { summary: task.summary });
    const body = {
      summary: task.summary,
      description: task.description,
      start: { dateTime: task.start, timeZone: task.timeZone ?? "UTC" },
      end: { dateTime: task.end, timeZone: task.timeZone ?? "UTC" },
      attendees: task.attendees?.map((email) => ({ email })),
    };
    const response = await fetch(`${CAL_BASE}/calendars/${calendarId}/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok)
      throw new AdapterHttpError("nexus-adapter-calendar", response.status, await response.text());
    const data = (await response.json()) as {
      id: string;
      summary: string;
      htmlLink: string;
      start: { dateTime: string };
      end: { dateTime: string };
    };
    return {
      id: data.id,
      summary: data.summary,
      htmlLink: data.htmlLink,
      start: data.start.dateTime,
      end: data.end.dateTime,
    };
  }

  if (task.taskType === "calendar.list-events") {
    ctx.logger.info("calendar.list-events", { calendarId });
    const url = new URL(`${CAL_BASE}/calendars/${calendarId}/events`);
    if (task.timeMin) url.searchParams.set("timeMin", task.timeMin);
    if (task.timeMax) url.searchParams.set("timeMax", task.timeMax);
    url.searchParams.set("maxResults", String(task.maxResults ?? 20));
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    const response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok)
      throw new AdapterHttpError("nexus-adapter-calendar", response.status, await response.text());
    const data = (await response.json()) as {
      items: {
        id: string;
        summary: string;
        htmlLink: string;
        start: { dateTime: string };
        end: { dateTime: string };
      }[];
      nextPageToken?: string;
    };
    return {
      events: (data.items ?? []).map((e) => ({
        id: e.id,
        summary: e.summary,
        htmlLink: e.htmlLink,
        start: e.start.dateTime,
        end: e.end.dateTime,
      })),
      nextPageToken: data.nextPageToken,
    };
  }

  // calendar.delete-event
  ctx.logger.info("calendar.delete-event", { eventId: task.eventId });
  const response = await fetch(`${CAL_BASE}/calendars/${calendarId}/events/${task.eventId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok && response.status !== 204)
    throw new AdapterHttpError("nexus-adapter-calendar", response.status, await response.text());
  return { ok: true };
}

export const calendarAdapter = defineAdapter<
  CalendarTask,
  CalendarEventResult | CalendarListResult | { ok: boolean }
>({
  name: "nexus-adapter-calendar",
  version: "0.1.0",
  capabilities: ["storage.read", "storage.write"],
  taskTypes: ["calendar.create-event", "calendar.list-events", "calendar.delete-event"],
  execute,
});
export default calendarAdapter;
