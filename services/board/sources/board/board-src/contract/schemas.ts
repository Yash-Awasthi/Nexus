import { z } from 'zod'

export const CHANNEL_PATH_MAX = 2048
/** A grant's channel pattern: a path, or a path and its subtree (`ops/`). */
export const CHANNEL_PATTERN_MAX = CHANNEL_PATH_MAX + 1
export const MESSAGE_TEXT_MAX = 10_000
/** The longest `x-board-can` header the board reads; a schedule keeps its creator's. */
export const CAN_MAX = 4000
export { ATTACHMENT_BYTES_MAX, DIRECT_UPLOAD_BYTES_MAX, IMPORT_BYTES_MAX } from './files.ts'
export const ATTACHMENTS_PER_MESSAGE_MAX = 10
/** The label namespace the board writes itself: `board.task`, a task's state. No caller's write sets or unsets a key under it. */
export const RESERVED_LABEL_PREFIX = 'board.'
/** The label a task's root wears, with its state as the value. */
export const TASK_LABEL = 'board.task'
/** How many tasks one task waits for at most, in the log: the local board's limit, which a request's schema leaves to it. */
export const TASK_NEEDS_MAX = 20
/**
 * How many tasks one batch makes at most, on any board. board() refuses more itself: every root goes
 * through its middleware before a backend sees one, so it takes no more than any backend makes. A
 * board that holds fewer in a write says so, and `createTasksInChunks` sends this many first.
 */
export const TASK_BATCH_MAX = 100
/** The longest name a batch's task goes by among the batch's others, on the local board. */
export const TASK_KEY_MAX = 64
/** The longest result or reason a task keeps: a line or two, with the detail in its thread. */
export const TASK_NOTE_MAX = 1000

const segment = '[a-z0-9][a-z0-9_-]*'

/** `errors-www`, `www/production`: lowercase segments joined by `/`. */
export const ChannelPath = z
  .string()
  .max(CHANNEL_PATH_MAX)
  .regex(new RegExp(`^${segment}(?:/${segment})*$`), 'invalid channel path')

/**
 * No board string holds a NUL, which Postgres can't store, or a lone surrogate,
 * which no store keeps as it was: requests with one are refused, and sync
 * cleans what platforms send.
 */
export const storable = (value: string) => !value.includes('\u0000') && value.isWellFormed()

/** `value` as the board keeps it, for what comes in from a platform: without NUL, and a lone surrogate as U+FFFD. */
export const toStorable = (value: string) => value.replaceAll('\u0000', '').toWellFormed()

/** A message's text as a request sends it: its length is the backend's to judge. */
export const SentText = z
  .string()
  .refine((text) => text.trim().length > 0, 'message text is empty')
  .refine(storable, 'message text has a NUL character or a lone surrogate')

export const MessageText = z
  .string()
  .max(MESSAGE_TEXT_MAX)
  .refine((text) => text.trim().length > 0, 'message text is empty')
  .refine(storable, 'message text has a NUL character or a lone surrogate')

/** A message is named by the log index of its `message.posted` event. */
export const MessageId = z.number().int().positive()

/**
 * Names every object has (`constructor`, `__proto__`), and `prototype`. Emoji and label keys are
 * keys of plain objects, where these would read what an object inherits, so neither takes one.
 */
const INHERITED = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype'])
const notInherited = (name: string) => !INHERITED.has(name)

/** The longest label key and value: a value is a word or a line, like `fixed` or a short verdict. */
export const LABEL_KEY_MAX = 64
export const LABEL_VALUE_MAX = 256

/** What a refused key is told: the key itself, and the rule, so the next try needn't guess it. */
const notALabelKey = (issue: { input?: unknown }) =>
  `${JSON.stringify(String(issue.input))} isn't a label key: one is 1 to ${LABEL_KEY_MAX} lowercase letters, numbers, ., _, and -, starting with a letter or number`

export const LabelKey = z
  .string()
  .max(LABEL_KEY_MAX, { error: notALabelKey })
  .regex(/^[a-z0-9][a-z0-9_.-]*$/, { error: notALabelKey })
  .refine(notInherited, 'label key is a reserved name')
export const LabelValue = z
  .string()
  .max(LABEL_VALUE_MAX, { error: (issue) => `a label value is at most ${LABEL_VALUE_MAX} characters, and this one has ${String(issue.input).length}` })
  .refine(storable, 'label value has a NUL character or a lone surrogate')
export const Labels = z.record(LabelKey, LabelValue)
/**
 * A label value as a write sets it: no control characters either, so a value can't break the line
 * a reader shows it on (`vb read` prints labels inline). Labels already in a log keep what they have.
 */
