// SPDX-License-Identifier: Apache-2.0
/**
 * Stage F-Tier1 — the exec gate, driven through the real routes.
 *
 * What these pin is the property the gate exists for: a command the policy
 * stops for does not run until a human says so, the approval covers exactly
 * the command that was shown, it works once, and it belongs to one user.
 *
 * `NEXUS_LOCAL_PTY_FORCE` is set because the PTY routes are otherwise loopback
 * only and `app.inject` has no remote address; the gate under test is the
 * policy, not the loopback check.
 */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const SECRET = "exec-approval-test-secret";

process.env.NEXUS_LOCAL_PTY_FORCE = "1";
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.NEXUS_EXEC_MODE = "ask";
delete process.env.NEXUS_EXEC_ALLOW;
delete process.env.NEXUS_EXEC_DENY;
delete process.env.NEXUS_EXEC_ROOTS;

const { buildServer } = await import("../../src/server.js");

let app: FastifyInstance;

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

const ALICE = `alice-${crypto.randomUUID()}`;
const BOB = `bob-${crypto.randomUUID()}`;

function call(method: "GET" | "POST", url: string, userId: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${tokenFor(userId)}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

/** Ask to spawn something the policy does not cover. */
function spawn(userId: string, body: Record<string, unknown>) {
  return call("POST", "/api/local/pty", userId, body);
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  delete process.env.NEXUS_LOCAL_PTY_FORCE;
  delete process.env.NEXUS_EXEC_MODE;
});

describe("a command the policy stops for", () => {
  it("does not spawn, and answers with an approval to grant", async () => {
    const res = await spawn(ALICE, { command: "npm", args: ["install"] });

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.payload) as { error: string; approvalId: string };
    expect(body.error).toBe("approval_required");
    expect(body.approvalId).toBeTruthy();
  });

  it("shows the request to its owner and to nobody else", async () => {
    const { approvalId } = JSON.parse(
      (await spawn(ALICE, { command: "npm", args: ["run", "build"] })).payload,
    ) as { approvalId: string };

    const mine = JSON.parse((await call("GET", "/api/v1/exec/approvals", ALICE)).payload) as {
      approvals: { id: string; command: string; status: string }[];
    };
    const theirs = JSON.parse((await call("GET", "/api/v1/exec/approvals", BOB)).payload) as {
      approvals: { id: string }[];
    };

    expect(mine.approvals.some((a) => a.id === approvalId && a.status === "pending")).toBe(true);
    expect(theirs.approvals.some((a) => a.id === approvalId)).toBe(false);
  });

  it("cannot be approved by another user", async () => {
    const { approvalId } = JSON.parse(
      (await spawn(ALICE, { command: "npm", args: ["test"] })).payload,
    ) as { approvalId: string };

    const res = await call("POST", `/api/v1/exec/approvals/${approvalId}/approve`, BOB);

    expect(res.statusCode).toBe(404);
  });

  it("refuses a request that was denied", async () => {
    const { approvalId } = JSON.parse(
      (await spawn(ALICE, { command: "npm", args: ["publish"] })).payload,
    ) as { approvalId: string };

    const denial = await call("POST", `/api/v1/exec/approvals/${approvalId}/deny`, ALICE);
    expect(denial.statusCode).toBe(200);

    const retry = await spawn(ALICE, { command: "npm", args: ["publish"], approvalId });
    expect(retry.statusCode).toBe(403);
    expect(JSON.parse(retry.payload).error).toBe("not_approved");
  });
});

describe("an approval covers exactly what was shown", () => {
  it("refuses to run a different command", async () => {
    const { approvalId } = JSON.parse(
      (await spawn(ALICE, { command: "npm", args: ["install"] })).payload,
    ) as { approvalId: string };
    await call("POST", `/api/v1/exec/approvals/${approvalId}/approve`, ALICE);

    const swapped = await spawn(ALICE, {
      command: "npm",
      args: ["install", "--global"],
      approvalId,
    });

    expect(swapped.statusCode).toBe(403);
    expect(JSON.parse(swapped.payload).error).toBe("action_mismatch");
  });

  it("is spent after one use", async () => {
    const { approvalId } = JSON.parse(
      (await spawn(ALICE, { command: "definitely-not-installed" })).payload,
    ) as { approvalId: string };
    await call("POST", `/api/v1/exec/approvals/${approvalId}/approve`, ALICE);

    // The command does not exist, so the spawn fails — the approval is still
    // spent, because it was redeemed before the process was started.
    const first = await spawn(ALICE, { command: "definitely-not-installed", approvalId });
    expect([201, 400]).toContain(first.statusCode);

    const second = await spawn(ALICE, { command: "definitely-not-installed", approvalId });
    expect(second.statusCode).toBe(403);
    expect(JSON.parse(second.payload).error).toBe("not_approved");
  });

  it("answers 409 when the same request is decided twice", async () => {
    const { approvalId } = JSON.parse(
      (await spawn(ALICE, { command: "npm", args: ["ci"] })).payload,
    ) as { approvalId: string };

    await call("POST", `/api/v1/exec/approvals/${approvalId}/approve`, ALICE);
    const again = await call("POST", `/api/v1/exec/approvals/${approvalId}/deny`, ALICE);

    expect(again.statusCode).toBe(409);
  });
});

