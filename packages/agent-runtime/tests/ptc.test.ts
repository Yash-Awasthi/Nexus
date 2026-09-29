// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  RuntimeToolSet,
  createProgrammaticToolTool,
  gatedInvoke,
  type PermissionGate,
} from "../src/index.js";

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

describe("createProgrammaticToolTool sandbox option (§7.2)", () => {
  it("accepts sandbox:true and still builds a gated meta-tool", () => {
    const ptc = createProgrammaticToolTool({ toolSet: toolSet(), sandbox: true });
    expect(ptc.tier).toBe("requires_permission");
    expect(ptc.name).toBe("run_tool_script");
  });

  const sandboxed = (timeoutMs = 20_000) =>
    createProgrammaticToolTool({
      toolSet: toolSet(),
      permissionGate: allow,
      sandbox: true,
      timeoutMs,
    });

  it("runs in a separate process that sees none of the host's environment", async () => {
    process.env.PTC_TEST_SECRET = "s3cret-value";
    const out = (await sandboxed().handler(
      {
        code: `print(String(globalThis.process?.env?.PTC_TEST_SECRET)); print(process.pid !== ${process.pid});`,
      },
      {},
    )) as string;
    delete process.env.PTC_TEST_SECRET;
    expect(out).not.toContain("s3cret-value");
    expect(out).toContain("true");
  }, 30_000);

  it("cannot read files, start processes or open sockets", async () => {
    const out = (await sandboxed().handler(
      {
        code: `
          for (const [label, attempt] of [
            ["fs", () => import("node:fs").then((fs) => fs.readFileSync("package.json", "utf8"))],
            ["exec", () => import("node:child_process").then((cp) => cp.execSync("echo hi").toString())],
            ["net", () => fetch("http://127.0.0.1:9")],
            ["dns", () => require("node:dns").promises.resolve4("example.com")],
            ["udp", () => require("node:dgram").createSocket("udp4").send("x", 53, "127.0.0.1")],
          ]) {
            try { await attempt(); print(label + ":allowed"); } catch { print(label + ":blocked"); }
          }`,
      },
      {},
    )) as string;
    expect(out).toContain("fs:blocked");
    expect(out).toContain("exec:blocked");
    expect(out).toContain("net:blocked");
    expect(out).toContain("dns:blocked");
    expect(out).toContain("udp:blocked");
  }, 30_000);

  it("still reaches tools through call() and returns only what it prints", async () => {
    const out = (await sandboxed().handler(
      {
        code: `const a = await call("read_file", { path: "a" }); print(a.toUpperCase()); return 7;`,
      },
      {},
    )) as string;
    expect(out).toContain("CONTENTS-OF-A");
    expect(out).toContain("[return] 7");
  }, 30_000);

  it("surfaces a thrown error after what was printed", async () => {
    const out = (await sandboxed().handler(
      { code: `print("before"); throw new Error("boom");` },
      {},
    )) as string;
    expect(out.indexOf("before")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("before")).toBeLessThan(out.indexOf("[error] boom"));
  }, 30_000);

  it("kills a script stuck in a synchronous loop", async () => {
    const out = (await sandboxed(1500).handler({ code: "while (true) {}" }, {})) as string;
    expect(out).toContain("timed out");
  }, 30_000);
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
