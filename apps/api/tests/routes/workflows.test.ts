// SPDX-License-Identifier: Apache-2.0
/**
 * Workflows surface route tests — the §16.7 extraction of /workflows from
 * api-bridge.ts into routes/workflows.ts (CRUD + run).
 *
 * Runs are exercised hermetically with a passthrough `fn` step — no LLM, no
 * network. Agent/condition/parallel step kinds are not covered (agent steps
 * need a live driver; condition/parallel execute inline functions).
 *
 * The module-level workflow store is shared across tests in this file, so each
 * test uses a unique name and cleans up after itself.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";

import { runDueWorkflows } from "../../src/routes/workflows.js";
import { buildServer } from "../../src/server.js";

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildServer();
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

interface Workflow {
  id: string;
  name: string;
  steps: unknown[];
  status: string;
  createdAt: string;
}

interface WorkflowResult {
  status: "completed" | "suspended" | "error";
  result?: unknown;
  events?: unknown[];
}

let counter = 0;
function freshName(): string {
  counter += 1;
  return `e2e-wf-${counter}-${Date.now()}`;
}

/** Create a workflow and return its id (caller deletes it). */
async function createWorkflow(name: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/workflows",
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json<Workflow>().id;
}

describe("POST /api/workflows", () => {
  it("creates an idle workflow with empty steps", async () => {
    const id = await createWorkflow(freshName());
    const res = await app.inject({ method: "GET", url: "/api/workflows" });
    const wf = res.json<Workflow[]>().find((w) => w.id === id);
    expect(wf).toBeDefined();
    expect(wf!.status).toBe("idle");
    expect(wf!.steps).toEqual([]);

    const del = await app.inject({ method: "DELETE", url: `/api/workflows/${id}` });
    expect(del.statusCode).toBe(204);
  });
});

