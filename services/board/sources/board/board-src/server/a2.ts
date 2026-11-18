import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import type { z } from 'zod'
import { A2Error, idempotentId, reducer } from 'experimental-a2'
import { consumer, createServer, type A2Scheduler, type ConsumerContext } from 'experimental-a2/server'
import { boardContract, inboxContract, INBOXES_SESSION, inboxSession, SCHEDULES_SESSION, type InboxEvent } from '../contract/contract.ts'
import { BOARD_SESSION, type BoardEvent, type BoardEvents } from '../contract/events.ts'
import { createTrust } from './trust.ts'
import { createSchemas } from './schemas.ts'
import type { ExternalAuthor, Link, Origin } from '../contract/external.ts'
import { actorsReducer, channelsReducer } from '../contract/reducers.ts'
import { type Actor, type ExternalCopy, type Message } from '../contract/folds.ts'
import { importedHandle, shownName, userIdOf } from '../contract/profiles.ts'
import { extractMentions, isEmail, replaceMentions } from '../contract/mentions.ts'
import { ATTACHMENT_BYTES_MAX, ATTACHMENTS_PER_MESSAGE_MAX, IMPORT_BYTES_MAX, MESSAGE_TEXT_MAX, platformAvatar, RemoteWatcherId, type Labels } from '../contract/schemas.ts'
import { CHANNELS_LIMIT_DEFAULT, INBOX_EVENT_ID_MAX, REGISTERED_WATCHERS_MAX, type Discovery, type InboxEntry, type Me, type ScheduleView } from '../api/routes.ts'
import type { Protocol } from '../api/protocol.ts'
import { FULL_ACCESS, parseCan, type Access, type Permission } from './access.ts'
import { authenticates, type Granted } from './auth.ts'
import { viaOf } from './actors.ts'
import { SYNC, type Backend, type BackendRoute, type BoardBinding, type Caller, type ProtocolMethods, type SelfCaller, type Trust } from './backend.ts'
import { BoardError } from '../client/client.ts'
import { attachmentBody, attachmentNotFound, finishUpload, ownUpload, readUpload, startUpload, writeUpload, type BlobStore, type Uploader } from './blob.ts'
import { badRequest, duplicateId, forbidden, HttpError, notFound, textTooLong, toErrorResponse } from './errors.ts'
import { eventView, foldEvent, indexOf, lastFeed, loadBefore, OWN_CODE, pollFeed, readableFilter, ref, toMessageFilter, verifiedRecord, view, viewedBy, viewLinkedIds, viaOfRecord } from './feed.ts'
import { createReads, tablesConsumer } from './reads.ts'
import { createdBy, createSchedules, type Schedule } from './schedules.ts'
import { createTasks, taskLimits } from './tasks.ts'
import type { BoardStore, MessageFilter, ThreadPosition } from '../store/types.ts'
import { compileWatcher, createWatchers, ID, registrantSession } from './watch.ts'
import { ack, pull, pullInbox, type QueueSession } from './registered.ts'
import { createRegistry, storedPrincipal, type SyncEntrySpec } from './registry.ts'
import { METHODS } from './routing.ts'
import { authorizeMessage, authorizeOwn, authorizePost, blindText, trusted, writeAttach, writeChannel, writeDelete, writeEdit, writeLabels, writeLinks, writePost, writeReaction, writeRoots, landedBatch, deploymentIdentity, landedFor, type Identity, type WriteContext } from './writes.ts'
import { SYNC_ACTOR, type WriteOrigin } from './origin.ts'
import { derivedId, isKeyIdOf } from '../client/ids.ts'
import { DroppedError, MIDDLEWARE_ACTOR } from './middleware.ts'
import { VERSION } from '../version.ts'

/**
 * The engine behind `local()`, internal: a board on A2's log, and what runs it. Who may use it,
 * and what its writes go through, are board()'s: `board({ authenticate, access, middleware })`.
 */
export type A2Options = {
  /** Where the board keeps its log and tables: `sqlite()` or `memory()` (`store/sqlite.ts`, `store/memory.ts`). */
  store: BoardStore
  /**
   * What gives the board a clock: `localScheduler()` (`scheduler/local.ts`). Without one, the
   * consumers (the tables, watchers, sync) run in the request that writes, a failure is tried again
   * on the next write, and scheduling answers 501 `no_scheduler`. `local()` always passes one.
   */
  scheduler?: A2Scheduler
  /**
   * Where attachments live: `fsBlob()` or `memoryBlob()` (`server/blob.ts`). Without one, the board
   * keeps no files: uploads, and posts that carry them, answer 501 `no_files`, and sync links a
   * platform's files where they are. `local()` always passes one.
   */
  blob?: BlobStore
}

const boardServer = (options: A2Options) =>
  createServer({
    contract: boardContract,
    store: options.store.log,
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  })

export type BoardSession = ReturnType<ReturnType<typeof boardServer>['session']>

/** The board's own code, through its handle: `team.post(…)`. With `as(profile)`, `board:client:<profile>`. */
const CLIENT_ACTOR = 'board:client'

/** A cursor or message ref in a request, as this board's log index: decimals, from 0. */
function cursorAt(value: string): number {
  const index = indexOf(value)
  if (index === null) throw badRequest(`${value} isn't a cursor or a message ID on this board`, 'invalid_cursor')
  return index
}

/** A `/threads` page's `older` on this board: where its oldest thread stands, its latest message's index then its root's. */
const olderRef = (position: ThreadPosition) => `${position.at}.${position.id}`

function olderAt(value: string): ThreadPosition {
  const match = /^(\d{1,15})\.(\d{1,15})$/.exec(value)
  if (!match) throw badRequest(`${value} isn't a page of threads on this board`, 'invalid_cursor')
  return { at: Number(match[1]), id: Number(match[2]) }
}

/** The message a ref in a request names, as its log index, or a 404 for one that names nothing here. */
function messageAt(value: string): number {
  const index = indexOf(value)
  if (index === null || index === 0) throw notFound(`message not found: #${value}`, 'message_not_found')
  return index
}

/**
 * A reply's `after`, as the index of a message. One that isn't one is 0, which names no message:
 * the post refuses it, after a retry that landed gets its reply back.
 */
const afterAt = (value: string | undefined): number | undefined => (value === undefined ? undefined : (indexOf(value) ?? 0))

/**
 * A schedule's ID, `s12`, as its index in session `schedules`. `12` from a client that strips the
 * `s`, and `ss12` from an older CLI that adds one to what this board hands out, name it too.
 */
function scheduleAt(value: string): number {
  const bare = value.replace(/^s{1,2}/, '')
  const index = indexOf(bare)
  if (index === null || index === 0) throw notFound(`schedule not found: s${bare}`, 'schedule_not_found')
  return index
}

/** A signal that never aborts, for what the board does by itself. */
const NEVER = new AbortController().signal

/**
 * `idempotentId`'s shape, a UUIDv8: the IDs the board derives for its own writes (schedule
 * sends, watchers, sync). They're guessable, so an API caller can't post with one and take it first.
 */
const DERIVED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** A request to the board, as board() verified it, as opposed to a write the board's own code makes in-process. */
const fromRequest = (caller: Caller) => 'identity' in caller && (caller.origin.via?.kind ?? 'api') === 'api'

/** Sync in board() in this deployment, as opposed to a sync elsewhere that uses this board. */
const ownSync = (caller: Caller) => 'self' in caller && caller.origin.via?.kind === 'engine'

/** board()'s own code, as the backend's discovery is asked for it. */
const OWN: SelfCaller = { self: null, origin: { via: { kind: 'client', name: null } } }

/**
 * Who a caller writes as. This deployment's own code writes as `board:client` from a handle,
 * `board:client:<profile>` from `as(profile)`, as `board:watch:<id>` from a watcher, which its
 * own writes never wake, and as `board:middleware` and `board:sync` from board()'s middleware
 * and sync.
 */
function selfIdentity(caller: SelfCaller): Identity {
  const identity = ownIdentity(caller)
  if (caller.can === undefined) return identity
  // A handle narrowed with `as(profile, { can })`: what a request narrowed with x-board-can gets.
  const { principal } = identity
  return { ...identity, principal: { ...principal, scope: caller.can, access: principal.access.narrow(parseCan(caller.can)) } }
}

/** Who this deployment's own code is, before a handle's `can` narrows it. */
function ownIdentity(caller: SelfCaller): Identity {
  const { self, origin } = caller
  if (origin.via?.kind === 'watcher') return deploymentIdentity(`board:watch:${self}`, self ?? 'watch')
  if (origin.via?.kind === 'middleware') return deploymentIdentity(MIDDLEWARE_ACTOR, 'middleware')
  if (origin.via?.kind === 'engine') return deploymentIdentity(SYNC_ACTOR, 'sync')
  if (self === null) return deploymentIdentity(CLIENT_ACTOR, 'client')
  if (!ID.test(self)) throw badRequest(`as: profiles use lowercase letters, numbers, - and _, got: ${self}`)
  return deploymentIdentity(`${CLIENT_ACTOR}:${self}`, self)
}

/** An actor's name as people see it, with who it acts through: `Malte via www (preview)`. */
const shownOf = (actor: Actor | undefined) => (actor ? shownName({ name: actor.name, via: viaOfRecord(actor) }) : undefined)

/** A schedule as its creator sees it where it can't read: its text as a blind writer's message's is. */
const blindSchedule = (schedule: ScheduleView, access: Access, own: string): ScheduleView =>
  access.readable(schedule.channel) ? schedule : { ...schedule, text: blindText(schedule.text, own) }