export const NewLabelValue = LabelValue.refine((value) => !/\p{Cc}/u.test(value), 'label value has a control character')
export const NewLabels = z.record(LabelKey, NewLabelValue)

/** Normalized short names, as Chat SDK names them: `eyes`, `check`, `thumbs_up`. */
export const Emoji = z
  .string()
  .max(64)
  .regex(/^[a-z0-9_+-]+$/, 'invalid emoji name')
  .refine(notInherited, 'emoji name is a reserved name')

/** `vercel:user:u_abc123`, or `vercel:user:u_abc123+claude` for a profile. */
export const ActorId = z.string().min(1).max(256)

/** What an actor is: a `person`, an `agent` acting for a principal (`--as claude`), a deployment, a workflow, or a platform user (`external`). */
export const ActorKind = z.enum([
  'person',
  'agent',
  'deployment',
  'workflow',
  'external',
])

/** `actor.seen` events written before agents were called agents say `profile`. */
export const SeenActorKind = z.union([ActorKind, z.literal('profile')])

export const actorKind = (kind: z.infer<typeof SeenActorKind>): ActorKind => (kind === 'profile' ? 'agent' : kind)

export const Handle = z.string().min(1).max(128).refine(storable, 'handle has a NUL character or a lone surrogate')

/** A platform user's avatar as the board keeps it: an https URL, or none. Anything else shows nowhere. */
export function platformAvatar(avatar: string | null): string | null {
  if (avatar === null) return null
  try {
    return new URL(avatar).protocol === 'https:' ? avatar : null
  } catch {
    return null
  }
}

export const Author = z.object({
  actor: ActorId,
  principal: z.string().min(1),
  profile: z.string().nullable(),
})

/** Who wrote something, as views show it: a log from before sessions were gone keeps one on each, which no view shows. */
export const authorView = ({ actor, principal, profile }: Author): Author => ({ actor, principal, profile })

/** 128 random bits, base64url: an attachment is named by an ID nobody can guess. */
/** 128 random bits, base64url, as a board on this machine makes them; or `att_` and a UUID, as Vercel's board does. */
export const AttachmentId = z.string().regex(/^(?:[A-Za-z0-9_-]{22}|att_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/, 'invalid attachment id')

/** A file on a message. The board records `type` and `size` from what it stored, never from the request. */
export const Attachment = z.object({
  id: AttachmentId,
  name: z.string().min(1).max(255),
  type: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
})

/** What a task is doing: its root's `board.task` label. */
export const TaskState = z.enum(['waiting', 'ready', 'claimed', 'blocked', 'completed', 'failed', 'canceled'])
export type TaskState = z.infer<typeof TaskState>
/** The states a task can still leave by being worked: `GET /tasks` lists these by default. */
export const OPEN_TASK_STATES = ['waiting', 'ready', 'claimed', 'blocked'] as const satisfies readonly TaskState[]

/** A task's result or reason: a line or two. */
export const TaskNote = z
  .string()
  .max(TASK_NOTE_MAX)
  .refine((text) => text.trim().length > 0, 'it is empty')
  .refine(storable, 'it has a NUL character or a lone surrogate')

/** A task's result or reason as a request sends it: its length is the backend's to judge. */
export const SentTaskNote = z
  .string()
  .refine((text) => text.trim().length > 0, 'it is empty')
  .refine(storable, 'it has a NUL character or a lone surrogate')

/** A hold's kind as a request sends it: its length is the backend's to judge. */
export const SentTaskHoldKind = z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/, 'a kind is lowercase letters, numbers, and _.-')

/** Why a task is held, as whoever held it names it: `needs_input`, `awaiting_approval`. `edited` is the board's own. */
/** The kind of the hold the board places itself, when someone who doesn't own a task edits its root: no request holds a task as it. */
export const EDITED_HOLD = 'edited'
export const TaskHoldKind = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/, 'a kind is up to 64 lowercase letters, numbers, and _.-')

export type ChannelPath = z.infer<typeof ChannelPath>
export type MessageId = z.infer<typeof MessageId>
export type Labels = z.infer<typeof Labels>
export type ActorId = z.infer<typeof ActorId>
export type ActorKind = z.infer<typeof ActorKind>
export type Author = z.infer<typeof Author>
export type Attachment = z.infer<typeof Attachment>

/** A registered watcher's ID: a profile name, since its writes are by that profile. */
export const RemoteWatcherId = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9-]{0,31}$/, 'ids start with a letter and use up to 32 letters, numbers, and hyphens')
