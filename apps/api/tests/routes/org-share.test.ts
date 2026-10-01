// SPDX-License-Identifier: Apache-2.0
/**
 * A company shared into a workspace: members read it and comment on its tasks.
 * Everything else, and every effect a board comment has, stays with the owner.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const SECRET = "org-share-test-secret";
const DB = "pglite://:memory:org-share-test";

process.env.NEXUS_JWT_SECRET = SECRET;
process.env.DATABASE_URL = DB;
process.env.NEXUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-org-share-"));

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.js");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.js");
const { requireAuthWithTier } = await import("../../src/middleware/auth.js");
const { orgRoutes } = await import("../../src/routes/org.js");
const { stopScheduler } = await import("../../src/lib/org-scheduler.js");
const { db } = await import("@nexus/db");
const { users, workspaces, workspaceMembers } = await import("@nexus/db/schema");

let app: FastifyInstance;

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

function call(method: string, url: string, userId: string, payload?: unknown) {
  return app.inject({
    method: method as "GET",
    url,
    headers: { authorization: `Bearer ${tokenFor(userId)}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

const OWNER = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const OUTSIDER = crypto.randomUUID();
const VIEWER = crypto.randomUUID();
const WS = crypto.randomUUID();

beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  await db.insert(users).values(
    [OWNER, MEMBER, OUTSIDER, VIEWER].map((id) => ({
      id,
      email: `${id}@example.com`,
      passwordHash: "x",
    })),
  );
  await db.insert(workspaces).values({ id: WS, name: "Crew", slug: "crew", ownerId: OWNER });
  await db.insert(workspaceMembers).values([
    { workspaceId: WS, userId: OWNER, role: "owner" },
    { workspaceId: WS, userId: MEMBER, role: "member" },
    { workspaceId: WS, userId: VIEWER, role: "viewer" },
  ]);
  app = Fastify();
  app.addHook("preHandler", requireAuthWithTier);
  await app.register(orgRoutes, { prefix: "/api" });
  await app.ready();
}, 120_000);

afterAll(async () => {
  stopScheduler();
  await app?.close();
  await closePgPools();
});

describe("a shared company", () => {
  it("takes a member's comments, new tasks and assignments, and nothing else", async () => {
    const c = (await call("POST", "/api/org/companies", OWNER, { name: "Shared Co" })).json<{
      id: string;
    }>();
    const agent = (
      await call("POST", `/api/org/companies/${c.id}/agents`, OWNER, {
        name: "Dev",
        heartbeat: { wakeOnAssign: false },
      })
    ).json<{ id: string }>();
    const qa = (
      await call("POST", `/api/org/companies/${c.id}/agents`, OWNER, { name: "Qa" })
    ).json<{ id: string }>();
    const task = (
      await call("POST", `/api/org/companies/${c.id}/tasks`, OWNER, {
        title: "Fix login",
        assigneeAgentId: agent.id,
      })
    ).json<{ id: string }>();
    const shared = await call("PATCH", `/api/org/companies/${c.id}`, OWNER, { workspaceId: WS });
    expect(shared.statusCode, shared.body).toBe(200);

    const said = await call("POST", `/api/org/tasks/${task.id}/comments`, MEMBER, {
      body: "@Qa please double check the redirect after sign in",
    });
    expect(said.statusCode, said.body).toBe(201);
    expect(said.json()).toMatchObject({ author: { type: "member", id: MEMBER } });

    const tasks = (await call("GET", `/api/org/companies/${c.id}/tasks`, OWNER)).json<{
      tasks: unknown[];
    }>();
    expect(tasks.tasks).toHaveLength(1);

    // A member may hand the task to another agent: logged as theirs, and it wakes the assignee.
    const moved = await call("PATCH", `/api/org/tasks/${task.id}`, MEMBER, {
      assigneeAgentId: qa.id,
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const acts = (await call("GET", `/api/org/companies/${c.id}/activity`, OWNER)).json<{
      activity: { action: string; actorType: string; actorId: string }[];
    }>().activity;
    expect(acts.find((a) => a.action === "task.assigned")).toMatchObject({
      actorType: "member",
      actorId: MEMBER,
    });
    const runs = (await call("GET", `/api/org/companies/${c.id}/runs`, OWNER)).json<{
      runs: { agentId: string; source: string }[];
    }>().runs;
    expect(runs.some((r) => r.agentId === qa.id && r.source === "assignment")).toBe(true);

    const filed = await call("POST", `/api/org/companies/${c.id}/tasks`, MEMBER, {
      title: "Write release notes",
      assigneeAgentId: agent.id,
    });
    expect(filed.statusCode, filed.body).toBe(201);
    expect(filed.json()).toMatchObject({ createdBy: { type: "member", id: MEMBER } });

    for (const [method, url, body] of [
      ["PATCH", `/api/org/tasks/${task.id}`, { title: "Renamed by a member" }],
      ["PATCH", `/api/org/tasks/${task.id}`, { assigneeAgentId: agent.id, priority: "low" }],
      ["POST", `/api/org/companies/${c.id}/tasks`, { title: "Blocking", blockedBy: [task.id] }],
      ["POST", `/api/org/tasks/${task.id}/comments`, { body: "hi", author: { type: "user" } }],
      ["POST", `/api/org/companies/${c.id}/agents`, { name: "Hire" }],
      ["PATCH", `/api/org/companies/${c.id}`, { workspaceId: null }],
      ["DELETE", `/api/org/companies/${c.id}`, undefined],
    ] as const) {
      expect((await call(method, url, MEMBER, body)).statusCode, `${method} ${url}`).toBe(403);
    }

    expect(
      (await call("POST", `/api/org/tasks/${task.id}/comments`, OUTSIDER, { body: "hi there" }))
        .statusCode,
    ).toBe(404);
  });

  it("never lets a member approve, spend, run, delete or read a literal secret", async () => {
    const c = (await call("POST", "/api/org/companies", OWNER, { name: "Locked Co" })).json<{
      id: string;
    }>();
    const hook = (
      await call("POST", `/api/org/companies/${c.id}/agents`, OWNER, {
        name: "Hook",
        adapterType: "http",
        adapterConfig: {
          url: "https://example.com/agent",
          headers: { Authorization: "Bearer sk-live-123", "X-Key": "secret:HOOK_KEY" },
        },
        heartbeat: { wakeOnAssign: false },
      })
    ).json<{ id: string }>();
    const other = (
      await call("POST", `/api/org/companies/${c.id}/agents`, OWNER, { name: "Other" })
    ).json<{ id: string }>();
    const task = (
      await call("POST", `/api/org/companies/${c.id}/tasks`, OWNER, { title: "Locked task" })
    ).json<{ id: string }>();
    await call("PATCH", `/api/org/companies/${c.id}`, OWNER, { workspaceId: WS });

    for (const url of [
      `/api/org/agents/${hook.id}`,
      `/api/org/companies/${c.id}/agents`,
      `/api/org/companies/${c.id}/chart`,
    ]) {
      const r = await call("GET", url, MEMBER);
      expect(r.statusCode, url).toBe(200);
      expect(r.body, url).not.toContain("sk-live-123");
    }
    expect((await call("GET", `/api/org/agents/${hook.id}`, OWNER)).body).toContain("sk-live-123");

    expect((await call("GET", `/api/org/companies/${c.id}/export`, MEMBER)).statusCode).toBe(403);
    for (const [method, url, body] of [
      ["POST", `/api/org/agents/${hook.id}/wake`, {}],
      ["POST", `/api/org/tasks/${task.id}/status`, { status: "cancelled" }],
      ["POST", `/api/org/tasks/${task.id}/discuss`, { agentIds: [hook.id, other.id] }],
      ["PUT", `/api/org/companies/${c.id}/budgets`, { scopeType: "company", amountUsd: 999 }],
      ["POST", `/api/org/companies/${c.id}/routines`, { title: "r", assigneeAgentId: other.id }],
      ["POST", `/api/org/companies/${c.id}/ask`, { question: "hi" }],
      ["POST", `/api/org/companies/${c.id}/memory`, { text: "a lesson from outside" }],
      ["POST", `/api/org/agents/${other.id}/forget-commands`, {}],
      ["DELETE", `/api/org/agents/${other.id}`, undefined],
    ] as const) {
      expect((await call(method, url, MEMBER, body)).statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await call("GET", `/api/org/tasks/${task.id}`, OWNER)).json()).toMatchObject({
      task: { status: "todo", assigneeAgentId: null },
    });
  });

  it("is invisible and unchangeable to an account outside the workspace", async () => {
    const post = <T>(url: string, body: unknown) =>
      call("POST", url, OWNER, body).then((r) => r.json<T>());
    const c = await post<{ id: string }>("/api/org/companies", {
      name: "Private Co",
      requireHireApproval: true,
    });
    const agent = await post<{ id: string }>(`/api/org/companies/${c.id}/agents`, {
      name: "Solo",
      heartbeat: { wakeOnAssign: false },
    });
    const hire = await post<{ id: string }>(`/api/org/companies/${c.id}/agents`, { name: "Later" });
    const goal = await post<{ id: string }>(`/api/org/companies/${c.id}/goals`, { title: "Grow" });
    const task = await post<{ id: string }>(`/api/org/companies/${c.id}/tasks`, {
      title: "Private task",
      assigneeAgentId: agent.id,
    });
    const run = await post<{ id: string }>(`/api/org/agents/${agent.id}/wake`, {});
    const lesson = await post<{ id: string }>(`/api/org/companies/${c.id}/memory`, {
      text: "Private lesson text",
    });
    const policy = await call("PUT", `/api/org/companies/${c.id}/budgets`, OWNER, {
      scopeType: "company",
      amountUsd: 5,
    }).then((r) => r.json<{ id: string }>());
    const routine = await post<{ id: string }>(`/api/org/companies/${c.id}/routines`, {
      title: "Weekly",
      assigneeAgentId: agent.id,
    });
    const approvals = (await call("GET", `/api/org/companies/${c.id}/approvals`, OWNER)).json<{
      approvals: { id: string; subject: { agentId?: string } }[];
    }>().approvals;
    const approval = approvals.find((a) => a.subject.agentId === hire.id)!;
    expect(approval).toBeTruthy();

    const listed = await call("GET", "/api/org/companies", OUTSIDER);
    expect(listed.body).not.toContain(c.id);
    for (const url of [
      `/api/org/companies/${c.id}`,
      `/api/org/companies/${c.id}/agents`,
      `/api/org/companies/${c.id}/tasks`,
      `/api/org/companies/${c.id}/goals`,
      `/api/org/companies/${c.id}/runs`,
      `/api/org/companies/${c.id}/approvals`,
      `/api/org/companies/${c.id}/budgets`,
      `/api/org/companies/${c.id}/memory`,
      `/api/org/companies/${c.id}/routines`,
      `/api/org/companies/${c.id}/export`,
      `/api/org/agents/${agent.id}`,
      `/api/org/tasks/${task.id}`,
      `/api/org/runs/${run.id}`,
      `/api/org/approvals/${approval.id}`,
      `/api/org/routines/${routine.id}`,
    ]) {
      const r = await call("GET", url, OUTSIDER);
      expect(r.statusCode, url).toBe(404);
      expect(r.body, url).not.toContain("Private");
    }
    for (const [method, url, body] of [
      ["PATCH", `/api/org/companies/${c.id}`, { name: "Mine now" }],
      ["PATCH", `/api/org/agents/${agent.id}`, { name: "Mine" }],
      ["PATCH", `/api/org/tasks/${task.id}`, { title: "Mine" }],
      ["PATCH", `/api/org/goals/${goal.id}`, { title: "Mine" }],
      ["POST", `/api/org/tasks/${task.id}/comments`, { body: "hello" }],
      ["POST", `/api/org/agents/${agent.id}/wake`, {}],
      ["POST", `/api/org/runs/${run.id}/cancel`, {}],
      ["POST", `/api/org/runs/${run.id}/replay`, { model: "groq/x" }],
      ["POST", `/api/org/approvals/${approval.id}/approve`, {}],
      ["DELETE", `/api/org/budgets/${policy.id}`, undefined],
      ["DELETE", `/api/org/memory/${lesson.id}`, undefined],
      ["POST", `/api/org/routines/${routine.id}/fire`, {}],
      ["DELETE", `/api/org/companies/${c.id}`, undefined],
    ] as const) {
      expect((await call(method, url, OUTSIDER, body)).statusCode, `${method} ${url}`).toBe(404);
    }
    const after = (await call("GET", `/api/org/approvals/${approval.id}`, OWNER)).json<{
      status: string;
    }>();
    expect(after.status).toBe("pending");
    expect((await call("GET", `/api/org/companies/${c.id}`, OWNER)).json()).toMatchObject({
      name: "Private Co",
    });
  });

  it("lets a workspace viewer read but never comment, assign or file", async () => {
    const c = (await call("POST", "/api/org/companies", OWNER, { name: "Viewer Co" })).json<{
      id: string;
    }>();
    const ag = (
      await call("POST", `/api/org/companies/${c.id}/agents`, OWNER, { name: "Dev" })
    ).json<{
      id: string;
    }>();
    const task = (
      await call("POST", `/api/org/companies/${c.id}/tasks`, OWNER, { title: "Viewer task" })
    ).json<{ id: string }>();
    await call("PATCH", `/api/org/companies/${c.id}`, OWNER, { workspaceId: WS });
    expect((await call("GET", `/api/org/tasks/${task.id}`, VIEWER)).statusCode).toBe(200);
    for (const [method, url, body] of [
      ["POST", `/api/org/tasks/${task.id}/comments`, { body: "hello there" }],
      ["PATCH", `/api/org/tasks/${task.id}`, { assigneeAgentId: ag.id }],
      ["POST", `/api/org/companies/${c.id}/tasks`, { title: "from a viewer" }],
    ] as const) {
      expect((await call(method, url, VIEWER, body)).statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("tells each caller what they may do with each company", async () => {
    const c = (await call("POST", "/api/org/companies", OWNER, { name: "Caps Co" })).json<{
      id: string;
    }>();
    await call("PATCH", `/api/org/companies/${c.id}`, OWNER, { workspaceId: WS });
    const can = async (user: string) =>
      (await call("GET", "/api/org/companies", user))
        .json<{ companies: { id: string; can: string[] }[] }>()
        .companies.find((x) => x.id === c.id)?.can;
    expect(await can(OWNER)).toEqual(["manage", "comment", "fileTask", "assign"]);
    expect(await can(MEMBER)).toEqual(["comment", "fileTask", "assign"]);
    expect(await can(VIEWER)).toEqual([]);
    expect(await can(OUTSIDER)).toBeUndefined();
  });
});
