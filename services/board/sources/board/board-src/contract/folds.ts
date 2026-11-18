// The board's views as plain folds and the types they keep, on no engine: `reducers.ts` hands
// them to A2, and anything else (a store's tables, a handle) folds with them directly.
import { canonicalEmoji } from './emoji.ts'
import { own, setOwn } from './own.ts'
import { actorKind, TASK_LABEL, type ActorKind, type Attachment, type Author, type Labels, type TaskState } from './schemas.ts'
import type { BoardEvent } from './events.ts'
import { externalMessageKey, isThreadTarget, type Link, type Origin } from './external.ts'
import type { Via } from './profiles.ts'

// A2 clones state at every read and snapshot boundary, so these folds mutate
// in place: an event costs O(1) instead of a copy of every message. A key a
// caller or platform chose is read with `own` and written with `setOwn`, so a
// handle or a channel named `constructor` is like any other.

/**
 * A task as the board keeps it on its root: the state the root's `board.task` label wears, and what
 * goes with it. Views show all of it but a claim's `token`.
 */
export type Task = {
  state: TaskState
  /** The principal that made the thread a task. */
  owner: string
  /** The actor it did that as: itself, or one of its profiles, which is held to the tasks it made. */
  by: string
  /** The one actor that claims it, or null when anyone who may does. */
  for: string | null
  /** The tasks it waits for, by their roots' IDs. */
  needs: number[]
  /** How many times it's been claimed: a claim's writes carry the epoch it was made at. */
  epoch: number
  /** Who holds it, until when. `token` is the SHA-256 of the claim's secret, hex. */
  claim: { actor: string; until: string; token: string } | null
  blocked: { kind: string | null; reason: string } | null
  /** What it came to, once it's completed. */
  result: string | null
  /** Why it failed or was canceled. */
  reason: string | null
}

export type Message = {
  id: number
  channel: string
  text: string
  re: number | null
  replyTo: number | null
  /** The thread key: the root's event ID. */
  thread: string
  labels: Labels
  reactions: Record<string, string[]>
  by: Author
  noSync: boolean
  /** Where it came from on a platform, if it did. */
  origin: Origin | null
  /** The sync key it came from, or null when written on the board. */
  from: string | null
  createdAt: string
  editedAt: string | null
  deleted: boolean
  /** Sync targets this message didn't reach, with why. A later delivery clears its entry. */
  undelivered: Record<string, string>
  attachments: Attachment[]
  /** Platform messages it links to (Slack permalinks), each with what it said. */
  links: Link[]
  /** Set when a schedule posted it: the schedule's ID and which send this was, from 0. */
  schedule?: { id: number; n: number }
  /** Set on a root that's a task. Its `state` is the root's `board.task` label too, while the root isn't deleted. */
  task?: Task
  /**
   * Set when its author couldn't read its channel, as `authorizeOwn` checks: where they can't read,
   * it's theirs to edit and delete only then. Its event's payload says so too.
   */
  blind?: true
  /**
   * Set while its text is a platform's though it was written on the board: its last edit is one a
   * sync brought in, which the board can't refuse or check. An edit made on the board clears it.
   */
  platformText?: true
  /** The index of the last event that changed it. Folds from before it existed leave it out. */
  version?: number
  /** The index of its post, or of its last edit or delete. Folds from before it existed leave it out. */
  revision?: number
}

export type MessagesState = {
  byId: Record<string, Message>
  /** Thread root → reply IDs, in log order. */
  replies: Record<string, number[]>
}

export const iso = (date: Date | string): string =>
  typeof date === 'string' ? date : date.toISOString()

export function foldMessages(
  state: MessagesState,
  event: BoardEvent,
): MessagesState {
  // Each change to a message is its newest version, so of two views of it, the later is newer.
  const changed = foldMessage(state, event)
  if (changed) changed.version = event.index
  // Only what an edit's `revision` checks: its text, and whether it's there.
  if (changed && (event.type === 'message.posted' || event.type === 'message.edited' || event.type === 'message.deleted')) changed.revision = event.index
  return state
}

