// SPDX-License-Identifier: Apache-2.0
/**
 * discord-bot — Lightweight Discord interaction framework for Nexus.
 *
 * Zero external deps. Works with the Discord HTTP Interactions API
 * (slash commands via POST to your webhook endpoint).
 *
 * Provides:
 *   • CommandRegistry — register slash command definitions + handlers
 *   • InteractionRouter — route raw Discord interaction payloads to handlers
 *   • Embed / Response builders — typed helpers for Discord API responses
 */

// ── Discord payload types (minimal subset) ────────────────────────────────────

export type InteractionType = 1 | 2 | 3; // PING | APPLICATION_COMMAND | MESSAGE_COMPONENT

/** Discord option interface definition. */
export interface DiscordOption {
  name: string;
  value: string | number | boolean;
}

/** Discord interaction interface definition. */
export interface DiscordInteraction {
  id: string;
  type: InteractionType;
  data?: {
    name?: string;
    options?: DiscordOption[];
    custom_id?: string;
  };
  guild_id?: string;
  channel_id?: string;
  member?: { user: { id: string; username: string } };
  user?: { id: string; username: string };
  token: string;
}

/** Discord embed interface definition. */
export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: string;
}

/** Interaction response interface definition. */
export interface InteractionResponse {
  type: 1 | 4 | 5 | 6 | 7; // PONG | CHANNEL_MESSAGE | DEFERRED | ACK | UPDATE_MESSAGE
  data?: {
    content?: string;
    embeds?: DiscordEmbed[];
    flags?: number;
    ephemeral?: boolean;
  };
}

// ── Command definition ─────────────────────────────────────────────────────────

export interface CommandOption {
  name: string;
  description: string;
  type: number; // 3=STRING, 4=INT, 5=BOOL, 6=USER, 7=CHANNEL, 8=ROLE
  required?: boolean;
  choices?: { name: string; value: string | number }[];
}

/** Command definition interface definition. */
export interface CommandDefinition {
  name: string;
  description: string;
  options?: CommandOption[];
}

/** Command context interface definition. */
export interface CommandContext {
  interaction: DiscordInteraction;
  options: Map<string, string | number | boolean>;
  userId: string;
  guildId?: string;
}

/** Command handler type alias. */
export type CommandHandler = (
  ctx: CommandContext,
) => InteractionResponse | Promise<InteractionResponse>;

// ── CommandRegistry ────────────────────────────────────────────────────────────

export class CommandRegistry {
  private definitions = new Map<string, CommandDefinition>();
  private handlers = new Map<string, CommandHandler>();

  register(definition: CommandDefinition, handler: CommandHandler): this {
    this.definitions.set(definition.name, definition);
    this.handlers.set(definition.name, handler);
    return this;
  }

  hasCommand(name: string): boolean {
    return this.handlers.has(name);
  }

  getDefinition(name: string): CommandDefinition | undefined {
    return this.definitions.get(name);
  }

  getHandler(name: string): CommandHandler | undefined {
    return this.handlers.get(name);
  }

  listCommands(): CommandDefinition[] {
    return [...this.definitions.values()];
  }

  /** Export for Discord bulk overwrite API. */
  toApplicationCommands(): CommandDefinition[] {
    return this.listCommands();
  }
}

// ── InteractionRouter ──────────────────────────────────────────────────────────

export interface RouterOptions {
  /** Called when interaction type is PING (type=1). Default: returns PONG. */
  onPing?: () => InteractionResponse;
  /** Called when no matching command is found. */
  onUnknown?: (interaction: DiscordInteraction) => InteractionResponse;
}

/** Interaction router. */
export class InteractionRouter {
  private registry: CommandRegistry;
  private opts: RouterOptions;

  constructor(registry: CommandRegistry, opts: RouterOptions = {}) {
    this.registry = registry;
    this.opts = opts;
  }

  async handle(interaction: DiscordInteraction): Promise<InteractionResponse> {
    // PING — Discord health check
    if (interaction.type === 1) {
      return this.opts.onPing?.() ?? { type: 1 };
    }

    // APPLICATION_COMMAND
    if (interaction.type === 2) {
      const name = interaction.data?.name;
      if (!name) return unknownResponse();

      const handler = this.registry.getHandler(name);
      if (!handler) {
        return this.opts.onUnknown?.(interaction) ?? unknownResponse();
      }

      const options = new Map<string, string | number | boolean>();
      for (const opt of interaction.data?.options ?? []) {
        options.set(opt.name, opt.value);
      }

      const userId = interaction.member?.user.id ?? interaction.user?.id ?? "unknown";

      const ctx: CommandContext = {
        interaction,
        options,
        userId,
        guildId: interaction.guild_id,
      };

      try {
        return await handler(ctx);
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : "Unknown error");
      }
    }

    return unknownResponse();
  }
}

// ── Response builders ──────────────────────────────────────────────────────────

export function messageResponse(content: string, ephemeral = false): InteractionResponse {
  return {
    type: 4,
    data: { content, flags: ephemeral ? 64 : 0 },
  };
}

/** Embed response. */
export function embedResponse(embed: DiscordEmbed, ephemeral = false): InteractionResponse {
  return {
    type: 4,
    data: { embeds: [embed], flags: ephemeral ? 64 : 0 },
  };
}

/** Deferred response. */
export function deferredResponse(): InteractionResponse {
  return { type: 5 };
}

/** Pong response. */
export function pongResponse(): InteractionResponse {
  return { type: 1 };
}

function unknownResponse(): InteractionResponse {
  return { type: 4, data: { content: "Unknown command.", flags: 64 } };
}

function errorResponse(message: string): InteractionResponse {
  return { type: 4, data: { content: `Error: ${message}`, flags: 64 } };
}

// ── Embed builder ──────────────────────────────────────────────────────────────

export class EmbedBuilder {
  private embed: DiscordEmbed = {};

  setTitle(title: string): this {
    this.embed.title = title;
    return this;
  }
  setDescription(description: string): this {
    this.embed.description = description;
    return this;
  }
  setColor(color: number): this {
    this.embed.color = color;
    return this;
  }
  setFooter(text: string): this {
    this.embed.footer = { text };
    return this;
  }
  setTimestamp(): this {
    this.embed.timestamp = new Date().toISOString();
    return this;
  }

  addField(name: string, value: string, inline = false): this {
    this.embed.fields = this.embed.fields ?? [];
    this.embed.fields.push({ name, value, inline });
    return this;
  }

  build(): DiscordEmbed {
    return { ...this.embed };
  }
}
