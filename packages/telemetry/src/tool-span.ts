// SPDX-License-Identifier: Apache-2.0
/**
 * One span per tool call, with the tool name and permission tier.
 *
 * Uses the global tracer, so it is a no-op unless `startTracing()` installed a
 * provider; the agent runtime can always wrap calls without checking config.
 */
import { SpanStatusCode, trace } from "@opentelemetry/api";

/** Span name shared by every tool call. */
export const TOOL_SPAN_NAME = "tool.call";

/** Span name for one agent chat turn; tool spans nest inside it. */
export const TURN_SPAN_NAME = "agent.turn";

/** Run `fn` inside an `agent.turn` span, so a turn's tool calls share one trace. */
export async function withTurnSpan<T>(fn: () => Promise<T>): Promise<T> {
  return trace.getTracer("nexus-agent").startActiveSpan(TURN_SPAN_NAME, async (span) => {
    try {
      return await fn();
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Run `fn` inside a `tool.call` span carrying `tool.name` and `tool.tier`. */
export async function withToolSpan<T>(
  toolName: string,
  tier: string,
  fn: () => Promise<T>,
): Promise<T> {
  return trace
    .getTracer("nexus-agent")
    .startActiveSpan(
      TOOL_SPAN_NAME,
      { attributes: { "tool.name": toolName, "tool.tier": tier } },
      async (span) => {
        try {
          return await fn();
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
}
