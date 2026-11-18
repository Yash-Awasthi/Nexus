import { canonicalEmoji } from '../contract/emoji.ts'
import type { BoardClient } from '../client/client.ts'
import { derivedId } from '../client/ids.ts'
import type { Actor, ExternalCopy } from '../contract/folds.ts'
import { externalMessageKey, isThreadTarget } from '../contract/external.ts'
import type { ExternalAuthor, ExternalEvent, ExternalFile, ExternalLink, Origin } from '../contract/external.ts'
import { fileSize, importedFileName, typeOf } from '../contract/files.ts'
import { ATTACHMENT_BYTES_MAX, ATTACHMENTS_PER_MESSAGE_MAX, IMPORT_BYTES_MAX, MESSAGE_TEXT_MAX, toStorable, type Attachment } from '../contract/schemas.ts'
import type { BoardEventView, InboxItem, LinkView, MessageView, SyncThreadView } from '../api/routes.ts'
import type { Method, Protocol } from '../api/protocol.ts'
import { afterRetry } from '../server/attempts.ts'
import type { Caller, InboxDelivery, ProtocolMethods } from '../server/backend.ts'
import { badRequest, HttpError, notFound } from '../server/errors.ts'
import type { SyncTarget } from '../server/targets.ts'
import { channelOf } from '../contract/external.ts'
import { DroppedError, type WriteSource } from '../server/middleware.ts'
import { waitUntil } from '../server/wait-until.ts'
import type { SyncProvider } from './provider.ts'
import { extractMentions, isEmail, replaceMentions } from '../contract/mentions.ts'
import { SyncOverrides, immutable, type SyncRoot, type ProviderEvent, type SyncResult } from './events.ts'
import { channelMissing, opensBlock, routesFor, ReceivedEvent, ResolvedTarget, UnreadableError, type ProviderSender, type Renderer } from './provider.ts'
import type { SyncIn, SyncOut } from './fn.ts'
import { ChannelPath } from '../contract/schemas.ts'
import { byVercelBot, displayText, vercelDeployments, type VercelDeployment } from '../contract/bots.ts'
import { actorParts, platformProfile, shownName, viaText } from '../contract/profiles.ts'

/** An event as sync gets it: a board event's view, with the message as it was before for a label change. */
export type SyncEvent = BoardEventView & { before?: MessageView }

/** Where a platform event's writes come from, for the middleware, and how to answer there: a reply in its own platform thread. */
type EventSource = { via: Extract<WriteSource, { kind: 'sync' }>; respond: (text: string) => Promise<void> }

/** What sync runs on: the board's backend's methods, its imports through board()'s middleware, and in-process clients through board(). */
export type SyncHost = {
  backend: ProtocolMethods
  /**
   * A client through board() for a sync callback, as the platform user `author` its event came from on
   * entry `key`: its writes are imports as them, on any backend, and its reads are sync's. Its posts get
   * IDs derived from `trigger`.
   */
  client(platform: { author: ExternalAuthor; key: string } & EventSource, trigger: string): BoardClient
  /** Whether sync runs entry `key` here, as the backend says: another deployment may hold it. */
  syncedHere(key: string): Promise<boolean>
}

/**
 * The actors sync renders with: who each is, and who this sync is on its board (`principal`), whose
 * platform users it may mention natively. Null when the board didn't say.
 */
type Actors = { byId: Record<string, Actor & { verified?: true }>; principal: string | null }

/** `files`: a message with files may have no text. */
const clampText = (raw: string, files = false) => {
  // A platform message can hold what the board can't store.
  const text = toStorable(raw)
  const trimmed = text.trim() === '' ? (files ? '' : '(no text)') : text
  // The cut can split a character, so it's cleaned again.
  return trimmed.length > MESSAGE_TEXT_MAX ? `${trimmed.slice(0, MESSAGE_TEXT_MAX - 1).toWellFormed()}…` : trimmed
}

/** A platform file the board couldn't bring over gets a line in the text instead. */
const fileNote = (file: ExternalFile, why: string, name = file.name ?? 'a file') =>
  `📎 ${name}${file.size !== undefined ? ` (${fileSize(file.size)})` : ''} didn't come over: ${why}`

/** What a board that keeps no files answers for every file route. */
const keepsNoFiles = (error: unknown) => error instanceof HttpError && error.code === 'no_files'

/**
 * A platform file on a board that keeps no files: a link to where it lives on the platform, which
 * its readers there can open, or its name when the platform gave no URL.
 */
