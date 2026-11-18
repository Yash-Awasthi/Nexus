import type { ActorView, BlockView, BoardEventView, ChannelView, Discovery, GrantView, Me, MessageView, RegistrationView, ScheduleView, SchemaView, TaskView, ThreadsPage } from '../../api/routes.ts'
// `@vercel/board/schemas`, in an app of yours.
import { findBlocks } from '../../contract/blocks.ts'
import { canonicalEmoji } from '../../contract/emoji.ts'
import type { ScheduleTiming } from '../../server/index.default.ts'
import { shownName } from './words.ts'

// The board, as this page knows it. Pure functions over plain state: the page
// loads snapshots, folds the live stream in, and overlays your own writes until
// the board confirms them. No DOM here, so it's tested like the rest.

/** A change you made that the board hasn't confirmed yet. */
export type Op =
  | { kind: 'react'; emoji: string; remove: boolean }
  | { kind: 'edit'; text: string }
  | { kind: 'delete' }
  | { kind: 'label'; set: Record<string, string>; unset: string[] }

/** A post on its way: shown at once, replaced by the real message when the board answers. */
export type Pending = {
  key: string
  channel: string
  re: string | null
  text: string
  noSync: boolean
  labels: Record<string, string>
  /** Files going with it, shown while it's on its way. */
  files?: { name: string; size: number }[]
  /** Set for one to send later: when, and how often. It's kept until the board has its schedule. */
  later?: ScheduleTiming
  /** Set for a thread that starts as a task: what it waits for, and the actor it's for. */
  task?: { needs: string[]; for: string | null }
  createdAt: string
  error: string | null
}

/** A listed thread: how many replies it has and its latest, by ID, as the board listed it or the stream has moved it since. */
export type Row = { replies: number; last: string | null }

/**
 * A channel's threads as the board lists them, by latest activity: a row per thread, by its root's ID, and the
 * `older` of the last page read, where the next older page starts (null when the oldest is here). Until its first
 * page is in (`loaded: false`), it keeps the posts the stream brings, for the page to merge into.
 */
export type Listing = { rows: Record<string, Row>; older: string | null; loaded: boolean }

/** A channel's listing, by its own key only: a channel can be named like an object's built-ins (`constructor`). */
export const listingOf = (state: State, channel: string): Listing | null | undefined =>
  Object.hasOwn(state.listings, channel) ? state.listings[channel] : undefined

const rowOf = (listing: Listing, root: string): Row | undefined => (Object.hasOwn(listing.rows, root) ? listing.rows[root] : undefined)

export type State = {
  me: Me | null
  discovery: Discovery | null
  channels: Record<string, ChannelView>
  /** Messages as the board last showed them, by ID. Of two views of one, the higher `version` wins. */
  messages: Record<string, MessageView>
  ops: Record<string, { id: string; op: Op }[]>
  pending: Pending[]
  actors: Record<string, ActorView>
  /** The stream's position: the last event's cursor, to resume from. */
  cursor: string | null
  /** What the board answered instead of its feed's newest events across channels, when it refused: the activity view says it. */
  activityRefused: string | null
  live: 'connecting' | 'live' | 'reconnecting'
  /** The claims this tab made, by task: which ones the board still shows as live. */
  claims: Record<string, Claim>
  /** Whether every open task is loaded, so the page can count them. */
  tasksCounted: boolean
  /** Each opened channel's listing, or null on a board whose thread pages have no `older`: it loads by messages. */
  listings: Record<string, Listing | null>
  /** The board's schema registry, once it's read: what a block's fields mean. */
  schemas: SchemaView[] | null
  /** What the board answered instead of its registry, when it refused. */
  schemasRefused: string | null
  /** The board's grants, as it answered when asked for them. */
  grants: Listed<GrantView>
  /** Scheduled messages: pending ones, or with `everySchedule` done and canceled ones too. Nothing in the feed says when one changes, so the page asks again. */
  schedules: Listed<ScheduleView>
  everySchedule: boolean
  /** The watchers boards elsewhere registered here. */
  watchers: Listed<RegistrationView>
}

export const initialState: State = {
  me: null,
  discovery: null,
  channels: {},
  messages: {},
  ops: {},
  pending: [],
  actors: {},
  cursor: null,
  activityRefused: null,
  live: 'connecting',
  claims: {},
  tasksCounted: false,
  listings: {},
  schemas: null,
  schemasRefused: null,
  grants: { is: 'unasked' },
  schedules: { is: 'unasked' },
  everySchedule: false,
  watchers: { is: 'unasked' },
}

