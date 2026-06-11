/**
 * Agent-09: Email
 * ───────────────
 * Gmail management: list, read, send, reply, search, archive, label.
 */
import {
  AgentBase, AgentTask, AgentResult, AgentConfig,
  MessageBus, StateStore, ToolDefinition,
} from '@workspace/core';
import * as Gmail from '@workspace/integrations/gmail';

const CONFIG: AgentConfig = {
  id:           'email',
  name:         'Email Agent',
  description:  'Gmail management — compose, reply, search, archive, label',
  version:      '1.0.0',
  capabilities: ['send_email','reply_email','search_email','list_emails','archive_email'],
  model:        'claude-opus-4-6',
  systemPrompt: [
    'You are the Email Agent. You manage Gmail on behalf of the user.',
    'When listing or searching, always include sender, subject, date snippet.',
    'When drafting, match the user\'s tone: direct, professional, concise.',
    'Never send an email without explicit confirmation in the task.',
    'Archive aggressively — keep the inbox near zero.',
  ].join(' '),
};

export class EmailAgent extends AgentBase {
  constructor(bus: MessageBus, state: StateStore) {
    super(CONFIG, bus, state);
  }

  protected registerTools(): void {
    const tools: ToolDefinition[] = [
      {
        name:        'list_emails',
        description: 'List recent emails from Gmail inbox',
        inputSchema: {
          type: 'object',
          properties: {
            maxResults: { type: 'number', description: 'Max emails to return (default 20)' },
            labelIds:   { type: 'array', items: { type: 'string' }, description: 'Gmail label IDs to filter by' },
          },
        },
        handler: async ({ maxResults = 20, labelIds }: { maxResults?: number; labelIds?: string[] }) => {
          const emails = await Gmail.listEmails({ maxResults, labelIds });
          return emails;
        },
      },
      {
        name:        'get_email',
        description: 'Get the full content of a specific email by ID',
        inputSchema: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', description: 'Gmail message ID' },
          },
        },
        handler: async ({ id }: { id: string }) => {
          return Gmail.getEmail(id);
        },
      },
      {
        name:        'search_emails',
        description: 'Search Gmail using Gmail query syntax (e.g. "from:boss@co.com subject:urgent")',
        inputSchema: {
          type: 'object',
          required: ['query'],
          properties: {
            query:      { type: 'string', description: 'Gmail search query' },
            maxResults: { type: 'number', description: 'Max results (default 20)' },
          },
        },
        handler: async ({ query, maxResults = 20 }: { query: string; maxResults?: number }) => {
          return Gmail.listEmails({ query, maxResults });
        },
      },
      {
        name:        'send_email',
        description: 'Send a new email via Gmail',
        inputSchema: {
          type: 'object',
          required: ['to', 'subject', 'body'],
          properties: {
            to:      { type: 'string', description: 'Recipient email address' },
            subject: { type: 'string', description: 'Email subject line' },
            body:    { type: 'string', description: 'Plain-text email body' },
            cc:      { type: 'string', description: 'CC addresses (comma-separated)' },
          },
        },
        handler: async ({ to, subject, body, cc }: { to: string; subject: string; body: string; cc?: string }) => {
          return Gmail.sendEmail({ to, subject, body, cc });
        },
      },
      {
        name:        'reply_email',
        description: 'Reply to an existing email thread',
        inputSchema: {
          type: 'object',
          required: ['threadId', 'body'],
          properties: {
            threadId: { type: 'string', description: 'Gmail thread ID to reply to' },
            body:     { type: 'string', description: 'Reply body text' },
          },
        },
        handler: async ({ threadId, body }: { threadId: string; body: string }) => {
          return Gmail.replyEmail({ threadId, body });
        },
      },
      {
        name:        'archive_email',
        description: 'Archive an email (remove from inbox)',
        inputSchema: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', description: 'Gmail message ID to archive' },
          },
        },
        handler: async ({ id }: { id: string }) => {
          return Gmail.archiveEmail(id);
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

export function createAgent(bus: MessageBus, state: StateStore): EmailAgent {
  return new EmailAgent(bus, state);
}
