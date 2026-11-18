import {
  AckBody,
  AssignTaskBody,
  TaskNeedsBody,
  BlockTaskBody,
  CancelTaskBody,
  ClaimReadyTaskBody,
  ClaimTaskBody,
  CompleteTaskBody,
  CreateTaskBody,
  CreateTasksBody,
  CreatedTasksQuery,
  FailTaskBody,
  ReleaseTaskBody,
  RenewTaskBody,
  TasksQuery,
  DeleteBody,
  EditBody,
  EventsQuery,
  InboxAckBody,
  InboxNextQuery,
  InboxPushBody,
  InboxQuery,
  LabelBody,
  MatchesQuery,
  PostBody,
  ReactBody,
  ChannelMessagesQuery,
  ChannelsQuery,
  ActorsQuery,
  CreateChannelBody,
  Ref,
  RegisterBody,
  ScheduleBody,
  CreateGrantsBody,
  GrantBody,
  RevokeGrantBody,
  UpdateGrantBody,
  ExplainQuery,
  SchemaBody,
  SchedulesQuery,
  SourceJoinBody,
  SourceReadQuery,
  LinkedQuery,
  SyncBody,
  SyncCopiesQuery,
  SyncFindQuery,
  SyncImportBody,
  UploadStartBody,
  SyncReceiptBody,
  ThreadQuery,
  ThreadsQuery,
  TypingBody,
  type MessageView,
} from '../api/routes.ts'
import type { Method, Protocol } from '../api/protocol.ts'
import type { ExternalAuthor } from '../contract/external.ts'
import type { Actor } from '../contract/folds.ts'
import { ATTACHMENT_BYTES_MAX, MESSAGE_TEXT_MAX, RESERVED_LABEL_PREFIX, TASK_BATCH_MAX, type Attachment, type Labels } from '../contract/schemas.ts'
import { findBlocks } from '../contract/blocks.ts'
import type { SchemaDefinition } from '../contract/data-schemas.ts'
import { checkValue } from '../contract/data-values.ts'
import type { SyncEvent } from '../sync/engine.ts'
import { SYNC, type Caller, type InboxDelivery, type ProtocolMethods, type SelfCaller, type VerifiedCaller } from './backend.ts'
import { hostTrusted, type Board, type BoardContext } from './board.ts'
import { derivedId, sha256 } from '../client/ids.ts'
import { claimsOf, KNOWN_AGENTS, viaOf } from './actors.ts'
import { importedHandle, userIdOf } from '../contract/profiles.ts'
import type { CallerRequest } from './auth.ts'
import { avatarSvg } from './avatars.ts'
import { badRequest, batchTooLarge, forbidden, HttpError, json, notFound, toErrorResponse } from './errors.ts'
import { extractMentions, settleMentions, type Mentioned, type MentionedActor } from '../contract/mentions.ts'
import { DroppedError, runMiddleware, type Write, type WriteSource } from './middleware.ts'
import { createRouter, METHODS, openapi, queryObject, readCapped, readJson, type BoardRoute } from './routing.ts'
import { FULL_ACCESS, parseCan, type Access } from './access.ts'
import { syncTarget, type SyncTarget } from './targets.ts'
import { SYNC_ACTOR, type WriteOrigin } from './origin.ts'
import type { WatcherContext } from './watcher.ts'
import { VERSION } from '../version.ts'

/** The methods whose answer is something new. */
const CREATED = new Set<Method>(['post', 'schedule', 'createTask', 'createTasks', 'upload', 'uploadFinish'])

/**
 * Refuses a label write under `board.`: those keys are the board's own, which only its task writes
 * set, so no caller's write sets or unsets one, this deployment's own code included.
 */
function ownLabels(set: Labels | undefined, unset: readonly string[] = []) {
  const key = [...Object.keys(set ?? {}), ...unset].find((name) => name.startsWith(RESERVED_LABEL_PREFIX))
  if (key !== undefined) throw new HttpError(400, 'reserved_label', `${key} is the board's own label: only its task writes set labels under ${RESERVED_LABEL_PREFIX}`)
}

/** Shown inline only when a browser can't run it: everything else downloads. */
const INLINE = /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm)|text\/plain)$/

/**
 * The file, sandboxed: it can't run as a page on the board's origin, and only
 * types a browser can't execute display inline.
 */
function attachmentResponse({ attachment, data }: Protocol['attachment']['output']): Response {
  const disposition = INLINE.test(attachment.type) ? 'inline' : 'attachment'
  const body = data instanceof Uint8Array ? new Blob([data as Uint8Array<ArrayBuffer>]) : data
  return new Response(body, {
    headers: {
      'content-type': attachment.type,
      'content-length': String(attachment.size),
      'content-disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
      'content-security-policy': "sandbox; default-src 'none'",
      'x-content-type-options': 'nosniff',
      // An ID's bytes never change.
      'cache-control': 'private, max-age=31536000, immutable',
    },
  })
}

