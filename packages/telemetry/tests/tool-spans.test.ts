// SPDX-License-Identifier: Apache-2.0
/**
 * A `tool.call` span carries the tool's identity and any caller-supplied
 * attributes. The two-argument call must keep working, because existing tool
 * calls use it, and LSP callers add `lsp.language` and `lsp.operation`.
 */
import { beforeAll, describe, expect, it } from "vite-plus/test";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

import { startTracing } from "../src/otel.ts";
import { TOOL_SPAN_NAME, TURN_SPAN_NAME, withToolSpan, withTurnSpan } from "../src/tool-span.ts";

class MemoryExporter {
  readonly spans: ReadableSpan[] = [];

  export(spans: ReadableSpan[], done: (result: { code: number }) => void): void {
    this.spans.push(...spans);
    done({ code: 0 });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

const exporter = new MemoryExporter();

beforeAll(() => {
  startTracing("telemetry-test", exporter as unknown as SpanExporter);
});

function lastSpan(): ReadableSpan {
  const span = exporter.spans.at(-1);
  if (!span) throw new Error("no span was exported");
  return span;
}

describe("tool spans", () => {
  it("keeps the two-argument call working", async () => {
    exporter.spans.length = 0;
    const result = await withToolSpan("read_file", "read", async () => "contents");

    expect(result).toBe("contents");
    const span = lastSpan();
    expect(span.name).toBe(TOOL_SPAN_NAME);
    expect(span.attributes["tool.name"]).toBe("read_file");
    expect(span.attributes["tool.tier"]).toBe("read");
  });

  it("attaches caller-supplied attributes", async () => {
    exporter.spans.length = 0;
    await withToolSpan("lsp_definition", "read", async () => undefined, {
      "lsp.language": "typescript",
      "lsp.operation": "definition",
    });

    const span = lastSpan();
    expect(span.name).toBe(TOOL_SPAN_NAME);
    expect(span.attributes["lsp.language"]).toBe("typescript");
    expect(span.attributes["lsp.operation"]).toBe("definition");
    expect(span.attributes["tool.name"]).toBe("lsp_definition");
  });

  it("nests LSP tool calls under the turn span", async () => {
    exporter.spans.length = 0;
    await withTurnSpan(async () => {
      // Same call shape as the agent-core LSP wrapper: extra attrs on a tool span.
      await withToolSpan("lsp_definition", "auto_allowed", async () => undefined, {
        "lsp.language": "typescript",
        "lsp.operation": "definition",
      });
      await withToolSpan("lsp_references", "auto_allowed", async () => undefined, {
        "lsp.language": "typescript",
        "lsp.operation": "references",
      });
    });

    const turns = exporter.spans.filter((span) => span.name === TURN_SPAN_NAME);
    const tools = exporter.spans.filter((span) => span.name === TOOL_SPAN_NAME);
    expect(turns).toHaveLength(1);
    expect(tools).toHaveLength(2);

    const [turn] = turns;
    if (!turn) throw new Error("no turn span was exported");
    const turnContext = turn.spanContext();
    for (const tool of tools) {
      const toolContext = tool.spanContext();
      expect(toolContext.traceId).toBe(turnContext.traceId);
      expect(tool.parentSpanContext?.spanId).toBe(turnContext.spanId);
      expect(tool.attributes["lsp.language"]).toBe("typescript");
    }
  });
});
