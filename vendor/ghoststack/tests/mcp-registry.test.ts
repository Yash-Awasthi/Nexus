import { MCPServerRegistry } from "../orchestration/mcp-registry";
import { IMCPTransport } from "../orchestration/interfaces/mcp.interface";

class MockMCPTransport implements IMCPTransport {
  private connected = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async send(message: any): Promise<any> {
    if (!this.connected) throw new Error("Transport not connected");
    return { status: "ok", echo: message };
  }

  isConnected(): boolean {
    return this.connected;
  }
}

describe("Milestone 1: MCP Server Registry & Transport Core", () => {
  it("should register servers, map active tools, connect/disconnect transports cleanly", async () => {
    const registry = new MCPServerRegistry();
    const transport = new MockMCPTransport();

    await registry.registerServer(
      {
        name: "financial-calculator",
        transportType: "http",
        endpoint: "http://localhost:8080/mcp",
        status: "inactive",
        tools: ["calculate_compound_interest", "calculate_yield"]
      },
      transport
    );

    const servers = await registry.listServers();
    expect(servers.length).toBe(1);
    expect(servers[0].name).toBe("financial-calculator");
    expect(servers[0].tools).toEqual(["calculate_compound_interest", "calculate_yield"]);

    const entry = await registry.getServer("financial-calculator");
    expect(entry).toBeDefined();

    // Connect transport
    await entry?.transport.connect();
    expect((entry?.transport as MockMCPTransport).isConnected()).toBe(true);

    const res = await entry?.transport.send({ action: "test" });
    expect(res.echo.action).toBe("test");

    await entry?.transport.disconnect();
    expect((entry?.transport as MockMCPTransport).isConnected()).toBe(false);
  });
});
