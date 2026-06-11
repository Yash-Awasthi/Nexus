import Anthropic from '@anthropic-ai/sdk';
import {
  AgentConfig, AgentStatus, AgentTask, AgentResult,
  ToolDefinition, AgentHealth, MessagePriority,
} from './types/index.js';
import { MessageBus }   from './message-bus.js';
import { StateStore }   from './state-store.js';
import { Logger }       from './logger.js';
import { ToolRegistry } from './tool-registry.js';

export abstract class AgentBase {
  protected readonly client:   Anthropic;
  protected readonly bus:      MessageBus;
  protected readonly state:    StateStore;
  protected readonly logger:   Logger;
  protected readonly tools:    ToolRegistry;

  public readonly config: AgentConfig;

  private _status:    AgentStatus = AgentStatus.IDLE;
  private _completed = 0;
  private _failed    = 0;
  private _startTime = Date.now();
  private _unsubscribers: Array<() => void> = [];

  constructor(config: AgentConfig, bus: MessageBus, state: StateStore) {
    this.config = config;
    this.bus    = bus;
    this.state  = state;
    this.logger = new Logger(config.id);
    this.tools  = new ToolRegistry();
    this.client = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] });
  }

  /** Called once after construction — register tools and bus subscriptions. */
  async init(): Promise<void> {
    this.registerTools();
    this.wire();
    this.logger.info('agent ready', { name: this.config.name });
  }

  // ── Subclass contract ────────────────────────────────────────────────────────

  /** Register tools via `this.tools.register(...)`. */
  protected abstract registerTools(): void;

  /** Core task handler — subclasses implement all domain logic here. */
  protected abstract handle(task: AgentTask): Promise<AgentResult>;

  // ── Status ───────────────────────────────────────────────────────────────────

  get status(): AgentStatus { return this._status; }

  protected setStatus(status: AgentStatus): void {
    this._status = status;
    this.bus.publish(
      `agent.${this.config.id}.status`,
      { agentId: this.config.id, status, timestamp: Date.now() },
      { from: this.config.id, priority: MessagePriority.HIGH },
    );
  }

  // ── Execution ────────────────────────────────────────────────────────────────

  async execute(task: AgentTask): Promise<AgentResult> {
    const start = Date.now();
    this.setStatus(AgentStatus.BUSY);

    this.bus.publish(`agent.${this.config.id}.task.started`, {
      taskId:    task.id,
      agentId:   this.config.id,
      taskType:  task.type,
      timestamp: start,
    });

    try {
      this.logger.info('task started', { taskId: task.id, type: task.type });
      const result = await this.handle(task);

      this._completed++;
      this.setStatus(AgentStatus.IDLE);
      this.logger.info('task done', { taskId: task.id, durationMs: Date.now() - start });
      return result;

    } catch (err) {
      this._failed++;
      this.setStatus(AgentStatus.ERROR);
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error('task failed', { taskId: task.id, error });

      return {
        taskId:     task.id,
        agentId:    this.config.id,
        success:    false,
        error,
        durationMs: Date.now() - start,
      };
    }
  }

  // ── Bus wiring ───────────────────────────────────────────────────────────────

  private wire(): void {
    const unsub = this.bus.subscribe<AgentTask>(
      `agent.${this.config.id}.task`,
      (msg) => void this.execute(msg.payload),
    );
    this._unsubscribers.push(unsub);
  }

  // ── LLM agentic loop helper ──────────────────────────────────────────────────

  /**
   * Runs the full Anthropic tool-use loop with registered tools.
   * Returns the final text response.
   */
  protected async runAgentLoop(
    userMessage: string,
    systemOverride?: string,
  ): Promise<string> {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: userMessage },
    ];

    for (;;) {
      const response = await this.client.messages.create({
        model:      this.config.model ?? 'claude-opus-4-6',
        max_tokens: 8192,
        thinking:   { type: 'adaptive' },
        system:     systemOverride ?? this.config.systemPrompt ?? 'You are a specialised agent.',
        tools:      this.tools.toAnthropicTools() as Anthropic.Tool[],
        messages,
      });

      if (response.stop_reason === 'end_turn') {
        const text = response.content.find((b) => b.type === 'text');
        return text?.type === 'text' ? text.text : '';
      }

      // Tool calls
      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );
      if (toolUses.length === 0) break;

      messages.push({ role: 'assistant', content: response.content });

      const results: Anthropic.ToolResultBlockParam[] = await Promise.all(
        toolUses.map(async (tu) => {
          try {
            const output = await this.tools.execute(tu.name, tu.input);
            return {
              type:        'tool_result' as const,
              tool_use_id: tu.id,
              content:     JSON.stringify(output),
            };
          } catch (err) {
            return {
              type:        'tool_result' as const,
              tool_use_id: tu.id,
              is_error:    true,
              content:     err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );

      messages.push({ role: 'user', content: results });
    }

    return '';
  }

  // ── Health ───────────────────────────────────────────────────────────────────

  health(): AgentHealth {
    return {
      agentId:  this.config.id,
      status:   this._status,
      uptime:   Date.now() - this._startTime,
      tasks:    { completed: this._completed, failed: this._failed },
      lastSeen: Date.now(),
    };
  }

  async shutdown(): Promise<void> {
    this._unsubscribers.forEach((u) => u());
    this.setStatus(AgentStatus.OFFLINE);
    this.logger.info('shutdown');
  }
}
