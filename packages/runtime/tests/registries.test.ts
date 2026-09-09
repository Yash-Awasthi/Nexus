// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import { LocalAgentRegistry } from "../src/agent-registry.js";
import { MCPServerRegistry } from "../src/mcp-registry.js";

describe("LocalAgentRegistry", () => {
  const agent = (id: string, caps: string[] = []) => ({
    id,
    name: id,
    type: "code",
    capabilities: caps,
    status: "idle" as const,
  });

  it("registers, lists, and retrieves agents", async () => {
    const registry = new LocalAgentRegistry();
    await registry.register(agent("a1", ["file_picker"]));
    await registry.register(agent("a2", ["code_edit"]));
    expect((await registry.getAgent("a1"))?.name).toBe("a1");
    expect(await registry.getAgent("ghost")).toBeUndefined();
    expect(await registry.listAgents()).toHaveLength(2);
  });

  it("deregisters agents and filters by capability", async () => {
    const registry = new LocalAgentRegistry();
    await registry.register(agent("a1", ["file_picker", "code_edit"]));
    await registry.register(agent("a2", ["code_edit"]));
    await registry.register(agent("a3", []));
    expect(await registry.findAgentsByCapability("code_edit")).toHaveLength(2);
    await registry.deregister("a2");
    expect(await registry.findAgentsByCapability("code_edit")).toHaveLength(1);
    expect(await registry.findAgentsByCapability("research")).toEqual([]);
  });
});

describe("MCPServerRegistry", () => {
  const transport = { name: "t", send: async () => "", close: async () => {} };

  it("registers servers as active and lists their info", async () => {
    const registry = new MCPServerRegistry();
    await registry.registerServer(
      { name: "floci", tools: ["create_s3_bucket"], status: "pending" },
      transport as never,
    );
    const server = await registry.getServer("floci");
    expect(server?.info.status).toBe("active");
    expect(server?.info.tools).toContain("create_s3_bucket");
    expect(await registry.listServers()).toHaveLength(1);
  });

  it("returns undefined for unknown servers", async () => {
    const registry = new MCPServerRegistry();
    expect(await registry.getServer("nope")).toBeUndefined();
    expect(await registry.listServers()).toEqual([]);
  });
});
