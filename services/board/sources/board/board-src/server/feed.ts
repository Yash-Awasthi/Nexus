import { carried } from './carried.ts'
import type { z } from 'zod'
import type { ActorView, Filters, LinkView, MessageView, BoardEventView, TaskView } from '../api/routes.ts'
import type { ParsedFilters } from '../api/routes.ts'
import type { BoardEvent } from '../contract/events.ts'
import type { Link } from '../contract/external.ts'
import { FULL_ACCESS, type Access } from './access.ts'
import { hasCriteria } from './watch-spec.ts'
import { channelsReducer } from '../contract/reducers.ts'
import { foldActors, foldMessages, iso, type Actor, type ActorsState, type Message, type MessagesState, type Task } from '../contract/folds.ts'
import { blocksIn } from '../contract/blocks.ts'
import { authorView, type Author } from '../contract/schemas.ts'
import { actorParts, type Via } from '../contract/profiles.ts'
import { mentionTerm, mentionTerms } from '../contract/mentions.ts'
import { own } from '../contract/own.ts'
import { concernedMessageId } from '../store/project.ts'
import type { MessageFilter } from '../store/types.ts'
import type { BoardSession } from './a2.ts'
import type { BoardReads } from './reads.ts'

export { concernedMessageId }

/** Bookkeeping events, shown only with `all`: who's who, delivery receipts, and a claim's renewals. */
const HIDDEN = new Set(['actor.seen', 'message.synced', 'message.files_synced', 'task.renewed'])

/** Whether the board checked who an actor is, as people see them, at their last write (`actor.seen`'s `verified`). */
export const verifiedRecord = (actor: Pick<Actor, 'verified'>): boolean => actor.verified === true

export function actorView(actors: ActorsState, id: string): ActorView | null {
  const author = own(actors.byId, id)
  if (!author) return null
  const via = viaOfRecord(author)
  return {
    kind: author.kind,
    handle: author.handle,
    name: author.name,
    avatar: author.avatar,
    ...(via ? { via } : {}),
    ...(author.platform ? { platform: author.platform } : {}),
    ...(verifiedRecord(author) ? { verified: true as const } : {}),
  }
}

/**
 * Who an actor with a profile acts through, as its record says. An agent recorded before records
 * said, whose handle is `<person>/<profile>`, acts through the person its handle names.
 */
export function viaOfRecord(actor: Pick<Actor, 'id' | 'handle' | 'via'>): Via | undefined {
  if (actor.via) return { ...actor.via }
  const slash = actor.handle.indexOf('/')
  return actorParts(actor.id).profile !== null && slash > 0 ? { name: actor.handle.slice(0, slash), environment: null } : undefined
}

/**
 * Who's reading a view, for what links show: a link to a board message they
 * can't read shows nothing of it. `channelOf` says where a linked message is,
 * for a reader that can't read every channel.
 */
export type Reader = { access: Access; channelOf: (message: number) => string | undefined }

/** The board's own code, which reads every channel: it needs no messages to say so. */
export const OWN_CODE: Reader = { access: FULL_ACCESS, channelOf: () => undefined }

/** The board messages `links` point to, for `Reader.channelOf`. */
export const linkedIds = (links: readonly Link[]): number[] => links.flatMap((link) => (link.message === null ? [] : [link.message]))

/**
 * Links as `reader` may see them. The log keeps each snapshot; it's hidden when
 * it's read. A linked message the reader's lookup doesn't have hides too: its
 * snapshot shows only where it's known to be readable.
 */
export function readableLinks(links: Link[], reader: Reader): LinkView[] {
  return links.map((link) => {
    if (link.message === null) return { ...link, message: null }
    const channel = reader.access.readsAll ? undefined : reader.channelOf(link.message)
    return reader.access.readsAll || (channel !== undefined && reader.access.readable(channel))
      ? { ...link, message: ref(link.message) }
      : { url: link.url, message: null, snapshot: null, unavailable: 'not_readable' }
  })
}

