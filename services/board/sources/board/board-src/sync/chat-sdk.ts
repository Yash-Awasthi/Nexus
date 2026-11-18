import { createHash } from 'node:crypto'
import type { ReactionEvent } from 'chat'
import type { z } from 'zod'
import { ChatSyncProvider, type ChatInput, type ChatTransport } from './chat-provider.ts'
import { envelope, eventSchema } from './events.ts'
import type { SyncFn } from './fn.ts'
import type { SyncContext, SyncProvider } from './provider.ts'

export type { ChatInput } from './chat-provider.ts'
export { channels } from './fn.ts'

const schemaOf = <P extends string>(platform: P) => eventSchema(platform, 'message')
/** What a `chatSdk()` entry's sync function reads as `sync.event`. `P` is its platform's name. */
export type ChatSdkEvent<P extends string = string> = z.infer<ReturnType<typeof schemaOf<P>>>

/** The adapter, and hooks for what board can't read from it. Every hook is optional. */
export type ChatSdkOptions<P extends string = string> = Omit<ChatTransport, 'platform'> & {
  /** The platform's name, in author IDs, author labels, and `vb sources`. The adapter's `name` unless given. */
  platform?: P
  /**
   * Whether a new board root opens a thread of its own in a mirrored channel, as on Discord or
   * Teams. Off unless given: on most platforms a chat is one conversation, so the root stays on
   * the board, and threads that came from the platform sync both ways.
   */
  canStartThreads?: boolean
  /** The platform's ID for one reaction occurrence, the same on every redelivery. Without it, a reaction is known by the webhook that brought it. */
  reactionId?(reaction: ReactionEvent): string
}

/**
 * Syncs any Chat SDK adapter with the board: `sync` is what each event does, both ways, like
 * `channels({ '-1001234567890': 'support' })`. Channels are the adapter's own IDs, without its
 * prefix. Slack, GitHub, and Linear have entries of their own, with more than this reads.
 */
export function chatSdk<P extends string>(options: ChatSdkOptions<P> & { platform: P }, sync: SyncFn<ChatSdkEvent<P>>): SyncProvider<ChatSdkEvent<P>>
export function chatSdk(options: ChatSdkOptions, sync: SyncFn<ChatSdkEvent>): SyncProvider<ChatSdkEvent>
export function chatSdk(options: ChatSdkOptions, sync: SyncFn<ChatSdkEvent>): SyncProvider<ChatSdkEvent> {
  if (!options?.adapter?.name) throw new Error('chatSdk needs a Chat SDK adapter: chatSdk({ adapter }, channels({ … }))')
  return new ChatSdkProvider(options, sync)
}

class ChatSdkProvider<P extends string> extends ChatSyncProvider<ChatSdkEvent<P>> {
  private readonly schema: ReturnType<typeof schemaOf<P>>
  private readonly reactionId: ((reaction: ReactionEvent) => string) | undefined

  constructor({ platform, reactionId, ...transport }: ChatSdkOptions<P>, sync: SyncFn<ChatSdkEvent<P>>) {
    const name = platform ?? (transport.adapter.name as P)
    super({ ...transport, platform: name }, sync)
    this.schema = schemaOf(name)
    this.reactionId = reactionId
  }

  override eventId(key: string, input: ChatInput): string {
    if (input.kind !== 'reaction') return super.eventId(key, input)
    const reaction = input.reaction
    const occurrence = this.reactionId?.(reaction) ?? this.occurrence()
    return `reaction:${key}:${this.toNative(reaction.threadId)}|${reaction.messageId}|${reaction.rawEmoji}|${reaction.user.userId}|${reaction.added}|${occurrence}`
  }

  /**
   * A reaction's occurrence, when the platform gives it no ID: the webhook that brought it. A
   * platform redelivers the same body, and sends a new one for each occurrence, even where the
   * payload has nothing that tells two apart (Discord's forwarded reactions carry a timestamp
   * beside it).
   */
  private occurrence(): string {
    const delivery = this.delivery()
    if (delivery === null) throw new Error(`${this.platform}: a reaction outside a webhook has no identity; pass reactionId`)
    return createHash('sha256').update(delivery).digest('base64url')
  }

  override event(context: SyncContext): ChatSdkEvent<P> {
    return this.schema.parse(envelope(this.platform, context.key, context.event, context.raw, context.id))
  }
}