/** Whether a message as the board shows it already reflects a change you made. */
export function confirms(message: MessageView, op: Op, me: string): boolean {
  switch (op.kind) {
    case 'react': {
      const reacted = (message.reactions[canonicalEmoji(op.emoji)] ?? []).includes(me)
      return op.remove ? !reacted : reacted || message.deleted
    }
    case 'edit':
      return message.text === op.text || message.deleted
    case 'delete':
      return message.deleted
    case 'label':
      return (
        message.deleted ||
        (Object.entries(op.set).every(([key, value]) => message.labels[key] === value) &&
          op.unset.every((key) => !(key in message.labels)))
      )
  }
}

/** A message with your unconfirmed changes applied. */
export function apply(message: MessageView, op: Op, me: string, now: string): MessageView {
  switch (op.kind) {
    case 'react': {
      const emoji = canonicalEmoji(op.emoji)
      const actors = (message.reactions[emoji] ?? []).filter((actor) => actor !== me)
      const reactions = { ...message.reactions, [emoji]: op.remove ? actors : [...actors, me] }
      if (reactions[emoji]!.length === 0) delete reactions[emoji]
      return { ...message, reactions }
    }
    case 'edit':
      return { ...message, text: op.text, editedAt: now }
    case 'delete':
      return { ...message, deleted: true, text: '', reactions: {} }
    case 'label': {
      const labels = { ...message.labels, ...op.set }
      for (const key of op.unset) delete labels[key]
      return { ...message, labels }
    }
  }
}

// #region guide inspector/merge.ts
/**
 * Takes in views of messages, keeping the newer of each. A message's `version` grows with every
 * change to it, so of two views the higher is newer, whatever order they arrive in: a snapshot
 * that lands after the event that outdated it changes nothing.
 */
export function newest(known: Record<string, MessageView>, views: MessageView[]): Record<string, MessageView> {
  let next = known
  for (const view of views) {
    if ((next[view.id]?.version ?? -1) > view.version) continue
    if (next === known) next = { ...known }
    next[view.id] = view
  }
  return next
}
// #endregion

/** Takes in message views, the newer of each, with what a newer view settles: your changes it confirms, and a claim it ends. */
export function merge(state: State, views: MessageView[]): State {
  const messages = newest(state.messages, views)
  if (messages === state.messages) return state
  let ops = state.ops
  let claims = state.claims
  for (const view of views) {
    // An older view changed nothing.
    if (messages[view.id] !== view) continue
    // A claim is over once the board shows the task released, settled, held, or claimed again.
    const claim = claims[view.id]
    if (claim && !(view.task?.state === 'claimed' && view.task.epoch === claim.epoch)) {
      claims = { ...claims }
      delete claims[view.id]
    }
    const waiting = ops[view.id]
    if (waiting && state.me) {
      const left = waiting.filter(({ op }) => !confirms(view, op, state.me!.actor))
      if (left.length !== waiting.length) {
        ops = { ...ops }
        if (left.length > 0) ops[view.id] = left
        else delete ops[view.id]
      }
    }
  }
  return { ...state, messages, ops, claims }
}

// #region guide inspector/pending.ts
/**
 * The post on its way that a message stands for: yours, in the same place, saying the same. The
 * feed can bring the message before the board answers the post, so whichever comes first replaces
 * the pending one, and the two never show at once.
 */
export function landed<Post extends { channel: string; re: string | null; text: string; error: string | null }>(pending: Post[], message: MessageView, me: string): Post | undefined {
  if (message.by.actor !== me) return undefined
  return pending.find((post) => post.error === null && post.channel === message.channel && post.re === message.re && post.text === message.text)
}
// #endregion

/** When a listed thread was last active: its latest reply, or its root. */
function activity(state: State, root: string, row: Row): Pick<MessageView, 'createdAt' | 'id'> {
  return (row.last === null ? undefined : state.messages[row.last]) ?? state.messages[root] ?? { createdAt: '', id: root }
}

/**
 * Takes in a page of a channel's threads: one row per thread, the newer where a thread is listed already. The first
 * page read and every older one set where the next older page starts; the first page read again leaves it.
 */
export function mergeThreads(state: State, channel: string, page: ThreadsPage, which: 'first' | 'older'): State {
  const next = merge(state, page.threads.flatMap((t) => (t.last ? [t.message, t.last] : [t.message])))
  const listing = listingOf(next, channel)
  const rows = { ...listing?.rows }
  for (const { message, replies, last } of page.threads) {
    const row = { replies, last: last?.id ?? null }
    const kept = Object.hasOwn(rows, message.id) ? rows[message.id] : undefined
    if (!kept || byWritten(activity(next, message.id, kept), activity(next, message.id, row)) <= 0) rows[message.id] = row
  }
  const older = which === 'first' && listing?.loaded ? listing.older : (page.older ?? null)
  return { ...next, listings: { ...next.listings, [channel]: { rows, older, loaded: true } } }
}