/** The links in an event view: its payload's, its message's, and the message before a label change. */
const viewLinks = (view: BoardEventView): LinkView[][] => {
  const { payload, message, before } = view as { payload?: { links?: LinkView[] }; message?: MessageView; before?: MessageView }
  return [payload?.links, message?.links, before?.links].filter((links) => links !== undefined)
}

/** The board messages an event view's links point to, for a reader of them. */
export const viewLinkedIds = (view: BoardEventView): number[] =>
  viewLinks(view).flatMap((links) => links.flatMap((link) => (link.message === null ? [] : [indexOf(link.message) ?? 0])))

/**
 * An event view made for one reader, as `reader` sees it: a link to a message it can't read shows
 * nothing of it. A watcher's match is made when its event lands and pulled later, by whatever its
 * registrant may read then.
 */
export function viewedBy(view: BoardEventView, reader: Reader): BoardEventView {
  if (reader.access.readsAll) return view
  const shown = structuredClone(view) as BoardEventView & { payload?: { links?: LinkView[] }; message?: MessageView; before?: MessageView }
  // A ref that names nothing here (0) has no channel, so it hides too.
  const reread = (links: LinkView[]) => readableLinks(links.map((link) => ({ ...link, message: link.message === null ? null : (indexOf(link.message) ?? 0) })), reader)
  if (shown.payload?.links) shown.payload.links = reread(shown.payload.links)
  if (shown.message) shown.message.links = reread(shown.message.links)
  if (shown.before) shown.before.links = reread(shown.before.links)
  return shown
}

/** A message's or a cursor's ID as clients see it. On this board it's the log index, in decimal. */
export const ref = (index: number): string => String(index)

/** A schedule's ID as clients see it: its index in session `schedules`, as `s12`, so it reads apart from message `12`. */
export const scheduleRef = (index: number): string => `s${index}`

/** The log index a ref names on this board, or null for a string that names nothing here. */
export const indexOf = (value: string): number | null => (/^(0|[1-9]\d{0,15})$/.test(value) ? Number(value) : null)

/** A task as every reader sees it: the tasks it waits for as refs, and its claim without the token, hashed or not. */
export function taskView(task: Task): TaskView {
  const { needs, claim, ...shown } = task
  return {
    ...shown,
    needs: needs.map(ref),
    claim: claim && { actor: claim.actor, until: claim.until },
    blocked: task.blocked && { ...task.blocked },
  }
}

/** A message as `reader` sees it. Every view names its reader, so none shows a link's snapshot by default. */
export function view(message: Message, actors: ActorsState, reader: Reader): MessageView {
  // A message folded before mentions were text alone keeps the actor IDs they resolved to.
  const { blind, version, revision, schedule, task, platformText, mentions: _mentions, ...shown } = message as Message & { mentions?: unknown }
  return {
    ...shown,
    ...(task ? { task: taskView(task) } : {}),
    by: authorView(message.by),
    ...(blind ? { blind } : {}),
    id: ref(message.id),
    re: message.re === null ? null : ref(message.re),
    replyTo: message.replyTo === null ? null : ref(message.replyTo),
    version: version ?? message.id,
    // A message folded before revisions has its post's: its next edit or delete moves it.
    revision: revision ?? message.id,
    ...(schedule ? { schedule: { id: scheduleRef(schedule.id), n: schedule.n } } : {}),
    links: readableLinks(message.links, reader),
    labels: { ...message.labels },
    reactions: Object.fromEntries(
      Object.entries(message.reactions).map(([emoji, ids]) => [emoji, [...ids]]),
    ),
    author: actorView(actors, message.by.actor),
    // Written on the board, so checked when it was: what a sync brought in, a whole message or an
    // edit of one, is a platform's text.
    blocks: message.from === null && !platformText ? blocksIn(message.text) : [],
  }
}

const actorSet = (value: string, actors: ActorsState): Set<string> =>
  own(actors.byId, value) ? new Set([value]) : new Set(own(actors.byHandle, value.toLowerCase()) ?? [])

