import type { ToolDefinition } from './types/index.js';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`ToolRegistry: "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  all(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** Return tools in Anthropic SDK tool-definition format. */
  toAnthropicTools(): Array<{
    name:         string;
    description:  string;
    input_schema: Record<string, unknown>;
  }> {
    return this.all().map((t) => ({
      name:         t.name,
      description:  t.description,
      input_schema: t.inputSchema,
    }));
  }

  async execute(name: string, input: unknown): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`ToolRegistry: unknown tool "${name}"`);
    return tool.handler(input);
  }
}
