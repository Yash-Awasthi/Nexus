/**
 * Agent-10: Calendar
 * ──────────────────
 * Google Calendar management: list, create, update, delete events, free/busy.
 */
import {
  AgentBase, AgentTask, AgentResult, AgentConfig,
  MessageBus, StateStore, ToolDefinition,
} from '@workspace/core';
import * as GoogleCal from '@workspace/integrations/googlecalendar';

const CONFIG: AgentConfig = {
  id:           'calendar',
  name:         'Calendar Agent',
  description:  'Google Calendar — schedule, reschedule, cancel, query free/busy',
  version:      '1.0.0',
  capabilities: ['list_events','create_event','update_event','delete_event','check_availability'],
  model:        'claude-opus-4-6',
  systemPrompt: [
    'You are the Calendar Agent. You manage Google Calendar for the user.',
    'Always confirm timezone when creating events — default to Asia/Kolkata (IST) unless specified.',
    'When checking availability, use get_free_busy before suggesting times.',
    'Prefer creating events with Google Meet links for remote meetings.',
    'Never delete recurring events without explicitly asking which instances.',
  ].join(' '),
};

export class CalendarAgent extends AgentBase {
  constructor(bus: MessageBus, state: StateStore) {
    super(CONFIG, bus, state);
  }

  protected registerTools(): void {
    const tools: ToolDefinition[] = [
      {
        name:        'list_events',
        description: 'List upcoming calendar events',
        inputSchema: {
          type: 'object',
          properties: {
            maxResults: { type: 'number', description: 'Max events to return (default 10)' },
            timeMin:    { type: 'string', description: 'Start time ISO 8601 (default: now)' },
            timeMax:    { type: 'string', description: 'End time ISO 8601' },
            calendarId: { type: 'string', description: 'Calendar ID (default: primary)' },
          },
        },
        handler: async ({ maxResults = 10, timeMin, timeMax, calendarId = 'primary' }:
          { maxResults?: number; timeMin?: string; timeMax?: string; calendarId?: string }) => {
          return GoogleCal.listEvents({ maxResults, timeMin: timeMin || new Date().toISOString(), timeMax, calendarId });
        },
      },
      {
        name:        'create_event',
        description: 'Create a new calendar event',
        inputSchema: {
          type: 'object',
          required: ['summary', 'start', 'end'],
          properties: {
            summary:     { type: 'string', description: 'Event title' },
            start:       { type: 'string', description: 'Start time ISO 8601' },
            end:         { type: 'string', description: 'End time ISO 8601' },
            description: { type: 'string', description: 'Event description' },
            attendees:   { type: 'array', items: { type: 'string' }, description: 'Attendee email addresses' },
            location:    { type: 'string', description: 'Physical or virtual location' },
            calendarId:  { type: 'string', description: 'Calendar ID (default: primary)' },
          },
        },
        handler: async ({ summary, start, end, description, attendees, location, calendarId = 'primary' }:
          { summary: string; start: string; end: string; description?: string;
            attendees?: string[]; location?: string; calendarId?: string }) => {
          return GoogleCal.createEvent({ summary, start, end, description, attendees, location, calendarId });
        },
      },
      {
        name:        'update_event',
        description: 'Update an existing calendar event',
        inputSchema: {
          type: 'object',
          required: ['eventId'],
          properties: {
            eventId:     { type: 'string', description: 'Google Calendar event ID' },
            summary:     { type: 'string', description: 'New event title' },
            start:       { type: 'string', description: 'New start time ISO 8601' },
            end:         { type: 'string', description: 'New end time ISO 8601' },
            description: { type: 'string', description: 'New description' },
            location:    { type: 'string', description: 'New location' },
            calendarId:  { type: 'string', description: 'Calendar ID (default: primary)' },
          },
        },
        handler: async ({ eventId, calendarId = 'primary', ...updates }:
          { eventId: string; calendarId?: string; [key: string]: unknown }) => {
          return GoogleCal.updateEvent({ eventId, calendarId, ...updates });
        },
      },
      {
        name:        'delete_event',
        description: 'Delete a calendar event',
        inputSchema: {
          type: 'object',
          required: ['eventId'],
          properties: {
            eventId:    { type: 'string', description: 'Google Calendar event ID' },
            calendarId: { type: 'string', description: 'Calendar ID (default: primary)' },
          },
        },
        handler: async ({ eventId, calendarId = 'primary' }:
          { eventId: string; calendarId?: string }) => {
          await GoogleCal.deleteEvent({ eventId, calendarId });
          return { deleted: true, eventId };
        },
      },
      {
        name:        'get_free_busy',
        description: 'Check free/busy slots for one or more calendars in a time range',
        inputSchema: {
          type: 'object',
          required: ['timeMin', 'timeMax'],
          properties: {
            timeMin:  { type: 'string', description: 'Range start ISO 8601' },
            timeMax:  { type: 'string', description: 'Range end ISO 8601' },
            calendars: { type: 'array', items: { type: 'string' }, description: 'Calendar IDs (default: [primary])' },
          },
        },
        handler: async ({ timeMin, timeMax, calendars = ['primary'] }:
          { timeMin: string; timeMax: string; calendars?: string[] }) => {
          return GoogleCal.getFreeBusy({ timeMin, timeMax, calendars });
        },
      },
    ];

    for (const t of tools) this.toolRegistry.register(t);
  }

  protected async handle(task: AgentTask): Promise<AgentResult> {
    const start = Date.now();
    const result = await this.runAgentLoop(task.input as string);
    return {
      taskId:     task.id,
      agentId:    this.config.id,
      success:    true,
      output:     result,
      durationMs: Date.now() - start,
    };
  }
}

export function createAgent(bus: MessageBus, state: StateStore): CalendarAgent {
  return new CalendarAgent(bus, state);
}