/**
 * Who a `--by` value covers. A person (`julian`) is everyone they are: their own
 * actor, and their agents (`julian/claude`). An agent or a platform actor is just itself.
 */
export function whoIs(value: string, actors: ActorsState): { actors: Set<string>; principals: Set<string> } {
  const ids = actorSet(value, actors)
  const principals = new Set([...ids].filter((id) => own(actors.byId, id)?.kind === 'person'))
  return { actors: ids, principals }
}

/**
 * Who a `--by` value names. `me` is the caller's own actor and nobody else, as on Vercel's board:
 * not a person's agents, which their handle covers. It needs no record of them, so it holds for
 * someone who has yet to post. Anyone else is `whoIs`.
 */
function authorOf(value: string, context: { me: Me | null; actors: ActorsState }): { actors: Set<string>; principals: Set<string> } {
  if (value === 'me' && context.me) return { actors: new Set([context.me.id]), principals: new Set() }
  return whoIs(value, context.actors)
}

/** The caller, as `--mentions me` names them: their actor ID and handle. */
export type Me = { id: string; handle: string }

/**
 * What a `--mentions` value matches in a message's text (`mentionTerms`): `me` is the caller's handle
 * and ID. Anyone else is the value as written, and what's under it: a person's agents
 * (`@julian/claude`), a project's imports (`@support/malte`), and their IDs. A reader of every
 * channel also gets each actor the value names, by ID or by handle, through their other name: their
 * handle and ID. Anyone else doesn't, since that would say who goes by what where it can't read.
 */
export function mentionFilter(value: string, context: { me: Me | null; actors: ActorsState; access: Access }): NonNullable<MessageFilter['mentions']> {
  if (value === 'me') return { terms: context.me === null ? [] : [mentionTerm(context.me.handle), context.me.id], prefixes: [] }
  const under = (name: string) => (name.includes(':') ? `${name}+` : `${mentionTerm(name)}/`)
  const terms = new Set([mentionTerm(value)])
  const prefixes = new Set([under(value)])
  if (!context.access.readsAll) return { terms: [...terms], prefixes: [...prefixes] }
  for (const id of actorSet(value, context.actors)) {
    const actor = own(context.actors.byId, id)!
    terms.add(id).add(mentionTerm(actor.handle))
    prefixes.add(under(actor.handle)).add(under(id))
  }
  return { terms: [...terms], prefixes: [...prefixes] }
}

/** Whether `text` mentions what a `--mentions` filter matches. */
const mentionsIn = (text: string, filter: NonNullable<MessageFilter['mentions']>) =>
  mentionTerms(text).some((term) => filter.terms.includes(term) || filter.prefixes.some((prefix) => term.startsWith(prefix)))

/** Whether `author` is one of `who`: its actor, or an agent of one of its people. */
const covers = (who: { actors: Set<string>; principals: Set<string> }, actor: string, principal?: string) =>
  who.actors.has(actor) || (principal !== undefined && who.principals.has(principal))

export { hasCriteria }

type LabelFilter = readonly [string, readonly string[] | null]

const hasLabel = (labels: Record<string, string>, [key, values]: LabelFilter) =>
  Object.hasOwn(labels, key) && (values === null || values.includes(labels[key]!))

/**
 * Compiles filters once; handles resolve against the actors known at that
 * moment. A label matches on the message or its thread's root, where sync puts
 * labels, so `pr=…` means the PR's whole conversation. `messages` is the live
 * state for that lookup. A message in a channel `access` can't read never
 * matches, whatever the filters say.
 */
