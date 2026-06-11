/**
 * Agent-12: Content
 * ─────────────────
 * Content drafting, editing, structuring, and publishing.
 * Uses Groq for fast iteration and Tavily for research-backed content.
 */
import {
  AgentBase, AgentTask, AgentResult, AgentConfig,
  MessageBus, StateStore, ToolDefinition,
} from '@workspace/core';
import * as Groq from '@workspace/integrations/groq';
import * as Tavily from '@workspace/integrations/tavily';
import * as GitHub from '@workspace/integrations/github';

const CONFIG: AgentConfig = {
  id:           'content',
  name:         'Content Agent',
  description:  'Draft, edit, research-back, and publish written content',
  version:      '1.0.0',
  capabilities: ['draft_content','edit_content','research_topic','outline','publish_to_github'],
  model:        'claude-opus-4-6',
  systemPrompt: [
    'You are the Content Agent. You create and refine written content.',
    'Writing style: clear, direct, technically precise, no filler words.',
    'Always research before writing factual content — use research_topic first.',
    'Structure everything: use headings, bullets, numbered lists where appropriate.',
    'When publishing to GitHub, always use descriptive commit messages.',
  ].join(' '),
};

export class ContentAgent extends AgentBase {
  constructor(bus: MessageBus, state: StateStore) {
    super(CONFIG, bus, state);
  }

  protected registerTools(): void {
    const tools: ToolDefinition[] = [
      {
        name:        'draft_content',
        description: 'Draft a piece of content (blog post, README, doc, email template, etc.)',
        inputSchema: {
          type: 'object',
          required: ['type', 'topic'],
          properties: {
            type:         { type: 'string', description: 'Content type: blog, readme, doc, email, announcement, tweet, thread' },
            topic:        { type: 'string', description: 'Main topic or subject' },
            audience:     { type: 'string', description: 'Target audience' },
            tone:         { type: 'string', description: 'Tone: technical, casual, formal, persuasive' },
            keyPoints:    { type: 'array', items: { type: 'string' }, description: 'Key points to include' },
            wordLimit:    { type: 'number', description: 'Approximate word count target' },
          },
        },
        handler: async ({ type, topic, audience, tone, keyPoints, wordLimit }:
          { type: string; topic: string; audience?: string; tone?: string;
            keyPoints?: string[]; wordLimit?: number }) => {
          const prompt = [
            `Write a ${type} about: ${topic}`,
            audience ? `Audience: ${audience}` : '',
            tone ? `Tone: ${tone}` : '',
            keyPoints?.length ? `Key points: ${keyPoints.join(', ')}` : '',
            wordLimit ? `Target length: ~${wordLimit} words` : '',
          ].filter(Boolean).join('\n');

          return Groq.fastChat(prompt);
        },
      },
      {
        name:        'edit_content',
        description: 'Edit and improve existing content for clarity, style, and correctness',
        inputSchema: {
          type: 'object',
          required: ['content'],
          properties: {
            content:       { type: 'string', description: 'Content to edit' },
            editFocus:     { type: 'string', description: 'Focus: clarity, grammar, conciseness, technical_accuracy, tone' },
            preserveStyle: { type: 'boolean', description: 'Preserve original voice/style' },
          },
        },
        handler: async ({ content, editFocus, preserveStyle }:
          { content: string; editFocus?: string; preserveStyle?: boolean }) => {
          const prompt = [
            `Edit the following content${editFocus ? ` focusing on ${editFocus}` : ''}.`,
            preserveStyle ? 'Preserve the original voice and style.' : '',
            'Return only the improved content, no meta-commentary.',
            '\n---\n',
            content,
          ].filter(Boolean).join('\n');

          return Groq.fastChat(prompt);
        },
      },
      {
        name:        'outline_content',
        description: 'Generate a structured outline for a piece of content',
        inputSchema: {
          type: 'object',
          required: ['topic', 'type'],
          properties: {
            topic:    { type: 'string', description: 'Topic to outline' },
            type:     { type: 'string', description: 'Content type' },
            sections: { type: 'number', description: 'Number of main sections (default: 5)' },
          },
        },
        handler: async ({ topic, type, sections = 5 }:
          { topic: string; type: string; sections?: number }) => {
          return Groq.fastChat(
            `Create a ${sections}-section outline for a ${type} about: ${topic}. ` +
            `Format as numbered sections with 2-3 bullet sub-points each.`
          );
        },
      },
      {
        name:        'research_topic',
        description: 'Research a topic using Tavily and return a structured summary for use in content',
        inputSchema: {
          type: 'object',
          required: ['topic'],
          properties: {
            topic:    { type: 'string', description: 'Topic to research' },
            depth:    { type: 'string', enum: ['basic', 'deep'], description: 'Research depth (default: basic)' },
          },
        },
        handler: async ({ topic, depth = 'basic' }:
          { topic: string; depth?: 'basic' | 'deep' }) => {
          if (depth === 'deep') {
            return Tavily.searchAndSummarize(topic);
          }
          const results = await Tavily.search(topic, { maxResults: 5 });
          return results;
        },
      },
      {
        name:        'publish_to_github',
        description: 'Publish a file to a GitHub repository (create or update)',
        inputSchema: {
          type: 'object',
          required: ['repo', 'path', 'content', 'message'],
          properties: {
            repo:    { type: 'string', description: 'Repository in owner/repo format' },
            path:    { type: 'string', description: 'File path in the repo' },
            content: { type: 'string', description: 'File content to publish' },
            message: { type: 'string', description: 'Commit message' },
            branch:  { type: 'string', description: 'Branch name (default: main)' },
          },
        },
        handler: async ({ repo, path, content, message, branch = 'main' }:
          { repo: string; path: string; content: string; message: string; branch?: string }) => {
          const [owner, repoName] = repo.split('/');
          // Use GitHub API to create/update file
          const existing = await GitHub.getRepoContents(owner, repoName, path).catch(() => null);
          const sha = (existing as { sha?: string } | null)?.sha;
          const encoded = Buffer.from(content).toString('base64');

          const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
          const res = await fetch(
            `https://api.github.com/repos/${owner}/${repoName}/contents/${path}`,
            {
              method: 'PUT',
              headers: {
                Authorization: `Bearer ${GITHUB_TOKEN}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ message, content: encoded, branch, ...(sha ? { sha } : {}) }),
            }
          );
          const data = await res.json();
          return { published: true, url: (data as { content?: { html_url?: string } }).content?.html_url };
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

export function createAgent(bus: MessageBus, state: StateStore): ContentAgent {
  return new ContentAgent(bus, state);
}
