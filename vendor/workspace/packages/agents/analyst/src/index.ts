/**
 * Agent-13: Analyst
 * ─────────────────
 * Data analysis using Groq fast inference, Neon DB queries, and Tavily research.
 * Produces structured reports, summaries, and data insights.
 */
import {
  AgentBase, AgentTask, AgentResult, AgentConfig,
  MessageBus, StateStore, ToolDefinition,
} from '@workspace/core';
import * as Groq from '@workspace/integrations/groq';
import * as Neon from '@workspace/integrations/neon';
import * as Tavily from '@workspace/integrations/tavily';

const CONFIG: AgentConfig = {
  id:           'analyst',
  name:         'Analyst Agent',
  description:  'Data analysis, SQL insights, structured reports, Groq-powered summaries',
  version:      '1.0.0',
  capabilities: ['analyze_data','run_analytics_query','summarize','compare','generate_report'],
  model:        'claude-opus-4-6',
  systemPrompt: [
    'You are the Analyst Agent. You analyse data and produce actionable insights.',
    'Always include concrete numbers and percentages in your findings.',
    'Structure output as: Summary → Key Findings → Recommendations.',
    'When running SQL, use read-only SELECT queries — never mutate data.',
    'Use Groq for fast iteration on large text summaries.',
  ].join(' '),
};

export class AnalystAgent extends AgentBase {
  constructor(bus: MessageBus, state: StateStore) {
    super(CONFIG, bus, state);
  }

  protected registerTools(): void {
    const tools: ToolDefinition[] = [
      {
        name:        'run_analytics_query',
        description: 'Run a SELECT query on Neon DB for analysis purposes',
        inputSchema: {
          type: 'object',
          required: ['sql'],
          properties: {
            sql:    { type: 'string', description: 'SELECT SQL query (read-only)' },
            params: { type: 'array', description: 'Query parameters' },
          },
        },
        handler: async ({ sql, params }: { sql: string; params?: unknown[] }) => {
          const trimmed = sql.trim().toUpperCase();
          if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('WITH')) {
            return { error: 'Only SELECT / WITH queries are allowed in analytics mode' };
          }
          return Neon.query(sql, params as string[]);
        },
      },
      {
        name:        'summarize_text',
        description: 'Summarize a long piece of text using Groq fast inference',
        inputSchema: {
          type: 'object',
          required: ['text'],
          properties: {
            text:   { type: 'string', description: 'Text to summarize' },
            format: { type: 'string', enum: ['bullets', 'paragraph', 'executive'], description: 'Summary format' },
            length: { type: 'string', enum: ['short', 'medium', 'long'], description: 'Summary length' },
          },
        },
        handler: async ({ text, format = 'bullets', length = 'medium' }:
          { text: string; format?: string; length?: string }) => {
          const prompt = `Summarize the following text as ${length} ${format} summary:\n\n${text}`;
          return Groq.fastChat(prompt);
        },
      },
      {
        name:        'analyze_data',
        description: 'Analyze a dataset (JSON array or CSV text) and return insights',
        inputSchema: {
          type: 'object',
          required: ['data'],
          properties: {
            data:     { type: 'string', description: 'JSON array or CSV string of data to analyze' },
            question: { type: 'string', description: 'Specific question to answer about the data' },
            focus:    { type: 'string', description: 'Analysis focus: trends, outliers, distribution, comparison' },
          },
        },
        handler: async ({ data, question, focus }:
          { data: string; question?: string; focus?: string }) => {
          const prompt = [
            'Analyze the following data and provide structured insights.',
            focus ? `Focus on: ${focus}` : '',
            question ? `Specific question: ${question}` : '',
            'Format: Summary → Key Findings (with numbers) → Recommendations.',
            '\nDATA:\n',
            data,
          ].filter(Boolean).join('\n');

          return Groq.chat([{ role: 'user', content: prompt }], { model: 'llama-3.3-70b-versatile' });
        },
      },
      {
        name:        'compare_options',
        description: 'Compare multiple options or approaches and provide a recommendation',
        inputSchema: {
          type: 'object',
          required: ['options', 'criteria'],
          properties: {
            options:  { type: 'array', items: { type: 'string' }, description: 'Options to compare' },
            criteria: { type: 'array', items: { type: 'string' }, description: 'Evaluation criteria' },
            context:  { type: 'string', description: 'Additional context for the comparison' },
          },
        },
        handler: async ({ options, criteria, context }:
          { options: string[]; criteria: string[]; context?: string }) => {
          const prompt = [
            'Compare the following options across the given criteria.',
            context ? `Context: ${context}` : '',
            `Options: ${options.join(', ')}`,
            `Criteria: ${criteria.join(', ')}`,
            'Produce a comparison table (markdown) then a clear recommendation with rationale.',
          ].filter(Boolean).join('\n');

          return Groq.fastChat(prompt);
        },
      },
      {
        name:        'research_and_analyse',
        description: 'Research a topic via Tavily then produce a structured analysis',
        inputSchema: {
          type: 'object',
          required: ['topic'],
          properties: {
            topic:    { type: 'string', description: 'Topic to research and analyze' },
            question: { type: 'string', description: 'Specific analytical question to answer' },
          },
        },
        handler: async ({ topic, question }: { topic: string; question?: string }) => {
          const research = await Tavily.searchAndSummarize(question ? `${topic}: ${question}` : topic);
          const prompt = [
            `Based on this research, provide a structured analysis:`,
            question ? `Question: ${question}` : '',
            '\nResearch:\n',
            typeof research === 'string' ? research : JSON.stringify(research),
          ].filter(Boolean).join('\n');
          return Groq.fastChat(prompt);
        },
      },
    ];

    for (const t of tools) this.toolRegistry.register(t);
  }

  protected async handle(task: AgentTask): Promise<AgentResult> {
    const start = Date.now();
    const result = await this.runAgentLoop(task.input as string);
    return {
      taskId:     task.id,
      agentId:    this.config.id,
      success:    true,
      output:     result,
      durationMs: Date.now() - start,
    };
  }
}

export function createAgent(bus: MessageBus, state: StateStore): AnalystAgent {
  return new AnalystAgent(bus, state);
}