export function compileFilter(
  filters: ParsedFilters,
  context: { me: Me | null; actors: ActorsState; messages?: MessagesState; access: Access },
): (message: Message | undefined) => boolean {
  const { access } = context
  const text = filters.text?.toLowerCase()
  const labels = filters.label ?? []
  const channel = filters.channel
  const subtree = channel?.endsWith('/') ? channel.slice(0, -1) : null
  const by = filters.by === undefined ? null : authorOf(filters.by, context)
  // A ref that names nothing on this board matches nothing, as in the tables.
  const re = filters.re === undefined ? undefined : (indexOf(filters.re) ?? -1)
  const mentions = filters.mentions === undefined ? null : mentionFilter(filters.mentions, context)
  return (message) => {
    if (!message || !access.readable(message.channel)) return false
    if (channel !== undefined) {
      if (subtree !== null) {
        if (message.channel !== subtree && !message.channel.startsWith(`${subtree}/`)) return false
      } else if (message.channel !== channel) return false
    }
    if (re !== undefined && message.id !== re && message.re !== re) return false
    if (by !== null && !covers(by, message.by.actor, message.by.principal)) return false
    if (mentions !== null && !mentionsIn(message.text, mentions)) return false
    if (filters.from !== undefined && (message.from ?? 'board') !== filters.from) return false
    if (text !== undefined && !message.text.toLowerCase().includes(text)) return false
    if (labels.length > 0) {
      const root = message.re === null ? undefined : context.messages?.byId[message.re]
      for (const label of labels)
        if (!hasLabel(message.labels, label) && !(root && hasLabel(root.labels, label))) return false
    }
    return true
  }
}

/**
 * `filter`, narrowed to the channels `access` reads among `known`, as the tables
 * take it: a reader of every channel needs nothing more. A channel the caller
 * didn't know of is left out, never let in.
 */
export function readableFilter(filter: MessageFilter, known: Iterable<string>, access: Access): MessageFilter {
  if (access.readsAll) return filter
  const { channel, ...rest } = filter
  const within = (path: string) => !channel || path === channel.path || (channel.subtree && path.startsWith(`${channel.path}/`))
  return { ...rest, channels: [...known].filter((path) => within(path) && access.readable(path)) }
}

/** The filters as the tables take them: handles resolved to who they cover, mentions to the terms they match. */
export function toMessageFilter(filters: ParsedFilters, context: { me: Me | null; actors: ActorsState; access: Access }): MessageFilter {
  const out: MessageFilter = {}
  const channel = filters.channel
  if (channel !== undefined)
    out.channel = channel.endsWith('/') ? { path: channel.slice(0, -1), subtree: true } : { path: channel, subtree: false }
  // A ref that names nothing on this board matches nothing.
  if (filters.re !== undefined) out.re = indexOf(filters.re) ?? -1
  if (filters.by !== undefined) {
    const who = authorOf(filters.by, context)
    out.by = { actors: [...who.actors], principals: [...who.principals] }
  }
  if (filters.mentions !== undefined) out.mentions = mentionFilter(filters.mentions, context)
  if (filters.from !== undefined) out.from = filters.from
  if (filters.text !== undefined) out.text = filters.text.toLowerCase()
  if (filters.label?.length) out.labels = filters.label.map(([key, values]) => ({ key, values }))
  return out
}

/**
 * Loads into `messages`, as they were just before `event`, the message it
 * concerns and that message's root: what folding it and matching filters need.
 * `loaded` remembers what was asked for already, found or not.
 */
async function loadInto(
  reads: BoardReads,
  messages: MessagesState,
  loaded: Set<number>,
  event: BoardEvent,
  signal?: AbortSignal,
): Promise<void> {
  const id = concernedMessageId(event)
  if (id === null) return
  const through = event.index - 1
  const load = async (ids: number[]) => {
    const wanted = ids.filter((want) => !loaded.has(want))
    if (wanted.length === 0) return
    const found = await reads.messagesAt(wanted, through, signal)
    for (const want of wanted) {
      loaded.add(want)
      const message = found.get(want)
      if (message) messages.byId[want] = message
    }
  }
  // A post is new: the fold makes it. The rest concern a message that was already there.
  if (event.type === 'message.posted') loaded.add(id)
  else await load([id])
  const re = event.type === 'message.posted' ? event.payload.re : (messages.byId[id]?.re ?? null)
  if (re !== null) await load([re])
}

