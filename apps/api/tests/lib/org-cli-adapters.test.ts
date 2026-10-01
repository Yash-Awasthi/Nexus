// SPDX-License-Identifier: Apache-2.0
/**
 * External adapters: output parsing for each CLI (shapes captured from the real
 * tools), the exec gate asking once and then remembering a command, the child
 * seeing none of the server's environment, cancellation killing the process,
 * and the webhook adapter refusing private addresses unless allowlisted.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { describe, it, expect, vi } from "vitest";

import { bootOrg, useOrgDataDir } from "./org-test-env.js";

useOrgDataDir({
  NEXUS_EXEC_MODE: "ask",
  NEXUS_EXEC_ALLOW: undefined,
  NEXUS_EXEC_DENY: undefined,
  NEXUS_EXEC_ROOTS: undefined,
  NEXUS_ORG_HTTP_PRIVATE_ORIGINS: undefined,
  SERVER_ONLY_SECRET: "do-not-leak",
});

async function boot() {
  const b = await bootOrg(async () => ({
    cli: await import("../../src/lib/org-cli-adapters.js"),
    exec: await import("../../src/lib/exec-approvals.js"),
  }));
  await b.exec.loadApprovalStore();
  b.cli.registerExternalAdapters();
  return b;
}

/** A node one-liner as a shell agent: reads the prompt, answers with a control block. */
const NODE_ECHO = [
  "-e",
  "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log('prompt chars '+d.length+'; leaked='+(process.env.SERVER_ONLY_SECRET??'none'));console.log('```json');console.log(JSON.stringify({status:'done',summary:'echoed'}));console.log('```')})",
];

describe("CLI output parsing", () => {
  it("reads each tool's reply, session and usage", async () => {
    const { cli } = await boot();
    const claude = cli.CLI_SPECS.claude_code.parse(
      JSON.stringify({
        result: "PONG",
        session_id: "06fed5f3-3c1c-42a8-a79e-de9a1d3c2a1e",
        total_cost_usd: 0.119,
        is_error: false,
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 50,
          output_tokens: 5,
        },
        modelUsage: { "claude-opus-5-5": {} },
      }),
    );
    expect(claude).toMatchObject({
      output: "PONG",
      costUsd: 0.119,
      inputTokens: 152,
      outputTokens: 5,
      model: "claude-opus-5-5",
    });

    const codex = cli.CLI_SPECS.codex.parse(
      [
        "Reading prompt from stdin...",
        '{"type":"thread.started","thread_id":"t1"}',
        '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PONG"}}',
        '{"type":"turn.completed","usage":{"input_tokens":17304,"output_tokens":6}}',
      ].join("\n"),
    );
    expect(codex).toMatchObject({
      output: "PONG",
      sessionId: "t1",
      inputTokens: 17304,
      outputTokens: 6,
    });

    const gemini = cli.CLI_SPECS.gemini.parse(
      [
        '{"type":"init","session_id":"s","model":"auto"}',
        '{"type":"message","role":"user","content":"hi"}',
        '{"type":"message","role":"assistant","content":"PO","delta":true}',
        '{"type":"message","role":"assistant","content":"NG","delta":true}',
        '{"type":"result","status":"success","stats":{"input_tokens":877,"output_tokens":22,"models":{"gemini-3.5-flash-lite":{}}}}',
      ].join("\n"),
    );
    expect(gemini).toMatchObject({
      output: "PONG",
      inputTokens: 877,
      outputTokens: 22,
      model: "gemini-3.5-flash-lite",
    });

    const opencode = cli.CLI_SPECS.opencode.parse(
      [
        '{"type":"step-start","sessionID":"ses_1","part":{"type":"step-start"}}',
        '{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"PONG"}}',
        '{"type":"step_finish","sessionID":"ses_1","part":{"type":"step-finish","tokens":{"input":139177,"output":3},"cost":0.01}}',
      ].join("\n"),
    );
    expect(opencode).toMatchObject({
      output: "PONG",
      sessionId: "ses_1",
      inputTokens: 139177,
      costUsd: 0.01,
    });

    // Models are priced as "provider/model"; OpenCode names its models that way already.
    expect(cli.CLI_SPECS.claude_code.vendor).toBe("anthropic");
    expect(cli.CLI_SPECS.codex.vendor).toBe("openai");
    expect(cli.CLI_SPECS.gemini.vendor).toBe("gemini");
    expect(cli.CLI_SPECS.opencode.vendor).toBeUndefined();

    expect(
      cli.CLI_SPECS.claude_code.args({ permissionMode: "plan", maxTurns: 3 }, "sonnet"),
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "sonnet",
      "--permission-mode",
      "plan",
      "--max-turns",
      "3",
    ]);
    expect(cli.CLI_SPECS.claude_code.args({ permissionMode: "rm -rf" }, null)).not.toContain(
      "rm -rf",
    );
  });
});