/** A channel whose first page is on its way: from now, the stream's posts in it are kept for that page. */
export const listing = (state: State, channel: string): State =>
  listingOf(state, channel) ? state : { ...state, listings: { ...state.listings, [channel]: { rows: {}, older: null, loaded: false } } }

/** A channel whose first page didn't come: it's listed again when it's opened again. */
export function unlisted(state: State, channel: string): State {
  if (listingOf(state, channel)?.loaded !== false) return state
  const listings = { ...state.listings }
  delete listings[channel]
  return { ...state, listings }
}

/** A channel on a board whose thread pages have no `older`: it loads by messages. */
export const unpaged = (state: State, channel: string): State => ({ ...state, listings: { ...state.listings, [channel]: null } })

/** A post in a listed channel: a new thread gets a row, and a reply moves its thread's on, once. */
function listed(state: State, message: MessageView): State {
  const listing = listingOf(state, message.channel)
  if (!listing) return state
  const root = message.re ?? message.id
  const row = rowOf(listing, root)
  let next: Row
  if (message.re === null) {
    if (row) return state
    next = { replies: 0, last: null }
  } else {
    if (!row || byWritten(activity(state, root, row), message) >= 0) return state
    next = { replies: row.replies + 1, last: message.id }
  }
  return { ...state, listings: { ...state.listings, [message.channel]: { ...listing, rows: { ...listing.rows, [root]: next } } } }
}

/**
 * Your post, as the board answered it: in place of the post on its way, and a new thread listed in its
 * channel at once, so it never leaves the page while the stream catches up. A reply's thread moves on
 * when the stream brings it, in order, so replies the stream hasn't brought yet still count.
 */
export function sent(state: State, key: string, message: MessageView): State {
  const next = merge({ ...state, pending: state.pending.filter((p) => p.key !== key) }, [message])
  return message.re === null ? listed(next, message) : next
}

/** The channel of a live reply whose thread its listing doesn't have, so its first page is read again; else null. */
export function unlistedReply(state: State, event: BoardEventView): string | null {
  const message = event.message
  if (event.type !== 'message.posted' || !message || message.re === null) return null
  const listing = listingOf(state, message.channel)
  return listing?.loaded && !rowOf(listing, message.re) ? message.channel : null
}

/** Folds one live event in: the message it concerns, channel counts, listed threads, and actor details. */
export function applyEvent(state: State, event: BoardEventView): State {
  let next = event.message ? merge(state, [event.message]) : state
  if (event.type === 'message.posted' && event.message) {
    next = listed(next, event.message)
    // One to send later isn't on its way as a message: nothing that lands now stands for it.
    const post = landed(next.pending.filter((pending) => pending.later === undefined), event.message, next.me?.actor ?? '')
    if (post) next = { ...next, pending: next.pending.filter((p) => p !== post) }
    const { channel, re } = event.message
    const known = next.channels[channel]
    // A board that counts nothing in its channels (Vercel's API) gets no counts made up here,
    // for a channel a post shows first either.
    const uncounted = known ? known.lastIndex === undefined : Object.values(next.channels).some((c) => c.lastIndex === undefined)
    if (uncounted) {
      if (!known) next = { ...next, channels: { ...next.channels, [channel]: { path: channel } } }
    }
    // A new message's version is where it landed, as a channel's `lastIndex` is.
    else if (!known || (known.lastIndex ?? 0) < event.message.version)
      next = {
        ...next,
        channels: {
          ...next.channels,
          [channel]: {
            path: channel,
            lastIndex: event.message.version,
            messages: (known?.messages ?? 0) + 1,
            threads: (known?.threads ?? 0) + (re === null ? 1 : 0),
          },
        },
      }
  }
  // One made before anything posted to it lists at once, empty; a post that beat it here already did.
  if (event.type === 'channel.created' && !next.channels[event.payload.channel]) {
    const { channel } = event.payload
    next = { ...next, channels: { ...next.channels, [channel]: { path: channel, lastIndex: 0, messages: 0, threads: 0 } } }
  }
  if (event.type === 'actor.seen') {
    const { actor, kind, handle, name, avatar, via, platform } = event.payload
    next = { ...next, actors: { ...next.actors, [actor]: { kind: kind === 'profile' ? 'agent' : kind, handle, name, avatar, ...(via ? { via } : {}), ...(platform ? { platform } : {}) } } }
  }
  // The stream comes in order, so the last event's cursor is where to resume.
  return { ...next, cursor: event.cursor }
}

