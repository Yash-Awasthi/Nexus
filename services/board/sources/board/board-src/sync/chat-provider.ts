import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import type { Adapter, Author as ChatAuthor, Chat, FileUpload, Message as ChatMessage, ReactionEvent, StateAdapter } from 'chat'
import type { Actor } from '../contract/folds.ts'
import { LINKS_PER_MESSAGE_MAX, type ExternalAuthor, type ExternalFile, type ExternalLink } from '../contract/external.ts'
import { SyncProvider, ResolvedTarget, type Receive, type ReceivedEvent, type ProviderOptions, type ProviderPost, type ProviderFile, type ProviderDelivery, type FileDelivery, type FetchedLink } from './provider.ts'
import type { ProviderEvent, SyncRoot } from './events.ts'
import type { SyncFn } from './fn.ts'
import type { SourceJoin, SourceRead } from '../api/routes.ts'
import { createChat, markdownOf } from './chat.ts'
import { ephemeralState } from './state.ts'
import { externalAuthor } from './types.ts'
export { externalAuthor } from './types.ts'

export type ChatInput =
  | { kind: 'message' | 'edited'; message: ChatMessage }
  | { kind: 'deleted'; thread: string; message: string; raw: unknown }
  | { kind: 'reaction'; reaction: ReactionEvent }

export type ChatTransport = Omit<ProviderOptions, 'uploadsFiles'> & {
  adapter: Adapter
  /**
   * Where Chat SDK and the adapter keep their state, like `createRedisState()`. In memory unless
   * given, which is enough when the board's log is all an adapter needs to last.
   */
  state?: StateAdapter
  findByEmail?(email: string): Promise<ExternalAuthor | null>
  mention?(actor: Actor): string | null
  /** As `SyncProvider.mentionById`: a user's mention from their ID alone, where the platform takes one. */
  mentionById?(id: string): string | null
  /** The platform's users a message's text mentions as `@[<their id>]`, which `markdown` wrote there. */
  mentioned?(text: string): Promise<ExternalAuthor[]>
  author?(author: ChatAuthor, raw: unknown): ExternalAuthor
  /** A channel's name as its native ID. Without it, a name is the ID. */
  resolveChannel?(key: string): Promise<string>
  /**
   * A target's channel and kind, called on the provider. Without it, the adapter reads the target
   * as a thread: one it reads as its own channel, or can't read, is a channel.
   */
  resolveTarget?(this: SyncProvider, target: string): Promise<ResolvedTarget>
  groupThread?(thread: string): string
  channelOf?(thread: string): string
  isRoot?(thread: string, message: string): boolean
  fromChatId?(id: string): string
  toChatId?(id: string): string
  context?(message: ChatMessage): string | null
  markdown?(message: ChatMessage): string
  /** Platform messages a message links to, located under sync key `key`. */
  links?(key: string, message: ChatMessage): ExternalLink[]
  fetchLink?(link: ExternalLink, linker: { thread: string; message: string }): Promise<FetchedLink>
  /** The message a URL of the platform's names, by its own IDs: `SyncProvider.locate`. */
  locate?(url: string): { thread: string; message: string | null } | null
  /** The platform's URL for a message, by its own IDs: `SyncProvider.url`. */
  url?(thread: string, message: string): Promise<string | null>
  /** A channel or thread, read on demand without syncing it. */
  read?(target: string, options: { limit: number; after: string | null }): Promise<SourceRead>
  /** Adds the app to a channel so `read` can read it. */
  join?(target: string): Promise<SourceJoin>
  avatar?(message: ChatMessage): Promise<string | null>
  fetchRoot?(thread: string): Promise<Omit<SyncRoot, 'raw'> & { raw?: unknown }>
  intercept?(key: string, headers: Headers, body: string): ReceivedEvent[]
  /** Edits and deletes in a webhook that the adapter doesn't emit itself, as the adapter would have. */
  missed?(headers: Headers, body: string): ChatInput[]
  uploadFiles?(thread: string, files: FileUpload[]): Promise<FileDelivery>
  /** The name a file is uploaded under, when the platform reads more into a name than the board does. */
  uploadName?(file: ProviderFile): string
  fileIds?(raw: unknown): string[]
  refusesFiles?(error: unknown): boolean
  deleteFiles?(ids: string[]): Promise<void>
  /** What the adapter needs to fetch a file again, if not everything the event carried. */
  fileToFetch?(file: ExternalFile): ExternalFile
  startTyping?(thread: string, latest: string | null, status?: string): Promise<void>
}

/** A webhook being handled: what it brought, and what Chat SDK claimed and started for it. */
type Receiving = { key: string; emit: Receive; body: string; claims: string[]; failures: unknown[]; tasks: Promise<unknown>[] }