/** A method's input, from the request: its path's `:id` or `:key`, its query, or its body, validated. */
async function inputOf(name: Method, request: Request, url: URL, params: Record<string, string>): Promise<unknown> {
  const id = params.id ?? ''
  const key = params.key ?? ''
  const body = () => readJson(request)
  switch (name) {
    case 'discovery':
    case 'me':
    case 'channels':
      return ChannelsQuery.parse(queryObject(url))
    case 'actors':
      return ActorsQuery.parse(queryObject(url))
    case 'watchers':
    case 'grants':
    case 'schemas':
      return {}
    case 'message':
      return { id, ...ThreadQuery.parse(queryObject(url)) }
    case 'posted':
    case 'synced':
    case 'cancelSchedule':
    case 'unblockTask':
    case 'reopenTask':
    case 'schema':
    case 'attachment':
    case 'uploadFinish':
      return { id }
    case 'channelMessages':
      return ChannelMessagesQuery.parse(queryObject(url))
    case 'threads':
      return ThreadsQuery.parse(queryObject(url))
    case 'schedules':
      return SchedulesQuery.parse(queryObject(url))
    case 'matches':
      return MatchesQuery.parse(queryObject(url))
    case 'events': {
      const query = EventsQuery.parse(queryObject(url))
      // SSE's own resume header, when the client reconnects by itself.
      const last = request.headers.get('last-event-id')
      if (query.after === undefined && last && Ref.safeParse(last).success) {
        query.after = last
        // A stream that began with the feed's newest events goes on from where it was.
        delete query.last
      }
      return query
    }
    case 'post':
      return PostBody.parse(await body())
    case 'createChannel':
      return CreateChannelBody.parse(await body())
    case 'schedule':
      return ScheduleBody.parse(await body())
    case 'tasks':
      return TasksQuery.parse(queryObject(url))
    case 'createTask':
      return CreateTaskBody.parse(await body())
    case 'createdTasks':
      return { id, ...CreatedTasksQuery.parse(queryObject(url)) }
    case 'createTasks': {
      const sent = await body()
      // Every root of a batch goes through the middleware before a backend sees one, so more than any backend makes
      // stops here, before anything runs for it: said as that, which its sender splits on, whatever else is wrong with it.
      const tasks = (sent as { tasks?: unknown } | null | undefined)?.tasks
      if (Array.isArray(tasks) && tasks.length > TASK_BATCH_MAX) throw batchTooLarge(tasks.length, TASK_BATCH_MAX)
      return CreateTasksBody.parse(sent)
    }
    case 'claimReadyTask':
      return ClaimReadyTaskBody.parse(await body())
    case 'claimTask':
      return { id, ...(ClaimTaskBody.parse(await body()) ?? {}) }
    case 'renewTask':
      return { id, ...RenewTaskBody.parse(await body()) }
    case 'releaseTask':
      return { id, ...ReleaseTaskBody.parse(await body()) }
    case 'completeTask':
      return { id, ...CompleteTaskBody.parse(await body()) }
    case 'failTask':
      return { id, ...FailTaskBody.parse(await body()) }
    case 'blockTask':
      return { id, ...BlockTaskBody.parse(await body()) }
    case 'assignTask':
      return { id, ...AssignTaskBody.parse(await body()) }
    case 'setTaskNeeds':
      return { id, ...TaskNeedsBody.parse(await body()) }
    case 'cancelTask':
      return { id, ...CancelTaskBody.parse(await body()) }
    case 'createGrant':
      return GrantBody.parse(await body())
    case 'createGrants':
      return CreateGrantsBody.parse(await body())
    case 'updateGrant':
      return { id, ...UpdateGrantBody.parse(await body()) }
    case 'revokeGrant':
      return { id, ...(RevokeGrantBody.parse(await body()) ?? {}) }
    case 'explain':
      return ExplainQuery.parse(queryObject(url))
    case 'createSchema':
      return SchemaBody.parse(await body())
    case 'register':
      return RegisterBody.parse(await body())
    case 'edit':
      return { id, ...EditBody.parse(await body()) }
    case 'delete':
      return { id, ...DeleteBody.parse(await body()) }
    case 'react':
      return { id, ...ReactBody.parse(await body()) }
    case 'label':
      return { id, ...LabelBody.parse(await body()) }
    case 'ack':
      return { id, ...AckBody.parse(await body()) }
    case 'upload': {
      const header = request.headers.get('x-board-filename')
      let name: string | null = null
      try {
        name = header === null ? null : decodeURIComponent(header)
      } catch {
        throw badRequest('`x-board-filename` is not URI-encoded')
      }
      return { data: await readCapped(request, ATTACHMENT_BYTES_MAX), name, type: request.headers.get('content-type') }
    }
    case 'uploadStart':
      return UploadStartBody.parse(await body())
    case 'syncImport':
      return SyncImportBody.parse(await body())
    case 'syncReceipt':
      return SyncReceiptBody.parse(await body())
    case 'syncThread':
      return { thread: params.thread ?? '' }
    case 'syncFind':
      return SyncFindQuery.parse(queryObject(url))
    case 'syncCopies':
      return SyncCopiesQuery.parse(queryObject(url))
    case 'inboxPush':
      return { key, ...InboxPushBody.parse(await body()) }
    case 'inboxNext':
      return { key, ...InboxNextQuery.parse(queryObject(url)) }
    case 'inboxAck':
      return { key, id, ...InboxAckBody.parse(await body()) }
    case 'inbox':
      return { key, ...InboxQuery.parse(queryObject(url)) }
    case 'typing':
      return { id, ...(TypingBody.parse(await body()) ?? {}) }
    case 'readSource':
      return { key, ...SourceReadQuery.parse(queryObject(url)) }
    case 'joinSource':
      return { key, ...SourceJoinBody.parse(await body()) }
    case 'linked':
      return LinkedQuery.parse(queryObject(url))
  }
}

/**
 * A sync callback's caller: the platform user its event came from, on sync entry `key`, and how to
 * answer them in the event's platform thread. Its client's writes are imports as that user, and the
 * rest it does as sync.
 */
export type PlatformCaller = {
  platform: { author: ExternalAuthor; key: string; respond: (text: string) => Promise<void> }
  origin: WriteOrigin & { via: Extract<WriteSource, { kind: 'sync' }> }
}

/**
 * A platform user an import by `importer` is by, as the board records them: themselves for the
 * board's own sync on a board that keeps its log here, which checked them, and a profile of
 * anyone else's principal, whose word they are, under its name.
 */
const externalActor = (author: ExternalAuthor, importer: { principal: string; actor: Actor }): Actor => {
  const own = importer.principal === SYNC_ACTOR
  return {
    id: own ? author.id : `${importer.principal}+${author.id}`,
    kind: 'external',
    handle: own ? author.handle : importedHandle(viaOf({ id: importer.principal, handle: importer.actor.handle }).name, author.handle, userIdOf(author.id)),
    name: author.name,
    avatar: author.avatar,
  }
}

/** A write's caller, as the middleware is told: where it came from. The middleware's own handle and sync's lookups skip it. */
function sourceOf(caller: Caller): WriteSource | null {
  const via = caller.origin.via
  if (via?.kind === 'middleware' || via?.kind === 'engine') return null
  return via ?? { kind: 'api' }
}

/** The middleware's own handle: its writes skip the middleware. */
const MIDDLEWARE: SelfCaller = { self: 'middleware', origin: { via: { kind: 'middleware' } } }
/** board()'s own code, for what it looks up itself. */
const OWN: SelfCaller = { self: null, origin: { via: { kind: 'client', name: null } } }

/** board()'s server half, for its handle: what serving, watching, and syncing need, loaded on first use. */
export type Serve = {
  /** Serves a request, or one of this deployment's own calls as `injected`. */
  dispatch(request: Request, injected: Caller | PlatformCaller | null): Promise<Response>
  /** An in-process client's call, as `caller`: its posts get IDs derived from `trigger`, counting `writes`. */
  inject(request: Request, caller: Caller | PlatformCaller, trigger: string | null, writes: { made: number }): Promise<Response>
  run(id: string, event: WatcherContext['event'], meta: { trigger: string; attempt: number }): Promise<void>
  receive(key: string, item: InboxDelivery, meta: { id: string; attempt: number; signal: AbortSignal }): Promise<void>
  pull(): Promise<number>
  /** What `readSource` reads with: sync entry `key`'s app, a 404 `not_synced_here` for one this board doesn't run. */
  readSource(key: string, target: string, limit: number, after: string | null): Promise<Protocol['readSource']['output']>
  /** What `joinSource` joins with: sync entry `key`'s app, a 404 `not_synced_here` for one this board doesn't run. */
  joinSource(key: string, target: string): Promise<Protocol['joinSource']['output']>
  /** What `typing` shows typing with: the platforms this board syncs. */
  typing(messages: readonly MessageView[], status: string | undefined): Promise<string[]>
}

/**
 * The board, serving the protocol over HTTP on its backend: it routes and validates each request,
 * verifies its caller, applies `access`, runs the middleware, and calls the backend's method of the
 * same name with the caller it verified. Sync runs here too, for requests and for its own code.
 */