/** Applies `event`, and returns the message it changed: none for an event that changes nothing. */
function foldMessage(state: MessagesState, event: BoardEvent): Message | undefined {
  switch (event.type) {
    case 'message.posted': {
      const { payload } = event
      const message: Message = {
        id: event.index,
        channel: payload.channel,
        text: payload.text,
        re: payload.re,
        replyTo: payload.replyTo,
        thread: payload.thread,
        labels: { ...payload.labels },
        reactions: {},
        by: payload.by,
        noSync: payload.noSync,
        origin: payload.origin,
        from: payload.from,
        createdAt: iso(event.createdAt),
        editedAt: null,
        deleted: false,
        undelivered: {},
        attachments: payload.attachments ?? [],
        links: payload.links ?? [],
        ...(payload.schedule ? { schedule: { ...payload.schedule } } : {}),
        ...(payload.blind ? { blind: true as const } : {}),
      }
      state.byId[event.index] = message
      if (payload.re !== null) (state.replies[payload.re] ??= []).push(event.index)
      return message
    }
    case 'message.edited': {
      const message = state.byId[event.payload.id]
      if (!message || message.deleted) return undefined
      message.text = event.payload.text
      message.editedAt = iso(event.createdAt)
      if (message.from === null && event.payload.from !== null) message.platformText = true
      else delete message.platformText
      return message
    }
    case 'message.deleted': {
      const message = state.byId[event.payload.id]
      if (!message || message.deleted) return undefined
      message.deleted = true
      message.text = ''
      message.reactions = {}
      // Labels are state a filter finds: a tombstone in a label's view would still look open.
      message.labels = {}
      message.attachments = []
      message.links = []
      return message
    }
    case 'reaction.added': {
      const message = state.byId[event.payload.id]
      if (!message || message.deleted) return undefined
      // Older events may use Slack's names (`+1`); they group with Chat SDK's (`thumbs_up`).
      const emoji = canonicalEmoji(event.payload.emoji)
      const actors = own(message.reactions, emoji)
      if (actors?.includes(event.payload.by.actor)) return undefined
      if (actors) actors.push(event.payload.by.actor)
      else setOwn(message.reactions, emoji, [event.payload.by.actor])
      return message
    }
    case 'reaction.removed': {
      const message = state.byId[event.payload.id]
      if (!message || message.deleted) return undefined
      const { by } = event.payload
      const emoji = canonicalEmoji(event.payload.emoji)
      const had = own(message.reactions, emoji)
      if (!had?.includes(by.actor)) return undefined
      const actors = had.filter((a) => a !== by.actor)
      if (actors.length > 0) setOwn(message.reactions, emoji, actors)
      else delete message.reactions[emoji]
      return message
    }
    case 'labels.changed': {
      const message = state.byId[event.payload.id]
      if (!message || message.deleted) return undefined
      for (const [key, value] of Object.entries(event.payload.set)) setOwn(message.labels, key, value)
      for (const key of event.payload.unset) delete message.labels[key]
      return message
    }
    case 'message.linked': {
      const message = state.byId[event.payload.id]
      if (!message || message.deleted) return undefined
      message.links = event.payload.links
      return message
    }
    case 'message.sync_failed': {
      const message = state.byId[event.payload.id]
      if (!message) return undefined
      setOwn(message.undelivered, event.payload.target, event.payload.error)
      return message
    }
    case 'message.synced': {
      const message = state.byId[event.payload.id]
      // Most receipts are for a delivery that never failed: nothing to clear.
      if (!message || !Object.hasOwn(message.undelivered, event.payload.target)) return undefined
      delete message.undelivered[event.payload.target]
      return message
    }
    case 'task.created': {
      const message = state.byId[event.payload.id]
      // A thread becomes a task once, at its root, while the root is there.
      if (!message || message.deleted || message.re !== null || message.task) return undefined
      const { needs, by } = event.payload
      message.task = { state: needs.length > 0 ? 'waiting' : 'ready', owner: by.principal, by: by.actor, for: event.payload.for, needs: [...needs], epoch: 0, claim: null, blocked: null, result: null, reason: null }
      return labeled(message)
    }
    case 'task.assigned':
    case 'task.needs_changed':
    case 'task.ready':
    case 'task.claimed':
    case 'task.renewed':
    case 'task.released':
    case 'task.expired':
    case 'task.completed':
    case 'task.failed':
    case 'task.blocked':
    case 'task.unblocked':
    case 'task.canceled':
    case 'task.reopened': {
      const message = state.byId[event.payload.id]
      if (!message?.task || !foldTask(message.task, event)) return undefined
      return labeled(message)
    }
    default:
      return undefined
  }
}

/** `message`, a task's root, wearing its task's state as `board.task`. A tombstone wears no labels, this one included. */
function labeled(message: Message): Message {
  if (!message.deleted) setOwn(message.labels, TASK_LABEL, message.task!.state)
  return message
}

type TaskEvent = Extract<BoardEvent, { type: `task.${string}` }>

/** Whether a claim's write is by the claim that holds the task: the same epoch, while it's claimed. */
const holds = (task: Task, epoch: number) => task.state === 'claimed' && task.epoch === epoch

