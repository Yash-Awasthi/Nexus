export interface Agent {
  id: string;
  name: string;
  type: string;
  capabilities: string[];
  status: "idle" | "busy" | "offline";
}

export interface IAgentRegistry {
  register(agent: Agent): Promise<void>;
  deregister(agentId: string): Promise<void>;
  getAgent(agentId: string): Promise<Agent | undefined>;
  listAgents(): Promise<Agent[]>;
  findAgentsByCapability(capability: string): Promise<Agent[]>;
}

export class LocalAgentRegistry implements IAgentRegistry {
  private registry = new Map<string, Agent>();

  async register(agent: Agent): Promise<void> {
    this.registry.set(agent.id, agent);
  }

  async deregister(agentId: string): Promise<void> {
    this.registry.delete(agentId);
  }

  async getAgent(agentId: string): Promise<Agent | undefined> {
    return this.registry.get(agentId);
  }

  async listAgents(): Promise<Agent[]> {
    return Array.from(this.registry.values());
  }

  async findAgentsByCapability(capability: string): Promise<Agent[]> {
    const agents = await this.listAgents();
    return agents.filter((agent) => agent.capabilities.includes(capability));
  }
}