/** The message `event` concerns and its root, as they were just before it. */
export async function loadBefore(reads: BoardReads, event: BoardEvent, signal?: AbortSignal): Promise<MessagesState> {
  const messages: MessagesState = { byId: {}, replies: {} }
  await loadInto(reads, messages, new Set(), event, signal)
  return messages
}

/** Folds one event into `messages` and `actors`, and returns the message it concerns before and after. */
export function foldEvent(messages: MessagesState, actors: ActorsState, event: BoardEvent) {
  const id = concernedMessageId(event)
  const before = id === null ? undefined : structuredClone(messages.byId[id])
  foldMessages(messages, event)
  foldActors(actors, event)
  const after = id === null ? undefined : messages.byId[id]
  return { id, before, after }
}

/** An event as subscribers receive it, with its message as it is afterwards. */
export function eventView(event: BoardEvent, after: Message | undefined, actors: ActorsState, reader: Reader): BoardEventView {
  const by = (event.payload as { by?: { actor?: string } }).by?.actor
  const actor = by ? own(actors.byId, by) : undefined
  const { links } = event.payload as { links?: Link[] }
  // `type` and `payload` come from the same event, so they still match; TypeScript
  // can't follow that through a union, and this is the one place views are made.
  return {
    cursor: ref(event.index),
    type: event.type,
    createdAt: iso(event.createdAt),
    payload: payloadView(event.payload as Record<string, unknown>, links ? readableLinks(links, reader) : undefined),
    ...(after ? { message: view(after, actors, reader) } : {}),
    ...(actor ? { actor: { id: actor.id, ...actorView(actors, actor.id)! } } : {}),
  } as BoardEventView
}

/** An event's payload as clients see it: the message IDs in it are refs, and a claim's token is left out. */
function payloadView(payload: Record<string, unknown>, links: LinkView[] | undefined): Record<string, unknown> {
  // Only `task.claimed` carries a `token`: its hash is the board's to check claims against, and no reader's.
  // A post or an edit from before mentions were text alone carries the actor IDs they resolved to.
  // A post's `along` is the board's own count of what its append carried.
  const { token: _token, mentions: _mentions, along: _along, ...shown }: Record<string, unknown> = payload
  for (const key of ['id', 're', 'replyTo'] as const) if (typeof shown[key] === 'number') shown[key] = ref(shown[key])
  if (Array.isArray(shown.needs)) shown.needs = (shown.needs as number[]).map(ref)
  if (typeof shown.by === 'object' && shown.by !== null) shown.by = authorView(shown.by as Author)
  const schedule = shown.schedule as { id: number; n: number } | undefined
  if (schedule) shown.schedule = { id: scheduleRef(schedule.id), n: schedule.n }
  if (links) shown.links = links
  return shown
}

export type FeedItem = { index: number; view: BoardEventView | null }

/**
 * Folds events one at a time and decides what a subscriber sees. It holds only
 * the messages events have touched, each loaded from the tables as it was just
 * before the first event that touched it. A label or reaction change is
 * delivered when its message matched the filter before *or* after it, so
 * subscribers see messages leave a view too.
 *
 * It's the one choke point for `/events` (tail, wait, and poll): an event about
 * a message shows only where `access` reads its channel, and one about no
 * message (who's who, a thread's sync) only to a reader of every channel.
 */
export class FeedProjection {
  private readonly messages: MessagesState = { byId: {}, replies: {} }
  private readonly loaded = new Set<number>()
  private readonly reads: BoardReads
  readonly actors: ActorsState
  private readonly match: (message: Message | undefined) => boolean
  private readonly criteria: boolean
  private readonly all: boolean
  private readonly access: Access
  /** Where each board message a view links to lives, for a reader that can't read every channel. */
  private readonly linked = new Map<number, string | undefined>()

  constructor(options: FeedOptions) {
    this.reads = options.reads
    this.actors = options.actors
    this.access = options.access
    this.match = compileFilter(options.filters, { me: options.me, actors: options.actors, messages: this.messages, access: options.access })
    this.criteria = hasCriteria(options.filters)
    this.all = options.all
  }

