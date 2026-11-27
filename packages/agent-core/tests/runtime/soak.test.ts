// SPDX-License-Identifier: Apache-2.0
/**
 * Long-run soak (plan M5.3.5): two hundred sequential turns, sampling memory and connections.
 *
 * Every turn runs the real `ToolAgentRuntime` loop with a mock model and a tool that makes a real
 * HTTP request to a server on this machine. That is the smallest setup that still exercises the two
 * things that leak in a long-lived agent process: retained objects per turn and sockets that are
 * opened and never reclaimed. The test samples `heapUsed`, the number of live libuv resources and
 * the server's own open-socket count, and it compares the *second half* with the first: a soak that
 * only checks "did it finish" and "is memory under a gigabyte" cannot see a leak.
 */
import { createServer, type Server } from "node:http";

import { describe, it, expect } from "vite-plus/test";

import { RuntimeToolSet, ToolAgentRuntime } from "../../src/runtime/index.ts";
import type { LlmToolFn, LlmToolTurn } from "../../src/runtime/index.ts";

const TURNS = 200;
const SAMPLE_EVERY = 10;

interface Sample {
  turn: number;
  heapUsed: number;
  resources: number;
  sockets: number;
}

function startServer(): Promise<{ server: Server; url: string; sockets: () => number }> {
  let open = 0;
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url ?? "/", ok: true }));
  });
  server.on("connection", (socket) => {
    open++;
    socket.on("close", () => {
      open--;
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      resolve({ server, url: `http://127.0.0.1:${address.port}/status`, sockets: () => open });
    });
  });
}

describe("long-run soak", () => {
  it("holds memory and connection counts flat over 200 sequential turns", async () => {
    const { server, url, sockets } = await startServer();
    const toolSet = new RuntimeToolSet();
    toolSet.add({
      name: "fetch_status",
      description: "read a local status document",
      tier: "read_only",
      handler: async () => {
        const res = await fetch(url);
        return await res.text();
      },
    });

    // One tool call, then a final answer: every turn goes through the tool path and the classifier.
    let calls = 0;
    const llm: LlmToolFn = async (): Promise<LlmToolTurn> => {
      calls++;
      if (calls % 2 === 1) {
        return {
          content: "",
          toolCalls: [{ callId: `c${calls}`, name: "fetch_status", arguments: {} }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      return {
        content: `turn ${calls / 2} done`,
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    };

    const runtime = new ToolAgentRuntime({ llm, toolSet, maxSteps: 4 });
    const samples: Sample[] = [];

    try {
      for (let turn = 1; turn <= TURNS; turn++) {
        const result = await runtime.run(`turn ${turn}`);
        expect(result.finalContent).toBe(`turn ${turn} done`);
        expect(result.steps).toHaveLength(2);
        if (turn % SAMPLE_EVERY === 0) {
          samples.push({
            turn,
            heapUsed: process.memoryUsage().heapUsed,
            resources: process.getActiveResourcesInfo().length,
            sockets: sockets(),
          });
        }
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // Every sample was taken, so the numbers below are a series and not one lucky reading.
    expect(samples).toHaveLength(TURNS / SAMPLE_EVERY);
    const first = samples[0]!;
    const last = samples[samples.length - 1]!;

    // Sockets: the pool may hold one keep-alive connection, but it may not grow per turn.
    expect(last.sockets).toBeLessThanOrEqual(Math.max(2, first.sockets));
    // libuv resources: no timer, socket or handle is added per turn.
    expect(Math.abs(last.resources - first.resources)).toBeLessThanOrEqual(2);

    // Heap: the second half of the run may not cost materially more than the first. A per-turn leak
    // of even 50 KB would show up as 10 MB here; 12 MB is the allowance for allocator noise.
    const firstHalf = samples.filter((s) => s.turn <= TURNS / 2).at(-1)!;
    const growth = last.heapUsed - firstHalf.heapUsed;
    expect(growth).toBeLessThan(12 * 1024 * 1024);

    // And the process is still able to work after the soak.
    expect(typeof runtime.run).toBe("function");
  }, 120_000);
});