const externalFile = (file: NonNullable<ChatMessage['attachments']>[number]): ExternalFile => ({
  type: file.type,
  ...(file.name ? { name: file.name.slice(0, 1000) } : {}),
  ...(file.mimeType ? { mimeType: file.mimeType.slice(0, 255) } : {}),
  ...(typeof file.size === 'number' && Number.isInteger(file.size) && file.size >= 0 ? { size: file.size } : {}),
  ...(file.url && file.url.length <= 4000 ? { url: file.url } : {}),
  ...(file.fetchMetadata ? { fetchMetadata: file.fetchMetadata } : {}),
})

export abstract class ChatSyncProvider<E extends ProviderEvent = ProviderEvent> extends SyncProvider<E> {
  protected readonly transport: ChatTransport
  private readonly chat: Chat
  private readonly state: StateAdapter
  private readonly receiving = new AsyncLocalStorage<Receiving>()
  private initialized: Promise<void> | undefined

  constructor(transport: ChatTransport, sync: SyncFn<E>) {
    super({ ...transport, uploadsFiles: !!transport.uploadFiles }, sync)
    this.transport = transport
    this.state = transport.state ?? ephemeralState()
    this.chat = createChat(transport.adapter, this.claiming(this.state))
    // What Chat SDK processes while a webhook is handled finishes before it answers, so the board
    // stores it first, even when the adapter doesn't hand it to `waitUntil` (Discord's forwarded
    // reactions don't).
    const chat = this.chat as unknown as Record<string, unknown>
    // Waited on only: what the board couldn't store fails the webhook through `failures`, and Chat
    // SDK's own errors stay as it handles them.
    for (const name of ['processMessage', 'processMessageUpdated', 'processMessageDeleted', 'processReaction']) {
      const original = chat[name]
      // Loud, so a Chat SDK that renames one fails here rather than answering before it stores.
      if (typeof original !== 'function') throw new Error(`Chat SDK has no ${name}: board can't wait for what it processes`)
      chat[name] = (...args: unknown[]) => {
        const task: unknown = original.apply(this.chat, args)
        if (task instanceof Promise) this.receiving.getStore()?.tasks.push(task.catch(() => {}))
        return task
      }
    }
    const onMessage = async (_thread: unknown, message: ChatMessage) => this.emit({ kind: 'message', message })
    this.chat.onNewMessage(/[\s\S]*/, onMessage)
    this.chat.onNewMention(onMessage)
    this.chat.onMessageUpdated(async (_thread, message) => this.emit({ kind: 'edited', message }))
    this.chat.onMessageDeleted(async (event) => this.emit({ kind: 'deleted', thread: event.threadId, message: event.messageId, raw: event.raw }))
    this.chat.onReaction(async (reaction) => this.emit({ kind: 'reaction', reaction }))
  }

  protected toNative(id: string): string {
    const native = id.slice(id.indexOf(':') + 1)
    return this.transport.fromChatId?.(native) ?? native
  }

  protected toChat(id: string): string {
    return `${this.transport.adapter.name}:${this.transport.toChatId?.(id) ?? id}`
  }

  protected locationOf(key: string, chatThread: string) {
    const native = this.toNative(chatThread)
    const precise = `${key}:${native}`
    const thread = `${key}:${this.transport.groupThread?.(native) ?? native}`
    const channel = this.transport.channelOf?.(native) ?? this.toNative(this.transport.adapter.channelIdFromThreadId(chatThread))
    return { channel: `${key}:${channel}`, thread, subthread: precise === thread ? null : precise }
  }

  override inboxChannel(key: string, thread: string): string {
    const native = thread.slice(key.length + 1)
    return `${key}:${this.transport.channelOf?.(native) ?? this.toNative(this.transport.adapter.channelIdFromThreadId(this.toChat(native)))}`
  }

  eventId(key: string, input: ChatInput): string {
    if (input.kind === 'reaction') throw new Error(`${this.platform} must supply a stable reaction occurrence ID`)
    if (input.kind === 'deleted') return `deleted:${key}:${this.toNative(input.thread)}|${input.message}`
    const message = input.message
    const location = `${key}:${this.toNative(message.threadId)}|${message.id}`
    if (input.kind === 'message') return `message:${location}`
    // A digest, not the text: an inbox event ID is short (300 characters on Vercel's API), and a message isn't.
    // With when it was edited, where the platform says: an edit back to earlier text is a new edit, not a retry.
    const at = message.metadata?.editedAt ? new Date(message.metadata.editedAt).getTime() : NaN
    return `edited:${location}|${createHash('sha256').update(message.text).digest('base64url')}${Number.isFinite(at) ? `|${at}` : ''}`
  }

  protected author(author: ChatAuthor, raw: unknown) {
    return this.transport.author?.(author, raw) ?? externalAuthor(this.platform, author)
  }

