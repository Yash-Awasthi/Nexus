import {
  AgentBase, AgentTask, AgentResult, AgentConfig,
  MessageBus, StateStore,
} from '@workspace/core';
import * as Tavily from '@workspace/integrations/dist/tavily/index.js';

const CONFIG: AgentConfig = {
  id:           'researcher',
  name:         'Researcher',
  description:  'Web search and information retrieval via Tavily',
  version:      '0.1.0',
  capabilities: ['search', 'fetch', 'summarise', 'research', 'cite'],
  model:        'claude-opus-4-6',
  systemPrompt: [
    'You are a precise research agent. Use the search tool to find accurate information.',
    'Always cite sources. Summarise findings concisely with key facts first.',
    'If a query is ambiguous, pick the most likely interpretation and state it.',
  ].join(' '),
};

interface SearchInput  { query: string; depth?: 'basic' | 'advanced'; maxResults?: number }
interface FetchInput   { url: string }
interface ResearchInput { topic: string; depth?: number }

export class ResearcherAgent extends AgentBase {
  constructor(bus: MessageBus, state: StateStore) {
    super(CONFIG, bus, state);
  }

  protected registerTools(): void {
    this.tools.register({
      name:        'search_web',
      description: 'Search the web for information about a query. Returns top results with summaries.',
      inputSchema: {
        type: 'object',
        properties: {
          query:      { type: 'string', description: 'Search query' },
          depth:      { type: 'string', enum: ['basic', 'advanced'], description: 'Search depth' },
          maxResults: { type: 'number', description: 'Max results (1-10, default 5)' },
        },
        required: ['query'],
      },
      handler: async (input: unknown) => {
        const { query, depth = 'basic', maxResults = 5 } = input as SearchInput;
        const res = await Tavily.search(query, { depth, maxResults, includeAnswer: true });
        return {
          answer:  res.answer,
          results: res.results.map((r) => ({
            title:   r.title,
            url:     r.url,
            content: r.content.slice(0, 400),
            score:   r.score,
          })),
        };
      },
    });

    this.tools.register({
      name:        'fetch_page',
      description: 'Fetch and extract text content from a specific URL.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'URL to fetch' } },
        required: ['url'],
      },
      handler: async (input: unknown) => {
        const { url } = input as FetchInput;
        const content = await Tavily.fetchPage(url);
        return { url, content };
      },
    });

    this.tools.register({
      name:        'deep_research',
      description: 'Perform multi-step research on a topic using multiple search queries.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Research topic' },
          depth: { type: 'number', description: 'Number of searches (1-5, default 3)' },
        },
        required: ['topic'],
      },
      handler: async (input: unknown) => {
        const { topic, depth = 3 } = input as ResearchInput;
        const queries = [topic, `${topic} latest`, `${topic} research`].slice(0, depth);
        const results = await Promise.all(
          queries.map((q) => Tavily.search(q, { depth: 'advanced', includeAnswer: true })),
        );
        return {
          topic,
          summaries: results.map((r, i) => ({ query: queries[i], answer: r.answer })),
          sources:   results.flatMap((r) => r.results.slice(0, 2).map((s) => ({ title: s.title, url: s.url }))),
        };
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

export function createAgent(bus: MessageBus, state: StateStore): ResearcherAgent {
  return new ResearcherAgent(bus, state);
}