describe("CLI progress events", () => {
  it("turns streamed events into live log lines", async () => {
    const { cli } = await boot();
    const s = cli.CLI_SPECS;
    expect(
      s.claude_code.progress({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Looking" },
            { type: "tool_use", name: "Read" },
          ],
        },
      }),
    ).toBe("Looking\ntool: Read");
    expect(s.claude_code.progress({ type: "system", subtype: "init" })).toBeNull();
    expect(
      s.codex.progress({
        type: "item.started",
        item: { type: "command_execution", command: "ls" },
      }),
    ).toBe("$ ls");
    expect(s.gemini.progress({ type: "tool_use", tool_name: "read_file" })).toBe("tool: read_file");
    expect(s.gemini.progress({ type: "message", role: "user", content: "x" })).toBeNull();
    expect(s.opencode.progress({ type: "text", part: { text: "hi" } })).toBe("hi");
  });
});

describe("shell adapter through the exec gate", () => {
  it("asks once, remembers the command, and keeps server env out of the child", async () => {
    const { cli, exec, rt, work, org } = await boot();
    const c = org.createCompany("alice", { name: "Shell Co" });
    const a = org.createAgent("alice", c.id, {
      name: "Echo",
      adapterType: "shell",
      adapterConfig: { command: process.execPath, args: NODE_ECHO },
      heartbeat: { wakeOnAssign: false },
    });
    const t = work.createTask("alice", c.id, { title: "Echo it", assigneeAgentId: a.id });

    const first = rt.enqueueWake("alice", a.id, { source: "manual" });
    await rt.idle();
    expect(rt.getRun("alice", first.id)).toMatchObject({ status: "skipped" });
    expect(rt.getRun("alice", first.id).error).toMatch(/Waiting for you to allow/);
    const pending = exec.listApprovals("alice").find((x) => x.status === "pending")!;
    expect(pending.command).toBe(process.execPath);
    expect(exec.listApprovals("bob")).toEqual([]);

    exec.decideApproval("alice", pending.id, true);
    expect(cli.wakeApprovedGrants()).toEqual([a.id]);
    expect(cli.wakeApprovedGrants()).toEqual([]);
    await rt.idle();
    const second = rt.listRuns("alice", c.id)[0]!;
    expect(second).toMatchObject({ source: "approval", status: "succeeded" });
    expect(rt.getRun("alice", second.id).output).toMatch(/leaked=none/);
    expect(work.getTask("alice", t.id).status).toBe("done");

    // Remembered: the same command runs again without asking.
    const t2 = work.createTask("alice", c.id, { title: "Again", assigneeAgentId: a.id });
    rt.enqueueWake("alice", a.id, { source: "manual" });
    await rt.idle();
    expect(work.getTask("alice", t2.id).status).toBe("done");
    expect(exec.listApprovals("alice").filter((x) => x.status === "pending")).toEqual([]);

    // A changed command asks again.
    org.updateAgent("alice", a.id, {
      adapterConfig: { command: process.execPath, args: [...NODE_ECHO, "x"] },
    });
    work.createTask("alice", c.id, { title: "Third", assigneeAgentId: a.id });
    const third = rt.enqueueWake("alice", a.id, { source: "manual" });
    await rt.idle();
    expect(rt.getRun("alice", third.id).status).toBe("skipped");
    expect(cli.revokeGrants("alice", a.id)).toBeGreaterThan(0);
  });

  it("refuses a denied command and kills a cancelled one", async () => {
    process.env.NEXUS_EXEC_DENY = "nope-cli";
    const { rt, work, org } = await boot();
    const c = org.createCompany("alice", { name: "Deny Co" });
    const denied = org.createAgent("alice", c.id, {
      name: "Denied",
      adapterType: "shell",
      adapterConfig: { command: "nope-cli" },
      heartbeat: { wakeOnAssign: false },
    });
    work.createTask("alice", c.id, { title: "x", assigneeAgentId: denied.id });
    const r = rt.enqueueWake("alice", denied.id, { source: "manual" });
    await rt.idle();
    expect(rt.getRun("alice", r.id).error).toMatch(/Blocked by exec policy/);
    delete process.env.NEXUS_EXEC_DENY;

    process.env.NEXUS_EXEC_MODE = "trusted";
    process.env.NEXUS_EXEC_ALLOW = path.basename(process.execPath, ".exe");
    const slow = org.createAgent("alice", c.id, {
      name: "Slow",
      adapterType: "shell",
      adapterConfig: { command: process.execPath, args: ["-e", "setTimeout(()=>{},60000)"] },
      heartbeat: { wakeOnAssign: false },
    });
    work.createTask("alice", c.id, { title: "sleep", assigneeAgentId: slow.id });
    const run = rt.enqueueWake("alice", slow.id, { source: "manual" });
    await vi.waitFor(() => expect(rt.getRun("alice", run.id).status).toBe("running"));
    await new Promise((res) => setTimeout(res, 300));
    rt.cancelRun("alice", run.id);
    await rt.idle(20_000);
    expect(rt.getRun("alice", run.id).status).toBe("cancelled");
    process.env.NEXUS_EXEC_MODE = "ask";
    delete process.env.NEXUS_EXEC_ALLOW;
  }, 30_000);
});