  /** Loads what `events` touch, all as of `index`, in two queries rather than two per event. */
  async preload(events: readonly BoardEvent[], index: number): Promise<void> {
    const ids = new Set<number>()
    for (const event of events) {
      const id = concernedMessageId(event)
      if (id === null) continue
      if (event.type !== 'message.posted') ids.add(id)
      else if (event.payload.re !== null) ids.add(event.payload.re)
    }
    const load = async (wanted: number[]) => {
      if (wanted.length === 0) return
      const found = await this.reads.messagesAt(wanted, index)
      for (const id of wanted) {
        this.loaded.add(id)
        const message = found.get(id)
        if (message) this.messages.byId[id] = message
      }
    }
    await load([...ids].filter((id) => !this.loaded.has(id) && id <= index))
    const roots = Object.values(this.messages.byId).flatMap((message) => (message.re === null ? [] : [message.re]))
    await load([...new Set(roots)].filter((id) => !this.loaded.has(id)))
  }

  async step(event: BoardEvent, signal?: AbortSignal): Promise<FeedItem> {
    await loadInto(this.reads, this.messages, this.loaded, event, signal)
    const { id, before, after } = foldEvent(this.messages, this.actors, event)
    const message = after ?? before
    const readable = id === null ? this.access.readsAll : message !== undefined && this.access.readable(message.channel)
    const hidden = HIDDEN.has(event.type) && !this.all
    const visible = readable && !hidden && (this.criteria ? this.match(before) || this.match(after) : id !== null || this.all)
    if (!visible) return { index: event.index, view: null }
    await this.loadLinked([...(after?.links ?? []), ...((event.payload as { links?: Link[] }).links ?? [])], event.index, signal)
    const reader: Reader = {
      access: this.access,
      channelOf: (message) => this.messages.byId[message]?.channel ?? this.linked.get(message),
    }
    return { index: event.index, view: eventView(event, after, this.actors, reader) }
  }

  /** Where the messages `links` point to live; a message never moves, so any version says. */
  private async loadLinked(links: readonly Link[], index: number, signal?: AbortSignal): Promise<void> {
    if (this.access.readsAll) return
    const wanted = [...new Set(linkedIds(links))].filter((id) => !this.messages.byId[id] && !this.linked.has(id))
    if (wanted.length === 0) return
    const found = await this.reads.messagesAt(wanted, index, signal)
    for (const id of wanted) this.linked.set(id, found.get(id)?.channel)
  }
}