/**
 * A platform user, writing through sync: full access, and each write still proved against the
 * channel it lands in. Their avatar is an https URL or none. This board's own sync checked the
 * platform said so, so its platform users are themselves (`slack:user:U0456`); a sync elsewhere's
 * are its word, a profile of its principal (`vercel:project:prj_1:production+slack:user:U0456`),
 * whose record only its own imports change.
 */
function externalIdentity(author: ExternalAuthor, through: Granted | null, platform: string): Identity {
  const id = through === null ? author.id : `${through.id}+${author.id}`
  // A host's principal's imports are its profiles: the board records them as the host's, as its agents.
  const host = through?.facts?.issuer === 'host' ? { facts: through.facts } : {}
  const principal: Granted = { id: through?.id ?? author.id, kind: 'external', handle: author.handle, access: FULL_ACCESS, expiresAt: null, ...host }
  return {
    principal,
    author: { actor: id, principal: principal.id, profile: through === null ? null : author.id },
    actor: {
      id,
      kind: 'external',
      // The board's own sync's user is themselves; anyone else's is under the principal that imported them.
      handle: through === null ? author.handle : importedHandle(viaOf(through).name, author.handle, userIdOf(author.id)),
      name: author.name,
      avatar: platformAvatar(author.avatar),
      ...(through === null ? {} : { via: viaOf(through) }),
      platform,
      // A sync elsewhere's word, which names it by the handle its credential gave it: checked as `via` shows.
      ...(through !== null && !through.id.startsWith('board:') ? { verified: true as const } : {}),
    },
  }
}

/** The board events sync delivers: what a platform shows, and a thread's new targets. */
const DELIVERED = ['thread.synced', 'message.posted', 'message.edited', 'message.deleted', 'reaction.added', 'reaction.removed', 'labels.changed'] as const

/** The inboxes that have had an event, so a sync key's inbox lists every channel's. */
const inboxesReducer = reducer({
  contract: inboxContract,
  name: 'board.inboxes.v1',
  initialState: {} as Record<string, true>,
}).fold((state, event) => {
  if (event.type === 'inbox.opened') state[event.payload.channel] = true
  return state
})

/** A platform event in an inbox. */
type Received = Extract<InboxEvent, { type: 'external.received' }>
type PlatformEvent = Received['payload']['event']

/** An append that holds an event ID already in the log. */
const duplicate = (error: unknown) => error instanceof A2Error && error.code === 'PARTIAL_DUPLICATE_BATCH'

/**
 * A platform event whose ID is already in an inbox: the platform's retry, which can read differently
 * (another instance, a name changed since), so the copy already there stands.
 */
const alreadyReceived = (error: unknown) => {
  if (!duplicate(error)) throw error
}