export function addOp(state: State, message: string, id: string, op: Op): State {
  return { ...state, ops: { ...state.ops, [message]: [...(state.ops[message] ?? []), { id, op }] } }
}

export function dropOp(state: State, message: string, id: string): State {
  const left = (state.ops[message] ?? []).filter((entry) => entry.id !== id)
  const ops = { ...state.ops }
  if (left.length > 0) ops[message] = left
  else delete ops[message]
  return { ...state, ops }
}

/** A message as this page shows it: the board's view, your pending changes, and fresh author details. */
export function shown(state: State, id: string, now = new Date().toISOString()): MessageView | undefined {
  const message = state.messages[id]
  if (!message) return undefined
  let out = message
  for (const { op } of state.ops[id] ?? []) out = apply(out, op, state.me?.actor ?? '', now)
  const actor = state.actors[message.by.actor]
  // Who it acts through, and its platform, stay as the board showed them when what it records now doesn't say.
  const via = actor?.via ?? out.author?.via
  const platform = actor?.platform ?? out.author?.platform
  return actor ? { ...out, author: { ...actor, ...(via ? { via } : {}), ...(platform ? { platform } : {}) } } : out
}

export type Thread = { root: MessageView; replies: MessageView[]; pending: Pending[] }

/** A root's replies at a glance: how many, the latest, and the last three people who wrote one. */
export type ReplySummary = { count: number; last: MessageView | null; faces: MessageView[] }

/** A thread in a channel, with its replies summarized. */
export type ChannelThread = Thread & { summary: ReplySummary }

function summarize(replies: MessageView[], count = replies.length, last: MessageView | null = replies.at(-1) ?? null): ReplySummary {
  const newest = last && replies.length > 0 && byWritten(replies.at(-1)!, last) > 0 ? replies.at(-1)! : last
  const faces = [...new Map([...replies, ...(newest && !replies.includes(newest) ? [newest] : [])].map((r) => [r.by.actor, r])).values()].slice(-3)
  return { count: Math.max(count, replies.filter((r) => !r.deleted).length), last: newest, faces }
}

/**
 * Messages in the order they were written: by when, and between two in the same millisecond, by
 * ID, digits compared as numbers. IDs are the board's to choose, so this is only a tiebreak.
 */
export const byWritten = (a: Pick<MessageView, 'createdAt' | 'id'>, b: Pick<MessageView, 'createdAt' | 'id'>) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id.localeCompare(b.id, undefined, { numeric: true })

/** A channel's threads, oldest first, from the messages loaded so far. */
export function channelThreads(state: State, channel: string): { threads: ChannelThread[]; pending: Pending[] } {
  const roots: MessageView[] = []
  const replies = new Map<string, MessageView[]>()
  for (const message of Object.values(state.messages)) {
    if (message.channel !== channel) continue
    const view = shown(state, message.id)!
    if (message.re === null) roots.push(view)
    else replies.set(message.re, [...(replies.get(message.re) ?? []), view])
  }
  roots.sort(byWritten)
  return {
    threads: roots.map((root) => {
      const loaded = (replies.get(root.id) ?? []).sort(byWritten)
      return { root, replies: loaded, pending: state.pending.filter((post) => post.re === root.id), summary: summarize(loaded) }
    }),
    pending: state.pending.filter((post) => post.channel === channel && post.re === null),
  }
}

/**
 * A channel's listed threads by latest activity, the latest last: each with its row's reply count and latest reply,
 * and the replies loaded so far, from an opened thread or the stream.
 */
export function channelRows(state: State, channel: string): { threads: ChannelThread[]; pending: Pending[] } {
  const rows = listingOf(state, channel)?.rows ?? {}
  const replies = new Map<string, MessageView[]>()
  for (const message of Object.values(state.messages))
    if (message.re !== null && Object.hasOwn(rows, message.re)) replies.set(message.re, [...(replies.get(message.re) ?? []), shown(state, message.id)!])
  const threads = Object.entries(rows).flatMap(([id, row]) => {
    const root = shown(state, id)
    if (!root) return []
    const loaded = (replies.get(id) ?? []).sort(byWritten)
    const last = row.last === null ? null : (shown(state, row.last) ?? null)
    return [{ root, replies: loaded, pending: state.pending.filter((post) => post.re === id), summary: summarize(loaded, row.replies, last) }]
  })
  threads.sort((a, b) => byWritten(a.summary.last ?? a.root, b.summary.last ?? b.root))
  return { threads, pending: state.pending.filter((post) => post.channel === channel && post.re === null) }
}

