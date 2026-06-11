import {
  AgentBase, AgentTask, AgentResult, AgentConfig, MessageBus, StateStore,
} from '@workspace/core';
import * as SL from '@workspace/integrations/dist/slack/index.js';

const CONFIG: AgentConfig = {
  id: 'slack', name: 'Slack', description: 'Slack messaging, notifications, channel management',
  version: '0.1.0', capabilities: ['send', 'notify', 'channel', 'thread', 'react'],
  model: 'claude-opus-4-6',
  systemPrompt: 'You are a Slack automation agent. Send messages, manage channels, and handle notifications professionally.',
};

export class SlackAgent extends AgentBase {
  constructor(bus: MessageBus, state: StateStore) { super(CONFIG, bus, state); }

  protected registerTools(): void {
    this.tools.register({
      name: 'send_message', description: 'Send a message to a Slack channel or user.',
      inputSchema: { type: 'object', properties: { channel: { type: 'string', description: 'Channel name or ID (e.g. #general, @user)' }, text: { type: 'string' } }, required: ['channel', 'text'] },
      handler: async (i: unknown) => { const { channel, text } = i as { channel: string; text: string }; const ts = await SL.postMessage(channel, text); return { ts, sent: true }; },
    });
    this.tools.register({
      name: 'reply_in_thread', description: 'Reply to a message in a thread.',
      inputSchema: { type: 'object', properties: { channel: { type: 'string' }, threadTs: { type: 'string' }, text: { type: 'string' } }, required: ['channel', 'threadTs', 'text'] },
      handler: async (i: unknown) => { const { channel, threadTs, text } = i as { channel: string; threadTs: string; text: string }; await SL.replyInThread(channel, threadTs, text); return { sent: true }; },
    });
    this.tools.register({
      name: 'list_channels', description: 'List all Slack channels.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => SL.listChannels(),
    });
    this.tools.register({
      name: 'get_messages', description: 'Get recent messages from a channel.',
      inputSchema: { type: 'object', properties: { channel: { type: 'string' }, limit: { type: 'number' } }, required: ['channel'] },
      handler: async (i: unknown) => { const { channel, limit = 20 } = i as { channel: string; limit?: number }; return SL.getChannelMessages(channel, limit); },
    });
    this.tools.register({
      name: 'create_channel', description: 'Create a new Slack channel.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      handler: async (i: unknown) => { const { name } = i as { name: string }; return SL.createChannel(name); },
    });
    this.tools.register({
      name: 'add_reaction', description: 'Add an emoji reaction to a message.',
      inputSchema: { type: 'object', properties: { channel: { type: 'string' }, ts: { type: 'string' }, emoji: { type: 'string', description: 'Emoji name without colons, e.g. thumbsup' } }, required: ['channel', 'ts', 'emoji'] },
      handler: async (i: unknown) => { const { channel, ts, emoji } = i as { channel: string; ts: string; emoji: string }; await SL.addReaction(channel, ts, emoji); return { reacted: true }; },
    });
  }

  protected async handle(task: AgentTask): Promise<AgentResult> {
    const start = Date.now();
    const result = await this.runAgentLoop(typeof task.input === 'string' ? task.input : JSON.stringify(task.input));
    return { taskId: task.id, agentId: this.config.id, success: true, output: result, durationMs: Date.now() - start };
  }
}

export function createAgent(bus: MessageBus, state: StateStore): SlackAgent {
  return new SlackAgent(bus, state);
}