/** Resolves when the iterator yields, or with null once the signal aborts. */
function nextOrAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T> | null> {
  if (signal.aborted) return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(null)
    signal.addEventListener('abort', onAbort, { once: true })
    iterator.next().then(
      (result) => {
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

export type FeedOptions = {
  session: BoardSession
  reads: BoardReads
  after: number | undefined
  filters: ParsedFilters
  all: boolean
  me: Me | null
  actors: ActorsState
  /** What the subscriber may read; an open stream keeps what it had when it opened. */
  access: Access
}

/** Where a feed starts: `after`, or the head when it's omitted or past it. */
async function start(options: FeedOptions): Promise<number> {
  const { index: head } = await options.session.state(channelsReducer)
  return options.after === undefined || options.after >= head ? head : options.after
}

const PAGE = 200
/** How far back a read of the feed's newest events looks: this many pages of the log. */
const LAST_PAGES = 10

/**
 * The newest `last` matching events, oldest first, with the feed's end as the cursor: a poll from it goes on
 * with what comes next. It looks back a page of the log at a time until it has them, through `LAST_PAGES` at
 * most, so a filter that matches little on a busy board can answer fewer.
 */
export async function lastFeed(options: FeedOptions, last: number, signal: AbortSignal): Promise<{ events: BoardEventView[]; cursor: number }> {
  const { index: head } = await options.session.state(channelsReducer)
  let events: BoardEventView[] = []
  for (let to = head, pages = 0; to >= 1 && events.length < last && pages < LAST_PAGES; pages++) {
    const from = Math.max(1, to - PAGE + 1)
    const stretch = (await options.session.history({ gte: from, lte: to })) as BoardEvent[]
    // Each stretch is read as a feed that starts right before it would be.
    const feed = new FeedProjection(options)
    await feed.preload(stretch, from - 1)
    const found: BoardEventView[] = []
    for (const event of stretch) {
      const { view } = await feed.step(event, signal)
      if (view) found.push(view)
    }
    events = [...found, ...events]
    to = from - 1
  }
  return { events: await asNow(options, events.slice(-last), head, signal), cursor: head }
}

/** What an event's payload says of its message: answered as the message has it now. */
const CONTENT = ['text', 'blocks', 'attachments', 'links', 'labels'] as const

/**
 * Events read from the feed's end, each with its message as it is at `head`, not as the event left it: the walk
 * replays the log, and what was deleted or edited since is no longer the board's to answer. One whose message can't
 * be read now is left out, and so is one a filter on what messages say found by what it said then.
 */
async function asNow(options: FeedOptions, events: BoardEventView[], head: number, signal: AbortSignal): Promise<BoardEventView[]> {
  const idOf = (event: BoardEventView) => (event.message ? indexOf(event.message.id) : null)
  const ids = [...new Set(events.flatMap((event) => idOf(event) ?? []))]
  if (ids.length === 0) return events
  const now = await options.reads.messagesAt(ids, head, signal)
  const reader = await options.reads.reader(options.access, now.values())
  const said = options.filters as { text?: unknown; mentions?: unknown }
  const byWords = said.text !== undefined || said.mentions !== undefined
  return events.flatMap((event) => {
    const id = idOf(event)
    if (id === null || !event.message) return [event]
    const current = now.get(id)
    if (!current || !options.access.readable(current.channel)) return []
    const message = view(current, options.actors, reader)
    if (byWords && (message.deleted || message.text !== event.message.text)) return []
    const payload: Record<string, unknown> = { ...(event.payload as Record<string, unknown>) }
    for (const key of CONTENT) {
      if (!(key in payload)) continue
      const was = payload[key]
      // An event that kept its attachments by ID answers the IDs the message has now.
      payload[key] = key === 'attachments' && Array.isArray(was) && was.every((item) => typeof item === 'string') ? message.attachments.map((attachment) => attachment.id) : message[key]
    }
    // And with nothing else the message no longer carries: a label's value, a reaction, a hold's reason.
    const settled = carried({ ...event, payload, message } as BoardEventView)
    return settled ? [settled] : []
  })
}

/**
 * One long-poll: matching events already in the log return at once; otherwise
 * it waits up to `waitMs` for the first new match. The cursor is the last
 * event examined, matched or not, so the next poll never rescans.
 */
export async function pollFeed(
  options: FeedOptions,
  waitMs: number,
  signal: AbortSignal,
): Promise<{ events: BoardEventView[]; cursor: number }> {
  const index = await start(options)
  const feed = new FeedProjection(options)
  const events: BoardEventView[] = []
  let cursor = index
  const backlog = (await options.session.history({ gte: index + 1, lte: index + PAGE })) as BoardEvent[]
  await feed.preload(backlog, index)
  for (const event of backlog) {
    const item = await feed.step(event, signal)
    cursor = item.index
    if (item.view) events.push(item.view)
  }
  if (events.length > 0 || backlog.length === PAGE || waitMs <= 0) return { events, cursor }

  const timeout = AbortSignal.timeout(waitMs)
  const until = AbortSignal.any([signal, timeout])
  const iterator = options.session.stream({ startAfter: cursor })[Symbol.asyncIterator]()
  try {
    while (true) {
      const next = await nextOrAbort(iterator, until)
      if (next === null || next.done) return { events, cursor }
      const item = await feed.step(next.value as BoardEvent, until)
      cursor = item.index
      if (item.view) {
        events.push(item.view)
        return { events, cursor }
      }
    }
  } finally {
    void iterator.return?.()
  }
}
