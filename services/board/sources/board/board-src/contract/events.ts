// The board log's events, as plain zod: what a handle reads and the folds take, on any
// backend. `contract.ts` hands them to A2 as the board's contract.
import { z } from 'zod'
import {
  ActorId,
  Attachment,
  ATTACHMENTS_PER_MESSAGE_MAX,
  SeenActorKind,
  Author,
  ChannelPath,
  Emoji,
  Handle,
  LabelKey,
  Labels,
  MessageId,
  MessageText,
  MESSAGE_TEXT_MAX,
  RemoteWatcherId,
  CAN_MAX,
  storable,
  TASK_NEEDS_MAX,
  TaskHoldKind,
  TaskNote,
} from './schemas.ts'
import { ExternalEvent, ExternalTarget, Link, LINKS_PER_MESSAGE_MAX, Origin } from './external.ts'

/** The sync key a write came from, or null when it was written on the board. */
const From = z.string().nullable()

/** The thread key: the event ID of the thread's root. Lanes and sync state are keyed by it. */
const ThreadKey = z.string().min(1).max(200).refine(storable, 'thread key has a NUL character or a lone surrogate')

/** The task an event changes: its root's ID, and the root's thread key, which lanes go by. */
const Task = { id: MessageId, thread: ThreadKey }
/** The most events a new thread's own append carries after its post: `task.created`, `task.ready`, and `task.claimed`. */
export const ALONG_MAX = 3

/** Which claim of a task this is: 1 for its first, one more for each after. A write that names an older one changes nothing. */
const Epoch = z.number().int().positive()
/** When a claim's lease runs out, as an ISO time. */
const Until = z.string().datetime()

