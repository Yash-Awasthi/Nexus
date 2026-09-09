// SPDX-License-Identifier: Apache-2.0
// Served graphrag (pass 71) — graphrag local + global search as MCP tools.
// These tests drive the real McpHttpServer JSON-RPC handle() seam (the same
// seam the worker/CLI localMcpToolsFromServer bridge and any HTTP host use):
// tools/list advertises both tools, local search round-trips the grounded
// answer (single LLM pass, no-match never calls the model), global search runs
// the map-reduce over community reports, and the error paths hold.
import { describe, expect, it } from "vitest";

import { createGraphRagMcpServer } from "../src/mcp-server.js";
import type { QueryRouter } from "../src/index.js";
import type { IndexedEntity, IndexedRelation } from "../src/index-graphrag.js";

/** Scripted router cycling through canned completions. */
function stubRouter(contents: string[]): { router: QueryRouter; calls: number } {
  let calls = 0;
  return {
    router: {
      async complete(_p: { model: string; messages: Array<{ role: string; content: string }> }) {
        calls++;
        return { content: contents[Math.min(calls - 1, contents.length - 1)]! };
      },
    },
    get calls() {
      return calls;
    },
  };
}

const ent = (name: string, descriptions: string[], mentions = 1): IndexedEntity => ({
  name,
  type: "entity",
  descriptions,
  mentions,
});

const rel = (source: string, target: string, type = "rel"): IndexedRelation => ({
  source,
  target,
  type,
  descriptions: [`${source} ${type} ${target}`],
  mentions: 1,
});

const ENTITIES = [
  ent("acme aerospace", ["builds rockets"], 5),
  ent("rocket engine", ["combustion chamber"], 2),
  ent("green energy", ["solar panels"], 2),
];
const RELATIONS = [rel("acme aerospace", "rocket engine")];

const REPORTS = [
  {
    id: "c1",
    communityId: "com-1",
    level: 0,
    title: "rocket propulsion report",
    summary: "Acme builds rocket engines for orbital launches.",
    fullContent: "full",
    rank: 1,
    rating: 0.5,
    findings: ["acme builds rocket engines"],
    entities: ["acme aerospace", "rocket engine"],
    createdAt: 1_700_000_000,
  },
  {
    id: "c2",
    communityId: "com-2",
    level: 0,
    title: "solar panel report",
    summary: "Green energy makes solar panels.",
    fullContent: "full",
    rank: 1,
    rating: 0.5,
    findings: ["green energy makes solar"],
    entities: ["green energy"],
    createdAt: 1_700_000_000,
  },
];

function makeServer(contents: string[]) {
  const stub = stubRouter(contents);
  const server = createGraphRagMcpServer({
    entities: ENTITIES,
    relations: RELATIONS,
    reports: REPORTS,
    router: stub.router,
  });
  return { server, stub };
}

type RpcResult = {
  result?: { content?: { text?: string }[]; isError?: boolean };
  error?: { code?: number; message?: string };
};

async function call(
  server: ReturnType<typeof makeServer>["server"],
  method: string,
  params: Record<string, unknown> = {},
) {
  const res = await server.handle({
    method: "POST",
    path: "/mcp",
    body: { jsonrpc: "2.0", id: 1, method, params },
  });
  return res.body as RpcResult;
}

describe("createGraphRagMcpServer (served graphrag local + global search)", () => {
  it("advertises both search tools with question required", async () => {
    const { server } = makeServer(["x"]);
    const init = await call(server, "initialize", {
      protocolVersion: "2026-07-28",
      clientInfo: { name: "test-client" },
    });
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe(
      "graphrag (for test-client)",
    );

    const list = await call(server, "tools/list");
    const tools = (
      list.result as { tools: Array<{ name: string; inputSchema: { required?: string[] } }> }
    ).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["graphrag_global_search", "graphrag_local_search"].sort(),
    );
    for (const t of tools) expect(t.inputSchema.required).toEqual(["question"]);
  });

  it("round-trips a local search: grounded answer, entities used, one LLM pass", async () => {
    const { server, stub } = makeServer(["acme builds rockets for orbit."]);
    const res = await call(server, "tools/call", {
      name: "graphrag_local_search",
      arguments: { question: "acme aerospace" },
    });
    expect(res.error).toBeUndefined();
    expect(stub.calls).toBe(1); // single-pass, no map-reduce
    const parsed = JSON.parse((res.result as { content: { text: string }[] }).content[0]!.text) as {
      answer: string;
      entitiesUsed: string[];
      relationshipsUsed: unknown[];
      context: string;
      durationMs: number;
    };
    expect(parsed.answer).toBe("acme builds rockets for orbit.");
    expect(parsed.entitiesUsed).toContain("acme aerospace");
    expect(parsed.entitiesUsed).not.toContain("green energy");
    expect(parsed.relationshipsUsed.length).toBeGreaterThan(0);
    expect(parsed.context).toContain("-----Entities-----");
    expect(parsed.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("answers a no-match local search without ever calling the model", async () => {
    const { server, stub } = makeServer([]);
    const res = await call(server, "tools/call", {
      name: "graphrag_local_search",
      arguments: { question: "quantum computing" },
    });
    expect(res.error).toBeUndefined();
    expect(stub.calls).toBe(0);
    const parsed = JSON.parse((res.result as { content: { text: string }[] }).content[0]!.text) as {
      answer: string;
      entitiesUsed: string[];
    };
    expect(parsed.entitiesUsed).toEqual([]);
    expect(parsed.answer).toMatch(/No entities/);
  });

  it("round-trips a global search: map-reduce over community reports", async () => {
    const { server, stub } = makeServer(["rocket facts", "global final answer"]);
    const res = await call(server, "tools/call", {
      name: "graphrag_global_search",
      arguments: { question: "rocket engine", maxCommunities: 1 },
    });
    expect(res.error).toBeUndefined();
    expect(stub.calls).toBe(2); // one map completion + one reduce completion
    const parsed = JSON.parse((res.result as { content: { text: string }[] }).content[0]!.text) as {
      answer: string;
      communitiesUsed: Array<{ id: string; title: string }>;
      durationMs: number;
    };
    expect(parsed.answer).toBe("global final answer");
    expect(parsed.communitiesUsed).toHaveLength(1);
    expect(parsed.communitiesUsed[0]!.id).toBe("c1"); // the rocket report outranks solar
    expect(parsed.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("errors on an unknown tool and a missing question without leaking stacks", async () => {
    const { server } = makeServer(["x"]);
    const unknown = await call(server, "tools/call", { name: "nope", arguments: {} });
    expect(unknown.error?.code).toBe(-32602);

    for (const name of ["graphrag_local_search", "graphrag_global_search"]) {
      const missing = await call(server, "tools/call", { name, arguments: {} });
      expect(missing.error).toBeUndefined(); // guard is an isError result
      expect((missing.result as { isError: boolean }).isError).toBe(true);
    }
  });
});