export function thread(state: State, root: string): Thread | null {
  const view = shown(state, root)
  if (!view) return null
  const replies = Object.values(state.messages)
    .filter((message) => message.re === root)
    .sort(byWritten)
    .map((message) => shown(state, message.id)!)
  return { root: view, replies, pending: state.pending.filter((post) => post.re === root) }
}

/** The newest messages across every channel (that `keep` keeps), oldest first. */
export function recent(state: State, limit = 200, keep: (m: MessageView) => boolean = () => true): MessageView[] {
  return Object.values(state.messages)
    .filter(keep)
    .sort((a, b) => byWritten(b, a))
    .slice(0, limit)
    .reverse()
    .map((message) => shown(state, message.id)!)
}

/** A view's filters, as the board's API takes them: `label` is `key`, `key=value`, or `key=a|b`. */
export type Filter = { from?: string; label: string[]; text?: string }

export const filtering = (filter: Filter) => !!(filter.from || filter.text || filter.label.length)

function hasLabel(labels: Record<string, string>, filter: string): boolean {
  const at = filter.indexOf('=')
  if (at === -1) return filter in labels
  const key = filter.slice(0, at)
  return key in labels && filter.slice(at + 1).split('|').includes(labels[key]!)
}

/** The board's filter rules, for messages already here: labels match on the message or its thread's root. */
export function matches(state: State, message: MessageView, filter: Filter): boolean {
  if (filter.from && (message.from ?? 'board') !== filter.from) return false
  if (filter.text && !message.text.toLowerCase().includes(filter.text.toLowerCase())) return false
  const root = message.re === null ? undefined : state.messages[message.re]
  return filter.label.every((label) => hasLabel(message.labels, label) || (root !== undefined && hasLabel(root.labels, label)))
}

/** Every label key on the loaded messages, with the values each has taken: suggestions for pickers. */
export function knownLabels(state: State): Map<string, Set<string>> {
  const known = new Map<string, Set<string>>()
  for (const message of Object.values(state.messages))
    for (const [key, value] of Object.entries(message.labels)) {
      let values = known.get(key)
      if (!values) known.set(key, (values = new Set()))
      values.add(value)
    }
  return known
}

const GROUP_MS = 5 * 60_000
const sameDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString()

export type Groupable = Pick<MessageView, 'by' | 'createdAt' | 'deleted' | 'channel' | 're'>

/**
 * The platform whose logo a message wears, for one that came from a platform: its author's, as their
 * sync key was registered, or else what the board's sync entries say of the key it came through.
 */
export const sourcePlatform = (m: Pick<MessageView, 'from' | 'author'>, platforms: Record<string, string> = {}): string | null =>
  m.from === null ? null : (m.author?.platform ?? platforms[m.from] ?? m.from)

/**
 * Whether `m` continues `previous` under one header, as Slack shows a run of messages: by the same
 * author in the same place (a channel's threads, or one thread's replies), the same day and close in
 * time, with nothing in between. A thread with replies ends the run, so the next shows who wrote it.
 */
export function continues(previous: Groupable | undefined, m: Groupable, hasReplies = false): boolean {
  return (
    !!previous &&
    !hasReplies &&
    !previous.deleted &&
    previous.by.actor === m.by.actor &&
    previous.channel === m.channel &&
    previous.re === m.re &&
    sameDay(previous.createdAt, m.createdAt) &&
    gap(previous, m) >= 0 &&
    gap(previous, m) < GROUP_MS
  )
}

// A channel lists threads by latest activity, so an older one can come after a newer one: it never runs on from it.
const gap = (previous: Groupable, m: Groupable) => Date.parse(m.createdAt) - Date.parse(previous.createdAt)


// --- who's who ---------------------------------------------------------------------------------

/** Who's looking: what the board says of you (`team.me()`), and what you may do where. */
export type Viewer = {
  actor: string
  principal: string
  /** The profile you write as, or null as yourself. */
  profile: string | null
  may(permission: 'post' | 'label' | 'manage', channel: string): boolean
  /** `manage` at `*`: what registering a schema and listing grants need. */
  manages: boolean
}

/**
 * An actor or a principal by name: as the board last said who they are, or else what their ID
 * says, a profile and the last part of its principal's (`local:user:julian+codex` is `codex via julian`).
 */
export function nameOf(state: State, id: string): string {
  const known = state.actors[id]
  if (known) return shownName(known)
  const plus = id.indexOf('+')
  const principal = plus === -1 ? id : id.slice(0, plus)
  const tail = state.actors[principal]?.name ?? principal.slice(principal.lastIndexOf(':') + 1)
  return plus === -1 ? tail : `${id.slice(plus + 1)} via ${tail}`
}

