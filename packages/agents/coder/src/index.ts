import {
  AgentBase, AgentTask, AgentResult, AgentConfig,
  MessageBus, StateStore,
} from '@workspace/core';
import * as GitHub from '@workspace/integrations/dist/github/index.js';

const CONFIG: AgentConfig = {
  id:           'coder',
  name:         'Coder',
  description:  'Code generation, review, debugging and refactoring',
  version:      '0.1.0',
  capabilities: ['generate', 'review', 'debug', 'refactor', 'test', 'explain'],
  model:        'claude-opus-4-6',
  systemPrompt: [
    'You are an expert software engineer. You write clean, efficient, well-documented code.',
    'For code reviews, be specific: line numbers, concrete suggestions, severity levels.',
    'For debugging, trace execution mentally before suggesting fixes.',
    'Default to TypeScript for new code unless specified. Always include error handling.',
  ].join(' '),
};

interface GenerateInput { description: string; language?: string; context?: string }
interface ReviewInput   { code: string; language?: string; focus?: string }
interface DebugInput    { code: string; error: string; language?: string }
interface RefactorInput { code: string; goal: string; language?: string }

export class CoderAgent extends AgentBase {
  constructor(bus: MessageBus, state: StateStore) {
    super(CONFIG, bus, state);
  }

  protected registerTools(): void {
    this.tools.register({
      name:        'generate_code',
      description: 'Generate code from a description. Specify language, requirements, and context.',
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'What the code should do' },
          language:    { type: 'string', description: 'Programming language (default: TypeScript)' },
          context:     { type: 'string', description: 'Existing codebase context or constraints' },
        },
        required: ['description'],
      },
      handler: async (input: unknown) => {
        const { description, language = 'TypeScript', context } = input as GenerateInput;
        const prompt = [
          `Generate ${language} code for: ${description}`,
          context ? `Context:\n${context}` : '',
          'Include: proper types, error handling, comments for complex logic.',
        ].filter(Boolean).join('\n\n');
        return await this.runAgentLoop(prompt);
      },
    });

    this.tools.register({
      name:        'review_code',
      description: 'Review code for bugs, security issues, performance, and style.',
      inputSchema: {
        type: 'object',
        properties: {
          code:     { type: 'string', description: 'Code to review' },
          language: { type: 'string', description: 'Programming language' },
          focus:    { type: 'string', description: 'Review focus: security, performance, style, correctness' },
        },
        required: ['code'],
      },
      handler: async (input: unknown) => {
        const { code, language = 'unknown', focus = 'all' } = input as ReviewInput;
        const prompt = `Review this ${language} code (focus: ${focus}):\n\n\`\`\`\n${code}\n\`\`\`\n\nProvide: severity, line numbers, and fixes.`;
        return await this.runAgentLoop(prompt);
      },
    });

    this.tools.register({
      name:        'debug_code',
      description: 'Debug code given an error message or unexpected behaviour.',
      inputSchema: {
        type: 'object',
        properties: {
          code:     { type: 'string', description: 'Code with the bug' },
          error:    { type: 'string', description: 'Error message or description of wrong behaviour' },
          language: { type: 'string', description: 'Programming language' },
        },
        required: ['code', 'error'],
      },
      handler: async (input: unknown) => {
        const { code, error, language = 'unknown' } = input as DebugInput;
        const prompt = `Debug this ${language} code.\n\nError: ${error}\n\nCode:\n\`\`\`\n${code}\n\`\`\`\n\nTrace the execution, identify the root cause, provide the fix.`;
        return await this.runAgentLoop(prompt);
      },
    });

    this.tools.register({
      name:        'refactor_code',
      description: 'Refactor code to improve readability, performance, or structure.',
      inputSchema: {
        type: 'object',
        properties: {
          code:     { type: 'string', description: 'Code to refactor' },
          goal:     { type: 'string', description: 'Refactoring goal' },
          language: { type: 'string', description: 'Programming language' },
        },
        required: ['code', 'goal'],
      },
      handler: async (input: unknown) => {
        const { code, goal, language = 'unknown' } = input as RefactorInput;
        const prompt = `Refactor this ${language} code to: ${goal}\n\nOriginal:\n\`\`\`\n${code}\n\`\`\`\n\nReturn the refactored version with explanation.`;
        return await this.runAgentLoop(prompt);
      },
    });

    this.tools.register({
      name:        'get_repo_file',
      description: 'Get file contents from a GitHub repository.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo:  { type: 'string' },
          path:  { type: 'string' },
        },
        required: ['owner', 'repo', 'path'],
      },
      handler: async (input: unknown) => {
        const { owner, repo, path } = input as { owner: string; repo: string; path: string };
        const contents = await GitHub.getRepoContents(owner, repo, path);
        return { files: contents };
      },
    });
  }

  protected async handle(task: AgentTask): Promise<AgentResult> {
    const start = Date.now();
    const input = typeof task.input === 'string' ? task.input : JSON.stringify(task.input);
    const result = await this.runAgentLoop(input);
    return { taskId: task.id, agentId: this.config.id, success: true, output: result, durationMs: Date.now() - start };
  }
}

export function createAgent(bus: MessageBus, state: StateStore): CoderAgent {
  return new CoderAgent(bus, state);
}
