// SPDX-License-Identifier: Apache-2.0
import { globalBus, type SseEvent } from "@nexus/sse";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleAgentEventMessage } from "../../src/lib/agent-events-bridge.js";

afterEach(() => globalBus.clearAll());

describe("handleAgentEventMessage", () => {
  it("dispatches a valid event onto the agent:<stream> channel", () => {
    const listener = vi.fn();
    globalBus.subscribe("agent:run-1", listener);

    handleAgentEventMessage(
      JSON.stringify({ stream: "run-1", type: "step", data: { stepIndex: 2 }, ts: 9 }),
    );

    expect(listener).toHaveBeenCalledTimes(1);
    const ev = listener.mock.calls[0]?.[0] as SseEvent<{ stream: string; stepIndex: number }>;
    expect(ev.event).toBe("agent.step");
    expect(ev.data).toEqual({ stream: "run-1", stepIndex: 2 });
    expect(ev.id).toBe("agent-run-1-9");
  });

  it("also reaches the firehose channel", () => {
    const firehose = vi.fn();
    globalBus.subscribe("agent", firehose);
    handleAgentEventMessage(JSON.stringify({ stream: "x", type: "status", data: {}, ts: 1 }));
    expect(firehose).toHaveBeenCalledTimes(1);
  });

  it("drops malformed JSON without throwing", () => {
    const firehose = vi.fn();
    globalBus.subscribe("agent", firehose);
    expect(() => handleAgentEventMessage("not json{")).not.toThrow();
    expect(firehose).not.toHaveBeenCalled();
  });

  it("drops events missing stream/type", () => {
    const firehose = vi.fn();
    globalBus.subscribe("agent", firehose);
    handleAgentEventMessage(JSON.stringify({ data: {}, ts: 1 }));
    handleAgentEventMessage(JSON.stringify({ stream: "x", data: {} }));
    expect(firehose).not.toHaveBeenCalled();
  });

  it("defaults missing ts/data to safe values", () => {
    const listener = vi.fn();
    globalBus.subscribe("agent:y", listener);
    handleAgentEventMessage(JSON.stringify({ stream: "y", type: "run_started" }));
    const ev = listener.mock.calls[0]?.[0] as SseEvent<{ stream: string }>;
    expect(ev.id).toBe("agent-y-0");
    expect(ev.data).toEqual({ stream: "y" });
  });
});