// --- tasks: a thread with a state ---------------------------------------------------------

// #region guide inspector/task-state.ts
export type TaskState = TaskView['state']

/**
 * A task's state as it stands now. A claim past its lease is over, so its task is ready, whatever
 * the board last wrote: a board with no timers says `claimed` until something asks.
 */
export function stateNow(task: TaskView, now: number): TaskState {
  return task.state === 'claimed' && task.claim !== null && Date.parse(task.claim.until) <= now ? 'ready' : task.state
}
// #endregion

/** A root that's a task. */
export type TaskRoot = MessageView & { task: TaskView }
export const isTask = (message: MessageView | null | undefined): message is TaskRoot => !!message?.task

/** A claim this tab made, by the epoch it was made at. Its token, a secret, stays out of the page's state: the data module keeps it. */
export type Claim = { epoch: number }

/** The states a task can still leave by being worked: what a list shows unless it's asked for more. */
export const OPEN_STATES: readonly TaskState[] = ['waiting', 'ready', 'claimed', 'blocked']

/** The profiles the board has seen a principal write as, then the usual agents: who a task of its can be for. */
export function profilesOf(state: State, principal: string): string[] {
  const seen = Object.keys(state.actors).flatMap((id) => (id.startsWith(`${principal}+`) ? [id.slice(principal.length + 1)] : []))
  return [...new Set([...seen, 'claude', 'codex'])]
}

/** Takes in a claim this tab made: the task as the claim left it, and what its writes carry. */
export function claimed(state: State, view: MessageView, claim: Claim): State {
  const next = merge({ ...state, claims: { ...state.claims, [view.id]: claim } }, [view])
  // The feed can be ahead of the claim's answer: a task that has moved on since isn't held.
  const now = next.messages[view.id]?.task
  return now?.state === 'claimed' && now.epoch === claim.epoch ? next : unclaimed(next, view.id)
}

/** Forgets a claim: the board said it's over. */
export function unclaimed(state: State, task: string): State {
  if (!state.claims[task]) return state
  const claims = { ...state.claims }
  delete claims[task]
  return { ...state, claims }
}

/** The claim this tab holds on a task, while it's live: the board still shows it, and its lease hasn't run out. */
export function holding(state: State, root: TaskRoot, now: number): Claim | undefined {
  const claim = state.claims[root.id]
  const { task } = root
  return claim && task.state === 'claimed' && task.epoch === claim.epoch && task.claim !== null && Date.parse(task.claim.until) > now ? claim : undefined
}

/**
 * What the viewer can do to a task now, by the board's rules, so the page offers only that. The
 * board decides each write all the same: a view can be a moment old.
 */
export type Moves = {
  claim: boolean
  /** This tab holds its claim: it can renew, release, complete, fail, and block it. */
  held: boolean
  /** The viewer holds it, but not from this tab: the claim was made elsewhere, or a reload lost it. */
  elsewhere: boolean
  /** As its owner, or with `manage` in its channel. `hold` blocks one no one has claimed. */
  hold: boolean
  unblock: boolean
  reopen: boolean
  assign: boolean
  cancel: boolean
}

export function moves(state: State, root: TaskRoot, viewer: Viewer, now: number): Moves {
  const { task, channel } = root
  const current = stateNow(task, now)
  const finished = current === 'completed' || current === 'failed' || current === 'canceled'
  // Its owner changes it: the principal itself, as no profile, or the one of its actors that made
  // it a task (`by`). The owner comes first: another principal's own ID can read the same as `by`.
  const mine = task.owner === viewer.principal && (viewer.profile === null || task.by === viewer.actor)
  const owns = viewer.may('manage', channel) || (mine && (viewer.may('post', channel) || viewer.may('label', channel)))
  const held = holding(state, root, now) !== undefined
  return {
    claim: current === 'ready' && !root.deleted && viewer.may('label', channel) && (task.for === null || (task.for === viewer.actor && task.owner === viewer.principal)),
    held,
    elsewhere: !held && current === 'claimed' && task.claim?.actor === viewer.actor,
    hold: owns && (current === 'waiting' || current === 'ready'),
    unblock: owns && current === 'blocked',
    reopen: owns && current === 'failed',
    assign: owns && !finished,
    cancel: owns && current !== 'completed' && current !== 'canceled',
  }
}

/** Which tasks a list shows, as the board's API takes them: `channel` is a channel or, with a trailing `/`, it and what's under it. */
export type TaskFilter = { channel?: string; state: 'open' | 'all' | TaskState; label: string[]; owner?: string; for?: string }

