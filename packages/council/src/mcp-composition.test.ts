// SPDX-License-Identifier: Apache-2.0
/**
 * MCP composition — @nexus/council served over the MCP HTTP surface.
 *
 * The campaign's other half of the MCP story: @nexus/mcp-client's
 * McpHttpServer serves tools, and a council tool is exactly the kind of
 * capability a host (Claude Desktop, an agent runtime) would call. This
 * wires DeliberativeCouncil behind a `council.deliberate` tool and drives
 * the full JSON-RPC surface: initialize → tools/list → tools/call → verdict.
 */
import { describe, expect, it } from "vitest";
import { McpHttpServer, type McpCallResult } from "@nexus/mcp-client";
import { DeliberativeCouncil } from "./deliberative.js";
import type { Archetype } from "./archetypes.js";
import type { ILLMResponse, ILLMTransport } from "./engine.js";

const PANEL: Archetype[] = [
  {
    id: "architect",
    name: "The Architect",
    thinkingStyle: "systems-first, long-term structural view",
    asks: "What breaks at scale?",
    blindSpot: "immediate costs",
    systemPrompt: "You are The Architect. Focus on structure, interfaces, and durability.",
  },
  {
    id: "minimalist",
    name: "The Minimalist",
    thinkingStyle: "do the least that works",
    asks: "What can we cut?",
    blindSpot: "future-proofing",
    systemPrompt: "You are The Minimalist. Cut scope until only essentials remain.",
  },
];

/** Deterministic transport: phases are recognised from the user prompt. */
function fakeTransport(): ILLMTransport {
  return {
    async chat(messages): Promise<ILLMResponse> {
      const user = messages.find((m) => m.role === "user")?.content ?? "";
      let content = "";
      if (user.includes("brought this question to the council")) {
        const name = messages.find((m) => m.role === "system")?.content?.slice(9, 25) ?? "";
        content = `Position from ${name}: the plan is workable if scoped tightly.`;
      } else if (user.includes("advisors independently answered this question")) {
        content =
          "1. Strongest: B — grounded in the evidence.\n" +
          "2. Biggest blind spot: A — it ignores rollout cost.\n" +
          "3. Missed by all: the timeline is unrealistic.";
      } else if (user.includes("Produce the COUNCIL VERDICT")) {
        content =
          "AGREEMENTS:\n" +
          "- everyone agrees scope matters\n" +
          "\n" +
          "CLASHES:\n" +
          "- The Architect wants modularity now; the Minimalist wants to defer it\n" +
          "\n" +
          "BLIND SPOTS:\n" +
          "- only the review round surfaced the rollout risk\n" +
          "\n" +
          "RECOMMENDATION:\n" +
          "Start small and ship the module behind a flag.\n" +
          "\n" +
          "NEXT ACTION:\n" +
          "Draft the RFC this week.";
      }
      return {
        content,
        model: "fake",
        usage: { promptTokens: 10, completionTokens: 20 },
        latencyMs: 1,
      };
    },
  };
}

function makeServer() {
  const council = new DeliberativeCouncil({ llm: fakeTransport(), advisors: PANEL });
  const server = new McpHttpServer({
    name: "council",
    version: "1.0.0",
    tools: [
      {
        name: "council.deliberate",
        description: "Run the deliberative council on a question and return its verdict.",
        inputSchema: {
          type: "object",
          properties: {
            question: { type: "string" },
            context: { type: "string" },
          },
          required: ["question"],
        },
      },
    ],
    execute: async (name, args): Promise<McpCallResult> => {
      if (name !== "council.deliberate") throw new Error(`unknown tool ${name}`);
      const outcome = await council.run(String(args.question ?? ""), String(args.context ?? ""));
      return {
        content: [{ type: "text", text: JSON.stringify(outcome.verdict, null, 2) }],
        text: JSON.stringify(outcome.verdict),
      };
    },
  });
  return { server, council };
}

const listRequest = {
  method: "POST",
  path: "/mcp",
  body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
};

describe("DeliberativeCouncil over MCP", () => {
  it("advertises the council tool with its schema", async () => {
    const { server } = makeServer();
    const res = await server.handle(listRequest);
    const tools = (res.body as { result: { tools: { name: string }[] } }).result.tools;
    expect(tools.map((t) => t.name)).toEqual(["council.deliberate"]);
  });

  it("runs the full council flow through tools/call and returns the verdict", async () => {
    const { server } = makeServer();
    const res = await server.handle({
      method: "POST",
      path: "/mcp",
      body: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "council.deliberate",
          arguments: { question: "Should we adopt a queue-based pipeline?" },
        },
      },
    });
    const result = (res.body as { result: { content: { text: string }[] } }).result;
    const verdict = JSON.parse(result.content[0]!.text) as {
      agreements: string[];
      clashes: string[];
      blindSpots: string[];
      recommendation: string;
      nextAction: string;
    };
    expect(verdict.agreements.length).toBeGreaterThan(0);
    expect(verdict.clashes.length).toBeGreaterThan(0);
    expect(verdict.recommendation).toContain("flag");
    expect(verdict.nextAction).toContain("RFC");
  });

  it("routes an unknown tool name to the JSON-RPC error contract", async () => {
    const { server } = makeServer();
    const res = await server.handle({
      method: "POST",
      path: "/mcp",
      body: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "nope", arguments: {} },
      },
    });
    expect((res.body as { error: { code: number } }).error.code).toBe(-32602);
  });

  it("does not leak executor failures as stack traces", async () => {
    const server = new McpHttpServer({
      name: "council",
      version: "1.0.0",
      tools: [{ name: "boom", inputSchema: { type: "object" } }],
      execute: async () => {
        throw new Error("secret internals");
      },
    });
    const res = await server.handle({
      method: "POST",
      path: "/mcp",
      body: {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "boom", arguments: {} },
      },
    });
    const err = (res.body as { error: { code: number; message: string } }).error;
    expect(err.code).toBe(-32603);
    expect(err.message).toContain("secret internals");
    expect(err.message).not.toContain("at ");
  });
});