import { MessageBus, StateStore } from '@workspace/core';
import { AgentRegistry } from './agent-registry.js';
import { TaskRouter }    from './task-router.js';

export class Orchestrator {
  readonly bus:      MessageBus;
  readonly state:    StateStore;
  readonly registry: AgentRegistry;
  readonly router:   TaskRouter;

  private healthInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.bus      = new MessageBus();
    this.state    = new StateStore();
    this.registry = new AgentRegistry(this.bus);
    this.router   = new TaskRouter(this.registry, this.bus);
  }

  async start(): Promise<void> {
    console.log('═══ Orchestrator starting ═══');
    await this.registry.initAll();

    // Health check every 30 s
    this.healthInterval = setInterval(
      () => void this.registry.healthCheckAll(),
      30_000,
    );

    // Log all bus messages in dev
    if (process.env['NODE_ENV'] !== 'production') {
      this.bus.subscribeAll((msg) => {
        console.debug(`[Bus] ${msg.topic}`);
      });
    }

    console.log(`═══ Orchestrator ready — ${this.registry.size()} agents ═══`);
  }

  async shutdown(): Promise<void> {
    if (this.healthInterval) clearInterval(this.healthInterval);
    await this.registry.shutdownAll();
    await this.state.close();
    console.log('═══ Orchestrator shut down ═══');
  }
}

export { AgentRegistry } from './agent-registry.js';
export { TaskRouter }    from './task-router.js';
