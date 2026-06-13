// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock() is hoisted to the top of the file by Vitest's transform, so any
// variables it references must also be hoisted via vi.hoisted() — otherwise
// they sit in the temporal dead zone when the factory executes.
const { mockInsert, _mockInsertValues, mockInsertReturning, mockUpdate, _mockUpdateSet } =
  vi.hoisted(() => {
    const mockInsertReturning = vi.fn();
    const mockInsertValues = vi.fn(() => ({ returning: mockInsertReturning }));
    const mockInsert = vi.fn(() => ({ values: mockInsertValues }));
    const mockUpdateSet = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
    const mockUpdate = vi.fn(() => ({ set: mockUpdateSet }));
    return { mockInsert, mockInsertValues, mockInsertReturning, mockUpdate, mockUpdateSet };
  });

vi.mock("@nexus/db", () => ({
  db: { insert: mockInsert, update: mockUpdate },
  ingestedEvents: {},
  signals: {},
}));
vi.mock("drizzle-orm", () => ({ eq: vi.fn(), sql: vi.fn() }));

import { handleIngestJob, type IngestJobPayload } from "../../src/handlers/ingest-handler.js";

describe("handleIngestJob — classifyEvent routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: insert returns a signal row
    mockInsertReturning.mockResolvedValue([{ id: "sig-001" }]);
  });

  function makePayload(source: string, eventType: string): IngestJobPayload {
    return { eventId: "evt-1", source, eventType, payload: { foo: "bar" } };
  }

  it("classifies security events as critical", async () => {
    const result = (await handleIngestJob(makePayload("github", "security_alert"))) as {
      signalType: string;
      priority: string;
    };
    expect(result.priority).toBe("critical");
    expect(result.signalType).toMatch(/security-alert/);
  });

  it("classifies breach events as critical", async () => {
    const result = (await handleIngestJob(makePayload("siem", "data_breach"))) as {
      priority: string;
    };
    expect(result.priority).toBe("critical");
  });

  it("classifies deploy events as high", async () => {
    const result = (await handleIngestJob(makePayload("ci", "deploy_success"))) as {
      signalType: string;
      priority: string;
    };
    expect(result.priority).toBe("high");
    expect(result.signalType).toMatch(/deployment/);
  });

  it("classifies release events as high", async () => {
    const result = (await handleIngestJob(makePayload("github", "release_published"))) as {
      priority: string;
    };
    expect(result.priority).toBe("high");
  });

  it("classifies PR events as medium", async () => {
    const result = (await handleIngestJob(makePayload("github", "pull_request_opened"))) as {
      signalType: string;
      priority: string;
    };
    expect(result.priority).toBe("medium");
    expect(result.signalType).toMatch(/pr-event/);
  });

  it("classifies email events as medium", async () => {
    const result = (await handleIngestJob(makePayload("gmail", "email_received"))) as {
      priority: string;
    };
    expect(result.priority).toBe("medium");
  });

  it("classifies financial events as high", async () => {
    const result = (await handleIngestJob(makePayload("bloomberg", "market_update"))) as {
      priority: string;
    };
    expect(result.priority).toBe("high");
  });

  it("falls back to low priority for unknown event types", async () => {
    const result = (await handleIngestJob(makePayload("custom", "some_unknown_event"))) as {
      signalType: string;
      priority: string;
    };
    expect(result.priority).toBe("low");
    expect(result.signalType).toBe("custom.some_unknown_event");
  });

  it("returns signalId from DB insert", async () => {
    const result = (await handleIngestJob(makePayload("gh", "push"))) as {
      signalId: string;
    };
    expect(result.signalId).toBe("sig-001");
  });

  it("still completes when DB insert returns empty (no signalId)", async () => {
    mockInsertReturning.mockResolvedValue([]);
    const result = (await handleIngestJob(makePayload("gh", "push"))) as {
      signalId: undefined;
    };
    expect(result.signalId).toBeUndefined();
    // processedAt update should NOT have been called without a signal
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
