import {
  AgentBase, AgentId, AgentHealth, AgentStatus, MessageBus,
} from '@workspace/core';

export class AgentRegistry {
  private readonly agents = new Map<AgentId, AgentBase>();
  private readonly bus:    MessageBus;

  constructor(bus: MessageBus) {
    this.bus = bus;
  }

  register(agent: AgentBase): void {
    if (this.agents.has(agent.config.id)) {
      throw new Error(`AgentRegistry: "${agent.config.id}" already registered`);
    }
    this.agents.set(agent.config.id, agent);
    console.log(`[Registry] +${agent.config.id} (${agent.config.name})`);
  }

  async initAll(): Promise<void> {
    await Promise.all([...this.agents.values()].map((a) => a.init()));
    console.log(`[Registry] ${this.agents.size} agents ready`);
  }

  get(id: AgentId): AgentBase | undefined {
    return this.agents.get(id);
  }

  /** Find agents that declare a given capability. */
  byCapability(capability: string): AgentBase[] {
    return [...this.agents.values()].filter((a) =>
      a.config.capabilities.includes(capability),
    );
  }

  allHealths(): AgentHealth[] {
    return [...this.agents.values()].map((a) => a.health());
  }

  /** Returns the first IDLE agent with the given capability, or null. */
  availableFor(capability: string): AgentBase | null {
    return (
      this.byCapability(capability).find(
        (a) => a.status === AgentStatus.IDLE,
      ) ?? null
    );
  }

  async healthCheckAll(): Promise<void> {
    const healths = this.allHealths();
    const errors  = healths.filter((h) => h.status === AgentStatus.ERROR);
    if (errors.length > 0) {
      const ids = errors.map((h) => h.agentId).join(', ');
      console.warn(`[Registry] Agents in ERROR state: ${ids}`);
      this.bus.publish('orchestrator.agent.errors', { errors });
    }
  }

  async shutdownAll(): Promise<void> {
    await Promise.all([...this.agents.values()].map((a) => a.shutdown()));
    console.log('[Registry] All agents shut down');
  }

  size(): number {
    return this.agents.size;
  }
}