/**
 * Applies a task's event to it, and says whether it changed anything. Each event lands only from
 * the states it can leave, so one written against a task that has since moved on changes nothing:
 * the writes check first, and this is what holds if one didn't.
 */
function foldTask(task: Task, event: Exclude<TaskEvent, { type: 'task.created' }>): boolean {
  switch (event.type) {
    case 'task.assigned':
      if (task.for === event.payload.for) return false
      task.for = event.payload.for
      return true
    case 'task.needs_changed':
      // What it waits for changes while no one holds it and it isn't finished. It waits again when it waits for
      // any task: `task.ready` follows at once when they've all completed. One held for a person stays held.
      if (task.state !== 'waiting' && task.state !== 'ready' && task.state !== 'blocked') return false
      task.needs = [...event.payload.needs]
      if (task.state !== 'blocked') task.state = task.needs.length > 0 ? 'waiting' : 'ready'
      return true
    case 'task.ready':
      if (task.state !== 'waiting') return false
      task.state = 'ready'
      return true
    case 'task.claimed': {
      const { epoch, until, token, by } = event.payload
      if (task.state !== 'ready' || epoch !== task.epoch + 1) return false
      task.state = 'claimed'
      task.epoch = epoch
      task.claim = { actor: by.actor, until, token }
      return true
    }
    case 'task.renewed':
      if (!holds(task, event.payload.epoch)) return false
      task.claim!.until = event.payload.until
      return true
    case 'task.released':
    case 'task.expired':
      if (!holds(task, event.payload.epoch)) return false
      task.state = 'ready'
      task.claim = null
      return true
    case 'task.completed':
      if (!holds(task, event.payload.epoch)) return false
      task.state = 'completed'
      task.claim = null
      task.result = event.payload.result
      return true
    case 'task.failed':
      if (!holds(task, event.payload.epoch)) return false
      task.state = 'failed'
      task.claim = null
      task.reason = event.payload.reason
      return true
    case 'task.blocked':
      if (task.state !== 'waiting' && task.state !== 'ready' && task.state !== 'claimed') return false
      task.state = 'blocked'
      task.claim = null
      task.blocked = { kind: event.payload.kind, reason: event.payload.reason }
      return true
    case 'task.unblocked':
      if (task.state !== 'blocked') return false
      // Back to waiting when it waits for any task: `task.ready` follows at once when they've all completed.
      task.state = task.needs.length > 0 ? 'waiting' : 'ready'
      task.blocked = null
      return true
    case 'task.canceled':
      if (task.state === 'completed' || task.state === 'canceled') return false
      task.state = 'canceled'
      task.claim = null
      task.blocked = null
      task.reason = event.payload.reason
      return true
    case 'task.reopened':
      // A failed task was claimed, so every task it needs had completed: it's ready.
      if (task.state !== 'failed') return false
      task.state = 'ready'
      task.reason = null
      return true
  }
}

export type Channel = {
  path: string
  lastIndex: number
  messages: number
  threads: number
}

export type ChannelsState = Record<string, Channel>

export type Actor = {
  id: string
  kind: ActorKind
  handle: string
  name: string
  avatar: string | null
  /** Who an actor with a profile (an agent, or a platform user a sync speaks for) acts through. */
  via?: Via
  /** A platform user's platform (`slack`), as their sync key was registered with: for display. */
  platform?: string
  /** A host's principal, or one of its profiles: once it's seen as one, it stays one. Views leave it out. */
  host?: true
  /** Its last `actor.seen` was by a write whose credential named it as shown. Each write says it anew. */
  verified?: true
}

export type ActorsState = {
  byId: Record<string, Actor>
  /** Lowercased handle → actor IDs. Handles aren't reserved, so several can share one. */
  byHandle: Record<string, string[]>
}

/** Who's who: `actor.seen`. */
export function foldActors(state: ActorsState, event: BoardEvent): ActorsState {
  if (event.type !== 'actor.seen') return state
  const { actor, kind, handle, name, avatar, via, platform, host, verified } = event.payload
  const previous = own(state.byId, actor)
  if (previous) {
    const key = previous.handle.toLowerCase()
    const remaining = (own(state.byHandle, key) ?? []).filter((id) => id !== actor)
    if (remaining.length > 0) setOwn(state.byHandle, key, remaining)
    else delete state.byHandle[key]
  }
  setOwn(state.byId, actor, { id: actor, kind: actorKind(kind), handle, name, avatar, ...(via ? { via: { ...via } } : {}), ...(platform ? { platform } : {}), ...(host || previous?.host ? { host: true as const } : {}), ...(verified ? { verified: true as const } : {}) })
  const key = handle.toLowerCase()
  const ids = own(state.byHandle, key) ?? setOwn(state.byHandle, key, [])
  if (!ids.includes(actor)) ids.push(actor)
  return state
}

