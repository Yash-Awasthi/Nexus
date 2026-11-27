// SPDX-License-Identifier: Apache-2.0
/**
 * A budget hard stop, refused at the API rather than only hidden in the UI.
 *
 * The UI can hide a button; it cannot stop a request. This test drives the same HTTP surface a
 * client would — set the budget, ask an agent to work a task, watch the run — and asserts that
 * the run the API created is `skipped` with the budget as its reason, so no model call happened
 * and the refusal is visible in the run record the API returns.
 */
import crypto from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { bootOrg, useOrgDataDir } from "../lib/org-test-env.ts";

const SECRET = "org-budget-refusal-secret";
process.env.NEXUS_JWT_SECRET = SECRET;

useOrgDataDir();

const { requireAuthWithTier } = await import("../../src/middleware/auth.ts");
const { orgRoutes } = await import("../../src/routes/org.ts");
const { stopScheduler } = await import("../../src/lib/org-scheduler.ts");
const runtime = await import("../../src/lib/org-runtime.ts");

const OWNER = crypto.randomUUID();
let app: FastifyInstance;

function token(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: OWNER, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

function call(method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token()}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

beforeAll(async () => {
  // The runtime's stores are the ones the routes use: one module graph, one data directory.
  await bootOrg(async () => ({
    budget: await import("../../src/lib/org-budget.ts"),
  }));
  app = Fastify();
  app.addHook("preHandler", requireAuthWithTier);
  await app.register(orgRoutes, { prefix: "/api" });
  await app.ready();
});

afterAll(async () => {
  stopScheduler();
  await app.close();
});

describe("a company over its budget", () => {
  it("skips the run the API accepted, and says why", async () => {
    const company = (await call("POST", "/api/org/companies", { name: "Budget Co" })).json<{
      id: string;
    }>();
    const agent = (
      await call("POST", `/api/org/companies/${company.id}/agents`, { name: "Worker" })
    ).json<{ id: string }>();
    const goal = (
      await call("POST", `/api/org/companies/${company.id}/goals`, { title: "Ads" })
    ).json<{ id: string }>();
    const task = (
      await call("POST", `/api/org/companies/${company.id}/tasks`, {
        title: "write an ad",
        goalId: goal.id,
        assigneeAgentId: agent.id,
      })
    ).json<{ id: string }>();

    // A hard-stop policy on the goal, with nothing left to spend.
    const policy = await call("PUT", `/api/org/companies/${company.id}/budgets`, {
      scopeType: "goal",
      scopeId: goal.id,
      amountUsd: 0.0001,
    });
    expect(policy.statusCode).toBeLessThan(300);

    const spent = runtime.enqueueWake(OWNER, agent.id, { source: "manual", taskId: task.id });
    await runtime.idle();
    // The first run spends the allowance; from here the scope is over its limit.
    expect(runtime.getRun(OWNER, spent.id).status).not.toBe("failed");

    const wake = await call("POST", `/api/org/agents/${agent.id}/wake`, { taskId: task.id });
    expect(wake.statusCode).toBe(202);
    const run = wake.json<{ id: string }>();
    await runtime.idle();

    // The refusal is in the run the API serves, not only in a UI state.
    const view = (await call("GET", `/api/org/runs/${run.id}`)).json<{
      status: string;
      outcome?: { summary?: string };
      log?: { text: string }[];
    }>();
    expect(view.status).toBe("skipped");
    // The reason is in the run the API serves: whoever reads the run sees the budget.
    const said = [view.outcome?.summary ?? "", ...(view.log ?? []).map((entry) => entry.text)].join(
      "\n",
    );
    expect(said).toMatch(/budget/i);
  });
});
