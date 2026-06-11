// SPDX-License-Identifier: Apache-2.0
import type {
  IMCPServerRegistry,
  IMCPServerInfo,
  IMCPTransport,
} from "./interfaces/mcp.interface.js";

export class MCPServerRegistry implements IMCPServerRegistry {
  private servers = new Map<string, { info: IMCPServerInfo; transport: IMCPTransport }>();

  async registerServer(info: IMCPServerInfo, transport: IMCPTransport): Promise<void> {
    const mutableInfo = { ...info };
    mutableInfo.status = "active";
    this.servers.set(info.name, { info: mutableInfo, transport });
  }

  async getServer(
    name: string,
  ): Promise<{ info: IMCPServerInfo; transport: IMCPTransport } | undefined> {
    return this.servers.get(name);
  }

  async listServers(): Promise<IMCPServerInfo[]> {
    return Array.from(this.servers.values()).map((s) => s.info);
  }
}