const inChannel = (channel: string, wanted: string) => (wanted.endsWith('/') ? channel === wanted.slice(0, -1) || channel.startsWith(wanted) : channel === wanted)

/** Where a task list can look: a tree (`work/`, it and what's under it) or one channel, and how many of your channels it holds. */
export type TaskPlace = { place: string; channels: number }

/**
 * The places one level below `under`, a tree such as `work/`, or below the whole board without it:
 * the tree's own channel, each tree under it, and each channel with nothing under it, by name. For a
 * board that lists tasks a tree at a time, as Vercel's does for a caller who doesn't read every
 * channel: a tree that's still too big has places of its own.
 */
export function placesUnder(channels: string[], under?: string): TaskPlace[] {
  const base = under === undefined ? '' : under.endsWith('/') ? under : `${under}/`
  const own = base.slice(0, -1)
  const inside = channels.filter((path) => path.startsWith(base))
  const treeOf = (path: string) => `${base}${path.slice(base.length).split('/')[0]}/`
  const trees = new Set(inside.filter((path) => path.slice(base.length).includes('/')).map(treeOf))
  const found = new Map<string, TaskPlace>()
  if (base && channels.includes(own)) found.set(own, { place: own, channels: 1 })
  for (const path of inside) {
    // A channel with channels under it goes with them, in its tree: the tree holds it.
    const place = trees.has(treeOf(path)) ? treeOf(path) : path
    const known = found.get(place)
    if (known) known.channels++
    else found.set(place, { place, channels: 1 })
  }
  return [...found.values()].sort((a, b) => (a.place < b.place ? -1 : a.place > b.place ? 1 : 0))
}

/** The board's rules for a task list, for tasks already here, so one that changes state moves in or out as it happens. */
export function taskMatches(root: TaskRoot, filter: TaskFilter, now: number): boolean {
  const { task } = root
  if (root.deleted) return false
  if (filter.channel && !inChannel(root.channel, filter.channel)) return false
  // Open is what the task wears; a state by name is what it is now, so a lapsed claim lists as ready.
  if (filter.state === 'open' ? !OPEN_STATES.includes(task.state) : filter.state !== 'all' && stateNow(task, now) !== filter.state) return false
  if (filter.owner && task.owner !== filter.owner) return false
  if (filter.for && task.for !== filter.for) return false
  return filter.label.every((label) => hasLabel(root.labels, label))
}

/**
 * The loaded tasks a filter keeps, oldest first: the order a queue works them in. While the board
 * has more than it listed, the list ends at `through`, the last one it did, so a new task doesn't
 * show after a gap.
 */
export function tasks(state: State, filter: TaskFilter, now: number, through?: Pick<MessageView, 'createdAt' | 'id'>): TaskRoot[] {
  const found: TaskRoot[] = []
  for (const message of Object.values(state.messages)) {
    if (!isTask(message) || !taskMatches(message, filter, now)) continue
    if (through && byWritten(message, through) > 0) continue
    found.push(shown(state, message.id) as TaskRoot)
  }
  return found.sort(byWritten)
}

/** How many tasks are open, once every open one is loaded. */
export const openTasks = (state: State): number | null =>
  state.tasksCounted ? Object.values(state.messages).filter((m) => isTask(m) && !m.deleted && OPEN_STATES.includes(m.task.state)).length : null

// --- blocks and schemas -------------------------------------------------------------------

/** A piece of a message's body: prose, or a block the board read out of it. */
export type BodyPart = { text: string } | { block: BlockView }

/**
 * A message's text as prose and blocks, in order. A block is a fence in the text that names a
 * schema; only the ones the board lists are blocks (it checked them), so a fence in a platform's
 * text stays text. Blocks the text can't place come after it.
 */
export function bodyParts(text: string, blocks: BlockView[]): BodyPart[] {
  if (blocks.length === 0) return text.trim() ? [{ text }] : []
  const fences = findBlocks(text).filter((found) => found.data !== undefined && found.name !== undefined)
  if (fences.length !== blocks.length) return [...(text.trim() ? [{ text }] : []), ...blocks.map((block) => ({ block }))]
  const parts: BodyPart[] = []
  let at = 0
  fences.forEach((fence, i) => {
    const before = text.slice(at, fence.start)
    if (before.trim()) parts.push({ text: before })
    parts.push({ block: blocks[i]! })
    at = fence.end
  })
  if (text.slice(at).trim()) parts.push({ text: text.slice(at) })
  return parts
}