/** Everything behind a board on the engine, built once board() binds it. Nothing in it connects until it's used. */
function build(options: A2Options, binding: BoardBinding) {
  const blob = options.blob ?? null
  const { store } = options
  // The same A2 store object for every server: A2 recognizes its own stores by identity.
  const log = store.log
  const registry = createRegistry({ store: log, scheduler: options.scheduler })

  /**
   * Who a caller is, and what it may do now: one board() verified, as it said, its access
   * included; this deployment's own code everything.
   */
  const identityOf = async (caller: Caller): Promise<Identity> => ('identity' in caller ? caller.identity : selfIdentity(caller))
  /** Its own code's handle, which reaches it in process. */
  let ownHandle: ReturnType<BoardBinding['handle']> | null = null
  const tails = Object.fromEntries(
    Object.entries(binding.subscriptions).flatMap(([id, subscription]) => (subscription.kind === 'tail' ? [[id, { tail: subscription.tail }]] : [])),
  )
  // Always, since anyone may register watchers here, to pull, at any time.
  const watchers = createWatchers({
    watch: tails,
    run: (id, event, trigger, attempt) => binding.run(id, event, { trigger, attempt }),
    store: log,
    scheduler: options.scheduler,
    registered: { state: registry.state, accessNow: (principal) => binding.accessNow(principal) },
  })
  const schedules = createSchedules({ store: log, scheduler: options.scheduler })
  const tasks = createTasks({ store: log, scheduler: options.scheduler })
  const projection = tablesConsumer(store.tables)

  /** Sync's delivery in progress here: its receipts are its consumer's appends, fenced by its attempt. */
  const delivering = new AsyncLocalStorage<ConsumerContext<BoardEvents>>()

  /**
   * Sync's outbound, when board() syncs: each event it delivers, on its thread's lane, with its own
   * place in the log, so no watcher holds it up. A2 retries what throws, and dead-letters it after 10.
   */
  const outbound = binding.subscriptions[SYNC]
    ? consumer({
        contract: boardContract,
        name: 'board-sync',
        types: DELIVERED,
        lane: ({ event }) => `thread:${(event.payload as { thread: string }).thread}`,
      }).run(async (ctx) => {
        const event = ctx.event as BoardEvent
        const [messages, { state: actors }] = await Promise.all([
          loadBefore(reads, event, ctx.signal),
          ctx.session.state(actorsReducer, { through: event.index - 1 }),
        ])
        const { before, after } = foldEvent(messages, actors, event)
        // A thread's sync is about its root, which came before it.
        const about = event.type === 'thread.synced' ? ((await reads.ensure(event.index - 1, ctx.signal), await store.tables.byEventId(event.payload.thread)) ?? undefined) : after
        // A label change re-renders a copy only when the labels change what it shows: sync compares them.
        const shown = { ...eventView(event, about, actors, OWN_CODE), ...(event.type === 'labels.changed' && before ? { before: view(before, actors, OWN_CODE) } : {}) }
        await delivering.run(ctx as ConsumerContext<BoardEvents>, () => binding.run(SYNC, shown, { trigger: ctx.event.id, attempt: ctx.attempt }))
      })
    : undefined

  // The tables, watchers, and sync each keep their own place in the board's log.
  const consumers = [projection, watchers.boardConsumer, outbound].filter((consumer) => consumer !== undefined)
  const server = createServer({
    contract: boardContract,
    store: log,
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    consumers,
  })
  const session = server.session(BOARD_SESSION)
  const reads = createReads(store.tables, session, projection)
  const writes: WriteContext = { session, reads }

  /** Sync's inbound: each platform event board()'s sync pushed here, one platform thread at a time. */
  const inbound = consumer({
    contract: inboxContract,
    name: 'board-inbox',
    types: ['external.received'],
    lane: ({ event }) => `thread:${event.payload.event.thread}`,
  }).run(async (ctx) => {
    const { payload } = ctx.event as Received
    await binding.receive(payload.sync, { event: payload.event, raw: payload.raw }, { id: ctx.event.id, attempt: ctx.attempt, signal: ctx.signal })
  })
  const inboxServer = createServer({
    contract: inboxContract,
    store: log,
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    consumers: [inbound],
  })
  // Who the board trusts beside its defaults: its grants.
  const access = createTrust({
    store: log,
    accessNow: (principal, grants) => binding.accessNow(principal, grants),
    explain: (principal, channel) => binding.explain(principal, channel),
    team: async () => (await binding.project()).teamId,
    logins: () => binding.logins,
  })
  // The schema registry, in a session of its own beside the board's.
  const schemaRegistry = createSchemas({ store: log })
  const inboxes = inboxServer.session(INBOXES_SESSION)
  /** The inboxes this instance knows have an `inbox.opened`, so most pushes write nothing more. */
  const opened = new Set<string>()

  // A schedule sends with what its creator may do now, which board()'s `access` says at each send. It
  // posts as its creator, through board(), so the middleware sees it.
  schedules.bind({ writes, accessNow: binding.accessNow, send: async (identity, origin, input) => sendAs(identity, origin, input) })
  tasks.bind({ writes })
  watchers.bind({ reads })

  /**
   * Whether `principal` may have a file: one it uploaded, or one a message it
   * can read carries. A deleted message drops its files, so it no longer counts.
   */
  async function attachmentReadable(principal: Granted, id: string, uploader: Uploader) {
    if (principal.access.readsAll || ownUpload(uploader, principal)) return true
    await reads.ensure()
    return (await reads.tables.withAttachment(id)).some((message) => principal.access.readable(message.channel))
  }

  /**
   * `filter`, narrowed to the channels `access` reads among those the log has,
   * and the index that list reflects: a read's cursor goes no further, or the
   * first post in a channel newer than the list would be in neither the page
   * nor the feed after it.
   */
  async function readable(filter: MessageFilter, access: Access): Promise<{ filter: MessageFilter; through: number }> {
    if (access.readsAll) return { filter, through: Number.POSITIVE_INFINITY }
    const { state, index } = await session.state(channelsReducer)
    return { filter: readableFilter(filter, Object.keys(state), access), through: index }
  }

  /** Who wrote, was mentioned by actor ID (`@[actor-id]`), or reacted in the channels `access` reads, a page at a time. */
  async function actorsIn(access: Access): Promise<Set<string>> {
    const ids = new Set<string>()
    const { filter } = await readable({}, access)
    for (let before: number | undefined; ; ) {
      const { messages } = await reads.messages(filter, { limit: 500, ...(before !== undefined ? { before } : {}) })
      for (const message of messages) {
        ids.add(message.by.actor)
        for (const token of extractMentions(message.text)) if (token.kind === 'actor' && !isEmail(token.actor)) ids.add(token.actor)
        for (const reactors of Object.values(message.reactions)) for (const id of reactors) ids.add(id)
      }
      if (messages.length < 500) return ids
      before = messages[0]!.id
    }
  }

  /**
   * The IDs the events of a batch made under `id` carry, as a post's carries its own: each root's post in turn, and the
   * event after the first root, which says what the batch was asked for. A batch is found again by them alone.
   */
  const batchRoot = (id: string, at: number) => derivedId('board-batch', id, String(at))
  const batchAsked = (id: string, request: string) => derivedId('board-batch-request', id, request)

  /** Files a write carries, as the board stored them: each one the caller may have, or 404 as if it didn't exist. */
  const attachmentsFor = (principal: Granted, ids: readonly string[] | undefined) =>
    Promise.all(
      [...new Set(ids ?? [])].map(async (id) => {
        const { attachment, ...uploader } = await readUpload(blob, id)
        if (!(await attachmentReadable(principal, id, uploader))) throw attachmentNotFound(id)
        return attachment
      }),
    )

  /** This board's own limits on a message, which requests leave to the backend. */
  const withinLimits = ({ text, attachments }: { text: string; attachments?: readonly string[] | undefined }) => {
    if (text.length > MESSAGE_TEXT_MAX) throw textTooLong()
    if ((attachments?.length ?? 0) > ATTACHMENTS_PER_MESSAGE_MAX) throw badRequest(`attachments: a message carries at most ${ATTACHMENTS_PER_MESSAGE_MAX}`)
  }

  /** A registrant's queue, in the watch contract: its watchers' and sync's matches, and its inbox. */
  const queueOf = (owner: string) => watchers.server.session(registrantSession(owner))

  /**
   * A schedule's send, as its creator, through board(): its middleware sees it as any post. One the
   * middleware drops is a `DroppedError`, as the schedule takes it.
   */
  async function sendAs(identity: Identity, origin: WriteOrigin, input: Parameters<Parameters<typeof schedules.bind>[0]['send']>[2]) {
    const { channel, re, ...rest } = input
    const handle = binding.handle({ identity, origin })
    try {
      return channel !== undefined ? await handle.post(channel, rest) : await handle.reply(re!, rest)
    } catch (error) {
      if (error instanceof BoardError && error.code === 'dropped') throw new DroppedError(error.message === 'the board dropped this message' ? [] : error.message.split('\n'))
      throw error
    }
  }

  /** Refuses a request's post an ID that's someone else's to post with: the board's own, another client's key, or a sync's import. */
  function ownId(caller: Caller, principal: Granted, id: string | undefined) {
    if (!fromRequest(caller) || id === undefined) return
    if (DERIVED_ID.test(id)) throw badRequest("id: UUIDv8s are the board's own, for the writes it makes itself")
    // A client elsewhere derives its posts' IDs from its key, under its own principal, so no
    // one else can post with one first and make its retry fail.
    if (id.startsWith('key:') && !isKeyIdOf(id, principal.id)) throw badRequest(`id: key:… IDs derive from a client's key, and this token's are key:${principal.id}:…`)
    // Nor with one a sync's import lands with (`importId`), which anyone can work out.
    if (id.startsWith('sync:')) throw badRequest('id: sync:… IDs are what sync imports, under the principal that imports them')
  }

  /** A post as it lands: what the caller may post, with the files it may have. */
  async function postNow(caller: Caller, identity: Identity, parsed: Protocol['post']['input']): Promise<Protocol['post']['output']> {
    const { principal } = identity
    withinLimits(parsed)
    const body = { ...parsed, re: parsed.re === undefined ? undefined : messageAt(parsed.re) }
    const proofs = await authorizePost(writes, principal.access, body)
    ownId(caller, principal, body.id)
    const attachments = await attachmentsFor(principal, body.attachments)
    const { schedule } = caller.origin
    const message = await writePost(writes, {
      attachments,
      identity,
      proofs,
      channel: body.channel,
      re: body.re,
      text: body.text,
      labels: body.labels,
      noSync: body.noSync,
      id: body.id,
      sync: body.sync,
      after: afterAt(body.after),
      // A schedule's send, which only this board's own schedules make.
      ...(schedule && !fromRequest(caller) ? { schedule } : {}),
    })
    return { message }
  }

  /**
   * The sync entry an import says it came through, when it names one: one its caller syncs, or a
   * 403. This board's own sync's, or what a sync elsewhere registered.
   */
  async function checkSource(caller: Caller, principal: string, source: { key: string } | undefined) {
    if (source && !(await entriesOf(caller, principal)).some((entry) => entry.key === source.key))
      throw forbidden(`this token doesn't sync ${source.key} here: its board registers its sync entries`)
  }

  const methods: ProtocolMethods = {
    async discovery() {
      // As its own code sees it: board() answers a request with who the board is to it, the URL it
      // reached and the project tokens are minted for. Its own code reaches it in process when
      // nothing says where else.
      const url = binding.url() ?? (ownHandle ??= binding.handle(OWN)).url
      const { id, teamId } = await binding.project()
      const body: Discovery = {
        version: VERSION,
        url,
        audience: url,
        team_id: teamId,
        project_id: id,
        // Its own sync's entries, and those of the syncs registered here.
        sync: await syncEntries(),
      }
      return body
    },
    async me(caller) {
      const { principal, author, actor } = (await identityOf(caller))
      const body: Me = {
        actor: actor.id,
        principal: principal.id,
        kind: actor.kind,
        handle: actor.handle,
        name: actor.name,
        avatar: actor.avatar,
        profile: author.profile,
        ...(actor.via ? { via: { ...actor.via } } : {}),
        expiresAt: principal.expiresAt?.toISOString() ?? null,
        can: principal.access.summary(),
      }
      return body
    },
    async channels(caller, { prefix, after, limit = CHANNELS_LIMIT_DEFAULT }) {
      const { principal } = (await identityOf(caller))
      const { state, index } = await session.state(channelsReducer)
      // By path, and a page after the last path of the one before it.
      const listed = Object.values(state)
        .filter((channel) => principal.access.readable(channel.path) && (prefix === undefined || channel.path.startsWith(prefix)) && (after === undefined || channel.path > after))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      const channels = listed.slice(0, limit)
      return { channels, cursor: ref(index), next: listed.length > limit ? channels.at(-1)!.path : null }
    },
    async createChannel(caller, { path }) {
      return writeChannel(writes, { identity: await identityOf(caller), path })
    },
    async actors(caller, { id: only }) {
      const { principal, actor } = (await identityOf(caller))
      const { state, index } = await session.state(actorsReducer)
      // A reader of every channel sees everyone; anyone else, who wrote, was mentioned by ID, or reacted where they read, and themselves.
      let seen: ((id: string) => boolean) | null = null
      if (!principal.access.readsAll) {
        const ids = await actorsIn(principal.access)
        ids.add(actor.id)
        seen = (id) => ids.has(id)
      }
      const wanted = only ? new Set(only) : null
      const actors = (wanted ? [...wanted].flatMap((id) => (Object.hasOwn(state.byId, id) ? [state.byId[id]!] : [])) : Object.values(state.byId))
        .filter((a) => seen === null || seen(a.id))
        .sort((a, b) => a.handle.localeCompare(b.handle))
        .map((found) => {
          const { host: _host, via: _via, ...a } = found
          const via = viaOfRecord(found)
          return { ...a, ...(via ? { via } : {}), ...(verifiedRecord(found) ? { verified: true as const } : {}) }
        })
      return { actors, cursor: ref(index) }
    },
    async channelMessages(caller, query) {
      const { principal } = (await identityOf(caller))
      const { state: actors } = await session.state(actorsReducer)
      const { filter, through } = await readable({ channel: { path: query.channel, subtree: false } }, principal.access)
      const limit = query.limit ?? 50
      const { messages, position } = await reads.messages(filter, {
        ...(query.after !== undefined ? { after: cursorAt(query.after) } : {}),
        limit,
      })
      const reader = await reads.reader(principal.access, messages)
      // A page after a cursor that its limit cut short stops at its last message, so reading on from its cursor
      // reaches the rest; any other has all there is, up to where the board is now.
      const stopped = query.after !== undefined && messages.length === limit ? messages.at(-1)!.id : position
      return { messages: messages.map((m) => view(m, actors, reader)), cursor: ref(Math.min(stopped, through)) }
    },
    async threads(caller, query) {
      const { principal, actor } = (await identityOf(caller))
      const { state: actors } = await session.state(actorsReducer)
      const { filter, through } = await readable(toMessageFilter(query, { me: { id: actor.id, handle: actor.handle }, actors, access: principal.access }), principal.access)
      const { threads, position, older } = await reads.threads(filter, {
        ...(query.after !== undefined ? { after: cursorAt(query.after) } : {}),
        ...(query.before !== undefined ? { before: olderAt(query.before) } : {}),
        limit: query.limit ?? 50,
      })
      const reader = await reads.reader(principal.access, threads.flatMap((t) => (t.last ? [t.root, t.last] : [t.root])))
      return {
        threads: threads.map((t) => ({ message: view(t.root, actors, reader), replies: t.replies, last: t.last && view(t.last, actors, reader) })),
        cursor: ref(Math.min(position, through)),
        ...(older !== undefined ? { older: older && olderRef(older) } : {}),
      }
    },
    async message(caller, { id, after, limit }, signal) {
      const { principal } = (await identityOf(caller))
      const at = messageAt(id)
      const message = await reads.message(at, signal)
      if (!message || !principal.access.readable(message.channel)) throw notFound(`message not found: #${at}`, 'message_not_found')
      const [{ messages, cursor }, { state: actors }] = await Promise.all([reads.thread(message.re ?? message.id, signal), session.state(actorsReducer)])
      const [root, ...all] = messages
      // The replies after one of its messages, the first `limit` of them; or with no message, the newest.
      const from = after === undefined ? 0 : messages.findIndex((each) => each.id === messageAt(after))
      if (from === -1) throw new HttpError(400, 'invalid_request', `after: ${after} isn't a message of this thread`)
      const rest = all.slice(from)
      const replies = limit === undefined ? rest : after === undefined ? rest.slice(-limit) : rest.slice(0, limit)
      const reader = await reads.reader(principal.access, messages)
      return {
        message: view(root!, actors, reader),
        replies: replies.map((reply) => view(reply, actors, reader)),
        cursor: ref(cursor),
        schedules: await schedules.forThread(root!.id),
      }
    },
    async posted(caller, { id }, signal) {
      const identity = (await identityOf(caller))
      const landed = await reads.byEventId(id, signal)
      const shown = landed ? await landedFor(writes, identity, landed) : null
      if (!shown) throw notFound(`no post of yours has id ${id}`, 'post_not_found')
      return { message: shown }
    },
    async post(caller, parsed) {
      return postNow(caller, await identityOf(caller), parsed)
    },
    async edit(caller, { id, text, revision }) {
      withinLimits({ text })
      const identity = await identityOf(caller)
      const authorized = await authorizeOwn(writes, identity, messageAt(id), 'edit')
      await writeEdit(writes, { identity, authorized, text, revision })
      return { ok: true as const }
    },
    async delete(caller, { id, revision }) {
      const identity = (await identityOf(caller))
      const authorized = await authorizeOwn(writes, identity, messageAt(id), 'delete')
      await writeDelete(writes, { identity, authorized, revision })
      return { ok: true }
    },
    async react(caller, { id, emoji, remove }) {
      const identity = (await identityOf(caller))
      const authorized = await authorizeMessage(writes, identity.principal.access, 'react', messageAt(id))
      await writeReaction(writes, { identity, authorized, emoji, remove })
      return { ok: true }
    },
    async label(caller, { id, set, unset, if: expected }) {
      const identity = (await identityOf(caller))
      const authorized = await authorizeMessage(writes, identity.principal.access, 'label', messageAt(id))
      await writeLabels(writes, { identity, authorized, set, unset, if: expected })
      return { ok: true }
    },
    async schedule(caller, parsed) {
      withinLimits(parsed)
      const identity = (await identityOf(caller))
      const body = { ...parsed, re: parsed.re === undefined ? undefined : messageAt(parsed.re) }
      // Checked now, where the caller sees it, and again at every send.
      await authorizePost(writes, identity.principal.access, body)
      const attachments = await attachmentsFor(identity.principal, body.attachments)
      return schedules.create(identity, body, attachments)
    },
    async schedules(caller, query) {
      const { principal, actor } = (await identityOf(caller))
      let root: number | undefined
      if (query.re !== undefined) {
        const at = messageAt(query.re)
        root = (await authorizeMessage(writes, principal.access, 'read', at)).message.re ?? at
      }
      const visible = (schedule: Schedule) => principal.access.readable(schedule.channel) || createdBy(schedule, { principal, actor })
      // `me` is the caller, as it is on Vercel's board.
      const by = query.by === 'me' ? actor.id : query.by
      return { schedules: (await schedules.list({ ...query, ...(by !== undefined ? { by } : {}), ...(root !== undefined ? { root } : {}) }, visible)).map((schedule) => blindSchedule(schedule, principal.access, actor.id)) }
    },
    async cancelSchedule(caller, { id }) {
      const identity = await identityOf(caller)
      const answer = await schedules.cancel(identity, scheduleAt(id))
      return { ...answer, schedule: blindSchedule(answer.schedule, identity.principal.access, identity.actor.id) }
    },
    tasks: async (caller, query) => tasks.list(await identityOf(caller), query),
    async createTask(caller, body) {
      // A new thread's root is a message, within what this board holds of one, and a task within what it holds of those.
      if (body.re === undefined) withinLimits({ text: body.text ?? '', attachments: body.attachments })
      taskLimits.needs(body.needs)
      taskLimits.lease(body.lease)
      const identity = await identityOf(caller)
      const { principal } = identity
      const about = { needs: body.needs, for: body.for, claim: body.claim, lease: body.lease, token: body.token }
      if (body.re !== undefined) return tasks.adopt(identity, messageAt(body.re), about)
      // A new thread, posted as any is: `post` where it lands, and `label` for the labels it carries.
      const proofs = await authorizePost(writes, principal.access, { channel: body.channel, labels: body.labels })
      ownId(caller, principal, body.id)
      const attachments = await attachmentsFor(principal, body.attachments)
      const made = tasks.starting(identity, { channel: body.channel!, ...about })
      const task = await writePost(writes, { attachments, identity, proofs, channel: body.channel, text: body.text ?? '', labels: body.labels, noSync: body.noSync, id: body.id, with: made.along })
      // A retry gets back the post that landed with its ID: one that was no task's is another write's.
      if (!task.task) throw duplicateId()
      const claim = await made.claimed(messageAt(task.id))
      return { task, ...(claim ? { claim } : {}) }
    },
    async createTasks(caller, body) {
      // This board's own limits on a batch, and on each task's root as on any message.
      taskLimits.batch(body.tasks)
      for (const [at, task] of body.tasks.entries()) {
        if (task.text.length > MESSAGE_TEXT_MAX) throw textTooLong()
        if ((task.attachments?.length ?? 0) > ATTACHMENTS_PER_MESSAGE_MAX) throw badRequest(`tasks.${at}.attachments: a message carries at most ${ATTACHMENTS_PER_MESSAGE_MAX}`)
      }
      const identity = await identityOf(caller)
      const { principal } = identity
      // New threads, posted as any are: `post` where they land, and `label` when any carries labels.
      const proofs = await authorizePost(writes, principal.access, { channel: body.channel, labels: body.tasks.find((task) => Object.keys(task.labels ?? {}).length > 0)?.labels })
      ownId(caller, principal, body.id)
      const made = tasks.startingMany(identity, body.tasks)
      // A batch's `id` names its roots in order, so a retry finds the ones that landed. They're the board's own IDs, which no request posts with.
      const rootId = (at: number) => (body.id !== undefined ? batchRoot(body.id, at) : Promise.resolve(crypto.randomUUID()))
      const roots = await Promise.all(
        body.tasks.map(async (task, at) => ({ id: await rootId(at), text: task.text, labels: task.labels, noSync: task.noSync, attachments: await attachmentsFor(principal, task.attachments) })),
      )
      // The same `id` again is the same batch only for the same request, as board() gave it: the event after the first
      // root keeps that, in its ID. board() answers a retry before it gets here; two first calls at once meet in the write.
      const { id } = body
      const asked = id !== undefined ? await batchAsked(id, body.request ?? '') : undefined
      const again = id !== undefined && asked !== undefined ? { asked, landed: () => landedBatch(writes, identity, (at) => batchRoot(id, at), asked) } : undefined
      return { tasks: await writeRoots(writes, { identity, proofs, channel: body.channel, roots, with: made, again }) }
    },
    async createdTasks(caller, { id, request }) {
      const identity = await identityOf(caller)
      const found = await landedBatch(writes, identity, (at) => batchRoot(id, at), request !== undefined ? await batchAsked(id, request) : undefined)
      if ('tasks' in found) return found
      // Someone else's batch is none of the caller's, as a post is. Its own, made for another request, is another write's.
      if (found.not === 'asked') throw duplicateId()
      throw notFound(`no batch of yours has id ${id}`, 'batch_not_found')
    },
    async claimReadyTask(caller, body, signal) {
      taskLimits.lease(body.lease)
      taskLimits.from(body.from)
      return tasks.claimReady(await identityOf(caller), body, signal)
    },
    async claimTask(caller, { id, lease, token }) {
      taskLimits.lease(lease)
      return tasks.claim(await identityOf(caller), messageAt(id), lease, token)
    },
    async renewTask(caller, { id, epoch, token, lease }) {
      taskLimits.lease(lease)
      return tasks.renew(await identityOf(caller), messageAt(id), { epoch, token }, lease)
    },
    releaseTask: async (caller, { id, epoch, token }) => tasks.settle(await identityOf(caller), messageAt(id), { epoch, token }, { type: 'task.released' }),
    async completeTask(caller, { id, epoch, token, result }) {
      taskLimits.note('result', result)
      return tasks.settle(await identityOf(caller), messageAt(id), { epoch, token }, { type: 'task.completed', result: result ?? null })
    },
    async failTask(caller, { id, epoch, token, reason }) {
      taskLimits.note('reason', reason)
      return tasks.settle(await identityOf(caller), messageAt(id), { epoch, token }, { type: 'task.failed', reason })
    },
    async blockTask(caller, { id, reason, kind, epoch, token }) {
      taskLimits.note('reason', reason)
      taskLimits.kind(kind)
      return tasks.block(await identityOf(caller), messageAt(id), { reason, kind, ...(epoch !== undefined && token !== undefined ? { proof: { epoch, token } } : {}) })
    },
    unblockTask: async (caller, { id }) => tasks.unblock(await identityOf(caller), messageAt(id)),
    reopenTask: async (caller, { id }) => tasks.reopen(await identityOf(caller), messageAt(id)),
    assignTask: async (caller, { id, for: actor }) => tasks.assign(await identityOf(caller), messageAt(id), actor),
    async setTaskNeeds(caller, { id, needs }) {
      taskLimits.needs(needs)
      return tasks.needs(await identityOf(caller), messageAt(id), needs)
    },
    async cancelTask(caller, { id, reason }) {
      taskLimits.note('reason', reason)
      return tasks.cancel(await identityOf(caller), messageAt(id), reason)
    },
    grants: async (caller) => access.grants(await identityOf(caller)),
    createGrant: async (caller, body) => access.createGrant(await identityOf(caller), body),
    createGrants: async (caller, body) => access.createGrants(await identityOf(caller), body),
    updateGrant: async (caller, input) => access.updateGrant(await identityOf(caller), input),
    explain: async (caller, query) => access.explain(await identityOf(caller), query),
    revokeGrant: async (caller, input) => access.revokeGrant(await identityOf(caller), input),
    // Anyone board() let in reads the schemas: they say what anyone posting has to send.
    schemas: async () => schemaRegistry.schemas(),
    schema: async (_caller, input) => schemaRegistry.schema(input),
    createSchema: async (caller, body) => schemaRegistry.createSchema(await identityOf(caller), body),
    async upload(caller, { data, name, type }) {
      const { principal } = (await identityOf(caller))
      // A file is no use until a post or an import carries it, so uploading needs `post` or `sync` somewhere.
      if (!principal.access.anywhere('post') && !principal.access.anywhere('sync')) throw forbidden("this token can't post anywhere, so it can't upload")
      // Sync's own imports are fetched in this process, with no request to fit under, so they may be bigger.
      const max = ownSync(caller) ? IMPORT_BYTES_MAX : ATTACHMENT_BYTES_MAX
      return { attachment: await writeUpload(blob, { data, name, type, uploadedBy: principal.id }, max) }
    },
    async uploadStart(caller, { name, type, size }) {
      const { principal } = (await identityOf(caller))
      if (!principal.access.anywhere('post') && !principal.access.anywhere('sync')) throw forbidden("this token can't post anywhere, so it can't upload")
      return startUpload(blob, { name: name ?? null, type: type ?? null, size, uploadedBy: principal.id })
    },
    async uploadFinish(caller, { id }) {
      const { principal } = (await identityOf(caller))
      return { attachment: await finishUpload(blob, id, principal) }
    },
    async attachment(caller, { id }) {
      const { principal } = (await identityOf(caller))
      const { attachment, ...uploader } = await readUpload(blob, id)
      if (!(await attachmentReadable(principal, attachment.id, uploader))) throw attachmentNotFound(attachment.id)
      return { attachment, data: await attachmentBody(blob, attachment.id) }
    },
    async watchers(caller) {
      const { principal } = (await identityOf(caller))
      // Each names a board's URL and tails: all of them only for `manage` in every channel, the caller's own for anyone.
      const all = await registry.list()
      return { watchers: principal.access.everywhere('manage') ? all : all.filter((found) => found.owner === principal.id) }
    },
    async register(caller, body) {
      // This board wakes nothing: a registrant pulls its matches. A path wakes the caller's own Vercel project, which only Vercel's board can.
      if (body.path) throw new HttpError(501, 'no_wake_by_path', "this board wakes nothing: register no path, and pull your matches")
      if (body.url) throw new HttpError(501, 'no_wake_by_url', "this board wakes nothing: register no url, and pull your matches")
      const { principal } = (await identityOf(caller))
      ownWatchers(principal)
      // A registered watcher sees only what its registrant may read.
      if (!principal.access.anywhere('read'))
        throw forbidden("this token can't read anywhere, so a watcher it registers would see nothing")
      // A sync's entries speak for platform users, and discovery lists them: only for one that may sync.
      if ((body.sync?.length ?? 0) > 0 && !principal.access.anywhere('sync')) throw forbidden("this token can't register a sync: it needs sync somewhere")
      // A key names one sync's platform locations: this board's own sync's keys are its own.
      const taken = body.sync?.find((entry) => binding.sync.some((own) => own.key === entry.key))
      if (taken) throw new HttpError(409, 'sync_key_taken', `this board's own sync has sync entry ${taken.key}: give yours another key`)
      if (Object.keys(body.watch).length > REGISTERED_WATCHERS_MAX)
        throw badRequest(`a registration holds at most ${REGISTERED_WATCHERS_MAX} watchers`, 'too_many_watchers')
      for (const [id, spec] of Object.entries(body.watch)) {
        const name = RemoteWatcherId.safeParse(id)
        if (!name.success) throw badRequest(`watch ${id}: ${name.error.issues[0]!.message}`, 'bad_watcher')
        try {
          compileWatcher(id, spec)
        } catch (error) {
          throw badRequest((error as Error).message, 'bad_watcher')
        }
      }
      return registry.register(storedPrincipal(principal), { url: null, watch: body.watch, sync: body.sync ?? [] })
    },
    async matches(caller, query, signal) {
      const { principal } = (await identityOf(caller))
      ownWatchers(principal)
      if (!(await registry.state()).byOwner[principal.id]) throw notFound('this token has no watchers registered here', 'no_registration')
      const queue = queueOf(principal.id) as unknown as QueueSession
      const pulling = { access: principal.access, limit: query.limit ?? 10 }
      const deadline = Date.now() + (query.wait ?? 0) * 1000
      for (let pause = 100; ; pause = Math.min(pause * 2, 1000)) {
        const matches = await pull(queue, { ...pulling, now: Date.now() })
        if (matches.length > 0) {
          // Each was made for what its registrant could read when it matched: its links show what it may read now.
          const reader = await reads.readerOf(principal.access, matches.flatMap((match) => viewLinkedIds(match.event)))
          return { matches: matches.map((match) => ({ ...match, event: viewedBy(match.event, reader) })) }
        }
        if (Date.now() >= deadline || signal.aborted) return { matches }
        await new Promise((resolve) => setTimeout(resolve, Math.min(pause, Math.max(0, deadline - Date.now()))))
      }
    },
    async ack(caller, { id, ...body }) {
      const { principal } = (await identityOf(caller))
      ownWatchers(principal)
      const result = await ack(queueOf(principal.id) as unknown as QueueSession, id, body, { now: Date.now() })
      if (result === 'gone') throw notFound(`no match ${id} is waiting for this token`, 'no_match')
      if (result === 'stale') throw new HttpError(409, 'stale_lease', 'that lease ran out, and the match was pulled again')
      return { ok: true }
    },
    async events(caller, query, signal) {
      const { principal, actor } = (await identityOf(caller))
      const after = query.after !== undefined ? cursorAt(query.after) : undefined
      const { state: actors } = await session.state(actorsReducer)
      const feed = { session, reads, after, filters: query, all: query.all ?? false, me: { id: actor.id, handle: actor.handle }, actors, access: principal.access }
      const { events, cursor } = query.last !== undefined ? await lastFeed(feed, query.last, signal) : await pollFeed(feed, (query.wait ?? 0) * 1000, signal)
      return { events, cursor: ref(cursor) }
    },

    async typing(caller, { id, status }, signal) {
      // Typing is a reply about to come: `post` where the thread is, and the sync that runs here shows it.
      const { principal } = await identityOf(caller)
      const found = await reads.message(messageAt(id), signal)
      if (!found || found.deleted || !principal.access.readable(found.channel)) throw notFound(`message not found: #${id}`, 'message_not_found')
      if (!principal.access.can('post', found.channel)) throw forbidden(`this token can't post in ${found.channel}`)
      const { message, replies } = await methods.message(caller, { id }, signal)
      return { targets: await binding.typing([message, ...replies], status) }
    },
    async readSource(caller, { key, target, limit, after }) {
      // Only the board that runs a sync entry has its platform's app to read with.
      if (!binding.sync.some((entry) => entry.key === key)) throw notFound(`this board doesn't run sync entry ${key}: read it where its sync runs`, 'not_synced_here')
      // The app's token reads what the app can, not what the caller can.
      const { principal } = await identityOf(caller)
      if (!principal.access.everywhere('manage')) throw forbidden("this token can't read a source: it needs manage in every channel")
      unnarrowed(principal, 'read a source')
      return binding.readSource(key, target, limit ?? 50, after ?? null)
    },
    async joinSource(caller, { key, target }) {
      if (!binding.sync.some((entry) => entry.key === key)) throw notFound(`this board doesn't run sync entry ${key}: join it where its sync runs`, 'not_synced_here')
      const { principal } = await identityOf(caller)
      if (!principal.access.everywhere('manage')) throw forbidden("this token can't join a source: it needs manage in every channel")
      unnarrowed(principal, 'join a source')
      return binding.joinSource(key, target)
    },
    async synced(caller, { id }, signal) {
      const { principal } = await identityOf(caller)
      const message = await reads.message(messageAt(id), signal)
      if (!message || !principal.access.readable(message.channel)) throw notFound(`message not found: #${id}`, 'message_not_found')
      await reads.ensure(undefined, signal)
      const { tables } = store
      const [thread, copies] = await Promise.all([tables.syncOf(message.thread), tables.copiesOf([message.id])])
      const mine = copies.get(message.id) ?? {}
      const targets = await Promise.all(
        (thread?.targets ?? []).map(async (target) => {
          const key = target.slice(0, target.indexOf(':'))
          const external = (thread && Object.hasOwn(thread.external, target) ? thread.external[target] : undefined) ?? null
          // A message that came from a platform thread is recorded by that thread, not by the channel it's in.
          const copy = (Object.hasOwn(mine, target) ? mine[target] : external !== null && Object.hasOwn(mine, external) ? mine[external] : undefined) ?? null
          return {
            target,
            key,
            thread: copy?.thread ?? external,
            message: copy?.message ?? null,
            url: copy ? await binding.linkOf(key, copy.thread, copy.message) : null,
            undelivered: Object.hasOwn(message.undelivered, target) ? message.undelivered[target]! : null,
          }
        }),
      )
      return { targets }
    },
    async linked(caller, { url }, signal) {
      // The platform is never asked: a link no entry here knows, one to nothing the board synced, and
      // one to a message the caller can't read are the same 404, so none says what's out of sight.
      const missing = () => notFound('no message on this board for that link', 'message_not_found')
      const read = binding.locate(url)
      if (read.length === 0) throw missing()
      await reads.ensure(undefined, signal)
      const { tables } = store
      // Any sync of that platform may have synced it, each under its own key: this board's, and those registered here.
      const registered = Object.values((await registry.state()).byOwner).flatMap((registration) => registration.sync)
      const keysOf = (platform: string) => new Set([...binding.sync, ...registered].filter((entry) => entry.platform === platform).map((entry) => entry.key))
      const first = async (): Promise<number | null> => {
        for (const { platform, thread, message } of read)
          for (const key of keysOf(platform)) {
            let found: number | null
            if (message !== null) found = await tables.messageOf(`${key}:${thread}`, message)
            else {
              const at = await tables.threadOf(`${key}:${thread}`)
              found = at === null ? null : ((await tables.syncOf(at))?.root ?? null)
            }
            if (found) return found
          }
        return null
      }
      const id = await first()
      if (id === null) throw missing()
      try {
        return await methods.message(caller, { id: ref(id) }, signal)
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) throw missing()
        throw error
      }
    },

    // Sync's records. A caller with `sync` in a channel speaks for platform users there.

    async syncImport(caller, body, signal) {
      const { principal } = (await needSync(caller, 'import', true))
      // Only a user of a sync key it has, never anyone this board signs in.
      // The platform users its text mentions are checked as its author is: each is who they'd be had they written.
      const mentioned = body.op === 'post' || body.op === 'edit' ? (body.mentioned ?? []) : []
      const [platform, ...platforms] = (await speaksFor(caller, principal.id, [body.author, ...mentioned], body.from)) as [string, ...string[]]
      const author = externalIdentity(body.author, ownSync(caller) ? null : principal, platform)
      const may = (channel: string) => principal.access.can('sync', channel)
      // A mention of one of its keys' users is of the platform user as this import names them: its own profile of them.
      const keys = ownSync(caller) ? [] : (await entriesOf(caller, principal.id)).map(({ key }) => key)
      // Where that would take the text past what a message holds, it stays as it came: sync still finds who a short ID names.
      const asNamed = (text: string) => {
        if (keys.length === 0) return text
        const named = replaceMentions(text, (token) => (token.kind === 'actor' && keys.some((key) => token.actor.startsWith(`${key}:`)) ? `@[${principal.id}+${token.actor}]` : null))
        return named.length > MESSAGE_TEXT_MAX ? text : named
      }
      const introduces = mentioned.map((user, at) => externalIdentity(user, ownSync(caller) ? null : principal, platforms[at]!).actor)
      if (body.op === 'post') {
        if ((body.channel === undefined) === (body.re === undefined)) throw badRequest('an import needs `channel`; a reply needs `re`')
        let re: number | undefined
        let root: Message | null = null
        let channel = body.channel
        if (body.re !== undefined) {
          re = messageAt(body.re)
          root = await reads.message(re)
          if (!root || !principal.access.readable(root.channel)) throw notFound(`message not found: #${body.re}`, 'message_not_found')
          channel = root.channel
        }
        if (!may(channel!)) throw forbidden(`this token can't sync in ${channel}, so it can't import there`)
        const id = body.id === undefined ? undefined : importId(caller, principal.id, body.id)
        const attachments = await attachmentsFor(principal, body.attachments)
        const commit = async ({ text, labels }: { text: string; labels: Labels }) => {
          const proofs = await trusted.post(writes, { channel: body.channel, re, labels })
          const posted = await writePost(writes, {
            identity: author,
            proofs,
            channel: body.channel,
            re,
            text: asNamed(text),
            labels,
            noSync: body.noSync,
            id,
            origin: body.origin,
            from: body.from,
            // Its platform message is the copy of the sync that imported it.
            ...(body.origin && !ownSync(caller) ? { importedBy: principal.id } : {}),
            after: afterAt(body.after),
            attachments,
            links: await linksOf(principal, body.links),
            introduces,
          })
          return posted.id
        }
        const write = { text: body.text, labels: body.labels ?? {} }
        // A retry of one that landed: it stands.
        if (id !== undefined && (await reads.byEventId(id, signal))) return { message: await commit(write) }
        if (body.origin) await claimable(body.origin, body.from, root?.thread ?? null)
        await checkSource(caller, principal.id, body.source)
        return { message: await commit(write) }
      }
      // The message it changes: found from its platform IDs, or named by its board ID. One the caller
      // can't sync is as good as missing.
      if ((body.origin === undefined) === (body.message === undefined)) throw badRequest('a change names its message by `origin` or by `message`, one or the other')
      const id = body.origin !== undefined ? await locate(body.origin) : indexOf(body.message!)
      const found = id === null || id === 0 ? null : await reads.message(id)
      if (!found || !may(found.channel)) return { message: null }
      const authorized = <P extends Permission>(permission: P) => trusted.message(writes, permission, found.id)
      // A platform's own edit or delete is what the platform did; one named by board ID is the author's, only of their own.
      const asAuthor = body.origin === undefined
      if (body.op === 'edit') {
        const proof = await authorized('post')
        const commit = async ({ text }: { text: string }) => {
          await writeEdit(writes, { identity: author, authorized: proof, text: asNamed(text), from: body.from, asAuthor, revision: body.revision, introduces })
          return ref(found.id)
        }
        const write = { kind: 'edit' as const, id: ref(found.id), channel: found.channel, re: found.re === null ? null : ref(found.re), text: body.text }
        if (!found.deleted && !(asAuthor && found.by.actor !== author.author.actor)) await checkSource(caller, principal.id, body.source)
        return { message: await commit(write) }
      }
      if (body.op === 'delete') await writeDelete(writes, { identity: author, authorized: await authorized('post'), from: body.from, asAuthor, revision: body.revision })
      else if (body.op === 'react')
        await writeReaction(writes, { identity: author, authorized: await authorized('react'), emoji: body.emoji, remove: body.remove ?? false, from: body.from })
      else if (body.op === 'labels') await writeLabels(writes, { identity: author, authorized: await authorized('label'), set: body.set, unset: body.unset, if: body.if })
      else await writeLinks(writes, { identity: author, authorized: await authorized('post'), links: (await linksOf(principal, body.links)) ?? [], from: body.from })
      return { message: ref(found.id) }
    },

    async syncReceipt(caller, body) {
      // A message the caller can't read is missing; one it can, but can't sync, is a 403.
      const identity = (await identityOf(caller))
      unnarrowed(identity.principal, 'record what it synced')
      const authorized = await authorizeMessage(writes, identity.principal.access, 'sync', messageAt(body.message))
      const { message } = authorized
      if (body.kind === 'thread')
        return { ok: true, ...(await writeAttach(writes, { identity, authorized, target: { target: body.target, kind: body.targetKind }, cause: body.cause })) }
      await deliverable(caller, identity.principal.id, message, body.target, body.kind === 'message' ? body.external : undefined)
      const about = { id: message.id, thread: message.thread, target: body.target }
      // A copy is the sync's that made it: a sync elsewhere's is named, and only it sees it.
      const by = ownSync(caller) ? {} : { syncedBy: identity.principal.id }
      if (body.kind === 'message')
        await receipt(caller, `receipt:${message.id}:${body.target}`, [
          { type: 'message.synced', payload: { ...about, external: body.external, ...by } },
          ...(body.files !== undefined ? [{ type: 'message.files_synced' as const, payload: { ...about, files: body.files, ...by } }] : []),
        ])
      else if (body.kind === 'files') await receipt(caller, `files:${message.id}:${body.target}`, [{ type: 'message.files_synced', payload: { ...about, files: body.files, ...by } }])
      else await receipt(caller, `failed:${message.id}:${body.target}`, [{ type: 'message.sync_failed', payload: { ...about, error: body.error } }])
      return { ok: true }
    },

    async syncThread(caller, { thread }) {
      const { principal } = (await needSync(caller, 'look up a sync'))
      await reads.ensure()
      const synced = await store.tables.syncOf(thread)
      if (!synced || !principal.access.can('sync', synced.channel)) throw notFound(`no thread ${thread} on this board`, 'thread_not_found')
      return { thread, root: ref(synced.root), channel: synced.channel, targets: [...synced.targets], external: { ...synced.external } }
    },

    async syncFind(caller, query, signal) {
      const { principal } = (await needSync(caller, 'look up a sync'))
      const { tables } = store
      let thread: string | null = null
      let message: string | null = null
      if (query.post !== undefined) {
        // An import the caller's sync made: a retry's, found before it goes through the middleware again.
        const landed = await reads.byEventId(importId(caller, principal.id, query.post), signal)
        if (landed && principal.access.can('sync', landed.channel)) message = ref(landed.id)
      }
      if (query.thread !== undefined) {
        // A thread synced just now may not be in the tables yet: a miss waits for them.
        let key = query.message === undefined ? await tables.threadOf(query.thread) : null
        if (key === null) {
          await reads.ensure(undefined, signal)
          key = await tables.threadOf(query.thread)
        }
        const synced = key === null ? null : await tables.syncOf(key)
        if (synced && principal.access.can('sync', synced.channel)) thread = key
        if (query.message !== undefined) {
          const id = await tables.messageOf(query.thread, query.message)
          const found = id === null ? null : await tables.message(id)
          if (found && principal.access.can('sync', found.channel)) message = ref(found.id)
        }
      }
      return { thread, message }
    },

    async syncCopies(caller, query) {
      const { principal } = (await needSync(caller, 'look up a sync'))
      await reads.ensure()
      const ids = [...new Set(query.message.map(indexOf).filter((id) => id !== null && id > 0))] as number[]
      // Only the messages the caller may sync, which for one that syncs everywhere is all of them.
      const everywhere = principal.access.everywhere('sync')
      const [copies, messages] = await Promise.all([
        store.tables.copiesOf(ids),
        everywhere ? null : store.tables.messagesAt(ids, await store.tables.position()),
      ])
      // And of those, only its own sync's copies: a sync changes what it posted, never another's
      // under a key they share, whose platform app it isn't.
      const own = ownSync(caller)
      const mine = (copy: ExternalCopy) => (own ? copy.by === undefined : copy.by === principal.id)
      const out: Record<string, Record<string, ExternalCopy>> = {}
      for (const id of ids) {
        const found = messages?.get(id)
        if (everywhere || (found && principal.access.can('sync', found.channel)))
          out[ref(id)] = Object.fromEntries(Object.entries(copies.get(id) ?? {}).filter(([, copy]) => mine(copy)).map(([target, { by: _by, ...copy }]) => [target, copy]))
      }
      return { copies: out }
    },

    async inboxPush(caller, { key, events }) {
      const { principal } = (await needSync(caller, 'push to an inbox', true))
      for (const { id } of events)
        if (id.length > INBOX_EVENT_ID_MAX) throw badRequest(`an inbox event ID is ${INBOX_EVENT_ID_MAX} characters at most, got ${id.length}`)
      for (const { event } of events)
        for (const location of [event.channel, event.thread, 'subthread' in event ? event.subthread : null])
          if (location !== null && !location.startsWith(`${key}:`)) throw badRequest(`an inbox's platform locations belong to its sync key: ${location} isn't ${key}'s`)
      if (ownSync(caller)) {
        // This board's own sync: each platform channel's inbox, delivered here on its threads' lanes.
        for (const { id, event, raw } of events) {
          await openInbox(event.channel)
          await inboxServer.session(inboxSession(event.channel)).append({
            type: 'external.received',
            id: await idempotentId('board-inbox', key, id),
            payload: { sync: key, event, raw },
          }).catch(alreadyReceived)
        }
        return { ok: true }
      }
      // A sync elsewhere: its own queue, for it to pull back.
      const queue = queueOf(principal.id)
      const matched = await Promise.all(
        events.map(async ({ id, event, raw }) => ({
          type: 'watch.matched' as const,
          id: await idempotentId('board-inbox', key, id),
          payload: { thread: event.thread, inbox: key, event: { sync: key, event, raw } },
        })),
      )
      await queue.append(...matched).catch(async (error: unknown) => {
        if (!duplicate(error)) throw error
        for (const one of matched) await queue.append(one).catch(alreadyReceived)
      })
      return { ok: true }
    },

    async inboxNext(caller, { key, limit }) {
      // This board's own sync gets its inbox delivered here.
      if (ownSync(caller)) return { items: [] }
      const { principal } = (await needSync(caller, 'pull from an inbox', true))
      const leased = await pullInbox(queueOf(principal.id) as unknown as QueueSession, key, { access: principal.access, limit: limit ?? 10, now: Date.now() })
      return {
        items: leased.map(({ id, thread, lease, attempt, event }) => {
          const item = event as { event: PlatformEvent; raw: unknown }
          return { id, key, thread, lease, attempt, event: item.event, raw: item.raw }
        }),
      }
    },

    async inboxAck(caller, { id, lease, error }) {
      const { principal } = (await needSync(caller, 'ack an inbox event', true))
      const result = await ack(queueOf(principal.id) as unknown as QueueSession, id, { lease, error }, { now: Date.now() })
      if (result === 'gone') throw notFound(`no inbox event ${id} is waiting for this token`, 'no_item')
      if (result === 'stale') throw new HttpError(409, 'stale_lease', 'that lease ran out, and the event was pulled again')
      return { ok: true }
    },

    async inbox(caller, { key, channel, limit }) {
      // Raw platform payloads. This board's own inbox, and every sync's that registered here, span every
      // channel; a caller's own pushes are its own. Sync's records, which no caller narrowed with
      // x-board-can reads, as a sandbox's policy never reaches them.
      const { principal } = (await needSync(caller, 'read an inbox', true))
      const everywhere = principal.access.everywhere('sync')
      const entries: InboxEntry[] = []
      if (everywhere) {
        const channels = channel !== undefined ? [channel] : Object.keys((await inboxes.state(inboxesReducer)).state).filter((found) => found.startsWith(`${key}:`))
        for (const found of channels)
          for (const event of await inboxServer.session(inboxSession(found)).history())
            if (event.type === 'external.received' && event.payload.sync === key)
              entries.push({ id: event.id, channel: found, createdAt: new Date(event.createdAt).toISOString(), ...event.payload } as InboxEntry)
      }
      const pushers = new Set([principal.id, ...(everywhere ? Object.keys((await registry.state()).byOwner) : [])])
      for (const pusher of pushers)
        for (const event of await queueOf(pusher).history()) {
          const pushed = event.payload as { inbox?: string; event?: { sync: string; event: PlatformEvent; raw: unknown } }
          if (event.type !== 'watch.matched' || pushed.inbox !== key || !pushed.event) continue
          if (channel !== undefined && pushed.event.event.channel !== channel) continue
          entries.push({ id: event.id, channel: pushed.event.event.channel, createdAt: new Date(event.createdAt).toISOString(), ...pushed.event } as InboxEntry)
        }
      return { events: entries.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, limit ?? 50) }
    },
  }

  /**
   * An import's client ID as the board keeps it. A sync elsewhere names its posts under its own
   * principal, so it can't take an ID anyone else would use.
   */
  function importId(caller: Caller, principal: string, id: string) {
    return ownSync(caller) ? id : `sync:${principal}:${createHash('sha256').update(`board-sync\u001f${id}`).digest('hex').slice(0, 32)}`
  }

  /**
   * The sync entries a caller imports through: this board's own sync's, or what a sync elsewhere
   * registered, but for a key this board's own sync has since taken: its platform locations are
   * that sync's alone.
   */
  async function entriesOf(caller: Caller, principal: string): Promise<readonly SyncEntrySpec[]> {
    if (ownSync(caller)) return binding.sync
    return ((await registry.state()).byOwner[principal]?.sync ?? []).filter((entry) => !binding.sync.some((own) => own.key === entry.key))
  }

  /**
   * The sync entries this board lists in its discovery: its own sync's, then those of the syncs
   * registered here that may still sync. A key its own sync has is its own.
   */
  async function syncEntries(): Promise<SyncEntrySpec[]> {
    const found = new Map<string, SyncEntrySpec>()
    for (const { key, platform } of binding.sync) found.set(key, { key, platform })
    for (const registration of Object.values((await registry.state()).byOwner)) {
      if (registration.sync.length === 0) continue
      if (!(await binding.accessNow(registration.principal))?.anywhere('sync')) continue
      for (const { key, platform } of registration.sync) if (!found.has(key)) found.set(key, { key, platform })
    }
    return [...found.values()]
  }

  /**
   * Whether a caller may write as each of `users`, and the platform of the sync key each is a user
   * of: a platform user, never anyone this board signs in, named under a key it syncs
   * (`slack-eu:…`): entry `from`, when it names one. An import's author, and who its text mentions.
   */
  async function speaksFor(caller: Caller, principal: string, users: readonly { id: string }[], from: string | null): Promise<string[]> {
    const signs = await signedIn()
    for (const { id } of users) if (authenticates(id) || signs(id)) throw forbidden(`${id} is someone this board signs in, not a platform user: sync can't write as them`)
    const entries = await entriesOf(caller, principal)
    const keys = from === null ? entries : entries.filter((entry) => entry.key === from)
    if (from !== null && keys.length === 0) throw forbidden(`this token doesn't sync ${from} here: its board registers its sync entries`)
    return users.map(({ id }) => {
      const entry = keys.find(({ key }) => id.startsWith(`${key}:`))
      if (!entry) throw forbidden(`${id} isn't a user of ${keys.length ? keys.map(({ key }) => key).join(' or ') : 'a sync key this token has'}: their ID starts with its key`)
      return entry.platform
    })
  }

  /**
   * Whether an ID is someone this board signs in that `authenticates` can't tell by its shape: a
   * host's principal, which may take any ID and kind, and their agents (`<principal>+<profile>`).
   * It is once it has registered (its watchers write as `<principal>+<id>`, which never wakes
   * them), or written: the board records a host's principals and their profiles as the host's,
   * whatever their kind, and anything else that writes as other than a platform user.
   */
  async function signedIn(): Promise<(id: string) => boolean> {
    const owners = (await registry.state()).byOwner
    const { state: actors } = await session.state(actorsReducer)
    return (id) => {
      const plus = id.indexOf('+')
      if (owners[id] || (plus > 0 && owners[id.slice(0, plus)])) return true
      return [id, plus > 0 ? id.slice(0, plus) : null].some((known) => {
        const actor = known === null ? undefined : actors.byId[known]
        return actor !== undefined && (actor.kind !== 'external' || actor.host === true)
      })
    }
  }

  /**
   * Refuses a caller narrowed with `x-board-can` (a sandboxed agent, say): its principal's
   * watchers are one registration, which its project registers and runs with the token it
   * narrowed. A narrowed pull would take matches from it, and a narrowed register replace it.
   */
  function ownWatchers(principal: Granted) {
    if (principal.scope !== undefined) throw forbidden("this token is narrowed with x-board-can: registering and running watchers is its project's job")
  }

  /**
   * The caller, when it may sync somewhere: what every sync route needs. `records`: what it does
   * keeps sync's records (imports, receipts, its inbox, links), which only an integration does,
   * never a caller narrowed with `x-board-can`.
   */
  async function needSync(caller: Caller, what: string, records = false): Promise<Identity> {
    const identity = await identityOf(caller)
    if (!identity.principal.access.anywhere('sync')) throw forbidden(`this token can't ${what}: it needs sync`)
    if (records) unnarrowed(identity.principal, what)
    return identity
  }

  /**
   * Refuses a caller narrowed with `x-board-can` what its principal's sync does: a platform
   * thread or message it claimed for a channel in its scope would bring that sync's later events
   * there, from wherever on the platform they are.
   */
  function unnarrowed(principal: Granted, what: string) {
    if (principal.scope !== undefined) throw forbidden(`this token is narrowed with x-board-can, so it can't ${what}: that's its project's sync's job`)
  }

  /**
   * Refuses a platform origin an import can't have. Sync's records map each platform thread and
   * message to one board thread and message, board-wide, so taking one over would send what the
   * platform says there to another channel: a new root's platform thread must be no board
   * thread's yet, a reply's must be its own thread's, and its platform message no board message's.
   * Its platform locations are under the sync key it came through.
   */
  async function claimable(origin: Origin, from: string | null, thread: string | null) {
    if (from === null) throw badRequest('an import with an origin names the sync key it came through: pass `from`')
    for (const location of [origin.channel, origin.thread, origin.subthread])
      if (location !== undefined && location !== null && !location.startsWith(`${from}:`))
        throw badRequest(`an import's platform locations belong to its sync key: ${location} isn't ${from}'s`)
    // Its exact platform thread is one of its thread's (a review thread in its PR's), where its
    // platform message is found again: never another's, which another board thread may sync with.
    if (origin.subthread != null && !origin.subthread.startsWith(`${origin.thread}:`))
      throw badRequest(`an import's subthread is in its thread: ${origin.subthread} isn't in ${origin.thread}`)
    await reads.ensure()
    const owner = await store.tables.threadOf(origin.thread)
    if (owner !== null && owner !== thread) throw new HttpError(409, 'already_synced', `${origin.thread} is already synced with another thread`)
    if (owner === null && thread !== null) throw new HttpError(409, 'not_synced', `${origin.thread} isn't synced with this thread`)
    const exact = origin.subthread ?? origin.thread
    if ((await store.tables.messageOf(exact, origin.message)) !== null)
      throw new HttpError(409, 'already_synced', `${origin.message} in ${exact} is already on the board`)
  }

  /**
   * Refuses a delivery receipt a caller's sync can't have made: one for a target of another sync's,
   * or of none of its message's thread's, or one that says its message landed as a platform thread
   * or message another board thread or message syncs with. Receipts map those board-wide.
   */
  async function deliverable(caller: Caller, principal: string, message: Message, target: string, external?: { thread: string; message: string }) {
    const key = target.slice(0, target.indexOf(':'))
    if (!(await entriesOf(caller, principal)).some((entry) => entry.key === key)) throw forbidden(`this token doesn't sync ${key} here: its board registers its sync entries`)
    await reads.ensure()
    if (!(await store.tables.syncOf(message.thread))?.targets.includes(target))
      throw badRequest(`#${message.id}'s thread doesn't sync with ${target}`, 'not_a_target')
    if (!external) return
    if (!external.thread.startsWith(`${key}:`)) throw badRequest(`a delivery to ${target} lands under ${key}, not in ${external.thread}`)
    const owner = await store.tables.threadOf(external.thread)
    if (owner !== null && owner !== message.thread) throw new HttpError(409, 'already_synced', `${external.thread} is already synced with another thread`)
    const copy = await store.tables.messageOf(external.thread, external.message)
    if (copy !== null && copy !== message.id) throw new HttpError(409, 'already_synced', `${external.message} in ${external.thread} is another board message's`)
  }

  /** The board message an import changes: a platform message, or the root of the thread a platform thread belongs to. */
  async function locate(origin: { thread: string; message?: string | undefined }): Promise<number | null> {
    await reads.ensure()
    if (origin.message !== undefined) return store.tables.messageOf(origin.thread, origin.message)
    const thread = await store.tables.threadOf(origin.thread)
    return thread === null ? null : ((await store.tables.syncOf(thread))?.root ?? null)
  }

  /**
   * An import's links, as the board keeps them. One names a board message only if the importer
   * may read it, and then says what the board's own copy says, never what the import does: its
   * readers see that snapshot as the message's. Any other keeps its URL, and the platform's
   * snapshot if it came with one.
   */
  async function linksOf(principal: Granted, links: readonly (Omit<Link, 'message'> & { message: string | null })[] | undefined): Promise<Link[] | undefined> {
    if (!links) return undefined
    const { state: actors } = await session.state(actorsReducer)
    return Promise.all(
      links.map(async ({ message: ref, ...link }): Promise<Link> => {
        const id = ref === null ? null : indexOf(ref)
        const found = id === null || id === 0 ? null : await reads.message(id)
        if (!found || found.deleted || !principal.access.readable(found.channel)) return { ...link, message: null }
        const snapshot = {
          author: shownOf(actors.byId[found.by.actor]) ?? found.by.actor,
          text: found.text,
          createdAt: found.createdAt,
          files: found.attachments.map((file) => ({ name: file.name, url: null })),
        }
        return { url: link.url, message: found.id, snapshot, unavailable: null }
      }),
    )
  }

  /**
   * A receipt. This board's own sync, while it delivers here, appends it as its consumer, keyed by
   * `key`: a retry after a crash lands it once, and an attempt that was taken over can't. Anyone
   * else's lands once by `key`.
   */
  async function receipt(caller: Caller, key: string, events: { type: 'message.synced' | 'message.files_synced' | 'message.sync_failed'; payload: unknown }[]) {
    const ctx = delivering.getStore()
    if (ctx && ownSync(caller)) {
      await ctx.session.append(key, ...(events as never[]))
      return
    }
    for (const [i, event] of events.entries())
      await session.append({ ...event, id: await idempotentId('board-receipt', key, String(i)) } as never).catch((error: unknown) => {
        if (!duplicate(error)) throw error
      })
  }

  /** Records that the inbox for `channel` exists, the first time anything lands in it. */
  async function openInbox(channel: string) {
    if (opened.has(channel)) return
    if (!(await inboxes.state(inboxesReducer)).state[channel])
      await inboxes.append({ type: 'inbox.opened', id: await idempotentId('board-inbox', 'opened', channel), payload: { channel } })
    opened.add(channel)
  }

  // The inbox's second and the watchers' last, where tests and tools look for them.
  const servers = [server, inboxServer, schedules.server, registry.server, tasks.server, watchers.server]
  return {
    methods,
    schedules,
    trust: access.trust,
    /** The scheduler's callback, for every A2 server behind the board. */
    scheduler: options.scheduler
      ? options.scheduler.handler(...servers)
      : async (_request: Request) => toErrorResponse(notFound('this board has no scheduler')),
    servers,
    session,
    store,
  }
}