export async function createServe(context: BoardContext): Promise<Serve> {
  const { options, backend, runtime, policy } = context
  const entries = options.sync ?? {}
  // The sync engine, and the adapters it drives, only for a board that syncs.
  const engine = Object.keys(entries).length > 0 ? (await runtime.sync()).createSyncEngine(entries) : null
  const streamMaxMs = options.streamMaxMs ?? 280_000
  const route = createRouter(backend.routes, options.basePath)
  const { state, ownUrl, clientAs, handleOf } = context
  const watch = options.watch ?? {}
  const middleware = options.middleware ?? []

  /** What a request says about who it is, none of it verified yet: its bearer token, its claims, and the board's URL. */
  function requestOf(request: Request, at: string): CallerRequest {
    const header = request.headers.get('authorization') ?? ''
    const credential = header.match(/^Bearer\s+(.+)$/i)?.[1] ?? null
    // Only a token is checked against the audience: a request without one (a cookie, no one) needs no URL to be sure of.
    const audience = credential === null ? (options.url?.replace(/\/+$/, '') ?? at) : audienceOf(at)
    return { credential, claims: claimsOf(request.headers), audience, headers: request.headers }
  }

  /** A request's caller, verified: who it is, and what `access` lets it do now. */
  async function callerOf(request: CallerRequest): Promise<VerifiedCaller> {
    return { identity: await policy.identify(request), origin: { via: { kind: 'api' } } }
  }

  let warned = false
  /**
   * The URL a token's audience must be: `url`, or the one `at` reaches where something checks a request's
   * Host first. Anywhere else its sender chooses it, so a production board without `url` verifies no tokens.
   */
  function audienceOf(at: string): string {
    if (options.url) return options.url.replace(/\/+$/, '')
    if (hostTrusted(options)) return at
    if (typeof process !== 'undefined' && process.env.NODE_ENV === 'production')
      throw new HttpError(500, 'no_board_url', "this board has no URL to check a token's audience against, and outside Vercel a request's Host is its sender's to choose", {
        hint: "Pass board({ url: 'https://<host>/api/board' }), the URL people reach it at.",
      })
    if (!warned) console.warn(`[board] no url: verifying tokens for ${at}, the host requests name. Pass board({ url }) before this serves in production.`)
    warned = true
    return at
  }

  /**
   * What a board that serves no requests answers them: one that uses another board's. One on
   * Vercel's still takes wake-ups and webhooks; one at `BOARD_URL` has neither.
   */
  const servesOnly = () =>
    new HttpError(404, 'not_found', `${ownUrl() ?? 'this board'} answers ${backend.routes.length > 0 || engine ? 'only wake-ups and webhooks' : 'nothing itself'}`)

  /**
   * A sync target as the board that syncs it resolves it. One for an entry this board doesn't
   * have goes on as it is, for the sync that does, unless this board syncs: then it's a mistake.
   */
  async function resolveTarget(target: string | SyncTarget): Promise<SyncTarget> {
    if (typeof target !== 'string') return target
    const at = target.indexOf(':')
    if (at <= 0) throw badRequest(`sync targets look like <key>:<channel or thread>, got: ${target}`)
    const key = target.slice(0, at)
    if (engine && entries[key]) return engine.normalizeTarget(target)
    if (engine) throw badRequest(`no sync entry named ${key}`)
    return syncTarget(target)
  }

  /**
   * What a verified caller may do, as board()'s `access` said when it verified them: board() checks
   * it before it does anything for them past calling the backend (a platform call, sync's own write,
   * reading an upload, the middleware), so a caller it won't let in starts none of it. Null for this
   * deployment's own code, which may do everything, unless `as(profile, { can })` narrowed its
   * handle: then what that `can` leaves it, as a request narrowed with x-board-can is checked.
   */
  const accessOf = (caller: Caller): Access | null =>
    'identity' in caller ? caller.identity.principal.access : caller.can !== undefined ? FULL_ACCESS.narrow(parseCan(caller.can)) : null
  /** Whether `caller` is narrowed with a `can`: a request's x-board-can, or a handle's from `as()`. */
  const narrowed = (caller: Caller) => ('identity' in caller ? caller.identity.principal.scope !== undefined : caller.can !== undefined)

  /**
   * Whether board() may work for a write of `caller`'s that lands in `channel`, or in the thread of
   * message `re`, which it must read: `post` there. One it may not goes to the backend as it came,
   * for the backend to say why.
   */
  async function mayPost(caller: Caller, where: { channel?: string | undefined; re?: string | undefined }, signal: AbortSignal): Promise<{ access: Access | null; channel: string } | null> {
    const access = accessOf(caller)
    // This deployment's own code needs no lookup: it may.
    if (access === null) return { access: null, channel: where.channel ?? '' }
    const channel = where.channel ?? (where.re === undefined ? undefined : (await lookup(caller, where.re, signal))?.channel)
    if (channel === undefined) return null
    return access.can('post', channel) ? { access, channel } : null
  }

  /** Who this deployment's own code is on its backend, asked once each: the middleware is told who's writing. */
  const selves = new Map<string, Promise<{ principal: string; actor: Actor }>>()
  async function whoIs(caller: Caller, signal: AbortSignal): Promise<{ principal: string; actor: Actor }> {
    if ('identity' in caller) return { principal: caller.identity.principal.id, actor: caller.identity.actor }
    const key = JSON.stringify([caller.origin.via?.kind ?? '', caller.self, caller.profile ?? null])
    let found = selves.get(key)
    if (!found) {
      selves.set(
        key,
        (found = backend.me(caller, {}, signal).then((me) => ({
          principal: me.principal,
          actor: { id: me.actor, kind: me.kind, handle: me.handle, name: me.name, avatar: me.avatar },
        }))),
      )
      found.catch(() => selves.delete(key))
    }
    return found
  }

  /** The schemas writes have named, as the backend answered them: a version never changes, so each is read once. */
  const definitions = new Map<string, Promise<SchemaDefinition>>()

  /**
   * Checks the blocks `text` carries before it's written, each against the schema its fence names:
   * a 400 for one that isn't a JSON object, names a schema the board doesn't have, or doesn't match
   * it. So what a message written on the board shows as its `blocks` always matches. The check is
   * board()'s, so it reads each schema as board() itself, whoever is writing: every caller's write
   * is held to the same definition, and gets the same answer.
   */
  async function checkBlocks(text: string): Promise<void> {
    if (!text.includes('json#')) return
    for (const found of findBlocks(text)) {
      if (found.problem !== undefined) throw badRequest(found.problem, 'invalid_block')
      let definition = definitions.get(found.id)
      if (!definition) {
        // Shared by every write that names it, so no one request's signal ends it.
        definition = backend.schema(OWN, { id: found.id }, new AbortController().signal).then(({ schema }) => schema.schema)
        definitions.set(found.id, definition)
        definition.catch(() => definitions.delete(found.id))
      }
      const schema = await definition.catch((error: unknown) => {
        if (error instanceof HttpError && error.status === 404) throw badRequest(`the ${found.id} block names a schema this board doesn't have`, 'schema_not_found')
        throw error
      })
      const problem = checkValue(schema, found.data)
      if (problem !== null) throw badRequest(`the ${found.id} block doesn't match its schema: ${problem}`, 'invalid_block')
    }
  }

  /**
   * Checks a write's blocks, unless board() already knows its caller may not post where it lands:
   * then the backend's refusal is the answer, not what the text says. A message board() can't find
   * for the caller is still checked, since one written without reading is its author's to edit.
   */
  /**
   * Settles the `@handle`s of a caller's texts: a mention is `@[actor-id]`, so a handle that names
   * exactly one of the actors the caller can see is written as that, and one that names none or
   * several stays as typed, a mention of no one. Of several, one on the board wins over platform
   * users (a synced user's handle is their display name, theirs to set), and else it's the one who
   * wrote in `thread`, if exactly one did. The actors are read once, for the first text that has a handle. A board behind
   * this one settles them itself, and a schedule's send goes as it was settled when it was made: a
   * handle that mentioned no one then mentions no one later. An ID is longer than a handle, so where
   * settling would take a text past what a message holds, it stays as typed, each handle's actor a
   * candidate: the writer is never refused for a length they didn't type.
   */
  function settler(caller: Caller, signal: AbortSignal) {
    let listed: Promise<MentionedActor[]> | null = null
    // Platform users, whose handle is whatever their platform calls them: see `prefer` below.
    const external = new Set<string>()
    // A caller that may not list the board's actors can name no one by handle.
    const actors = () =>
      (listed ??= backend.actors(caller, {}, signal).then(
        (answer) =>
          answer.actors.map(({ id, handle, name, kind }) => {
            if (kind === 'external') external.add(id)
            return { id, handle, name }
          }),
        (error: unknown) => {
          if (error instanceof HttpError && (error.status === 403 || error.status === 404)) return []
          throw error
        },
      ))
    return async (text: string, thread: () => Promise<string | undefined>): Promise<{ text: string; mentions: Mentioned[] }> => {
      if (backend.settlesMentions || caller.origin.via?.kind === 'schedule' || !extractMentions(text).some((token) => token.kind === 'handle')) return { text, mentions: [] }
      const fitting = (settled: { text: string; mentions: Mentioned[] }) =>
        settled.text.length <= MESSAGE_TEXT_MAX || text.length > MESSAGE_TEXT_MAX ? settled : { text, mentions: settled.mentions.map(unsettled) }
      const settled = settleMentions(text, await actors())
      if (!settled.mentions.some((mention) => mention.candidates.length > 1)) return fitting(settled)
      const id = await thread()
      const writers = new Set<string>()
      if (id !== undefined) {
        try {
          const { message, replies } = await backend.message(caller, { id }, signal)
          for (const written of [message, ...replies]) writers.add(written.by.actor)
        } catch (error) {
          if (!(error instanceof HttpError && error.status === 404)) throw error
        }
      }
      return fitting(
        settleMentions(text, await actors(), (candidates) => {
          // A platform user takes the handle their platform shows, which anyone there can set to a
          // board user's: one who's on the board is who it means, wherever the platform user wrote.
          const board = candidates.filter((actor) => !external.has(actor.id))
          const among = board.length > 0 ? board : candidates
          if (among.length === 1) return among[0]!
          const wrote = among.filter((actor) => writers.has(actor.id))
          return wrote.length === 1 ? wrote[0]! : null
        }),
      )
    }
  }

  /** A handle that would have mentioned an actor, said as one that didn't: still text, and they're who it could have meant. */
  const unsettled = (mention: Mentioned): Mentioned => (mention.actor ? { written: mention.written, actor: null, candidates: [mention.actor] } : mention)

  /**
   * Hands `write` a text with its `@handle`s settled, as `settler` does, and adds what became of each
   * to its answer. `kept` is the text the answer came back with: where that isn't the one written, a
   * retry got the message its first try made, and a handle is said to mention only who that text does.
   */
  async function settling<T extends object>(
    caller: Caller,
    text: string,
    thread: () => Promise<string | undefined>,
    signal: AbortSignal,
    write: (text: string) => Promise<T>,
    kept?: (answer: T) => string,
  ): Promise<T & { mentions?: Mentioned[] }> {
    const settled = await settler(caller, signal)(text, thread)
    const answer = await write(settled.text)
    if (settled.mentions.length === 0) return answer
    const stored = kept?.(answer) ?? settled.text
    if (stored === settled.text) return { ...answer, mentions: settled.mentions }
    const mentioned = new Set(extractMentions(stored).flatMap((token) => (token.kind === 'actor' ? [token.actor] : [])))
    return { ...answer, mentions: settled.mentions.map((mention) => (mention.actor && !mentioned.has(mention.actor.id) ? unsettled(mention) : mention)) }
  }

  async function checkWrite(caller: Caller, text: string, where: { channel: string } | { message: string }, signal: AbortSignal): Promise<void> {
    if (!text.includes('json#')) return
    const access = accessOf(caller)
    if (access !== null) {
      const channel = 'channel' in where ? where.channel : (await lookup(caller, where.message, signal))?.channel
      if (channel !== undefined && !access.can('post', channel)) return
    }
    await checkBlocks(text)
  }

  let middlewareBoard: Board | null = null
  /** Runs the middleware on a write, then `commit`s what it passed on: a `DroppedError` when it drops it. */
  const screen = <W extends Write, T>(write: W, author: Actor, source: WriteSource, commit: (write: W) => Promise<T>): Promise<T> =>
    runMiddleware(middleware, { write, author, source, board: () => (middlewareBoard ??= handleOf(MIDDLEWARE, null)) }, (passed) => {
      // What the middleware made of its labels is a caller's write too.
      if (passed.kind === 'post') ownLabels(passed.labels)
      return commit(passed)
    })

  /** Whether a lookup found what it looked for: a 404 says it didn't. */
  async function found(lookup: () => Promise<unknown>): Promise<boolean> {
    try {
      await lookup()
      return true
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return false
      throw error
    }
  }

  /** Files a write carries, as the board stored them: each one `caller` may have, or the backend's 404. */
  async function attachmentsOf(caller: Caller, ids: readonly string[] | undefined, signal: AbortSignal): Promise<Attachment[]> {
    const attachments: Attachment[] = []
    for (const id of new Set(ids ?? [])) {
      const { attachment, data } = await backend.attachment(caller, { id }, signal)
      if (data instanceof ReadableStream) await data.cancel().catch(() => {})
      attachments.push(attachment)
    }
    return attachments
  }

  /**
   * A post through the middleware, then `send`: once board() knows it would land (a reply's root is
   * there, and the caller may post, label, and sync where it does), with the files it may have. A
   * retry of one that landed stands, whatever the middleware would say now; one that wouldn't land
   * goes as it came, for the backend to say why.
   */
  async function screenPost<T>(caller: Caller, input: Protocol['post']['input'], signal: AbortSignal, send: (input: Protocol['post']['input']) => Promise<T>): Promise<T> {
    const source = sourceOf(caller)
    if (middleware.length === 0 || source === null) return send(input)
    if (input.id !== undefined && (await found(() => backend.posted(caller, { id: input.id! }, signal)))) return send(input)
    let channel = input.channel
    let re: string | null = null
    if (input.re !== undefined) {
      const root = await lookup(caller, input.re, signal)
      if (!root) return send(input)
      channel = root.channel
      re = root.re ?? root.id
    }
    const access = accessOf(caller)
    const labels = Object.keys(input.labels ?? {}).length > 0
    const syncs = input.re === undefined && (input.sync?.length ?? 0) > 0
    if (channel === undefined || (access && (!access.can('post', channel) || (labels && !access.can('label', channel)) || (syncs && !access.can('sync', channel)))))
      return send(input)
    const attachments = await attachmentsOf(caller, input.attachments, signal)
    const { actor } = await whoIs(caller, signal)
    return screen({ kind: 'post', channel, re, text: input.text, labels: input.labels ?? {}, attachments }, actor, source, (write) =>
      send({ ...input, text: write.text, labels: write.labels }),
    )
  }

  /**
   * A digest of what a batch asks for, as it was given: its channel and its tasks, as many, in the
   * same order, each with the same key, text, labels, `noSync`, files, needs, and assignee. A field
   * left out is its empty value. A batch made under an `id` is that `id`'s only for the same one.
   */
  async function batchRequest(body: Pick<Protocol['createTasks']['input'], 'channel' | 'tasks'>): Promise<string> {
    const tasks = body.tasks.map((task) => [task.key ?? null, task.text, Object.entries(task.labels ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)), task.noSync ?? false, task.attachments ?? [], task.needs ?? [], task.for ?? null])
    return (await sha256(JSON.stringify([body.channel, tasks]))).slice(0, 32)
  }

  /**
   * A batch's roots through the middleware, each as the post it is, in order, then `send` with what
   * it passed on: every one before any is written, so a root it drops makes none of them. A batch
   * that wouldn't land goes as it came, for the backend to say why. One that landed already never
   * gets here: its retry is answered before.
   */
  async function screenTasks<T>(
    caller: Caller,
    input: Protocol['createTasks']['input'],
    signal: AbortSignal,
    send: (tasks: Protocol['createTasks']['input']['tasks']) => Promise<T>,
  ): Promise<T> {
    const source = sourceOf(caller)
    if (middleware.length === 0 || source === null) return send(input.tasks)
    const { channel } = input
    const access = accessOf(caller)
    const labels = input.tasks.some((task) => Object.keys(task.labels ?? {}).length > 0)
    if (access && (!access.can('post', channel) || (labels && !access.can('label', channel)))) return send(input.tasks)
    const { actor } = await whoIs(caller, signal)
    const passed: Protocol['createTasks']['input']['tasks'] = []
    const from = async (at: number): Promise<T> => {
      const task = input.tasks[at]
      if (!task) return send(passed)
      const attachments = await attachmentsOf(caller, task.attachments, signal)
      return screen({ kind: 'post', channel, re: null, text: task.text, labels: task.labels ?? {}, attachments }, actor, source, (write) => {
        passed.push({ ...task, text: write.text, ...(task.labels || Object.keys(write.labels).length > 0 ? { labels: write.labels } : {}) })
        return from(at + 1)
      })
    }
    return from(0)
  }

  /**
   * A schedule, on a backend whose sends post elsewhere: its message through the middleware once,
   * as the caller's post of it, since its text and labels never change and no send comes back here.
   */
  function screenSchedule(caller: Caller, input: Protocol['schedule']['input'], signal: AbortSignal): Promise<Protocol['schedule']['output']> {
    const { channel, re, text, labels, noSync, attachments } = input
    const message = { ...(channel !== undefined ? { channel } : {}), ...(re !== undefined ? { re } : {}), text, ...(labels ? { labels } : {}), ...(noSync !== undefined ? { noSync } : {}), ...(attachments ? { attachments } : {}) }
    return screenPost(caller, message as Protocol['post']['input'], signal, async (screened) => {
      if (screened.text !== text) await checkBlocks(screened.text)
      return settling(caller, screened.text, async () => re, signal, (settled) =>
        backend.schedule(caller, { ...input, text: settled, ...(screened.labels ? { labels: screened.labels } : {}) }, signal),
      )
    })
  }

  /**
   * The caller's own message, still there, where it may post: what an edit of it changes. One it
   * can't read may still be its own, as board()'s own code finds it, only if it was written there
   * without reading too: one its principal wrote where it reads (a repo's workflows share one) is
   * as missing to it as one that isn't there.
   */
  async function ownMessage(caller: Caller, id: string, signal: AbortSignal): Promise<MessageView | null> {
    const access = accessOf(caller)
    const readable = await lookup(caller, id, signal)
    const message = readable ?? (access !== null ? await lookup(OWN, id, signal) : null)
    if (!message || message.deleted || (access && !access.can('post', message.channel))) return null
    if (!readable && !message.blind) return null
    return message.by.principal === (await whoIs(caller, signal)).principal ? message : null
  }

  /** An edit through the middleware, then `send`: only the author's own, of a message that's still there, reaches it. */
  async function screenEdit(
    caller: Caller,
    input: Protocol['edit']['input'],
    signal: AbortSignal,
    send: (input: Protocol['edit']['input']) => Promise<Protocol['edit']['output']>,
  ): Promise<Protocol['edit']['output']> {
    const source = sourceOf(caller)
    if (middleware.length === 0 || source === null) return send(input)
    const message = await ownMessage(caller, input.id, signal)
    if (!message) return send(input)
    const { actor } = await whoIs(caller, signal)
    return screen({ kind: 'edit', id: message.id, channel: message.channel, re: message.re, text: input.text }, actor, source, (write) => send({ ...input, text: write.text }))
  }

  /**
   * Where an import came from, as the middleware is told: the platform event sync says it's from,
   * or what its entry and origin say. Null when it names an entry its caller doesn't sync, which
   * the backend refuses.
   */
  async function importSource(
    caller: Caller,
    body: Extract<Protocol['syncImport']['input'], { op: 'post' | 'edit' }>,
    found: MessageView | null,
    signal: AbortSignal,
  ): Promise<Extract<WriteSource, { kind: 'sync' }> | null> {
    const key = body.source?.key ?? body.from
    if (body.source) {
      const known =
        'identity' in caller
          ? (await backend.watchers(caller, {}, signal)).watchers.some((registration) => registration.owner === caller.identity.principal.id && registration.sync.some((entry) => entry.key === key))
          : entries[body.source.key] !== undefined
      if (!known) return null
    }
    const origin = (body.op === 'post' ? body.origin : null) ?? found?.origin ?? null
    return {
      kind: 'sync',
      key: key ?? '',
      platform: body.author.id.slice(0, Math.max(0, body.author.id.indexOf(':'))),
      channel: body.source?.channel ?? found?.origin?.channel ?? origin?.channel ?? '',
      thread: body.source?.thread ?? (origin ? (origin.subthread ?? origin.thread) : ''),
    }
  }

  /** The board message an import changes: the one it names, or the one its platform IDs are on the board as. */
  async function importTarget(caller: Caller, body: Extract<Protocol['syncImport']['input'], { op: 'edit' }>, signal: AbortSignal): Promise<MessageView | null> {
    let id = body.message ?? null
    if (body.origin !== undefined) {
      const { thread, message } = await backend.syncFind(caller, { thread: body.origin.thread, ...(body.origin.message !== undefined ? { message: body.origin.message } : {}) }, signal)
      id = body.origin.message !== undefined ? message : thread === null ? null : (await backend.syncThread(caller, { thread }, signal)).root
    }
    return id === null ? null : lookup(caller, id, signal)
  }

  /**
   * An import with only the platform users its text mentions, as it lands: one the sync function or
   * the middleware wrote out of it isn't introduced to the board.
   */
  function introducing(body: Protocol['syncImport']['input']): Protocol['syncImport']['input'] {
    if ((body.op !== 'post' && body.op !== 'edit') || !body.mentioned?.length) return body
    const named = new Set(extractMentions(body.text).flatMap((token) => (token.kind === 'actor' ? [token.actor] : [])))
    const { mentioned: all, ...rest } = body
    const mentioned = all.filter((user) => named.has(user.id))
    return mentioned.length ? { ...rest, mentioned } : rest
  }

  /**
   * An import, through the middleware when it's a post or an edit that would land: what the
   * middleware passed on, or what it responded when it dropped it, for sync to tell the author on
   * the platform. A retry of one that landed stands.
   */
  async function syncImport(caller: Caller, body: Protocol['syncImport']['input'], signal: AbortSignal): Promise<Protocol['syncImport']['output']> {
    if (body.op === 'post') ownLabels(body.labels)
    if (body.op === 'labels') ownLabels(body.set, body.unset)
    // What a sync writes on the board itself, as a platform user (`from: null`), is checked as any
    // write, a sync callback's client's and a sync elsewhere's alike: only what came from a platform
    // is text the board can't refuse. Checked again when the middleware changed it.
    const written = (body.op === 'post' || body.op === 'edit') && body.from === null ? body.text : null
    if (written !== null) await checkBlocks(written)
    const send = async (patched: Protocol['syncImport']['input']) => {
      if (written !== null && (patched.op === 'post' || patched.op === 'edit') && patched.text !== written) await checkBlocks(patched.text)
      return backend.syncImport(caller, introducing(patched), signal)
    }
    if (middleware.length === 0 || caller.origin.via?.kind === 'middleware' || (body.op !== 'post' && body.op !== 'edit')) return send(body)
    const access = accessOf(caller)
    // One that can't import goes as it came, for the backend to say why: no sync, or narrowed with x-board-can.
    if (access && (!access.anywhere('sync') || narrowed(caller))) return send(body)
    const dropped = async (commit: () => Promise<Protocol['syncImport']['output']>) => {
      try {
        return await commit()
      } catch (error) {
        if (!(error instanceof DroppedError)) throw error
        return { message: null, dropped: [...error.responses] }
      }
    }
    if (body.op === 'post') {
      if (body.id !== undefined && (await backend.syncFind(caller, { post: body.id }, signal)).message !== null) return send(body)
      let channel = body.channel
      let re: string | null = null
      if (body.re !== undefined) {
        const root = await lookup(caller, body.re, signal)
        if (!root) return send(body)
        channel = root.channel
        re = root.re ?? root.id
      }
      if (channel === undefined || (access && !access.can('sync', channel))) return send(body)
      const source = await importSource(caller, body, null, signal)
      if (!source) return send(body)
      const attachments = await attachmentsOf(caller, body.attachments, signal)
      const author = externalActor(body.author, await whoIs(caller, signal))
      return dropped(async () =>
        screen({ kind: 'post', channel: channel!, re, text: body.text, labels: body.labels ?? {}, attachments }, author, source, async (write) =>
          send({ ...body, text: write.text, labels: write.labels }),
        ),
      )
    }
    if ((body.origin === undefined) === (body.message === undefined)) return send(body)
    const found = await importTarget(caller, body, signal)
    const author = externalActor(body.author, await whoIs(caller, signal))
    // Only an edit that would land reaches the middleware: the author's own, when it's named by board ID. A
    // backend that names imports by the platform user alone (Vercel's, before profiles) stored them so.
    const own = found !== null && (found.by.actor === author.id || found.by.actor === body.author.id)
    if (!found || found.deleted || (access && !access.can('sync', found.channel)) || (body.message !== undefined && !own)) return send(body)
    const source = await importSource(caller, body, found, signal)
    if (!source) return send(body)
    return dropped(async () =>
      screen({ kind: 'edit', id: found.id, channel: found.channel, re: found.re, text: body.text }, author, source, async (write) => send({ ...body, text: write.text })),
    )
  }

  /** A message as `caller` may read it, or null. */
  async function lookup(caller: Caller, id: string, signal: AbortSignal): Promise<MessageView | null> {
    try {
      const { message, replies } = await backend.message(caller, { id }, signal)
      return [message, ...replies].find((candidate) => candidate.id === id) ?? null
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null
      throw error
    }
  }

  /** A post, with the targets it names resolved once the caller may post and sync there, through the middleware. */
  async function post(caller: Caller, input: Protocol['post']['input'], signal: AbortSignal): Promise<Protocol['post']['output']> {
    await checkWrite(caller, input.text, input.channel !== undefined ? { channel: input.channel } : { message: input.re! }, signal)
    const send = (poster: Caller, body: Protocol['post']['input']) =>
      screenPost(poster, body, signal, async (patched) => {
        // What the middleware passed on is what's written: checked again when it changed the text.
        if (patched.text !== input.text) await checkBlocks(patched.text)
        return settling(poster, patched.text, async () => patched.re, signal, (text) => backend.post(poster, { ...patched, text }, signal), (answer) => answer.message.text)
      })
    // Without sync, nothing here calls a platform: its targets only take their shape.
    if (!engine) return send(caller, input.sync?.length ? { ...input, sync: await Promise.all(input.sync.map(resolveTarget)) } : input)
    const allowed = input.sync?.length ? await mayPost(caller, input, signal) : null
    if (!allowed) return send(caller, input)
    const { access, channel } = allowed
    // A reply's targets are a mistake the backend names: only a new thread's go to the platform.
    const syncs = input.re === undefined && (access === null || access.can('sync', channel))
    return send(caller, syncs ? { ...input, sync: await Promise.all(input.sync!.map(resolveTarget)) } : input)
  }

  /**
   * An import's answer, as a sync callback's client gets it: the message it wrote or changed, or the
   * middleware's responses in the event's platform thread and a `DroppedError` when it dropped it.
   */
  async function landed(caller: PlatformCaller, answer: Protocol['syncImport']['output']): Promise<string | null> {
    if (!answer.dropped) return answer.message
    for (const text of answer.dropped) await caller.platform.respond(text)
    throw new DroppedError(answer.dropped)
  }

  /**
   * What a sync callback's client does, on any backend. Its own writes are imports, as the platform
   * user the event came from, which the middleware sees as any import; everything else, its reads
   * included, it does as sync. A change it names by ID is an import that names it so.
   */
  async function asPlatform(name: Method, caller: PlatformCaller, input: unknown, signal: AbortSignal): Promise<unknown> {
    const sync = engine!
    const me = sync.caller
    const { author, key } = caller.platform
    const { via } = caller.origin
    const source = { key, channel: via.channel, thread: via.thread }
    const change = async (body: Protocol['syncImport']['input']) => {
      const message = await landed(caller, await syncImport(me, body, signal))
      if (message === null) throw notFound(`message not found: #${(body as { message?: string }).message}`, 'message_not_found')
      return { ok: true as const }
    }
    switch (name) {
      case 'post':
        return importPost(caller, input as Protocol['post']['input'], signal)
      case 'edit': {
        const { id, text, revision } = input as Protocol['edit']['input']
        return change({ op: 'edit', author, from: null, message: id, text, source, ...(revision !== undefined ? { revision } : {}) })
      }
      case 'delete': {
        const { id, revision } = input as Protocol['delete']['input']
        return change({ op: 'delete', author, from: null, message: id, ...(revision !== undefined ? { revision } : {}) })
      }
      case 'react': {
        const { id, emoji, remove } = input as Protocol['react']['input']
        return change({ op: 'react', author, from: null, message: id, emoji, ...(remove !== undefined ? { remove } : {}) })
      }
      case 'label': {
        const { id, set, unset, if: expected } = input as Protocol['label']['input']
        return change({ op: 'labels', author, from: null, message: id, ...(set ? { set } : {}), ...(unset ? { unset } : {}), ...(expected ? { if: expected } : {}) })
      }
      default:
        return invoke(name, me, input, signal)
    }
  }

  /** A sync callback's post, as an import by its platform user: once per client ID, which the backend sees to. */
  async function importPost(caller: PlatformCaller, input: Protocol['post']['input'], signal: AbortSignal): Promise<Protocol['post']['output']> {
    const sync = engine!
    const me = sync.caller
    const { author, key } = caller.platform
    const { via } = caller.origin
    const read = async (id: string) => {
      const message = await lookup(me, id, signal)
      if (!message) throw notFound(`message not found: #${id}`, 'message_not_found')
      return message
    }
    // A retry of one that landed: it stands, and its targets were recorded with it.
    if (input.id !== undefined) {
      const found = (await backend.syncFind(me, { post: input.id }, signal)).message
      if (found !== null) return { message: await read(found) }
    }
    const targets = await Promise.all((input.sync ?? []).map(resolveTarget))
    const message = await landed(
      caller,
      await syncImport(me, {
        op: 'post',
        author,
        from: null,
        origin: null,
        source: { key, channel: via.channel, thread: via.thread },
        ...(input.channel !== undefined ? { channel: input.channel } : { re: input.re! }),
        text: input.text,
        ...(input.labels ? { labels: input.labels } : {}),
        ...(input.noSync ? { noSync: true } : {}),
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.id !== undefined ? { id: input.id } : {}),
        ...(input.after !== undefined ? { after: input.after } : {}),
      }, signal),
    )
    // The targets it asked for, as sync records a thread's.
    for (const target of targets)
      await backend.syncReceipt(me, { kind: 'thread', message: message!, target: target.target, targetKind: target.kind, cause: 'request' }, signal)
    return { message: await read(message!) }
  }

  /** The protocol method `name`, as board() serves it: what it posts, edits, and imports goes through the middleware. */
  async function invoke(name: Method, caller: Caller, input: unknown, signal: AbortSignal): Promise<unknown> {
    switch (name) {
      case 'post':
        ownLabels((input as Protocol['post']['input']).labels)
        return post(caller, input as Protocol['post']['input'], signal)
      case 'label': {
        const { set, unset } = input as Protocol['label']['input']
        ownLabels(set, unset)
        return backend.label(caller, input as Protocol['label']['input'], signal)
      }
      case 'createTask': {
        const body = input as Protocol['createTask']['input']
        ownLabels(body.labels)
        // A thread that's there becomes a task as it is: nothing is posted, so the middleware has nothing to see.
        if (body.channel === undefined) return backend.createTask(caller, body, signal)
        // A new one's root is a post: its blocks are checked and the middleware sees it, as any post's.
        const { channel, labels, noSync, attachments, id } = body
        // It may be empty when the root has files, as a post's may.
        const sent = body.text ?? ''
        await checkWrite(caller, sent, { channel }, signal)
        const root = { channel, text: sent, ...(labels ? { labels } : {}), ...(noSync !== undefined ? { noSync } : {}), ...(attachments ? { attachments } : {}), ...(id !== undefined ? { id } : {}) } as Protocol['post']['input']
        return screenPost(caller, root, signal, async (screened) => {
          if (screened.text !== sent) await checkBlocks(screened.text)
          return settling(
            caller,
            screened.text,
            async () => undefined,
            signal,
            (text) => backend.createTask(caller, { ...body, text, ...(screened.labels ? { labels: screened.labels } : {}) }, signal),
            (answer) => answer.task.text,
          )
        })
      }
      case 'createTasks': {
        const body = input as Protocol['createTasks']['input']
        for (const task of body.tasks) ownLabels(task.labels)
        // A batch under an `id` that landed stands: the same request again gets its tasks, whatever the middleware would
        // make of it now, and another request under the `id` is refused. Neither is screened: each write is, once.
        // What it asks for is a digest of the request as given: this board's, or the one a board in front of it made
        // of what it was given, before its middleware. Both then know a repeat by the same thing.
        const request = body.id !== undefined ? (body.request ?? (await batchRequest(body))) : undefined
        if (body.id !== undefined) {
          try {
            return await backend.createdTasks(caller, { id: body.id, request }, signal)
          } catch (error) {
            if (!(error instanceof HttpError && error.status === 404 && error.code === 'batch_not_found')) throw error
          }
        }
        // Each task's root is a post: its blocks are checked and the middleware sees it, as any post's.
        for (const task of body.tasks) await checkWrite(caller, task.text, { channel: body.channel }, signal)
        return screenTasks(caller, body, signal, async (tasks) => {
          for (const [at, task] of tasks.entries()) if (task.text !== body.tasks[at]!.text) await checkBlocks(task.text)
          const settle = settler(caller, signal)
          const mentions: Mentioned[] = []
          const settled: typeof tasks = []
          for (const task of tasks) {
            const root = await settle(task.text, async () => undefined)
            settled.push(root.text === task.text ? task : { ...task, text: root.text })
            // One handle is said once, however many of the batch's tasks typed it.
            for (const mention of root.mentions) if (!mentions.some((said) => said.written === mention.written)) mentions.push(mention)
          }
          // What it asked for goes with it: a backend keeps it with the batch, and a board behind this one goes by it.
          const answer = await backend.createTasks(caller, { ...body, tasks: settled, request }, signal)
          return mentions.length > 0 ? { ...answer, mentions } : answer
        })
      }
      case 'edit': {
        const edit = input as Protocol['edit']['input']
        await checkWrite(caller, edit.text, { message: edit.id }, signal)
        return screenEdit(caller, edit, signal, async (patched) => {
          if (patched.text !== edit.text) await checkBlocks(patched.text)
          const thread = async () => {
            const edited = await lookup(caller, edit.id, signal)
            return edited ? (edited.re ?? edited.id) : undefined
          }
          return settling(caller, patched.text, thread, signal, (text) => backend.edit(caller, { ...patched, text }, signal))
        })
      }
      case 'syncImport':
        return syncImport(caller, input as Protocol['syncImport']['input'], signal)
      case 'schedule': {
        const body = input as Protocol['schedule']['input']
        ownLabels(body.labels)
        // Checked when it's made, where its author sees it; a send that comes back through here is checked as any post.
        await checkWrite(caller, body.text, body.channel !== undefined ? { channel: body.channel } : { message: body.re! }, signal)
        return backend.sendsSchedulesHere === false
          ? screenSchedule(caller, body, signal)
          : settling(caller, body.text, async () => body.re, signal, (text) => backend.schedule(caller, { ...body, text }, signal))
      }
      case 'inbox': {
        const query = input as Protocol['inbox']['input']
        // A channel by name, for an entry this board has: its platform ID, for a caller that may sync.
        if (engine && entries[query.key] && query.channel !== undefined) {
          const access = accessOf(caller)
          if (access === null || access.anywhere('sync')) return backend.inbox(caller, { ...query, channel: await engine.inboxChannel(query.key, query.channel) }, signal)
        }
        return backend.inbox(caller, query, signal)
      }
      default: {
        const method = backend[name] as unknown
        if (typeof method !== 'function') throw notFound(`no route: ${name}`)
        return (method as (caller: Caller, input: unknown, signal: AbortSignal) => Promise<unknown>).call(backend, caller, input, signal)
      }
    }
  }

  /** board()'s own routes for a caller: sync's, which run where board() does. */
  async function serve(name: BoardRoute, caller: Caller, request: Request, url: URL, params: Record<string, string>): Promise<Response> {
    const signal = request.signal
    switch (name) {
      case 'sync': {
        // Attaching a thread is a `thread` receipt, recorded as the caller: it needs `sync` where the thread is,
        // which a request's caller shows before its target goes to the platform to resolve.
        const body = SyncBody.parse(await readJson(request))
        const id = params.id ?? ''
        const access = accessOf(caller)
        if (access && engine) {
          const message = await lookup(caller, id, signal)
          if (!message) throw notFound(`message not found: #${id}`, 'message_not_found')
          if (!access.can('sync', message.channel)) throw forbidden(`this token can't sync in ${message.channel}`)
        }
        const target = await resolveTarget(body.target)
        const { attached } = await backend.syncReceipt(caller, { kind: 'thread', message: id, target: target.target, targetKind: target.kind, cause: 'request' }, signal)
        return json({ target: target.target, attached: attached ?? true })
      }
      default:
        throw notFound(`no route: ${request.method} ${url.pathname}`)
    }
  }

  // Sync reads and writes through the backend's methods, its imports through the middleware first.
  const synced = Object.fromEntries(
    METHODS.map((name) => [name, name === 'syncImport' ? syncImport : (caller: Caller, input: never, signal: AbortSignal) => (backend[name] as (...args: unknown[]) => unknown).call(backend, caller, input, signal)]),
  ) as unknown as ProtocolMethods
  engine?.bind({
    backend: synced,
    client: (platform, trigger) => clientAs({ platform: { author: platform.author, key: platform.key, respond: platform.respond }, origin: { via: platform.via } }, trigger),
    syncedHere: async (key) => (backend.syncedHere ? backend.syncedHere(key) : true),
  })

  /**
   * Server-sent events, from the backend's long-poll: each event's `id` is its cursor, so
   * `Last-Event-ID` resumes exactly. A request's caller is worked out again for each page, so what
   * `access` says now holds, and a token that runs out ends it.
   */
  async function sse(caller: Caller, query: Protocol['events']['input'], request: Request, identify: (() => Promise<Caller>) | null): Promise<Response> {
    // The first page now, so a bad cursor or a refusal answers as an error instead of a stream.
    // The feed's newest events (`last`) are the stream's first page, and it goes on from their cursor.
    const { last, ...following } = query
    const first = await backend.events(caller, last !== undefined ? query : { ...query, wait: 0 }, request.signal)
    const encoder = new TextEncoder()
    const controller = new AbortController()
    const deadline = Date.now() + streamMaxMs
    const signal = AbortSignal.any([request.signal, controller.signal, AbortSignal.timeout(streamMaxMs)])
    const body = new ReadableStream<Uint8Array>({
      async start(stream) {
        const send = (text: string) => {
          try {
            stream.enqueue(encoder.encode(text))
          } catch {}
        }
        const ping = setInterval(() => send(': ping\n\n'), 15_000)
        try {
          send(': connected\n\n')
          let page = first
          let after: string | undefined
          for (;;) {
            for (const event of page.events) send(`id: ${event.cursor}\nevent: board\ndata: ${JSON.stringify(event)}\n\n`)
            // Filtered-out events still advance the client's cursor with a bare `id:`, the first page's included.
            if (page.cursor !== (page.events.at(-1)?.cursor ?? after)) send(`id: ${page.cursor}\n\n`)
            after = page.cursor
            const left = deadline - Date.now()
            if (signal.aborted || left <= 0) break
            page = await backend.events(identify ? await identify() : caller, { ...following, after, wait: Math.min(300, left / 1000) }, signal)
          }
        } catch (error) {
          if (!signal.aborted) console.error('[board] feed failed', error)
        } finally {
          clearInterval(ping)
          try {
            stream.close()
          } catch {}
        }
      },
      cancel() {
        controller.abort()
      },
    })
    return new Response(body, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      },
    })
  }

  /**
   * Discovery, as a request reaches the board: who the board is to it (the URL a token must be minted
   * for, and the project people mint them with), which is board()'s to say, and the sync entries
   * accounts link on. Those are the backend's, where it keeps the board; a board on `http()` lists its own.
   */
  async function discovery(request: Request, url: string, signal: AbortSignal): Promise<Protocol['discovery']['output']> {
    const { projectId, teamId } = await policy.discoveryIdentity(request.headers)
    const sync = backend.keeps
      ? (await backend.discovery(OWN, {}, signal)).sync
      : Object.entries(entries).map(([key, entry]) => ({ key, platform: entry.platform }))
    return { version: VERSION, url, audience: url, team_id: teamId, project_id: projectId, sync }
  }

  async function dispatch(request: Request, injected: Caller | PlatformCaller | null): Promise<Response> {
    try {
      const url = new URL(request.url)
      const match = route(request.method, url.pathname)
      if (!match) throw notFound(`no route: ${request.method} ${url.pathname}`)
      const { target } = match
      // The mount, as requests show it. Every request reaches the handler under it, so one can only make it
      // look deeper (`/api/board/x/messages/1`): a mount replaces the one learned only when it's above it.
      if (!injected && !match.root && (state.learned === null || state.learned.startsWith(`${match.base}/`))) state.learned = match.base
      const at = `${url.origin}${match.base}`.replace(/\/+$/, '')

      if (target.kind === 'board' && target.name === 'webhook') {
        // A platform can't send a credential the board verifies: its adapter verifies the request.
        if (!engine || !entries[match.params.key ?? '']) throw notFound(`no sync entry named ${match.params.key}`)
        return await engine.handleWebhook(match.params.key!, request)
      }
      if (target.kind === 'board' && target.name === 'avatar') {
        const name = match.param ?? ''
        if (!(KNOWN_AGENTS as readonly string[]).includes(name)) throw notFound(`no avatar: ${name}`)
        return new Response(avatarSvg(name), {
          headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' },
        })
      }
      if (target.kind === 'board' && target.name === 'openapi') return json(openapi())
      // A backend's own routes check what they need: a wake-up carries no credential the board verifies.
      if (target.kind === 'backend') return await target.route.handle(request, { caller: injected && 'platform' in injected ? engine!.caller : injected, param: match.param })

      // Everything else is for a caller: this deployment's own code, or a request, which a board that
      // uses another board's doesn't serve. Nothing runs for one before that.
      if (!injected && !policy.open) throw servesOnly()
      if (!injected && target.kind === 'protocol' && target.name === 'discovery') return json(await discovery(request, audienceOf(at), request.signal))
      if (target.kind === 'protocol' && typeof (backend[target.name] as unknown) !== 'function') throw notFound(`no route: ${request.method} ${url.pathname}`)
      // A sync callback's client does everything but its own writes as sync.
      const own = injected && 'platform' in injected ? engine!.caller : injected
      const asked = own ? null : requestOf(request, at)
      const caller: Caller = own ?? (await callerOf(asked!))
      if (target.kind === 'board') return await serve(target.name, caller, request, url, match.params)

      const input = await inputOf(target.name, request, url, match.params)
      if (target.name === 'events' && (request.headers.get('accept') ?? '').includes('text/event-stream'))
        return await sse(caller, input as Protocol['events']['input'], request, asked ? () => callerOf(asked) : null)
      const output = injected && 'platform' in injected ? await asPlatform(target.name, injected, input, request.signal) : await invoke(target.name, caller, input, request.signal)
      if (target.name === 'attachment') return attachmentResponse(output as Protocol['attachment']['output'])
      // A channel that was there already is answered, not created.
      const made = CREATED.has(target.name) || (target.name === 'createChannel' && (output as Protocol['createChannel']['output']).created)
      return json(output, made ? 201 : 200)
    } catch (error) {
      // Stopped by its caller (a page reloaded, a long-poll let go): no one reads the answer, and
      // the abort isn't the board's failure. Any other failure still is, caller there or not.
      if (request.signal.aborted && error === request.signal.reason) return new Response(null, { status: 499 })
      return toErrorResponse(error)
    }
  }

  return {
    dispatch,
    async inject(request, caller, trigger, writes) {
      // What it posts, a task's new thread included, gets an ID from what triggered it, so a retry posts once.
      const pathname = new URL(request.url).pathname
      if (trigger !== null && request.method === 'POST' && (pathname.endsWith('/messages') || pathname.endsWith('/tasks') || pathname.endsWith('/tasks/batch'))) {
        const body = ((await request.json()) ?? {}) as Record<string, unknown>
        if (pathname.endsWith('/messages') || body.channel !== undefined) body.id ??= await derivedId('board-inbound', trigger, 'client', String(writes.made++))
        request = new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(body) })
      }
      return dispatch(request, caller)
    },
    async run(id, event, { trigger, attempt }) {
      if (id === SYNC && engine) return engine.deliver(event as SyncEvent, { attempt })
      const watcher = watch[id]
      if (!watcher) throw new Error(`this board has no watcher ${id}`)
      await watcher.run({ event, board: handleOf({ self: id, origin: { via: { kind: 'watcher', id } } }, trigger) })
    },
    async receive(key, item, { id, attempt }) {
      if (!engine) throw new Error(`this board has no sync, so nothing reads ${key}'s inbox`)
      await engine.receive(key, item, { id, attempt })
    },
    pull: () => (engine ? engine.pull() : Promise.resolve(0)),
    async readSource(key, target, limit, after) {
      if (!engine || !entries[key]) throw notFound(`this board doesn't run sync entry ${key}: read it where its sync runs`, 'not_synced_here')
      return engine.readSource(key, target, limit, after)
    },
    async joinSource(key, target) {
      if (!engine || !entries[key]) throw notFound(`this board doesn't run sync entry ${key}: join it where its sync runs`, 'not_synced_here')
      return engine.joinSource(key, target)
    },
    typing: async (messages, status) => (engine ? engine.typing(messages, status) : []),
  }
}