/** A registered schema version, or undefined for one the registry doesn't hold (or hasn't been read). */
export const schemaOf = (state: Pick<State, 'schemas'>, name: string, version: number): SchemaView | undefined =>
  state.schemas?.find((schema) => schema.name === name && schema.version === version)

/** A block's fields, in the order its schema lists them, then any it doesn't: each with what the schema says of it. */
export function blockFields(block: BlockView, schema: SchemaView | undefined): { name: string; value: unknown; description?: string }[] {
  const defined = schema?.schema.properties
  // A property's definition may be `true` or `false`, which says nothing of it.
  const properties = (isRecord(defined) ? defined : {}) as Record<string, unknown>
  const names = [...Object.keys(properties).filter((name) => name in block.data), ...Object.keys(block.data).filter((name) => !(name in properties))]
  return names.map((name) => {
    const property = properties[name]
    const description = isRecord(property) ? property.description : undefined
    return { name, value: block.data[name], ...(typeof description === 'string' ? { description } : {}) }
  })
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * A property's type in a word. A JSON Schema property is an object, or `true` for anything and
 * `false` for nothing, and an object may name no type at all.
 */
export function propertyType(property: unknown): string {
  if (property === false) return 'never'
  if (!isRecord(property)) return 'any'
  const type = Array.isArray(property.type) ? property.type.join(' | ') : typeof property.type === 'string' ? property.type : Array.isArray(property.enum) ? 'enum' : 'const' in property ? 'const' : 'any'
  return typeof property.format === 'string' ? `${type} (${property.format})` : type
}

/** A schema's properties as rows: each one's name, its type in a word, whether it's required, and what the schema says of it. */
export function schemaFields(schema: Record<string, unknown>): { name: string; type: string; required: boolean; description: string }[] {
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  return Object.entries(isRecord(schema.properties) ? schema.properties : {}).map(([name, property]) => ({
    name,
    type: propertyType(property),
    required: required.has(name),
    description: isRecord(property) && typeof property.description === 'string' ? property.description : '',
  }))
}

/** The registry by name: each schema's versions, oldest first, built-ins before the board's own. */
export function schemasByName(schemas: SchemaView[]): { name: string; builtIn: boolean; versions: SchemaView[] }[] {
  const names = new Map<string, SchemaView[]>()
  for (const schema of schemas) names.set(schema.name, [...(names.get(schema.name) ?? []), schema])
  return [...names]
    .map(([name, versions]) => ({ name, builtIn: versions.some((v) => v.builtIn), versions: versions.sort((a, b) => a.version - b.version) }))
    .sort((a, b) => Number(b.builtIn) - Number(a.builtIn) || a.name.localeCompare(b.name))
}

/** Takes in a schema version the board registered, once. */
export function addSchema(state: State, schema: SchemaView): State {
  if (state.schemas?.some((known) => known.id === schema.id)) return state
  return { ...state, schemas: [...(state.schemas ?? []), schema] }
}

// --- what a board answers when asked for a list ---------------------------------------------

/** A list the page asked the board for: not asked yet, on its way, here, or what the board answered instead. */
export type Listed<T> = { is: 'unasked' } | { is: 'loading' } | { is: 'here'; items: T[] } | { is: 'failed'; why: string }

// --- access -----------------------------------------------------------------------------------

/**
 * What a grant gives, from lines as the CLI writes them: `work/=read,post`, `secrets/=none`,
 * `*=all`. Which patterns and permissions exist is the board's to say; this only reads the shape.
 */
export function canFromLines(text: string): { can: Record<string, 'all' | 'none' | string[]> } | { problem: string } {
  const can: Record<string, 'all' | 'none' | string[]> = {}
  for (const line of text.split(/[\n;]/).map((line) => line.trim()).filter(Boolean)) {
    const at = line.indexOf('=')
    const pattern = at === -1 ? '' : line.slice(0, at).trim()
    const gives = line.slice(at + 1).trim()
    if (!pattern || !gives) return { problem: `${line} isn't pattern=permissions, like work/=read,post` }
    can[pattern] = gives === 'all' || gives === 'none' ? gives : gives.split(',').map((permission) => permission.trim()).filter(Boolean)
  }
  return Object.keys(can).length > 0 ? { can } : { problem: 'say what it gives: a line like work/=read,post' }
}

// --- schedules ---------------------------------------------------------------------------------

/** The pending schedules that reply in a thread, soonest first. */
export function threadSchedules(state: State, root: string): ScheduleView[] {
  if (state.schedules.is !== 'here') return []
  return state.schedules.items.filter((schedule) => schedule.re === root && schedule.state === 'pending').sort((a, b) => (a.next ?? '').localeCompare(b.next ?? ''))
}
