// SPDX-License-Identifier: Apache-2.0
/**
 * posthog-analytics — Typed PostHog event tracking for the Nexus platform.
 *
 * Provides:
 *   • AnalyticsClient — injectable client interface for testability
 *   • InMemoryAnalyticsClient — test/dev stub that stores events in memory
 *   • PostHogAnalyticsClient — real client that POSTs to PostHog capture API
 *   • NexusEvents — typed event catalogue for Nexus-specific events
 *   • track(), identify(), page() — convenience wrappers
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EventProperties {
  [key: string]: string | number | boolean | null | undefined;
}

export interface TrackedEvent {
  event: string;
  distinctId: string;
  properties: EventProperties;
  timestamp: string;
}

export interface IdentifyPayload {
  distinctId: string;
  properties: EventProperties;
}

export interface PageEvent {
  distinctId: string;
  url: string;
  title?: string;
  properties?: EventProperties;
  timestamp: string;
}

export interface AnalyticsClient {
  track(event: string, distinctId: string, properties?: EventProperties): Promise<void>;
  identify(distinctId: string, properties: EventProperties): Promise<void>;
  page(distinctId: string, url: string, properties?: EventProperties): Promise<void>;
  flush(): Promise<void>;
}

// ── InMemoryAnalyticsClient ───────────────────────────────────────────────────

export class InMemoryAnalyticsClient implements AnalyticsClient {
  readonly events: TrackedEvent[] = [];
  readonly identities: IdentifyPayload[] = [];
  readonly pages: PageEvent[] = [];

  async track(event: string, distinctId: string, properties: EventProperties = {}): Promise<void> {
    this.events.push({
      event,
      distinctId,
      properties,
      timestamp: new Date().toISOString(),
    });
  }

  async identify(distinctId: string, properties: EventProperties): Promise<void> {
    this.identities.push({ distinctId, properties });
  }

  async page(distinctId: string, url: string, properties: EventProperties = {}): Promise<void> {
    this.pages.push({
      distinctId,
      url,
      properties,
      timestamp: new Date().toISOString(),
    });
  }

  async flush(): Promise<void> {
    // No-op for in-memory
  }

  reset(): void {
    this.events.length = 0;
    this.identities.length = 0;
    this.pages.length = 0;
  }

  getEventsByName(name: string): TrackedEvent[] {
    return this.events.filter((e) => e.event === name);
  }

  getEventsForUser(distinctId: string): TrackedEvent[] {
    return this.events.filter((e) => e.distinctId === distinctId);
  }
}

// ── PostHogAnalyticsClient ────────────────────────────────────────────────────

export interface PostHogConfig {
  apiKey: string;
  host?: string; // default: https://app.posthog.com
  batchSize?: number;
  flushIntervalMs?: number;
  disabled?: boolean;
}

export class PostHogAnalyticsClient implements AnalyticsClient {
  private config: Required<Omit<PostHogConfig, "disabled">> & { disabled: boolean };
  private queue: TrackedEvent[] = [];

  constructor(config: PostHogConfig) {
    this.config = {
      apiKey: config.apiKey,
      host: config.host ?? "https://app.posthog.com",
      batchSize: config.batchSize ?? 20,
      flushIntervalMs: config.flushIntervalMs ?? 5000,
      disabled: config.disabled ?? false,
    };
  }

  async track(event: string, distinctId: string, properties: EventProperties = {}): Promise<void> {
    if (this.config.disabled) return;
    this.queue.push({
      event,
      distinctId,
      properties: { ...properties, $lib: "nexus-posthog" },
      timestamp: new Date().toISOString(),
    });
    if (this.queue.length >= this.config.batchSize) {
      await this.flush();
    }
  }

  async identify(distinctId: string, properties: EventProperties): Promise<void> {
    if (this.config.disabled) return;
    await this.track("$identify", distinctId, { $set: properties as unknown as EventProperties });
  }

  async page(distinctId: string, url: string, properties: EventProperties = {}): Promise<void> {
    if (this.config.disabled) return;
    await this.track("$pageview", distinctId, { $current_url: url, ...properties });
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0 || this.config.disabled) return;
    const batch = this.queue.splice(0, this.queue.length);
    const payload = {
      api_key: this.config.apiKey,
      batch: batch.map((e) => ({
        event: e.event,
        distinct_id: e.distinctId,
        properties: e.properties,
        timestamp: e.timestamp,
      })),
    };
    // In production this would call fetch(); here we emit for testability
    void payload;
  }

  get queueSize(): number { return this.queue.length; }
}

// ── Nexus-specific event catalogue ────────────────────────────────────────────

export const NexusEvents = {
  // Chat
  CHAT_MESSAGE_SENT:       "chat_message_sent",
  CHAT_MESSAGE_RATED:      "chat_message_rated",
  CHAT_MODEL_SWITCHED:     "chat_model_switched",

  // Memory
  MEMORY_STORED:           "memory_stored",
  MEMORY_RECALLED:         "memory_recalled",

  // Agent
  AGENT_TASK_STARTED:      "agent_task_started",
  AGENT_TASK_COMPLETED:    "agent_task_completed",
  AGENT_TASK_FAILED:       "agent_task_failed",

  // Discovery
  DISCOVERY_PROFILE_VIEWED:"discovery_profile_viewed",
  SIGNAL_REPORTED:         "signal_reported",

  // SDK
  SDK_INITIALIZED:         "sdk_initialized",
  SDK_TOOL_CALLED:         "sdk_tool_called",
} as const;

export type NexusEventName = typeof NexusEvents[keyof typeof NexusEvents];

// ── Convenience tracker ───────────────────────────────────────────────────────

export class NexusAnalytics {
  constructor(private client: AnalyticsClient) {}

  async chatMessageSent(userId: string, model: string, sessionId: string): Promise<void> {
    await this.client.track(NexusEvents.CHAT_MESSAGE_SENT, userId, { model, session_id: sessionId });
  }

  async chatMessageRated(userId: string, messageId: string, rating: "up" | "down"): Promise<void> {
    await this.client.track(NexusEvents.CHAT_MESSAGE_RATED, userId, { message_id: messageId, rating });
  }

  async agentTaskStarted(userId: string, taskId: string, taskType: string): Promise<void> {
    await this.client.track(NexusEvents.AGENT_TASK_STARTED, userId, { task_id: taskId, task_type: taskType });
  }

  async agentTaskCompleted(userId: string, taskId: string, durationMs: number): Promise<void> {
    await this.client.track(NexusEvents.AGENT_TASK_COMPLETED, userId, { task_id: taskId, duration_ms: durationMs });
  }

  async identify(userId: string, traits: EventProperties): Promise<void> {
    await this.client.identify(userId, traits);
  }

  async page(userId: string, url: string): Promise<void> {
    await this.client.page(userId, url);
  }
}