const fileLink = (file: ExternalFile, why: string) => {
  const name = file.name ?? 'a file'
  if (!file.url || !/^https?:\/\//.test(file.url)) return fileNote(file, why)
  const label = name.replace(/[[\]\\]/g, (char) => `\\${char}`)
  const url = file.url.replace(/[ ()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return fileNote(file, why, `[${label}](${url})`)
}

/** A platform message's text with its file notes after it. */
const withNotes = (text: string, notes: string[]) =>
  notes.length ? `${text.trim() ? `${text}\n\n` : ''}${notes.join('\n')}` : text

/** The file notes in a message's text, so a platform edit (which only knows the text it shows) keeps them. */
const notesIn = (text: string) => text.split('\n').filter((line) => /^📎 .* didn't come over: /u.test(line))

/** A link as an import carries it, its keys in one order. */
type ImportLink = Omit<LinkView, 'message'> & { message: string | null }
const linkKey = (link: ImportLink) => JSON.stringify([link.url, link.message, link.snapshot, link.unavailable])
/** Whether two link lists say the same, whatever order their keys were written in. */
const sameLinks = (a: ImportLink[], b: ImportLink[]) => a.length === b.length && a.every((link, i) => linkKey(link) === linkKey(b[i]!))

/** Tries per file before it's noted instead: a retry repeats the whole message, so keep it short. */
const FILE_ATTEMPTS = 3

/** How long a platform's answer to who has an email holds, for `@[ada@vercel.com]`: a busy thread asks once. */
const EMAIL_TTL_MS = 5 * 60_000
/** How many `@[email]`s one message has looked up on a platform: each is a call to it, and a message holds thousands. */
const EMAIL_LOOKUPS_PER_MESSAGE_MAX = 10

/** How long a webhook waits for the board's tables before it lets an event into the inbox anyway: platforms resend after about 3 seconds. */
const GATE_WAIT_MS = 2_000

/**
 * A2 dead-letters an event after 10 failures, and a dead letter stops its lane,
 * which is the thread's: nothing after it would sync. So a delivery retries a
 * few times, then records a `failed` receipt and lets the thread move on.
 */
const DELIVERY_ATTEMPTS = 5

/** How long one pull of the inbox runs before it leaves the rest to the next. */
const PULL_MS = 4 * 60_000

/** A signal that never aborts, for the engine's own calls. */
const NEVER = new AbortController().signal

const jsonSafe = (value: unknown): unknown => {
  try {
    return JSON.parse(JSON.stringify(value ?? null))
  } catch {
    return null
  }
}

/** Plain JSON with every string, keys too, as the board keeps it: platforms send what Postgres can't store. */
const storableJson = <T>(value: T): T => {
  if (typeof value === 'string') return toStorable(value) as T
  if (Array.isArray(value)) return value.map(storableJson) as T
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [toStorable(key), storableJson(item)])) as T
  return value
}

/** A platform error's code (`not_in_channel`) when it has one, else its message. */
const describe = (error: unknown): string => {
  const code = (error as { data?: { error?: unknown } } | null)?.data?.error
  const text = typeof code === 'string' ? code : error instanceof Error ? error.message : String(error)
  return toStorable(text.slice(0, 500)) || 'unknown error'
}

/** A board error that says what wasn't there. */
const missing = (error: unknown) => error instanceof HttpError && error.status === 404

/**
 * A platform user's ID as the board names them: under the sync key they came through, not the
 * platform their provider names (`slack-eu:user:U0456` for `slack:user:U0456` through key
 * `slack-eu`). The key is the connection, so a user is that connection's.
 */
export function keyedId(key: string, platform: string, id: string): string {
  if (id.startsWith(`${key}:`)) return id
  return `${key}:${id.startsWith(`${platform}:`) ? id.slice(platform.length + 1) : id}`
}

/**
 * A platform's text, each of its users it mentions by ID (`@[slack:user:U0456]`, as a provider
 * writes one) named under `key`: a mention by the platform's name would be of another sync's user.
 */
function keyedText(key: string, platform: string, text: string): string {
  if (key === platform) return text
  return replaceMentions(text, (token) => (token.kind === 'actor' && token.actor.startsWith(`${platform}:`) ? `@[${keyedId(key, platform, token.actor)}]` : null))
}

/**
 * A platform event with its author named under `key`, and every user its text mentions there too:
 * the ones `mentioned` describes, and any it has no room for.
 */
function keyedEvent(key: string, platform: string, event: ExternalEvent): ExternalEvent {
  if (!('author' in event)) return event
  const author = { ...event.author, id: keyedId(key, platform, event.author.id) }
  if ((event.kind !== 'message' && event.kind !== 'edited') || key === platform) return { ...event, author } as ExternalEvent
  return {
    ...event,
    author,
    ...(event.mentioned ? { mentioned: event.mentioned.map((user) => ({ ...user, id: keyedId(key, platform, user.id) })) } : {}),
    text: keyedText(key, platform, event.text),
  }
}

/**
 * Two-way sync between a board and its platforms, run by board(): webhooks come in through its
 * adapters and land in the backend's inbox, and what the board's subscription delivers goes out
 * to them. It reads and writes only through the backend's protocol methods, as `caller`.
 */
export function createSyncEngine(entries: Record<string, SyncProvider>) {
  let bound: SyncHost | null = null
  const host = () => {
    if (!bound) throw new Error('sync used before board() bound it')
    return bound
  }
  /** Sync's own caller: on a local board, `board:sync`; on http(), this deployment itself. */
  const me: Caller = { self: 'sync', origin: { via: { kind: 'engine' } } }

  /** One protocol method, as sync. */
  function call<M extends Method>(method: M, input: Protocol[M]['input'], signal: AbortSignal = NEVER, caller: Caller = me): Promise<Protocol[M]['output']> {
    const backend = host().backend
    return (backend[method] as (caller: Caller, input: Protocol[M]['input'], signal: AbortSignal) => Promise<Protocol[M]['output']>).call(backend, caller, input, signal)
  }

  const platformOf = (key: string): SyncProvider => {
    const platform = entries[key]
    if (!platform) throw badRequest(`no sync entry named ${key}`)
    return platform
  }
  const keyOf = (target: string) => target.slice(0, target.indexOf(':'))
  /** Whether this board syncs entry `key` here: another deployment may hold it, and take its webhooks and deliveries. */
  const here = (key: string) => host().syncedHere(key)
  /** A target of this sync's own, here: another sync on the board (its own, one elsewhere, or another deployment's) delivers the rest. */
  const ours = async (target: string) => entries[keyOf(target)] !== undefined && (await here(keyOf(target)))
  const native = (external: string) => external.slice(external.indexOf(':') + 1)

  // --- lookups --------------------------------------------------------------------

  /** A thread's sync, or null when the board has no such thread. */
  async function syncOf(thread: string): Promise<SyncThreadView | null> {
    try {
      return await call('syncThread', { thread })
    } catch (error) {
      if (missing(error)) return null
      throw error
    }
  }

  /** A board thread: its root and every reply, deleted ones included. */
  async function threadOf(root: string): Promise<MessageView[]> {
    try {
      const { message, replies } = await call('message', { id: root })
      return [message, ...replies]
    } catch (error) {
      if (missing(error)) return []
      throw error
    }
  }

  /** One board message as it is now. */
  async function messageOf(id: string): Promise<MessageView | null> {
    return (await threadOf(id)).find((message) => message.id === id) ?? null
  }

  async function copiesOf(ids: readonly string[]): Promise<Record<string, Record<string, ExternalCopy>>> {
    if (ids.length === 0) return {}
    return (await call('syncCopies', { message: [...new Set(ids)] })).copies
  }

  const find = (query: Protocol['syncFind']['input'], signal?: AbortSignal) => call('syncFind', query, signal)

  /** Who this sync is on its board, asked once: the board's own sync on a local board, or this deployment on one elsewhere. */
  let principal: Promise<string> | null = null
  function principalNow(): Promise<string> {
    if (principal) return principal
    const asked = call('me', {}).then((me) => me.principal)
    principal = asked
    asked.catch(() => {
      if (principal === asked) principal = null
    })
    return asked
  }

  /** The actors sync renders with, as the board has them now. */
  async function actorsNow(): Promise<Actors> {
    const [{ actors }, me] = await Promise.all([call('actors', {}), principalNow().catch(() => null)])
    const state: Actors = { byId: {}, principal: me }
    for (const actor of actors)
      state.byId[actor.id] = {
        id: actor.id,
        kind: actor.kind,
        handle: actor.handle,
        name: actor.name,
        avatar: actor.avatar,
        ...(actor.via ? { via: { ...actor.via } } : {}),
        ...(actor.platform ? { platform: actor.platform } : {}),
        ...(actor.verified ? { verified: true as const } : {}),
      }
    return state
  }

  // --- channels ---------------------------------------------------------------

  /** How long a name that didn't resolve (say, a Slack channel that doesn't exist yet) waits before another try. */
  const RETRY_MS = 60_000
  const resolutions = new Map<string, { id: Promise<string>; failed: boolean; at: number }>()
  /**
   * A platform channel's ID from its name, on entry `key`: what sync functions route by. Each
   * resolves once. One the platform says doesn't exist is logged and
   * tried again a minute later; one it couldn't check is asked again on the next call, so a
   * retried event asks again.
   */
  function resolve(key: string, name: string): Promise<string> {
    const at = `${key}:${name}`
    const cached = resolutions.get(at)
    if (cached && (!cached.failed || Date.now() - cached.at < RETRY_MS)) return cached.id
    const entry = { id: platformOf(key).resolveChannel(name), failed: false, at: Date.now() }
    entry.id.catch((error: unknown) => {
      entry.failed = true
      const missing = channelMissing(error)
      if (!missing && resolutions.get(at) === entry) resolutions.delete(at)
      console.warn(`[board] sync ${key}: ${missing ? 'skipping' : "couldn't resolve"} ${name}: ${(error as Error).message}`)
    })
    resolutions.set(at, entry)
    return entry.id
  }

  /** The platform channel a target is in, as the platform names it; null when its provider can't tell. */
  function channelIn(key: string, target: string): string | null {
    if (!isThreadTarget(target)) return native(target)
    try {
      const channel = platformOf(key).inboxChannel(key, target)
      return channel === null ? null : native(channel)
    } catch {
      return null
    }
  }

  const emails = new Map<string, { at: number; mention: Promise<string | null> }>()
  /**
   * How entry `key`'s platform mentions whoever has this email there, as it posts: `<@U0456>` for
   * `@[ada@vercel.com]`, or null when it finds no one. Each answer holds a few minutes.
   */
  function emailMention(key: string, email: string): Promise<string | null> {
    const at = `${key}\u001f${email.toLowerCase()}`
    const cached = emails.get(at)
    if (cached && Date.now() - cached.at < EMAIL_TTL_MS) return cached.mention
    if (emails.size >= 1000) emails.clear()
    const platform = platformOf(key)
    const mention = platform.findByEmail(email).then(
      (user) => (user ? platform.mention({ id: user.id, kind: 'external', handle: user.handle, name: user.name, avatar: user.avatar }) : null),
      () => null,
    )
    emails.set(at, { at: Date.now(), mention })
    return mention
  }

  /** Validates a requested target and resolves names (`slack:#prs`) to IDs. */
  async function normalizeTarget(target: string): Promise<SyncTarget> {
    const at = target.indexOf(':')
    if (at <= 0) throw badRequest(`sync targets look like <key>:<channel or thread>, got: ${target}`)
    const key = target.slice(0, at)
    const platform = platformOf(key)
    try {
      const resolved = ResolvedTarget.parse(await platform.resolveTarget(target.slice(at + 1)))
      if (resolved.kind === 'channel' && !platform.canStartThreads) throw new Error(`${platform.platform} cannot start threads; use an existing thread`)
      return { target: `${key}:${resolved.target}`, kind: resolved.kind }
    } catch (error) {
      throw badRequest(`can't sync to ${target}: ${(error as Error).message}`)
    }
  }

  // --- inbound: platform → inbox --------------------------------------------------

  async function intake(key: string, received: ReceivedEvent) {
    const { event, raw, dedupe } = ReceivedEvent.parse(storableJson({ ...received, raw: jsonSafe(received.raw) }))
    for (const location of [event.channel, event.thread, 'subthread' in event ? event.subthread : null])
      if (location !== null && !location.startsWith(`${key}:`)) throw badRequest(`provider locations must belong to sync entry ${key}`)
    // Only the channels a helper routes, and threads the board syncs, are kept. A helper that
    // can't tell yet throws: unless the board syncs the thread, the webhook fails, so the platform
    // sends it again.
    const routes = routesFor(platformOf(key))
    const kept = routes && (await routes(native(event.channel), (name) => resolve(key, name)).catch(async (error: unknown) => {
      if (await syncsThread(event.thread)) return true
      throw error
    }))
    if (routes && !kept && !(await syncsThread(event.thread))) return
    await call('inboxPush', { key, events: [{ id: dedupe, event, raw }] })
  }

  /**
   * Whether the board syncs a platform thread outside its mapped channels. A receipt or a
   * request that just synced it may not be in its tables yet, so a miss waits for them;
   * if they're still catching up, the inbox decides, since it waits as long as it takes.
   */
  async function syncsThread(thread: string): Promise<boolean> {
    try {
      return (await find({ thread }, AbortSignal.timeout(GATE_WAIT_MS))).thread !== null
    } catch (error) {
      const name = (error as Error | null)?.name
      if (name === 'TimeoutError' || name === 'AbortError') return true
      throw error
    }
  }

  async function handleWebhook(key: string, request: Request): Promise<Response> {
    const platform = entries[key]
    if (!platform) throw notFound(`no sync entry named ${key}`)
    // Another deployment holds the key: what the platform sends is that one's to import, and its adapter's to read.
    if (!(await here(key))) return new Response(null, { status: 200 })
    let response: Response
    try {
      response = await platform.receive(key, request, (received) => intake(key, received))
    } catch (error) {
      // The board refused the event as it is: a redelivery is the same event, refused the same way.
      if (error instanceof HttpError && error.status === 400) {
        console.error('[board] dropped an event the board refuses', error)
        return new Response(null, { status: 200 })
      }
      console.error('[board] intake failed', error)
      return new Response('intake failed', { status: 500 })
    }
    // A backend that queues what's pushed hands it back here; one that delivers it in-process has nothing to pull.
    const pulling = pull([key]).catch((error: unknown) => console.error(`[board] couldn't pull ${key}'s inbox:`, describe(error)))
    waitUntil(pulling)
    return response
  }

  /**
   * Pulls what this board's sync queued in the backend's inbox, runs it, and acks it, until
   * nothing's left or this run's time is up. A platform thread's events come one at a time.
   */
  async function pull(keys: readonly string[] = Object.keys(entries)): Promise<number> {
    let ran = 0
    const until = Date.now() + PULL_MS
    for (const key of keys) {
      if (!(await here(key))) continue
      while (Date.now() < until) {
        const { items } = await call('inboxNext', { key, limit: 10 })
        if (items.length === 0) break
        // Each is a different platform thread's oldest, so they run side by side.
        await Promise.all(items.map((item) => runItem(key, item)))
        ran += items.length
      }
    }
    return ran
  }

  async function runItem(key: string, item: InboxItem) {
    let error: string | undefined
    try {
      await inbound(key, { event: item.event, raw: item.raw }, { id: item.id, attempt: item.attempt + 1 })
    } catch (failure) {
      console.error(`[board] sync ${key} couldn't import ${item.id}:`, describe(failure))
      error = describe(failure)
    }
    // A lease that ran out was pulled again: that pull's ack is the one that counts.
    await call('inboxAck', { key, id: item.id, lease: item.lease, ...(error !== undefined ? { error } : {}) }).catch((failure: unknown) =>
      console.error(`[board] couldn't ack an inbox event:`, describe(failure)),
    )
  }

  // --- inbound: inbox → board -------------------------------------------------------

  /**
   * What a platform message's links point to, for a message in board channel `channel`. A linked
   * message the board has (it was synced) in that same channel is that board message; otherwise
   * it's what the platform sent about it (Slack's unfurl, which the platform checked against who
   * posted the link), what an earlier version of this message had, or what the platform says when
   * asked about it and `linker`, the platform message that links it. A board copy in another channel
   * is never one: sync reads every channel, and the link's readers may not read that one. A link
   * nobody can read says why.
   */
  async function resolveLinks(platform: SyncProvider, links: ExternalLink[], linker: { thread: string; message: string }, channel: string, previous: ImportLink[] = []): Promise<ImportLink[]> {
    if (links.length === 0) return []
    const resolved: ImportLink[] = []
    for (const link of links) {
      if (resolved.some((done) => done.url === link.url)) continue
      const id = (await find({ thread: link.thread, message: link.message })).message
      const copy = id === null ? null : await messageOf(id)
      if (copy && !copy.deleted && copy.channel === channel) {
        resolved.push({ url: link.url, message: copy.id, unavailable: null, snapshot: {
          author: copy.author ? shownName(copy.author) : copy.by.actor,
          text: copy.text, createdAt: copy.createdAt,
          files: copy.attachments.map((file) => ({ name: file.name, url: null })),
        } })
        continue
      }
      if (link.snapshot) {
        resolved.push({ url: link.url, message: null, snapshot: link.snapshot, unavailable: null })
        continue
      }
      // What the platform said before, never a board copy's, which may be gone or another channel's.
      const kept = previous.find((earlier) => earlier.url === link.url && earlier.snapshot && earlier.message === null)
      if (kept) {
        resolved.push(kept)
        continue
      }
      const fetched = await platform.fetchLink(link, linker).catch((error: unknown) => ({ snapshot: null, unavailable: describe(error) }))
      resolved.push({ url: link.url, message: null, snapshot: fetched.snapshot, unavailable: fetched.snapshot ? null : (fetched.unavailable ?? 'unknown').slice(0, 300) })
    }
    // A snapshot is what a platform sent, cut to fit.
    return storableJson(resolved)
  }

  /**
   * A platform message's files, onto the board: each is fetched through its
   * adapter (Chat SDK's `rehydrateAttachment`, so any platform that has it works)
   * and uploaded. A file that can't come over (too big, the platform refused)
   * becomes a line in the text, and on a board that keeps no files, a line that
   * links it where it lives; a failed fetch retries the message a few times first.
   */
  async function importFiles(platform: SyncProvider, files: ExternalFile[], attempt: number) {
    const attachments: Attachment[] = []
    const notes: string[] = []
    /** Why the board takes none of them, in its words, once it said so. */
    let noFiles: string | null = null
    for (const file of files.slice(0, ATTACHMENTS_PER_MESSAGE_MAX)) {
      if (noFiles !== null) {
        notes.push(fileLink(file, noFiles))
        continue
      }
      if (file.size !== undefined && file.size > IMPORT_BYTES_MAX) {
        notes.push(fileNote(file, `over ${IMPORT_BYTES_MAX / 1024 / 1024} MB`))
        continue
      }
      let data: Uint8Array
      try {
        const fetched = await platform.fetchFile(file)
        if (fetched === null) {
          notes.push(fileNote(file, `${platform.platform} can't hand it over`))
          continue
        }
        data = fetched
      } catch (error) {
        if (attempt < FILE_ATTEMPTS) throw error
        console.warn(`[board] couldn't fetch ${file.name ?? 'a file'} from ${platform.platform}:`, describe(error))
        notes.push(fileNote(file, `${platform.platform} wouldn't hand it over`))
        continue
      }
      if (data.byteLength > IMPORT_BYTES_MAX) {
        notes.push(fileNote(file, `over ${IMPORT_BYTES_MAX / 1024 / 1024} MB`))
        continue
      }
      if (data.byteLength === 0) {
        notes.push(fileNote(file, 'it was empty'))
        continue
      }
      const name = importedFileName(file.name ?? `${file.type}`)
      try {
        attachments.push((await call('upload', { data, name, type: file.mimeType || typeOf(name) })).attachment)
      } catch (error) {
        // A board elsewhere (`http()`) takes only what fits in a request, unless its store takes direct uploads.
        if (error instanceof HttpError && (error.code === 'too_large' || error.code === 'no_direct_uploads')) {
          notes.push(fileNote(file, `over ${ATTACHMENT_BYTES_MAX / 1024 / 1024} MB`))
          continue
        }
        if (!keepsNoFiles(error)) throw error
        noFiles = (error as HttpError).message
        notes.push(fileLink(file, noFiles))
      }
    }
    for (const file of files.slice(ATTACHMENTS_PER_MESSAGE_MAX))
      notes.push(fileNote(file, `a message carries at most ${ATTACHMENTS_PER_MESSAGE_MAX}`))
    return { attachments, notes }
  }

  /** One platform event from the inbox, through its entry's sync function. `id` is its ID there, which its writes derive theirs from. */
  async function inbound(key: string, received: InboxDelivery, meta: { id: string; attempt: number }) {
    const platform = platformOf(key)
    // Its author is the key's user, whatever the provider named them, events queued before included.
    const item = { ...received, event: keyedEvent(key, platform.platform, received.event) }
    const { event, raw } = item
    const linked = (await find({ thread: event.thread })).thread ?? undefined
    if (event.kind === 'message') {
      const copied = (await find({ thread: event.subthread ?? event.thread, message: event.message })).message
      if (copied !== null) {
        const origin = (await messageOf(copied))?.origin
        if (!origin || origin.message !== event.message || (origin.subthread ?? origin.thread) !== (event.subthread ?? event.thread)) return
      }
    }
    const author: ExternalAuthor = 'author' in event ? event.author : { id: `${key}:system`, handle: platform.platform, name: platform.platform, avatar: null, isBot: true }
    // Built when it's first read: an import that never reads it never needs what its schema asks of the payload.
    let typed: ProviderEvent | undefined
    const typedEvent = () => (typed ??= immutable(platform.event({ id: meta.id, key, event, raw })))
    let imported: Promise<SyncResult> | undefined
    let link: Promise<string | null> | undefined
    let active = true
    const sync: SyncIn = {
      direction: 'in',
      key,
      channel: native(event.channel),
      get event() {
        return typedEvent()
      },
      board: host().client({ author, key, ...originOf(key, event) }, meta.id),
      import(channel, overrides = {}) {
        if (!active) throw badRequest('the sync function has finished')
        imported ??= importEvent(key, item, meta, linked, channel, overrides)
        return imported
      },
      permalink() {
        const promise = link ?? platform.permalink(typedEvent())
        link = promise
        promise.catch(() => { if (link === promise) link = undefined })
        return promise
      },
      resolve: (name) => resolve(key, name),
    }
    try {
      await platform.sync(sync)
      await imported
    } finally {
      active = false
    }
  }

  /** The import `sync.import` makes: into the event's board thread, or a new root in `channel`. */
  async function importEvent(key: string, item: InboxDelivery, meta: { id: string; attempt: number }, linked: string | undefined, channel: string | undefined, overrides: SyncOverrides): Promise<SyncResult> {
    const where = channel ?? (linked ? (await syncOf(linked))?.channel : undefined)
    if (where === undefined) return { root: null, message: null }
    try {
      return await applyIncoming(key, item, meta, ChannelPath.parse(where), SyncOverrides.parse(overrides))
    } catch (error) {
      if (!(error instanceof DroppedError)) throw error
      // Dropped: nothing of it is on the board, though a root fetched for it may be.
      const thread = (await find({ thread: item.event.thread })).thread
      const root = thread === null ? null : ((await syncOf(thread))?.root ?? null)
      return { root, message: null }
    }
  }

  /**
   * Where a platform event's writes come from, for the middleware, and how it answers
   * there: a reply in the event's own platform thread.
   */
  function originOf(key: string, event: ExternalEvent): EventSource {
    const platform = platformOf(key)
    const thread = ('subthread' in event ? event.subthread : null) ?? event.thread
    return {
      via: { kind: 'sync', key, platform: platform.platform, channel: event.channel, thread },
      respond: async (text) => {
        await platform.post(native(thread), 'thread', { markdown: text })
      },
    }
  }

  async function applyIncoming(key: string, item: InboxDelivery, meta: { id: string; attempt: number }, channel: string, overrides: SyncOverrides): Promise<SyncResult> {
    const { event, raw } = item
    const source = originOf(key, event)
    const platform = platformOf(key)
    const threadKey = (await find({ thread: event.thread })).thread ?? undefined
    const synced = threadKey ? await syncOf(threadKey) : null
    const rootId = synced?.root
    // A2's `idempotentId`, byte for byte: logs already hold these IDs, and a retry must find its own.
    const writeId = (n: number) => derivedId('board-inbound', meta.id, String(n))
    // board()'s middleware sees each post and edit, and what it responds to one it drops is said in the platform thread.
    const from = { key, channel: source.via.channel, thread: source.via.thread }
    const screened = async (answer: Protocol['syncImport']['output']) => {
      if (!answer.dropped) return answer.message
      for (const text of answer.dropped) await source.respond(text)
      throw new DroppedError(answer.dropped)
    }
    type Post = {
      author: ExternalAuthor
      channel?: string
      re?: string
      text: string
      labels?: Record<string, string>
      noSync?: boolean
      attachments?: Attachment[]
      links?: ImportLink[]
      mentioned?: ExternalAuthor[]
      origin?: Origin
      id: string
    }
    // A reply lands in its root's channel: the thread's, or `channel` for a root just made there.
    const post = async ({ attachments = [], ...input }: Post): Promise<{ id: string; re: string | null }> => {
      const message = await screened(
        await call('syncImport', {
          op: 'post',
          from: key,
          source: from,
          ...input,
          origin: input.origin ?? null,
          ...(attachments.length ? { attachments: attachments.map((file) => file.id) } : {}),
        }),
      )
      return { id: message!, re: input.re ?? null }
    }
    const result = (message: { id: string; re: string | null }): SyncResult => ({ root: message.re ?? message.id, message: message.id })
    const labels = (defaults: Record<string, string> = {}) => {
      const merged = { ...defaults, ...overrides.labels }
      for (const key of overrides.unset ?? []) delete merged[key]
      return merged
    }
    const rootDraft = (draft: SyncRoot) => {
      if (!overrides.root) return draft
      const patch = overrides.root(immutable(structuredClone(draft)))
      if (patch && typeof patch === 'object' && 'then' in patch) throw badRequest('root overrides must be synchronous')
      const checked = SyncOverrides.pick({ text: true, labels: true }).parse(patch)
      return { ...draft, text: checked.text ?? draft.text, labels: { ...draft.labels, ...checked.labels } }
    }
    /** Labels for the thread's root, as `author`. */
    const setLabels = (author: ExternalAuthor, set: Record<string, string>, unset: string[]) =>
      call('syncImport', { op: 'labels', author, from: key, origin: { thread: event.thread }, set, unset })
    const setExtraLabels = async (author: ExternalAuthor, id: string) => {
      if (!overrides.labels && !overrides.unset) return
      const root = await messageOf(id)
      const set = Object.fromEntries(Object.entries(overrides.labels ?? {}).filter(([key, value]) => root?.labels[key] !== value))
      const unset = (overrides.unset ?? []).filter((key) => root?.labels[key] !== undefined)
      if (Object.keys(set).length || unset.length) await setLabels(author, set, unset)
    }

    switch (event.kind) {
      case 'message': {
        const existing = (await find({ thread: event.subthread ?? event.thread, message: event.message })).message
        if (existing !== null) return { root: rootId ?? existing, message: existing }
        const { attachments, notes } = event.files?.length ? await importFiles(platform, event.files, meta.attempt) : { attachments: [], notes: [] }
        const links = await resolveLinks(platform, event.links ?? [], { thread: event.subthread ?? event.thread, message: event.message }, synced?.channel ?? channel)
        const base = {
          ...(links.length ? { links } : {}),
          ...(event.mentioned?.length ? { mentioned: event.mentioned } : {}),
          author: event.author,
          text: clampText(withNotes(overrides.text ?? event.text, notes), attachments.length > 0),
          ...(attachments.length ? { attachments } : {}),
          origin: { channel: event.channel, thread: event.thread, subthread: event.subthread, message: event.message, context: event.context },
          id: await writeId(0),
        }
        // A reply kept on the board: no other platform gets it. A root always syncs, so its thread can.
        const reply = { ...base, ...(overrides.noSync ? { noSync: true } : {}) }
        if (rootId !== undefined) {
          await setExtraLabels(event.author, rootId)
          return result(await post({ ...reply, re: rootId }))
        }
        const fetched = await platform.fetchRoot(native(event.thread))
        if (fetched === null) {
          const draft = rootDraft({ text: event.text, labels: {}, author: event.author, raw })
          return result(await post({ ...base, channel, text: clampText(withNotes(overrides.text ?? draft.text, notes), attachments.length > 0), labels: labels(draft.labels) }))
        }
        const draft = rootDraft({ ...fetched, raw: fetched.raw ?? null })
        const root = await post({
          author: { ...fetched.author, id: keyedId(key, platform.platform, fetched.author.id) }, channel,
          text: clampText(draft.text), labels: labels(draft.labels),
          origin: { channel: event.channel, thread: event.thread, subthread: null, message: `root:${meta.id}`, context: null },
          id: await writeId(1),
        })
        return result(await post({ ...reply, re: root.id }))
      }
      case 'edited':
      case 'deleted':
      case 'reaction': {
        const id = (await find({ thread: event.subthread ?? event.thread, message: event.message })).message
        if (id === null) return { root: rootId ?? null, message: null }
        const author: ExternalAuthor = 'author' in event ? event.author : { id: `${key}:system`, handle: platform.platform, name: platform.platform, avatar: null, isBot: true }
        const origin = { thread: event.subthread ?? event.thread, message: event.message }
        if (rootId !== undefined) await setExtraLabels(author, rootId)
        if (event.kind === 'deleted') await call('syncImport', { op: 'delete', author, from: key, origin })
        else if (event.kind === 'edited') {
          const stored = await messageOf(id)
          const text = clampText(withNotes(overrides.text ?? event.text, stored ? notesIn(stored.text) : []), (stored?.attachments.length ?? 0) > 0)
          const mentioned = event.mentioned?.length ? { mentioned: event.mentioned } : {}
          if (stored && !event.linksOnly && stored.text !== text) await screened(await call('syncImport', { op: 'edit', author, from: key, origin, text, source: from, ...mentioned }))
          const links = stored ? await resolveLinks(platform, event.links ?? [], origin, stored.channel, stored.links) : []
          if (stored && !sameLinks(links, stored.links)) await call('syncImport', { op: 'links', author, from: key, origin, links })
        } else {
          if (platform.singleReaction) {
            const emoji = canonicalEmoji(event.emoji)
            // Its reactions are by the user, or on a board elsewhere, by this sync's profile of them.
            const as = new Set([author.id, `${await principalNow()}+${author.id}`])
            for (const [held, actors] of Object.entries((await messageOf(id))?.reactions ?? {}))
              if (actors.some((actor) => as.has(actor)) && !(event.added && held === emoji))
                await call('syncImport', { op: 'react', author, from: key, origin, emoji: held, remove: true })
          }
          if (!platform.singleReaction || event.added) await call('syncImport', { op: 'react', author, from: key, origin, emoji: event.emoji, remove: !event.added })
        }
        return { root: rootId ?? null, message: id }
      }
      case 'lifecycle': {
        if (rootId !== undefined) {
          const root = await messageOf(rootId)
          const createdHere = root?.origin?.message === `lifecycle:${meta.id}`
          const draft = createdHere ? rootDraft({ text: lifecycleText(event), labels: event.labels, author: event.author, raw }) : null
          const desired = labels(draft?.labels ?? event.labels)
          const owned = (key: string) => event.owns?.some((prefix) => key.startsWith(prefix)) ?? false
          const set = Object.fromEntries(Object.entries(desired).filter(([key, value]) => root?.labels[key] !== value))
          const unset = Object.keys(root?.labels ?? {}).filter((key) => !(key in desired) && (event.unset.includes(key) || overrides.unset?.includes(key) || owned(key)))
          if (root && !root.deleted && (Object.keys(set).length || unset.length)) await setLabels(event.author, set, unset)
          // A root this PR or issue made says its new title, as one it made now would, with the labels it has:
          // a root another thread made, which this one joined, keeps its own.
          if (event.retitled && root && !root.deleted && root.from === key && root.origin?.thread === event.thread) {
            const text = clampText(overrides.text ?? rootDraft({ text: lifecycleText(event), labels: root.labels, author: event.author, raw }).text)
            if (root.text !== text)
              await screened(await call('syncImport', { op: 'edit', author: event.author, from: key, origin: { thread: root.origin.thread, message: root.origin.message }, text }))
          }
          if (event.reply) return result(await post({ author: event.author, re: rootId, text: clampText(overrides.text ?? event.reply!), ...(overrides.noSync ? { noSync: true } : {}), id: await writeId(1) }))
          return { root: rootId, message: createdHere ? rootId : null }
        }
        if (!event.createRoot) return { root: null, message: null }
        const draft = rootDraft({ text: lifecycleText(event), labels: event.labels, author: event.author, raw })
        const root = await post({
          author: event.author, channel, text: clampText(event.reply ? draft.text : overrides.text ?? draft.text), labels: labels(draft.labels),
          origin: { channel: event.channel, thread: event.thread, subthread: null, message: `lifecycle:${meta.id}`, context: null },
          id: await writeId(0),
        })
        if (event.reply) return result(await post({ author: event.author, re: root.id, text: clampText(overrides.text ?? event.reply), ...(overrides.noSync ? { noSync: true } : {}), id: await writeId(1) }))
        return result(root)
      }
    }
  }

  // --- outbound: board → platforms --------------------------------------------------

  /**
   * A message's text for a platform, through entry `key`. A mention is `@[actor-id]`, settled when
   * the message was written: it reads natively when the actor is one of this entry's own users
   * (`@[slack:user:U0456]` also naming this sync's own profile of them), and as the actor's name
   * otherwise. An `@[email]` is whoever the platform finds with it, or the email, for the first 10
 * a message names. Everything else
   * is text and goes as written, an `@handle` included: no sync reads one as a mention.
   */
  async function textFor(key: string, actors: Actors, text: string): Promise<string> {
    const exact = extractMentions(text).flatMap((token) => (token.kind === 'actor' ? [token.actor] : []))
    if (exact.length === 0) return text
    const found = new Map<string, string | null>()
    let asked = 0
    for (const named of exact) {
      if (actors.byId[named] || !isEmail(named) || found.has(named)) continue
      // Past the cap an email goes as written, as one the platform has no one for does.
      found.set(named, asked++ < EMAIL_LOOKUPS_PER_MESSAGE_MAX ? await emailMention(key, named) : null)
    }
    return replaceMentions(text, (token) => {
      if (token.kind === 'handle') return null
      if (found.has(token.actor)) return found.get(token.actor) ?? token.actor
      const actor = actorNamed(token.actor, actors)
      return actor ? (nativeMention(key, actor.id, actors) ?? actor.name) : unmetMention(key, token.actor, actors)
    })
  }

  /**
   * How entry `key`'s platform mentions one of its users the board has no actor for, by the ID
   * they'd have (`@[slack:user:U0456]`, or this sync's `<principal>+slack:user:U0456`): where an ID
   * is all the platform needs. Null for anyone else's user, and on a platform whose mention needs
   * more, so the text goes as written.
   */
  function unmetMention(key: string, id: string, actors: Actors): string | null {
    const user = userOf(key, id, actors)
    if (user === null) return null
    const platform = platformOf(key)
    return platform.mentionById(`${platform.platform}:${user}`)
  }

  /**
   * The actor an `@[actor-id]` names: that actor, or, when the board has none by that ID, this
   * sync's own profile of it (`@[slack:user:U0456]` for `<principal>+slack:user:U0456`).
   */
  function actorNamed(id: string, actors: Actors): (Actor & { verified?: true }) | null {
    return actors.byId[id] ?? (actors.principal ? actors.byId[`${actors.principal}+${id}`] : undefined) ?? null
  }

  /**
   * Whose ID an actor is on entry `key`'s platform, when it's one of that entry's users: this sync's
   * own profile of them (`<principal>+<key>:…`), or one named under the key alone, as the board's
   * own sync names its users and as Vercel's board named imports before profiles. Null for anyone
   * else: a platform user another sync speaks for is that sync's word.
   */
  function userOf(key: string, actor: string, actors: Actors): string | null {
    const { principal, profile } = actorParts(actor)
    const id = profile === null ? actor : platformProfile(profile) !== null && principal === actors.principal ? profile : null
    return id?.startsWith(`${key}:`) ? id.slice(key.length + 1) : null
  }

  /** How entry `key`'s platform mentions an actor: natively when it's one of that entry's users, found on the platform by their ID there, or null. */
  function nativeMention(key: string, actor: string, actors: Actors): string | null {
    const account = actors.byId[actor]
    const user = account ? userOf(key, actor, actors) : null
    if (user === null) return null
    const platform = platformOf(key)
    return platform.mention({ ...account!, id: `${platform.platform}:${user}` })
  }

  /** A board message as markdown for a platform, which converts it to its own format: by `renderer`, or the provider's own. */
  async function render(key: string, target: string, message: MessageView, actors: Actors, renderer?: Renderer): Promise<{ markdown: string; as?: ProviderSender; deployments?: VercelDeployment[] }> {
    const actor = actors.byId[message.by.actor]
    // Whose word it is: the principal an actor with a profile writes for, and the platform of the
    // sync key an import came through, which may be another board's. A deployment writing as itself
    // names its environment in its own name, which is whose word it is too: `www (preview)`, as
    // project names have no spaces or parentheses (`www@preview` on what a local board stored before).
    const own = actor?.name ?? message.by.actor
    const after = `${actor?.via ? ` ${viaText(actor.via)}` : ''}${message.from ? ` (${actor?.platform ?? entries[message.from]?.platform ?? message.from})` : ''}`
    const environment = actor?.kind === 'deployment' && !actor.via ? (/(?:@[^@/]+| \([^()]+\))$/.exec(own)?.[0] ?? '') : ''
    const name = `${own}${after}`
    const attribution = `${environment}${after}`
    const platform = platformOf(key)
    const bot = byVercelBot(message, actor)
    const body = (renderer ?? ((input) => platform.render(input)))(immutable({
      message: { ...structuredClone(message), text: displayText(message.text, bot) },
      author: actor ? { ...actor } : null,
      mentionOf: (id: string) => nativeMention(key, id, actors),
      label: name,
      target,
    }))
    if (typeof body !== 'string') throw badRequest('a provider renderer must return markdown')
    // A text that opens a block is one only at a line's start: under its label, whichever renderer wrote it, not beside it.
    const labeled = `**${name}**: `
    const markdown = await textFor(key, actors, body.startsWith(labeled) && opensBlock(body.slice(labeled.length)) ? `**${name}**:\n\n${body.slice(labeled.length)}` : body)
    // Where the platform shows a sender per message, it shows one the board checked: anyone else's
    // name is what they sent, so it stays a label in the text, under the app.
    // Vercel's deployment comment goes with its deployments, for a platform that lays them out itself.
    const deployments = bot ? vercelDeployments(message.text) : null
    return { markdown, ...(actor?.verified ? { as: { name, avatar: senderAvatar(message, actor), attribution } } : {}), ...(deployments ? { deployments } : {}) }
  }

  /** An author's own picture, or for one with none or the board's built-in one, its person's Vercel avatar: `claude via julian` shows Julian. */
  function senderAvatar(message: MessageView, actor: Actor | undefined): string | null {
    const builtIn = (avatar: string | null | undefined) => !avatar || /\/avatars\/[a-z0-9-]+$/.test(avatar)
    const own = actor?.avatar ?? null
    if (!builtIn(own)) return own
    // Otherwise their handle, which a host's verifier may have named them by: their Vercel username. One
    // that's their user ID, all a Vercel login says, or one the board made up from it before, isn't.
    const username = actor?.handle.split('/')[0] ?? ''
    const id = message.by.principal.slice('vercel:user:'.length)
    if (!message.by.principal.startsWith('vercel:user:') || !username || /^user-/.test(username) || username.toLowerCase() === id.toLowerCase()) return own
    return `https://vercel.com/api/www/avatar?u=${encodeURIComponent(username)}&s=64&format=png`
  }

  /** What a platform shows for files it didn't get: one line each, so a reader knows they're on the board. */
  const attachmentNotes = (message: MessageView) =>
    message.attachments.map((a) => `\n📎 ${a.name} (${fileSize(a.size)}, on the board: #${message.id})`).join('')

  /**
   * `render`, with a line per file where the files won't follow: on a platform
   * that takes no uploads, or one that refused them (`noted`).
   */
  const renderFor = async (target: string, message: MessageView, actors: Actors, noted = false, renderer?: Renderer) => {
    const key = keyOf(target)
    const { markdown, ...rest } = await render(key, target, message, actors, renderer)
    const lines = message.attachments.length > 0 && (noted || !platformOf(key).uploadsFiles)
    return { markdown: lines ? `${markdown}\n${attachmentNotes(message)}` : markdown, ...rest, external: message.from !== null && message.from !== 'board' }
  }

  async function postReply(message: MessageView, target: string, externalThread: string, actors: Actors, renderer?: Renderer) {
    const replyCopy = message.replyTo === null ? undefined : (await copiesOf([message.replyTo]))[message.replyTo]?.[target]
    // A reply to a message in a platform sub-thread goes into that sub-thread; elsewhere into the main thread, as written.
    const inSubthread = replyCopy !== undefined && replyCopy.thread !== externalThread
    const place = inSubthread ? replyCopy.thread : externalThread
    const platform = platformOf(keyOf(target))
    let body = await renderFor(target, message, actors, false, renderer)
    let files: string[] | null | undefined
    let sentId: string
    if (!body.markdown.trim() && message.attachments.length && platform.uploadsFiles) {
      try {
        const sent = await uploadMessageFiles(message, target, place)
        sentId = sent.message
        files = sent.files
      } catch (error) {
        // A platform that won't take them, or a board that no longer keeps them: the text says they were there.
        if (!platform.refusesFiles(error) && !keepsNoFiles(error)) throw error
        body = await renderFor(target, message, actors, true, renderer)
        sentId = (await platform.post(native(place), 'thread', body)).message
        files = null
      }
    } else {
      if (!body.markdown.trim()) throw badRequest('a renderer must return text unless the message has media')
      sentId = (await platform.post(native(place), 'thread', body)).message
    }
    const external = { thread: place, message: sentId, ...(files !== undefined ? { files } : {}) }
    await recordDelivery(message, target, external)
    return external
  }

  async function recordDelivery(message: MessageView, target: string, copy: ExternalCopy) {
    await call('syncReceipt', {
      kind: 'message',
      message: message.id,
      target,
      external: { thread: copy.thread, message: copy.message },
      ...(copy.files !== undefined ? { files: copy.files } : {}),
    })
  }

  /** A message's files, as the board has them. */
  async function messageFiles(message: MessageView) {
    return Promise.all(message.attachments.map(async (a) => {
      const { data } = await call('attachment', { id: a.id })
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(await new Response(data).arrayBuffer())
      return { data: bytes, filename: a.name, mimeType: a.type }
    }))
  }

  async function uploadMessageFiles(message: MessageView, target: string, thread: string) {
    return platformOf(keyOf(target)).uploadFiles(native(thread), await messageFiles(message))
  }

  /**
   * A message's files, into the thread its text went to, once. The text's
   * receipt comes first, so a retry sends only what's missing. If the platform
   * refuses files, the text gets a line for each; any other failure retries.
   */
  async function deliverFiles(message: MessageView, target: string, copy: ExternalCopy, actors: Actors, renderer?: Renderer) {
    const platform = platformOf(keyOf(target))
    if (!platform.uploadsFiles || message.attachments.length === 0 || copy.files !== undefined) return
    let ids: string[] | null
    try {
      ids = (await uploadMessageFiles(message, target, copy.thread)).files
    } catch (error) {
      // Retried, and if it gives up, the `failed` receipt says it was the files: the text is there.
      if (!platform.refusesFiles(error) && !keepsNoFiles(error))
        throw Object.assign(new Error(`files: ${describe(error)}`), { cause: error, data: { error: `files: ${describe(error)}` } })
      console.warn(`[board] ${target} won't take #${message.id}'s files (${describe(error)}); noting them in its text`)
      ids = null
      await renderFor(target, message, actors, true, renderer).then((body) => platform.edit(native(copy.thread), copy.message, body)).catch((edit: unknown) =>
        console.warn(`[board] couldn't note #${message.id}'s files on ${target}:`, describe(edit)),
      )
    }
    // If this receipt fails after an upload, the retry uploads again: rare, and a duplicate beats a loss.
    await call('syncReceipt', { kind: 'files', message: message.id, target, files: ids })
  }

  /** What failed for a message, and where: a target, or none for a new root's sync function. */
  type Failure = { id: string; target: string | null; error: unknown }

  /** Records a failure once: a delivery's own and the sync function that passed it on are one. */
  const failed = (failures: Failure[], id: string, target: string | null, error: unknown) => {
    if (!failures.some((failure) => failure.error === error)) failures.push({ id, target, error })
  }

  async function settle(attempt: number, failures: Failure[]) {
    if (failures.length === 0) return
    if (attempt < DELIVERY_ATTEMPTS || afterRetry(attempt)) throw failures[0]!.error
    for (const { id, target, error } of failures) {
      console.error(`[board] gave up ${target === null ? `syncing #${id}` : `delivering #${id} to ${target}`}:`, describe(error))
      if (target !== null) await call('syncReceipt', { kind: 'failed', message: id, target, error: describe(error) })
    }
  }

  /**
   * Hands one board event, for one target, to its entry's sync function: `send` is what its
   * `deliver` does, at most once. A throw, the function's or the delivery's, comes back here.
   */
  async function offer(key: string, event: SyncEvent, message: MessageView, target: string | null, send: (renderer?: Renderer) => Promise<void>) {
    let sent: Promise<void> | undefined
    let active = true
    const finished = () => badRequest('the sync function has finished')
    const sync: SyncOut = {
      direction: 'out',
      key,
      channel: target === null ? null : channelIn(key, target),
      event: immutable(structuredClone(event)),
      message: immutable(structuredClone(message)),
      target,
      deliver(options = {}) {
        if (!active) throw finished()
        sent ??= target === null ? Promise.resolve() : send(options.render)
        return sent
      },
      start(channel) {
        if (!active) throw finished()
        return startThread(key, message, channel)
      },
      resolve: (name) => resolve(key, name),
    }
    try {
      await platformOf(key).sync(sync)
      await sent
    } finally {
      active = false
    }
  }

  /** Syncs a message's thread with a platform channel, as a sync function asked: never the channel it came from. */
  async function startThread(key: string, message: MessageView, channel: string) {
    const { target, kind } = await normalizeTarget(`${key}:${channel}`)
    const root = message.re === null ? message : await messageOf(message.re)
    if (!root || root.deleted || root.noSync) return
    const origin = root.origin ? root.origin.channel ?? channelOf(root.origin.thread) : null
    if (target === origin) return
    await call('syncReceipt', { kind: 'thread', message: root.id, target, targetKind: kind, cause: 'config' })
  }

  /** A new root, offered to each platform that can start threads: its sync function may `start` one there. */
  async function deliverRoot(event: Extract<SyncEvent, { type: 'message.posted' }>, attempt: number) {
    const starters: string[] = []
    for (const key of Object.keys(entries)) if (entries[key]!.canStartThreads && (await here(key))) starters.push(key)
    if (event.payload.noSync || starters.length === 0) return
    const root = await messageOf(event.message!.id)
    if (!root || root.deleted) return
    const failures: Failure[] = []
    for (const key of starters) {
      try {
        await offer(key, event, root, null, async () => {})
      } catch (error) {
        failed(failures, root.id, null, error)
      }
    }
    await settle(attempt, failures)
  }

  async function deliverThread(event: Extract<SyncEvent, { type: 'thread.synced' }>, attempt: number) {
    const { thread, target } = event.payload
    if (!(await ours(target))) return
    // Joining: only messages written after the join are delivered.
    if ((event.payload.kind ?? (isThreadTarget(target) ? 'thread' : 'channel')) === 'thread') return
    const synced = await syncOf(thread)
    // A target its sync doesn't list is another's: another project's, under a key of the same name.
    if (!synced?.targets.includes(target)) return
    const [root, ...replies] = await threadOf(synced.root)
    // A thread whose root was written with `noSync` stays on the board, however it came to be synced.
    if (!root || root.id !== synced.root || root.deleted || root.noSync) return
    const failures: Failure[] = []
    try {
      await offer(keyOf(target), event, root, target, (renderer) => backfill(synced, root, replies, target, failures, renderer))
    } catch (error) {
      failed(failures, root.id, target, error)
    }
    await settle(attempt, failures)
  }

  /**
   * A thread's root into a platform channel, then what's been said in it, each once. A reply
   * waits for its root; every reply is tried, and the first failure is thrown.
   */
  async function backfill(synced: SyncThreadView, root: MessageView, replies: MessageView[], target: string, failures: Failure[], renderer?: Renderer) {
    const actors = await actorsNow()
    const copies = await copiesOf([root.id, ...replies.map((reply) => reply.id)])
    const rootFailed = (error: unknown) => {
      failures.push({ id: root.id, target, error })
      return error
    }
    let externalThread = synced.external[target]
    if (!externalThread) {
      try {
        const platform = platformOf(keyOf(target))
        const body = await renderFor(target, root, actors, false, renderer)
        const mediaOnly = !body.markdown.trim() && root.attachments.length > 0 && platform.uploadsFiles
        if (!body.markdown.trim() && !mediaOnly) throw badRequest('a renderer must return text unless the message has media')
        let uploaded: string[] | null | undefined
        const post = async () => {
          if (!mediaOnly) {
            if (root.attachments.length === 0 || !platform.startsThreadsWithFiles) return platform.post(native(target), 'channel', body)
          }
          try {
            const sent = await platform.post(native(target), 'channel', { ...body, files: await messageFiles(root) })
            // A root with text that went without its files (no `files`) has them follow, as a reply's do.
            uploaded = mediaOnly ? (sent.files ?? []) : sent.files
            return sent
          } catch (error) {
            if (!platform.refusesFiles(error) && !keepsNoFiles(error)) throw error
            uploaded = null
            return platform.post(native(target), 'channel', await renderFor(target, root, actors, true, renderer))
          }
        }
        const sent = await post()
        externalThread = `${keyOf(target)}:${sent.thread}`
        const external: ExternalCopy = { thread: externalThread, message: sent.message, ...(uploaded !== undefined ? { files: uploaded } : {}) }
        await recordDelivery(root, target, external)
        await deliverFiles(root, target, external, actors, renderer)
      } catch (error) {
        throw rootFailed(error)
      }
    } else {
      const copy = copies[root.id]?.[target]
      if (copy)
        try {
          await deliverFiles(root, target, copy, actors, renderer)
        } catch (error) {
          throw rootFailed(error)
        }
    }
    const mine: Failure[] = []
    for (const reply of replies) {
      if (reply.deleted || reply.noSync || cameFrom(reply, target)) continue
      try {
        const copy = copies[reply.id]?.[target] ?? (await postReply(reply, target, externalThread, actors, renderer))
        await deliverFiles(reply, target, copy, actors, renderer)
      } catch (error) {
        mine.push({ id: reply.id, target, error })
      }
    }
    failures.push(...mine)
    if (mine.length) throw mine[0]!.error
  }

  /** Never deliver a message back to the platform it came from. */
  const cameFrom = (message: MessageView, target: string) =>
    message.origin?.thread === target || (message.from !== null && keyOf(target) === message.from)

  async function deliverPost(event: Extract<SyncEvent, { type: 'message.posted' }>, attempt: number) {
    if (!event.message) return
    if (event.message.re === null) return deliverRoot(event, attempt)
    if (event.payload.noSync) return
    const synced = await syncOf(event.payload.thread)
    if (!synced || synced.targets.length === 0) return
    // As it is now, not as it was posted: a delivery can go out late (a backlog, a retry), and what
    // its author has since edited goes as edited, and what they deleted doesn't go at all.
    const thread = await threadOf(synced.root)
    // A reply in a thread whose root stays on the board stays there too.
    if (thread[0]?.id !== synced.root || thread[0].noSync) return
    const message = thread.find((found) => found.id === event.message!.id)
    if (!message || message.deleted) return
    const actors = await actorsNow()
    const failures: Failure[] = []
    for (const target of synced.targets) {
      const externalThread = synced.external[target]
      if (!(await ours(target)) || !externalThread) continue // the root isn't there yet; its thread.synced delivery backfills
      if (cameFrom(message, target)) continue
      try {
        await offer(keyOf(target), event, message, target, async (renderer) => {
          const copy = (await copiesOf([message.id]))[message.id]?.[target] ?? (await postReply(message, target, externalThread, actors, renderer))
          await deliverFiles(message, target, copy, actors, renderer)
        })
      } catch (error) {
        failed(failures, message.id, target, error)
      }
    }
    await settle(attempt, failures)
  }

  /** Edits, deletes, and reactions are best-effort: a platform that can't do one skips it. */
  async function deliverChange(event: Extract<SyncEvent, { type: 'message.edited' | 'message.deleted' | 'reaction.added' | 'reaction.removed' }>) {
    const copies = (await copiesOf([event.payload.id]))[event.payload.id] ?? {}
    if (Object.keys(copies).length === 0) return
    // An edit renders the message as it is now, so one that goes out late sends nothing its author
    // has since changed or deleted: their later edit or delete is on its way too.
    const message = event.type === 'message.edited' ? await messageOf(event.payload.id) : (event.message ?? (await messageOf(event.payload.id)))
    if (!message || (event.type === 'message.edited' && message.deleted)) return
    const actors = await actorsNow()
    for (const [target, copy] of Object.entries(copies)) {
      if (!(await ours(target)) || (event.payload.from !== null && keyOf(target) === event.payload.from)) continue
      try {
        await offer(keyOf(target), event, message, target, async (renderer) => {
          const platform = platformOf(keyOf(target))
          const thread = native(copy.thread)
          if (event.type === 'message.edited') await platform.edit(thread, copy.message, await renderFor(target, message, actors, copy.files === null, renderer))
          else if (event.type === 'message.deleted') {
            await platform.delete(thread, copy.message)
            // The files went as a message of their own.
            if (copy.files?.length) await platform.deleteFiles(copy.files)
          }
          else if (event.type === 'reaction.added') await platform.react(thread, copy.message, canonicalEmoji(event.payload.emoji), true)
          else await platform.react(thread, copy.message, canonicalEmoji(event.payload.emoji), false)
        })
      } catch (error) {
        console.warn(`[board] skipped ${event.type} on ${target}:`, (error as Error).message)
      }
    }
  }

  /**
   * A renderer can read labels (a PR root showing its state), so a label change edits
   * each copy whose rendering it changes. The default renderer doesn't, so this never edits.
   */
  async function deliverLabels(event: Extract<SyncEvent, { type: 'labels.changed' }>) {
    const { id } = event.payload
    const copies = (await copiesOf([id]))[id] ?? {}
    const after = event.message
    if (!after || Object.keys(copies).length === 0) return
    // The message as it is now, so text its author has since changed or deleted never goes out again,
    // with the labels just after this change against just before it: a later change delivers its own.
    const current = await messageOf(id)
    if (!current || current.deleted) return
    const actors = await actorsNow()
    const message = { ...current, labels: after.labels }
    const previous = { ...current, labels: event.before?.labels ?? {} }
    for (const [target, copy] of Object.entries(copies)) {
      if (!(await ours(target))) continue
      try {
        await offer(keyOf(target), event, message, target, async (renderer) => {
          const body = await renderFor(target, message, actors, copy.files === null, renderer)
          if (body.markdown === (await renderFor(target, previous, actors, copy.files === null, renderer)).markdown) return
          await platformOf(keyOf(target)).edit(native(copy.thread), copy.message, body)
        })
      } catch (error) {
        console.warn(`[board] skipped labels.changed on ${target}:`, describe(error))
      }
    }
  }

  /**
   * Delivers one board event to the platforms: what the board's subscription for sync hands
   * it, on its thread's lane. A throw is retried; `attempt` counts tries from 1.
   */
  async function deliver(event: SyncEvent, { attempt }: { attempt: number }) {
    switch (event.type) {
      case 'thread.synced':
        return deliverThread(event, attempt)
      case 'message.posted':
        return deliverPost(event, attempt)
      case 'message.edited':
      case 'message.deleted':
      case 'reaction.added':
      case 'reaction.removed':
        return deliverChange(event)
      case 'labels.changed':
        return deliverLabels(event)
    }
  }

  /**
   * Shows typing in every platform thread a board thread is synced to. It's
   * ephemeral and best-effort: nothing goes in the log, and a platform that
   * fails is skipped. Answers the external threads that took it. `status`
   * replaces "Typing…" where the platform shows text (Slack).
   */
  async function typing(messages: readonly MessageView[], status?: string): Promise<string[]> {
    const synced = messages[0] ? await syncOf(messages[0].thread) : null
    if (!synced) return []
    const externals: string[] = []
    for (const external of new Set(Object.values(synced.external))) if (await ours(external)) externals.push(external)
    const done = await Promise.all(
      externals.map(async (external) => {
        const key = keyOf(external)
        try {
          const platform = platformOf(key)
          let latest: string | null = null
          for (let i = messages.length - 1; i >= 0 && latest === null; i--) {
            const origin = messages[i]!
            if (!origin.deleted && origin.origin?.thread === external) latest = origin.origin.message
          }
          await platform.startTyping(native(external), latest, status)
          return external
        } catch (error) {
          console.warn(`[board] skipped typing on ${external}:`, describe(error))
          return null
        }
      }),
    )
    return done.filter((external) => external !== null)
  }

  /** A channel the inbox listing names, as its platform ID: `#general` to `slack:C0123`. */
  async function inboxChannel(key: string, channel: string): Promise<string> {
    try {
      return `${key}:${await platformOf(key).resolveChannel(channel)}`
    } catch (error) {
      throw badRequest(`can't resolve inbox channel: ${(error as Error).message}`)
    }
  }

  /** The status for what a platform wouldn't read: the caller's mistake, missing, refused, or the platform failing. */
  const unreadableStatus = (code: string) => {
    if (code === 'unsupported' || code === 'invalid_target') return 400
    if (code === 'channel_not_found') return 404
    if (code === 'ratelimited') return 429
    if (['no_client', 'list_failed', 'internal_error', 'fatal_error', 'service_unavailable', 'request_timeout'].includes(code)) return 502
    return 403
  }

  /** A platform channel or thread, read for the caller: nothing is synced, stored, or joined. */
  async function readSource(key: string, target: string, limit: number, after: string | null) {
    const platform = platformOf(key)
    try {
      // What it read mentions the platform's users by ID, named under the key as an import's are.
      const read = await platform.read(target, { limit, after })
      return { ...read, messages: read.messages.map((message) => ({ ...message, text: keyedText(key, platform.platform, message.text) })) }
    } catch (error) {
      if (error instanceof UnreadableError) throw new HttpError(unreadableStatus(error.code), error.code, error.message)
      throw badRequest(`can't read ${target} from ${key}: ${describe(error)}`, 'platform_error')
    }
  }

  /** Adds the app to a channel so it can be read on demand: nothing is synced or stored. */
  async function joinSource(key: string, target: string) {
    const platform = platformOf(key)
    try {
      return await platform.join(target)
    } catch (error) {
      if (error instanceof UnreadableError) throw new HttpError(unreadableStatus(error.code), error.code, error.message)
      throw badRequest(`can't join ${target} on ${key}: ${describe(error)}`, 'platform_error')
    }
  }

  return {
    entries,
    bind(next: SyncHost) {
      bound = next
    },
    /** Sync's own caller, for its lookups. */
    caller: me,
    deliver,
    receive: inbound,
    pull,
    normalizeTarget,
    handleWebhook,
    inboxChannel,
    typing,
    readSource,
    joinSource,
  }
}

export type SyncEngine = ReturnType<typeof createSyncEngine>

/** A lifecycle root's text: the title, its link, and what the PR or issue says. */
function lifecycleText(event: { title: string; url: string | null; body?: string | null }): string {
  const head = event.url ? `${event.title}\n${event.url}` : event.title
  return event.body ? `${head}\n\n${event.body}` : head
}
