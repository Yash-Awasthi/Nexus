// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  RuntimeToolSet,
  createProgrammaticToolTool,
  gatedInvoke,
  type PermissionGate,
} from "../src/index.js";
import { executePtcScript } from "../src/ptc-sandbox.js";

function toolSet(): RuntimeToolSet {
  const ts = new RuntimeToolSet();
  ts.add({
    name: "read_file",
    description: "read",
    handler: async (a) => `contents-of-${String(a.path)}`,
  });
  ts.add({ name: "write_file", description: "write", handler: async () => "wrote" });
  ts.add({
    name: "hang",
    description: "never resolves",
    handler: () => new Promise<string>(() => {}),
  });
  return ts;
}

const allow: PermissionGate = () => ({ allowed: true });
const deny: PermissionGate = () => ({ allowed: false, reason: "nope" });

describe("createProgrammaticToolTool", () => {
  it("batches calls and returns only printed output (intermediates stay in the script)", async () => {
    const ptc = createProgrammaticToolTool({ toolSet: toolSet() });
    const code = `
      const a = await call("read_file", { path: "a" });
      const b = await call("read_file", { path: "b" });
      print("matched:", a.includes("a") ? "a" : b);
    `;
    const out = (await ptc.handler({ code }, {})) as string;
    expect(out).toContain("matched: a");
    expect(out).toContain("[2 tool call(s)]");
    // b's contents were used inside the script but never printed → not in context.
    expect(out).not.toContain("contents-of-b");
  });

  it("surfaces a returned value", async () => {
    const ptc = createProgrammaticToolTool({ toolSet: toolSet() });
    const out = (await ptc.handler({ code: "return 6 * 7;" }, {})) as string;
    expect(out).toContain("[return] 42");
  });

  it("honors the permission gate for inner calls (no bypass)", async () => {
    const ptc = createProgrammaticToolTool({ toolSet: toolSet(), permissionGate: deny });
    const out = (await ptc.handler(
      { code: `await call("write_file", { path: "x", content: "y" });` },
      {},
    )) as string;
    expect(out).toContain("[error]");
    expect(out).toContain("permission_denied");
  });

  it("allows gated calls when the gate approves", async () => {
    const ptc = createProgrammaticToolTool({ toolSet: toolSet(), permissionGate: allow });
    const out = (await ptc.handler(
      { code: `print(await call("write_file", { path: "x" }));` },
      {},
    )) as string;
    expect(out).toContain("wrote");
  });

  it("caps the number of tool calls", async () => {
    const ptc = createProgrammaticToolTool({ toolSet: toolSet(), maxCalls: 3 });
    const code = `for (let i = 0; i < 10; i++) await call("read_file", { path: String(i) });`;
    const out = (await ptc.handler({ code }, {})) as string;
    expect(out).toContain("exceeded 3 tool calls");
  });

  it("refuses to call itself", async () => {
    const ptc = createProgrammaticToolTool({ toolSet: toolSet() });
    const out = (await ptc.handler(
      { code: `await call("run_tool_script", { code: "1" });` },
      {},
    )) as string;
    expect(out).toContain("not callable");
  });

  it("times out a hanging script", async () => {
    const ptc = createProgrammaticToolTool({
      toolSet: toolSet(),
      permissionGate: allow,
      timeoutMs: 50,
    });
    const out = (await ptc.handler({ code: `await call("hang", {});` }, {})) as string;
    expect(out).toContain("timed out");
  });

  it("excludes named tools from the callable list", () => {
    const ptc = createProgrammaticToolTool({ toolSet: toolSet(), exclude: ["write_file"] });
    expect(ptc.description).toContain("read_file");
    expect(ptc.description).not.toContain("write_file");
  });
});

describe("executePtcScript — RPC + stdout-only contract (§7.2)", () => {
  it("bridges every tool call through `call` and returns only printed output", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    // Stand-in for the sandbox's local RPC: records the call, returns canned output.
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      calls.push({ name, args });
      return `contents-of-${String(args.path)}`;
    };
    const code = `
      const a = await call("read_file", { path: "a" });
      const b = await call("read_file", { path: "b" });
      print("chosen:", a.includes("a") ? "a" : b);
    `;
    const out = await executePtcScript(code, { tools: [] }, call);

    // Both tool calls went over the bridge (RPC), in order.
    expect(calls.map((c) => c.args.path)).toEqual(["a", "b"]);
    // Only the printed value re-enters context — b's raw contents never do.
    expect(out).toContain("chosen: a");
    expect(out).not.toContain("contents-of-b");
  });

  it("appends a [return] line and surfaces errors as [error]", async () => {
    const noop = async (): Promise<unknown> => undefined;
    expect(await executePtcScript("return 6*7;", {}, noop)).toContain("[return] 42");
    const err = await executePtcScript(`throw new Error("boom");`, {}, noop);
    expect(err).toContain("[error]");
    expect(err).toContain("boom");
  });

  it("enforces a cooperative timeout", async () => {
    const noop = async (): Promise<unknown> => undefined;
    const out = await executePtcScript("await new Promise(() => {});", {}, noop, { timeoutMs: 30 });
    expect(out).toContain("timed out");
  });
});

describe("createProgrammaticToolTool sandbox option (§7.2)", () => {
  it("accepts sandbox:true and still builds a gated meta-tool", () => {
    const ptc = createProgrammaticToolTool({ toolSet: toolSet(), sandbox: true });
    expect(ptc.tier).toBe("requires_permission");
    expect(ptc.name).toBe("run_tool_script");
  });
});

describe("gatedInvoke", () => {
  it("rejects a denied mutating tool", async () => {
    await expect(gatedInvoke(toolSet(), deny, "write_file", {})).rejects.toThrow(
      /permission_denied/,
    );
  });

  it("runs an auto-allowed tool without consulting the gate", async () => {
    await expect(gatedInvoke(toolSet(), deny, "read_file", { path: "z" })).resolves.toBe(
      "contents-of-z",
    );
  });

  it("propagates a tool error", async () => {
    const ts = new RuntimeToolSet();
    ts.add({
      name: "boom",
      description: "throws",
      handler: async () => {
        throw new Error("kaboom");
      },
    });
    await expect(gatedInvoke(ts, allow, "boom", {})).rejects.toThrow(/kaboom/);
  });
});