describe("http adapter", () => {
  it("blocks private addresses unless the origin is allowlisted", async () => {
    const received: unknown[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        received.push(JSON.parse(body));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ output: 'Handled.\n```json\n{"status":"done"}\n```' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const { rt, work, org } = await boot();
      const c = org.createCompany("alice", { name: "Hook Co" });
      const a = org.createAgent("alice", c.id, {
        name: "Remote",
        adapterType: "http",
        adapterConfig: { url: `${origin}/agent` },
        heartbeat: { wakeOnAssign: false },
      });
      const t = work.createTask("alice", c.id, { title: "Call out", assigneeAgentId: a.id });
      const blocked = rt.enqueueWake("alice", a.id, { source: "manual" });
      await rt.idle();
      expect(rt.getRun("alice", blocked.id).status).toBe("failed");
      expect(received).toEqual([]);

      process.env.NEXUS_ORG_HTTP_PRIVATE_ORIGINS = origin;
      rt.enqueueWake("alice", a.id, { source: "manual" });
      await rt.idle();
      expect(work.getTask("alice", t.id).status).toBe("done");
      expect(received[0]).toMatchObject({ task: { title: "Call out" }, agent: { name: "Remote" } });
    } finally {
      server.close();
      delete process.env.NEXUS_ORG_HTTP_PRIVATE_ORIGINS;
    }
  });
});

describe("agent skills", () => {
  it("run once per turn after the exec gate allows them, and feed their output to the prompt", async () => {
    const { cli, exec, rt, work, org } = await boot();
    cli.setSkillResolver((owner, ids) =>
      owner === "alice" && ids.includes("sk1")
        ? [{ id: "sk1", name: "Count", language: "javascript", code: "console.log(6 * 7)" }]
        : [],
    );
    const c = org.createCompany("alice", { name: "Skill Co" });
    const a = org.createAgent("alice", c.id, {
      name: "Calc",
      skills: ["sk1"],
      heartbeat: { wakeOnAssign: false },
    });
    const prompts: string[] = [];
    rt.registerAdapter("nexus", async (ctx) => {
      prompts.push(ctx.prompt.user);
      return { ok: true, output: '```json\n{"status":"in_progress"}\n```' };
    });
    work.createTask("alice", c.id, { title: "Compute", assigneeAgentId: a.id });

    const first = rt.enqueueWake("alice", a.id, { source: "manual" });
    await rt.idle();
    // The agent does not run without its skill; it waits for the owner like a gated command.
    expect(prompts).toEqual([]);
    expect(rt.getRun("alice", first.id)).toMatchObject({ status: "skipped" });
    expect(rt.getRun("alice", first.id).error).toMatch(/Waiting for you to allow the skill/);
    const pending = exec.listApprovals("alice").find((x) => x.status === "pending")!;
    expect(pending.args).toContain("skill:sk1");

    exec.decideApproval("alice", pending.id, true);
    expect(cli.wakeApprovedGrants()).toEqual([a.id]);
    await rt.idle();
    expect(prompts[0]).toMatch(/Count: OK\s+output:[\s\S]*42/);

    // An edited skill is new code: the agent waits for the owner again.
    cli.setSkillResolver((owner, ids) =>
      owner === "alice" && ids.includes("sk1")
        ? [{ id: "sk1", name: "Count", language: "javascript", code: "console.log(7 * 7)" }]
        : [],
    );
    work.createTask("alice", c.id, { title: "Compute again", assigneeAgentId: a.id });
    const edited = rt.enqueueWake("alice", a.id, { source: "manual" });
    await rt.idle();
    expect(prompts).toHaveLength(1);
    expect(rt.getRun("alice", edited.id).error).toMatch(/Waiting for you to allow the skill/);
    cli.setSkillResolver(() => []);
  }, 60_000);
});