/** The board's one log. Every board fact is an event in session `board`. */
export const boardEvents = {
    'message.posted': z.object({
      channel: ChannelPath,
      /** Empty only when the message has attachments. */
      text: z.union([MessageText, z.literal('')]),
      /** The thread root, or null for a root. */
      re: MessageId.nullable(),
      /** The exact message replied to, when it isn't the root. */
      replyTo: MessageId.nullable(),
      thread: ThreadKey,
      labels: Labels,
      noSync: z.boolean(),
      by: Author,
      origin: Origin.nullable(),
      from: From,
      /** Files on the message. Events written before attachments have none. */
      attachments: z.array(Attachment).max(ATTACHMENTS_PER_MESSAGE_MAX).optional(),
      /** Platform messages it links to. Events written before links have none. */
      links: z.array(Link).max(LINKS_PER_MESSAGE_MAX).optional(),
      /** (server) Posted by a schedule: its ID and which send this is, from 0. Other messages have none. */
      schedule: z.object({ id: z.number().int().positive(), n: z.number().int().nonnegative() }).optional(),
      /**
       * (server) Its author couldn't read the channel it posted in. Where a
       * caller can't read, it edits and deletes only these of its own. Events
       * from before channel access have none: everyone read everything then.
       */
      blind: z.literal(true).optional(),
      /**
       * (server) How many events right after it, in its own append, are about it: what made a new
       * thread a task. A writer that can't read its channel gets those back with its post on a
       * retry, and nothing written since. A post that came alone has none.
       */
      along: z.number().int().positive().max(ALONG_MAX).optional(),
      /**
       * (server) The principal of the sync elsewhere that imported it, whose copy `origin` names:
       * that sync's to act on. None for the board's own sync, or a write on the board.
       */
      importedBy: ActorId.optional(),
    }),
    /**
     * A channel made before anything posted to it. A post makes one too, with no event of its own:
     * this is only for one that's empty. It names no message, so it carries no `id`.
     */
    'channel.created': z.object({ channel: ChannelPath, by: Author }),
    /** A message's links changed: an edit linked something new, or the platform sent what a link says. */
    'message.linked': z.object({ id: MessageId, thread: ThreadKey, links: z.array(Link).max(LINKS_PER_MESSAGE_MAX), by: Author, from: From }),
    'message.edited': z.object({
      id: MessageId,
      thread: ThreadKey,
      text: MessageText,
      by: Author,
      from: From,
    }),
    'message.deleted': z.object({ id: MessageId, thread: ThreadKey, by: Author, from: From }),
    'reaction.added': z.object({ id: MessageId, thread: ThreadKey, emoji: Emoji, by: Author, from: From }),
    'reaction.removed': z.object({ id: MessageId, thread: ThreadKey, emoji: Emoji, by: Author, from: From }),
    'labels.changed': z.object({
      id: MessageId,
      thread: ThreadKey,
      set: Labels,
      unset: z.array(LabelKey),
      by: Author,
    }),
    /** A thread is synced with an external channel (start a thread there) or thread (join it). */
    'thread.synced': z.object({
      thread: ThreadKey,
      target: ExternalTarget,
      cause: z.enum(['config', 'request']),
      kind: z.enum(['channel', 'thread']).optional(),
      by: Author,
    }),
    /** An outbound delivery receipt: board message `id` exists on the platform as `external`. */
    'message.synced': z.object({
      id: MessageId,
      thread: ThreadKey,
      target: ExternalTarget,
      external: z.object({
        thread: ExternalTarget,
        message: z.string().min(1).max(300),
      }),
      /**
       * (server) The principal of the sync elsewhere that recorded it: its copy is that sync's to
       * change. None for the board's own sync.
       */
      syncedBy: ActorId.optional(),
    }),
    /**
     * Board message `id`'s files reached `target` after its text: `files` are the
     * platform's IDs for them, or null when the platform refused files and the
     * text got a line for each instead.
     */
    'message.files_synced': z.object({
      id: MessageId,
      thread: ThreadKey,
      target: ExternalTarget,
      files: z.array(z.string().min(1).max(300)).max(ATTACHMENTS_PER_MESSAGE_MAX).nullable(),
      /** (server) As on `message.synced`: only the sync that recorded the copy sets its files. */
      syncedBy: ActorId.optional(),
    }),
    /** A delivery that gave up: board message `id` didn't reach `target`, and `error` says why. */
    'message.sync_failed': z.object({
      id: MessageId,
      thread: ThreadKey,
      target: ExternalTarget,
      error: z.string().min(1).max(500),
    }),
    /**
     * The thread rooted at `id` is a task, and `by.principal` owns it. It waits while it has `needs`,
     * until `task.ready` says they've all completed; with none, it's ready.
     */
    'task.created': z.object({ ...Task, needs: z.array(MessageId).max(TASK_NEEDS_MAX), for: ActorId.nullable(), by: Author }),
    /** Only actor `for` claims it now, or with null, anyone who may. */
    'task.assigned': z.object({ ...Task, for: ActorId.nullable(), by: Author }),
    /**
     * It waits for `needs` now, in place of what it waited for. As from `task.created`, it waits
     * while it has any, until `task.ready` says they've all completed, and with none it's ready. One
     * that's held stays held.
     */
    'task.needs_changed': z.object({ ...Task, needs: z.array(MessageId).max(TASK_NEEDS_MAX), by: Author }),
    /** (server) Every task it needs has completed. */
    'task.ready': z.object(Task),
    /** (server) `by` holds it until `until`. `token` is the SHA-256 of the claim's secret, hex: no view shows it. */
    'task.claimed': z.object({ ...Task, epoch: Epoch, until: Until, token: z.string().regex(/^[0-9a-f]{64}$/), by: Author }),
    'task.renewed': z.object({ ...Task, epoch: Epoch, until: Until, by: Author }),
    'task.released': z.object({ ...Task, epoch: Epoch, by: Author }),
    /** (server) Its lease ran out. */
    'task.expired': z.object({ ...Task, epoch: Epoch }),
    'task.completed': z.object({ ...Task, epoch: Epoch, result: TaskNote.nullable(), by: Author }),
    'task.failed': z.object({ ...Task, epoch: Epoch, reason: TaskNote, by: Author }),
    /** Held for a person, which ends any claim. Kind `edited` is the board's: `by` edited its root, and isn't its owner. */
    'task.blocked': z.object({ ...Task, kind: TaskHoldKind.nullable(), reason: TaskNote, by: Author }),
    'task.unblocked': z.object({ ...Task, by: Author }),
    /** Reason `deleted` when its root was. */
    'task.canceled': z.object({ ...Task, reason: TaskNote, by: Author }),
    /** A failed task is ready again. */
    'task.reopened': z.object({ ...Task, by: Author }),
    'actor.seen': z.object({
      actor: ActorId,
      kind: SeenActorKind,
      handle: Handle,
      name: z.string().min(1).max(128).refine(storable, 'name has a NUL character or a lone surrogate'),
      avatar: z.string().url().nullable(),
      /**
       * (server) Who an actor with a profile acts through, as the board shows it: its principal's name
       * (a deployment's project, anyone else's handle), and a deployment's environment.
       */
      via: z.object({ name: Handle, environment: z.string().min(1).max(128).nullable() }).optional(),
      /** (server) A platform user's platform (`slack`), as their sync key was registered with: for display. */
      platform: z.string().min(1).max(64).optional(),
      /**
       * (server) A principal a host's `authenticate` made, or one of its profiles: someone the board
       * signs in, whatever its ID or kind, so sync never writes as it. Others have none.
       */
      host: z.literal(true).optional(),
      /**
       * (server) Whether this write's credential named the actor as shown, rather than taking it from what
       * the caller sent: under the handle it gave the principal, as itself or after `via`. Unlike `host`,
       * each `actor.seen` says it anew. Others, and events from before, have none.
       */
      verified: z.literal(true).optional(),
    }),
}

export const BOARD_SESSION = 'board'

export type BoardEvents = typeof boardEvents
/** One event of the board log, of type `K`, in the shape its log stores it. */
export type BoardEvent<K extends keyof BoardEvents & string = keyof BoardEvents & string> = {
  [T in keyof BoardEvents & string]: {
    id: string
    type: T
    payload: z.output<BoardEvents[T]>
    index: number
    sessionId: string
    createdAt: Date
  }
}[K]