/** A copy of a board message on a platform. */
/** `files`: the platform's IDs for the message's files, or null when it refused them; unset until they're sent. */
/** `by`: the principal of the sync elsewhere that recorded it, whose copy it is to change; none for the board's own sync's. */
export type ExternalCopy = { thread: string; message: string; files?: string[] | null; by?: string }

export type SyncedThread = {
  root: number
  channel: string
  kinds?: Record<string, 'channel' | 'thread'>
  /** External channels (start a thread there) and threads (joined), in sync order. */
  targets: string[]
  /** Target → the external thread it resolved to. A thread target resolves to itself. */
  external: Record<string, string>
}

export type SyncState = {
  /** Thread key → its sync. */
  threads: Record<string, SyncedThread>
  /** External thread (grouped) → thread key. */
  byExternalThread: Record<string, string>
  /** Board message → target → its copy there. Includes the copy it came from. */
  copies: Record<string, Record<string, ExternalCopy>>
  /** `${external thread}|${platform message ID}` → board message. */
  byExternalMessage: Record<string, number>
}

const addTarget = (thread: SyncedThread, target: string) => {
  if (!thread.targets.includes(target)) thread.targets.push(target)
}

export function foldSync(state: SyncState, event: BoardEvent): SyncState {
  switch (event.type) {
    case 'message.posted': {
      const { payload } = event
      if (payload.re === null)
        setOwn(state.threads, payload.thread, { root: event.index, channel: payload.channel, targets: [], external: {} })
      const origin = payload.origin
      if (!origin) return state
      const thread = own(state.threads, payload.thread)
      if (thread && payload.re === null) {
        addTarget(thread, origin.thread)
        setOwn((thread.kinds ??= {}), origin.thread, 'thread')
        setOwn(thread.external, origin.thread, origin.thread)
        setOwn(state.byExternalThread, origin.thread, payload.thread)
      }
      const precise = origin.subthread ?? origin.thread
      setOwn((state.copies[event.index] ??= {}), origin.thread, { thread: precise, message: origin.message, ...(payload.importedBy ? { by: payload.importedBy } : {}) })
      state.byExternalMessage[externalMessageKey(precise, origin.message)] = event.index
      // A sub-thread's message is its thread's too: a link to it may name only the thread (a GitHub review comment's does).
      if (precise !== origin.thread) state.byExternalMessage[externalMessageKey(origin.thread, origin.message)] = event.index
      return state
    }
    case 'thread.synced': {
      const thread = own(state.threads, event.payload.thread)
      if (!thread) return state
      const claims = (event.payload.kind ?? (isThreadTarget(event.payload.target) ? 'thread' : 'channel')) === 'thread'
      // A platform thread is one board thread's: a second claim to it, which a write refuses, is ignored.
      const owner = claims ? own(state.byExternalThread, event.payload.target) : undefined
      if (owner !== undefined && owner !== event.payload.thread) return state
      addTarget(thread, event.payload.target)
      if (event.payload.kind) setOwn((thread.kinds ??= {}), event.payload.target, event.payload.kind)
      if (claims) {
        setOwn(thread.external, event.payload.target, event.payload.target)
        setOwn(state.byExternalThread, event.payload.target, event.payload.thread)
      }
      return state
    }
    case 'message.files_synced': {
      // Only the sync whose copy it is says what its files are there.
      const copies = state.copies[event.payload.id]
      const copy = copies && own(copies, event.payload.target)
      if (copy && copy.by === event.payload.syncedBy) copy.files = event.payload.files
      return state
    }
    case 'message.synced': {
      const { id, target, external, syncedBy } = event.payload
      setOwn((state.copies[id] ??= {}), target, { ...external, ...(syncedBy ? { by: syncedBy } : {}) })
      state.byExternalMessage[externalMessageKey(external.thread, external.message)] = id
      const thread = own(state.threads, event.payload.thread)
      // A copy posted into a sub-thread (a reply in a GitHub review thread) is its thread's too, as one that came in is.
      const main = thread ? own(thread.external, target) : undefined
      if (main && main !== external.thread) state.byExternalMessage[externalMessageKey(main, external.message)] = id
      if (thread && thread.root === id && ((thread.kinds && own(thread.kinds, target)) ?? (isThreadTarget(target) ? 'thread' : 'channel')) === 'channel') {
        setOwn(thread.external, target, external.thread)
        setOwn(state.byExternalThread, external.thread, event.payload.thread)
      }
      return state
    }
    default:
      return state
  }
}