/**
 * The engine behind `local()`, internal: a board on A2's log, in its store, and optionally with a
 * scheduler and somewhere for files. It's a backend: `local()` passes it to `board({ backend })`,
 * and tests do. It trusts the callers board() verified; what it does outside requests, it asks
 * board()'s policy about and writes through board(). Nothing is built until board() binds it, and
 * nothing connects until the first call.
 */
export function a2(options: A2Options) {
  let binding: BoardBinding | null = null
  let built: ReturnType<typeof build> | null = null
  /** What's built, once board() binds it. */
  const now = () => {
    if (!built) throw new Error("this backend isn't serving a board yet: pass it to board({ backend })")
    return built
  }
  /** A scheduler's delivery, through its callback, and everything it runs: watchers' writes too. */
  const delivery = new AsyncLocalStorage<true>()
  const ready = async () => {
    const ran = now()
    // The first call on an instance starts the schedules catching up, and doesn't wait. Only a call
    // that isn't a scheduler's delivery takes them over: an old instance's timers mustn't take them back.
    ran.schedules.catchUp({ takeOver: !delivery.getStore() })
    return ran
  }
  const methods = Object.fromEntries(
    METHODS.map((name) => [name, async (caller: Caller, input: never, signal: AbortSignal) => ((await ready()).methods[name] as (...args: unknown[]) => unknown)(caller, input, signal)]),
  ) as unknown as ProtocolMethods
  const backend = {
    ...methods,
    // Everything it answers is the protocol's.
    routes: [] as BackendRoute[],
    // The board lives here: board() lets its people and own deployments in by default.
    keeps: true,
    // Its grants, in its log: board() checks requests against them.
    trust: {
      grants: async () => (await ready()).trust.grants(),
    } satisfies Trust,
    bind(given: BoardBinding) {
      if (binding) throw new Error('this backend already serves a board: create one per board()')
      binding = given
      // It builds now, and connects when it's first used.
      built = build(options, given)
    },
    /** The scheduler's callback. A board without a scheduler answers 404. */
    scheduler: (request: Request): Promise<Response> => delivery.run(true, async () => (await ready()).scheduler(request)),
    /** The A2 servers behind this board, to share one scheduler with other A2 servers. */
    get servers() {
      return now().servers
    },
    /** For tests and tools. */
    get session() {
      return now().session
    },
    get store() {
      return now().store
    },
  }
  // What tests and tools look at stays out of a spread, so `{ ...a2(), delete }` is a backend too.
  for (const key of ['servers', 'session', 'store']) Object.defineProperty(backend, key, { enumerable: false })
  return backend satisfies Backend
}

export type A2Backend = ReturnType<typeof a2>
