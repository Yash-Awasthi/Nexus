import * as path from "path";
import { createRuntimeContext } from "../runtime/runtime-context";
import { GhostStackMcpBridge, registerGhostStackMcpBridge } from "../orchestration/ghoststack-mcp-bridge";

describe("GhostStack MCP bridge", () => {
  const repoRoot = path.resolve(__dirname, "..");

  it("lists workflows via in-process tool", async () => {
    process.env.GHOSTSTACK_DATA_DIR = path.join(__dirname, "../temp-mcp-bridge-db");
    const ctx = await createRuntimeContext(repoRoot);
    const bridge = new GhostStackMcpBridge(ctx);
    await bridge.connect();

    const res = await bridge.send({
      method: "tools/call",
      params: { name: "ghoststack_list_workflows", arguments: {} }
    });

    const text = (res as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed)).toBe(true);
    const demo = parsed.find((w: { id: string }) => w.id === "demo-etl");
    expect(demo).toBeDefined();

    await bridge.disconnect();
  });

  it("registers composite MCP server on registry", async () => {
    const ctx = await createRuntimeContext(repoRoot);
    const { registry } = await registerGhostStackMcpBridge(ctx);
    const servers = await registry.listServers();
    expect(servers[0].name).toBe("ghoststack");
    expect(servers[0].tools).toContain("ghoststack_floci_execute");
    expect(servers[0].tools).toContain("ghoststack_run_e2e");
    expect(servers[0].tools).toContain("ghoststack_load_spec");
  });
});