  protected async authorOf(message: ChatMessage) {
    const author = this.author(message.author, message.raw)
    const avatar = await this.transport.avatar?.(message).catch(() => null)
    return avatar ? { ...author, avatar } : author
  }

  protected async normalize(key: string, input: ChatInput): Promise<ReceivedEvent> {
    const dedupe = this.eventId(key, input)
    if (input.kind === 'deleted') {
      return { dedupe, raw: input.raw, event: { kind: 'deleted', ...this.locationOf(key, input.thread), message: input.message } }
    }
    if (input.kind === 'reaction') {
      const event = input.reaction
      const emoji = (event.emoji?.name ?? event.rawEmoji).toLowerCase().replace(/[^a-z0-9_+-]/g, '_').slice(0, 64) || 'unknown'
      return { dedupe, raw: event.raw, event: {
        kind: 'reaction', ...this.locationOf(key, event.threadId), message: event.messageId,
        emoji, added: event.added, author: this.author(event.user, event.raw),
      } }
    }
    const message = input.message
    const found = this.transport.links?.(key, message) ?? []
    const links = found.length ? { links: found.slice(0, LINKS_PER_MESSAGE_MAX) } : {}
    const text = this.transport.markdown?.(message) ?? markdownOf(message)
    const mentioned = (await this.transport.mentioned?.(text)) ?? []
    const common = {
      ...this.locationOf(key, message.threadId), message: message.id,
      text, author: await this.authorOf(message),
      ...links,
      ...(mentioned.length ? { mentioned } : {}),
    }
    return { dedupe, raw: message.raw, event: input.kind === 'edited' ? { kind: 'edited', ...common } : {
      kind: 'message', ...common,
      isRoot: this.transport.isRoot?.(this.toNative(message.threadId), message.id) ?? false,
      context: this.transport.context?.(message) ?? null,
      ...(message.attachments?.length ? { files: message.attachments.slice(0, 20).map(externalFile) } : {}),
    } }
  }

  private async emit(input: ChatInput) {
    const context = this.receiving.getStore()
    if (!context) throw new Error('Chat SDK emitted an event outside a verified request')
    try {
      await context.emit(await this.normalize(context.key, input))
    } catch (error) {
      // Kept here too: an adapter may catch what its handlers throw (Telegram's does) and answer 200.
      context.failures.push(error)
      throw error
    }
  }

  /** The body of the webhook being handled, as the platform sent it: the same on a redelivery. */
  protected delivery(): string | null {
    return this.receiving.getStore()?.body ?? null
  }

  override async receive(key: string, request: Request, emit: Receive): Promise<Response> {
    const claims: string[] = []
    const body = await request.clone().text()
    try {
      return await this.receiving.run({ key, emit, body, claims, failures: [], tasks: [] }, () => this.receiveRequest(key, request, emit))
    } catch (error) {
      // The board couldn't store what came in, so the platform retries. Chat SDK and the adapter
      // claimed it as handled (a message's dedupe key, Telegram's update ID): give that back, or
      // they'd skip the retry and the event would be lost.
      await Promise.allSettled(claims.map((claim) => this.state.delete(claim)))
      throw error
    }
  }