describe("PATCH /api/workflows/:id", () => {
  it("updates status and steps", async () => {
    const id = await createWorkflow(freshName());

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/workflows/${id}`,
      payload: { status: "running", steps: [{ id: "s1", kind: "fn" }] },
    });
    expect(patched.statusCode).toBe(200);
    const wf = patched.json<Workflow>();
    expect(wf.status).toBe("running");
    expect(wf.steps).toEqual([{ id: "s1", kind: "fn" }]);

    const del = await app.inject({ method: "DELETE", url: `/api/workflows/${id}` });
    expect(del.statusCode).toBe(204);
  });

  it("returns 404 for an unknown id", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/workflows/nope",
      payload: { status: "running" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });
});

describe("POST /api/workflows/:id/run", () => {
  it("returns 400 when the workflow has no steps", async () => {
    const id = await createWorkflow(freshName());
    const res = await app.inject({
      method: "POST",
      url: `/api/workflows/${id}/run`,
      payload: { input: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ status: string; error: string }>().error).toContain("no steps to run");

    const del = await app.inject({ method: "DELETE", url: `/api/workflows/${id}` });
    expect(del.statusCode).toBe(204);
  });

  it("runs a passthrough fn step to completion with input preserved", async () => {
    const id = await createWorkflow(freshName());
    const res = await app.inject({
      method: "POST",
      url: `/api/workflows/${id}/run`,
      payload: {
        input: { hello: "world" },
        steps: [{ id: "s1", kind: "fn" }],
      },
    });
    expect(res.statusCode).toBe(200);
    const result = res.json<WorkflowResult>();
    expect(result.status).toBe("completed");
    expect(result.result).toEqual({ hello: "world" });
    expect(Array.isArray(result.events)).toBe(true);

    const del = await app.inject({ method: "DELETE", url: `/api/workflows/${id}` });
    expect(del.statusCode).toBe(204);
  });

  it("hands an org_task step to a company agent as a task", async () => {
    const company = await app.inject({
      method: "POST",
      url: "/api/org/companies",
      payload: { name: freshName() },
    });
    const cid = company.json<{ id: string }>().id;
    const id = await createWorkflow(freshName());
    const res = await app.inject({
      method: "POST",
      url: `/api/workflows/${id}/run`,
      payload: {
        input: { topic: "pricing" },
        steps: [{ id: "s1", kind: "org_task", companyId: cid, title: "Research pricing" }],
      },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json<{ result: { topic: string; orgTask: { identifier: string } } }>().result;
    expect(out.topic).toBe("pricing");
    const tasks = await app.inject({ method: "GET", url: `/api/org/companies/${cid}/tasks` });
    const filed = tasks.json<{
      tasks: { identifier: string; title: string; description: string }[];
    }>().tasks;
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({
      identifier: out.orgTask.identifier,
      title: "Research pricing",
    });
    expect(filed[0]!.description).toContain('"topic": "pricing"');
    await app.inject({ method: "DELETE", url: `/api/workflows/${id}` });
    await app.inject({ method: "DELETE", url: `/api/org/companies/${cid}` });
  });

  it("returns 404 for an unknown workflow id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/workflows/nope/run",
      payload: { input: {} },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });
});

describe("workflow canvas", () => {
  it("keeps the editor's graph with the workflow", async () => {
    const made = await app.inject({
      method: "POST",
      url: "/api/workflows",
      payload: { name: "Canvas keeper" },
    });
    const id = made.json<{ id: string }>().id;
    const graph = {
      nodes: [{ id: "n1", position: { x: 1, y: 2 }, data: { label: "Start" } }],
      edges: [],
    };
    const saved = await app.inject({
      method: "PATCH",
      url: `/api/workflows/${id}`,
      payload: { steps: [], graph },
    });
    expect(saved.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/api/workflows" });
    const found = list.json<
      { id: string; graph?: unknown }[] | { workflows: { id: string; graph?: unknown }[] }
    >();
    const rows = Array.isArray(found) ? found : found.workflows;
    expect(rows.find((w) => w.id === id)?.graph).toEqual(graph);
  });
});

describe("scheduled workflows", () => {
  it("runs a workflow on its cron once per minute and refuses a bad schedule", async () => {
    const id = await createWorkflow(freshName());
    const bad = await app.inject({
      method: "PATCH",
      url: `/api/workflows/${id}`,
      payload: { schedule: "every monday" },
    });
    expect(bad.statusCode).toBe(400);

    const saved = await app.inject({
      method: "PATCH",
      url: `/api/workflows/${id}`,
      payload: { steps: [{ id: "s1", kind: "fn" }], schedule: "30 9 * * 1" },
    });
    expect(saved.json<{ schedule: string; nextRunAt: string }>()).toMatchObject({
      schedule: "30 9 * * 1",
      nextRunAt: expect.any(String),
    });

    const monday = new Date(2026, 8, 28, 9, 30, 5);
    expect(await runDueWorkflows(new Date(2026, 8, 28, 9, 31))).not.toContain(id);
    expect(await runDueWorkflows(monday)).toContain(id);
    expect(await runDueWorkflows(new Date(2026, 8, 28, 9, 30, 40))).not.toContain(id);

    const list = await app.inject({ method: "GET", url: "/api/workflows" });
    const row = list
      .json<{ id: string; status: string; lastResult?: { result?: unknown } }[]>()
      .find((w) => w.id === id);
    expect(row?.status).toBe("completed");
    expect(row?.lastResult?.result).toEqual({ scheduledAt: monday.toISOString() });

    const off = await app.inject({
      method: "PATCH",
      url: `/api/workflows/${id}`,
      payload: { schedule: null },
    });
    expect(off.json<{ schedule: unknown }>().schedule).toBeNull();
    expect(await runDueWorkflows(new Date(2026, 9, 5, 9, 30))).not.toContain(id);
    await app.inject({ method: "DELETE", url: `/api/workflows/${id}` });
  });
});