describe("the policy itself", () => {
  it("refuses a denied command outright, with the rule that decided it", async () => {
    const res = await spawn(ALICE, { command: "shutdown", args: ["-h", "now"] });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.payload) as { error: string; rule: string };
    expect(body.error).toBe("exec_denied");
    expect(body.rule).toBe("builtin:deny-shutdown");
  });

  it("is readable by the caller it governs", async () => {
    const res = await call("GET", "/api/v1/exec/policy", ALICE);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).mode).toBe("ask");
  });
});

describe("the other surfaces", () => {
  it("runs sandbox code without asking, because the runtime is the control", async () => {
    const res = await call("POST", "/api/sandbox/execute", ALICE, {
      code: "console.log(1 + 1)",
      language: "javascript",
    });

    // 201: the sandbox answers created, with the execution record.
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.payload).output).toContain("2");
  });

  it("refuses sandbox code when the deployment is readonly", async () => {
    process.env.NEXUS_EXEC_MODE = "readonly";
    try {
      const res = await call("POST", "/api/sandbox/execute", ALICE, {
        code: "console.log(1 + 1)",
        language: "javascript",
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.payload).rule).toBe("mode:readonly");
    } finally {
      process.env.NEXUS_EXEC_MODE = "ask";
    }
  });

  it("stops for sandbox code when the operator raises that surface", async () => {
    process.env.NEXUS_EXEC_ASK_SURFACES = "sandbox";
    try {
      const res = await call("POST", "/api/sandbox/execute", ALICE, {
        code: "console.log(1 + 1)",
        language: "javascript",
      });

      expect(res.statusCode).toBe(202);
      expect(JSON.parse(res.payload).error).toBe("approval_required");
    } finally {
      delete process.env.NEXUS_EXEC_ASK_SURFACES;
    }
  });

  it("answers an MCP tool call in protocol when the policy refuses it", async () => {
    process.env.NEXUS_EXEC_DENY = "fetch_stealthy";
    try {
      const res = await call("POST", "/api/v1/mcp", ALICE, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "fetch_stealthy", arguments: {} },
      });

      // JSON-RPC, not an HTTP status: an MCP client reads the error object.
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { error?: { code: number; message: string } };
      expect(body.error?.code).toBe(-32004);
      expect(body.error?.message).toContain("Blocked by exec policy");
    } finally {
      delete process.env.NEXUS_EXEC_DENY;
    }
  });
});

describe("a mission with attached skills", () => {
  it("does not start until the skill code is approved, and an edit asks again", async () => {
    const skill = await call("POST", "/api/skills", ALICE, {
      name: "hello",
      language: "javascript",
      code: "console.log('hi')",
    });
    const skillId = JSON.parse(skill.payload).id as string;

    const first = await call("POST", "/api/missions", ALICE, {
      goal: "say hi",
      skillIds: [skillId],
    });
    expect(first.statusCode).toBe(202);
    const { error, approvalId } = JSON.parse(first.payload) as {
      error: string;
      approvalId: string;
    };
    expect(error).toBe("approval_required");

    await call("POST", `/api/v1/exec/approvals/${approvalId}/approve`, ALICE);
    const started = await call("POST", "/api/missions", ALICE, {
      goal: "say hi",
      skillIds: [skillId],
      approvalId,
    });
    expect(started.statusCode).toBe(202);
    expect(JSON.parse(started.payload).id).toBeTruthy();

    const edited = await call("POST", "/api/skills", ALICE, {
      name: "hello",
      language: "javascript",
      code: "console.log('bye')",
    });
    const again = await call("POST", "/api/missions", ALICE, {
      goal: "say hi",
      skillIds: [JSON.parse(edited.payload).id as string],
      approvalId,
    });
    expect(again.statusCode).toBe(403);
  });

  it("refuses outright when a deny rule covers the skill's language", async () => {
    process.env.NEXUS_EXEC_DENY = "bash";
    try {
      const skill = await call("POST", "/api/skills", ALICE, {
        name: "wipe",
        language: "bash",
        code: "echo hi",
      });
      const res = await call("POST", "/api/missions", ALICE, {
        goal: "go",
        skillIds: [JSON.parse(skill.payload).id as string],
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.payload).error).toBe("exec_denied");
    } finally {
      delete process.env.NEXUS_EXEC_DENY;
    }
  });
});

describe("the drive's command runner", () => {
  it("runs nothing in readonly mode and nothing a deny rule covers", async () => {
    process.env.NEXUS_EXEC_MODE = "readonly";
    try {
      const r = await call("POST", "/api/v1/drive/exec", ALICE, { command: "echo hi" });
      expect(r.statusCode).toBe(403);
      expect(JSON.parse(r.payload).error).toBe("exec_denied");
    } finally {
      process.env.NEXUS_EXEC_MODE = "ask";
    }
    process.env.NEXUS_EXEC_DENY = "sh";
    try {
      const r = await call("POST", "/api/v1/drive/exec", ALICE, { command: "echo hi" });
      expect(r.statusCode).toBe(403);
    } finally {
      delete process.env.NEXUS_EXEC_DENY;
    }
  });
});

describe("the code agent and build runners", () => {
  it("run nothing in readonly mode", async () => {
    process.env.NEXUS_EXEC_MODE = "readonly";
    try {
      for (const url of ["/api/code-agent/execute", "/api/build/run", "/api/code-agent/run"]) {
        const r = await call("POST", url, ALICE, {
          code: "print(1)",
          task: "print one",
          language: "python",
        });
        expect(r.statusCode, url).toBe(403);
        expect(JSON.parse(r.payload).error, url).toBe("exec_denied");
      }
    } finally {
      process.env.NEXUS_EXEC_MODE = "ask";
    }
  });
});