  /** `state`, noting each first claim (`setIfNotExists`) made while a webhook is handled. */
  private claiming(state: StateAdapter): StateAdapter {
    return new Proxy(state, {
      get: (target, property) => {
        if (property === 'setIfNotExists') {
          return async (key: string, value: unknown, ttlMs?: number) => {
            const claimed = await target.setIfNotExists(key, value, ttlMs)
            if (claimed) this.receiving.getStore()?.claims.push(key)
            return claimed
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  private async receiveRequest(key: string, request: Request, emit: Receive): Promise<Response> {
    const { body, tasks, failures } = this.receiving.getStore()!
    const webhooks = this.chat.webhooks as Record<string, (request: Request, options: { waitUntil(task: Promise<unknown>): void }) => Promise<Response>>
    const response = await webhooks[this.transport.adapter.name]!(request, { waitUntil: (task) => void tasks.push(task) })
    const results: PromiseSettledResult<unknown>[] = []
    while (tasks.length) results.push(...await Promise.allSettled(tasks.splice(0)))
    if (failures.length) throw failures[0]
    const failed = results.find((result) => result.status === 'rejected')
    if (failed) throw failed.reason
    if (response.ok && (this.transport.intercept || this.transport.missed)) {
      for (const input of this.transport.missed?.(request.headers, body) ?? []) await emit(await this.normalize(key, input))
      for (const received of this.transport.intercept?.(key, request.headers, body) ?? []) await emit(received)
    }
    return response
  }

  protected async ready() {
    this.initialized ??= this.chat.initialize().catch((error) => {
      this.initialized = undefined
      throw error
    })
    await this.initialized
    return this.transport.adapter
  }

  override async resolveChannel(key: string) { return this.transport.resolveChannel ? this.transport.resolveChannel(key) : key }
  override async resolveTarget(target: string) {
    return ResolvedTarget.parse(this.transport.resolveTarget ? await this.transport.resolveTarget.call(this, target) : this.targetOf(target))
  }
  /** A target as the adapter reads it: a thread in its channel, or a channel. */
  private targetOf(target: string): ResolvedTarget {
    let channel: string
    try {
      channel = this.transport.channelOf?.(target) ?? this.toNative(this.transport.adapter.channelIdFromThreadId(this.toChat(target)))
    } catch {
      return { target, channel: target, kind: 'channel' }
    }
    return { target, channel, kind: channel === target ? 'channel' : 'thread' }
  }
  override async findByEmail(email: string) { return this.transport.findByEmail?.(email) ?? null }
  override mention(actor: Actor) { return this.transport.mention?.(actor) ?? null }
  override mentionById(id: string) { return this.transport.mentionById?.(id) ?? null }
  override async fetchRoot(thread: string): Promise<SyncRoot | null> {
    const root = await this.transport.fetchRoot?.(thread)
    return root ? { ...root, raw: root.raw ?? null } : null
  }
  override async fetchLink(link: ExternalLink, linker: { thread: string; message: string }): Promise<FetchedLink> {
    return this.transport.fetchLink ? this.transport.fetchLink(link, linker) : super.fetchLink(link, linker)
  }
  override locate(url: string): { thread: string; message: string | null } | null {
    return this.transport.locate ? this.transport.locate(url) : super.locate(url)
  }
  override async url(thread: string, message: string): Promise<string | null> {
    return this.transport.url ? this.transport.url(thread, message) : super.url(thread, message)
  }

  override async read(target: string, options: { limit: number; after: string | null }): Promise<SourceRead> {
    return this.transport.read ? this.transport.read(target, options) : super.read(target, options)
  }
  override async join(target: string): Promise<SourceJoin> {
    return this.transport.join ? this.transport.join(target) : super.join(target)
  }
  override async fetchFile(file: ExternalFile): Promise<Uint8Array | null> {
    // Ready first: an adapter may resolve a file's credentials from its Chat state.
    const adapter = await this.ready()
    const fetch = adapter.rehydrateAttachment?.({ ...(this.transport.fileToFetch?.(file) ?? file) }).fetchData
    if (!fetch) return null
    const data = await fetch()
    return data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  override async post(target: string, kind: ResolvedTarget['kind'], { as: _sender, deployments: _listed, files, ...body }: ProviderPost): Promise<ProviderDelivery> {
    if (kind === 'channel' && !this.canStartThreads) throw new Error(`${this.platform} cannot start threads`)
    await this.ready()
    const sent = await (kind === 'channel' ? this.chat.channel(this.toChat(target)) : this.chat.thread(this.toChat(target))).post(files?.length ? { ...body, files: this.named(files) } : body)
    return { thread: this.toNative(sent.threadId), message: sent.id, ...(files?.length ? { files: this.transport.fileIds?.(sent.raw) ?? [] } : {}) }
  }
  override async edit(thread: string, message: string, { as: _sender, deployments: _listed, files, ...body }: ProviderPost) {
    await (await this.ready()).editMessage(this.toChat(thread), message, files ? { ...body, files: this.named(files) } : body)
  }
  override async delete(thread: string, message: string) { await (await this.ready()).deleteMessage(this.toChat(thread), message) }
  override async react(thread: string, message: string, emoji: string, added: boolean) {
    const adapter = await this.ready()
    if (added) await adapter.addReaction(this.toChat(thread), message, emoji)
    else await adapter.removeReaction(this.toChat(thread), message, emoji)
  }
  override async startTyping(thread: string, latest: string | null, status?: string) {
    const adapter = await this.ready()
    if (this.transport.startTyping) await this.transport.startTyping(this.toChat(thread), latest, status)
    else await adapter.startTyping(this.toChat(thread), status)
  }
  override async uploadFiles(thread: string, files: ProviderFile[]) {
    await this.ready()
    if (!this.transport.uploadFiles) return super.uploadFiles(thread, files)
    return this.transport.uploadFiles(this.toChat(thread), this.named(files))
  }
  /** Files as the Chat SDK takes them: Buffers, named as the platform wants. */
  private named(files: ProviderFile[]): FileUpload[] {
    const name = this.transport.uploadName
    return files.map((file) => ({
      ...file,
      data: Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength),
      ...(name ? { filename: name(file) } : {}),
    }))
  }
  override refusesFiles(error: unknown) { return this.transport.refusesFiles?.(error) ?? false }
  override async deleteFiles(ids: string[]) { await this.transport.deleteFiles?.(ids) }
}
