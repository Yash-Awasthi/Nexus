import { z } from 'zod'
import {
  ActorId,
  AttachmentId,
  ATTACHMENTS_PER_MESSAGE_MAX,
  CHANNEL_PATTERN_MAX,
  ChannelPath,
  DIRECT_UPLOAD_BYTES_MAX,
  Emoji,
  LabelKey,
  Labels,
  LabelValue,
  NewLabels,
  MESSAGE_TEXT_MAX,
  MessageText,
  SentText,
  platformAvatar,
  storable,
  TASK_BATCH_MAX,
  EDITED_HOLD,
  SentTaskHoldKind,
  SentTaskNote,
  TaskState,
} from '../contract/schemas.ts'
import { ExternalAuthor, ExternalEvent, ExternalTarget, Link as LinkSchema, LINKS_PER_MESSAGE_MAX, MENTIONED_PER_MESSAGE_MAX, Origin } from '../contract/external.ts'
import type { BoardEvent } from '../contract/events.ts'
import type { Link } from '../contract/external.ts'
import type { Actor, Channel, ExternalCopy, Message, Task } from '../contract/folds.ts'
import type { Via } from '../contract/profiles.ts'
import type { AccessSummary, Permission, WrittenCan } from '../server/access.ts'

/**
 * A message's, schedule's, or cursor's ID: a string clients pass back as they got it, and never
 * parse, compare, or count with. Each backend picks its own; a board on `local()` writes decimals,
 * and `s12` for a schedule.
 */
export const Ref = z.string().min(1).max(128)

/** The message's `revision` as it was read: if it's been edited or deleted since, 409 `revision_conflict`. */
const Revision = z.number().int().positive()
const id = Ref
/** A boolean query parameter: `true` or `1`, `false` or `0`. */
const flag = z.enum(['true', 'false', '1', '0']).transform((value) => value === 'true' || value === '1')
const repeated = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (Array.isArray(value) ? value : [value]))

/**
 * `pr` → `['pr', null]` (has the label), `status=open` → `['status', ['open']]`,
 * `state=open|draft` → either value.
 */
const LabelFilter = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]*(=.*)?$/, 'label filters look like key, key=value, or key=a|b')
  .transform((value) => {
    const at = value.indexOf('=')
    return at === -1 ? ([value, null] as const) : ([value.slice(0, at), value.slice(at + 1).split('|')] as const)
  })

/** A sync target as the board that syncs it resolved it: a platform channel to start a thread in, or a thread to join. */
export const ResolvedSyncTarget = z.object({ target: ExternalTarget, kind: z.enum(['channel', 'thread']) })

/** Shared by `/threads` and `/events`. */
export const Filters = z.object({
  channel: z.string().optional(),
  re: id.optional(),
  by: z.string().optional(),
  mentions: z.string().optional(),
  label: repeated.pipe(z.array(LabelFilter)).optional(),
  /**
   * Where messages came from: a sync key such as `slack`, or `board` for the board itself. On Vercel's board, another
   * project's key is `<project>/<key>`, by its name (up to 100 characters) or its ID.
   */
  from: z.string().min(1).max(165).optional(),
  /** Case-insensitive words the text contains. */
  text: z.string().min(1).max(200).optional(),
})
/** The filters a query asks for, as the board parsed them. */
export type ParsedFilters = z.output<typeof Filters>

/**
 * One channel's messages across its threads, oldest first: the newest `limit`, or with `after`, a cursor a read of
 * this channel answered, the ones posted since. The channel is one channel by its whole name, never a pattern: a board
 * lists no messages across channels.
 */
export const ChannelMessagesQuery = z.strictObject({
  channel: ChannelPath,
  after: Ref.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

/** How many channels a list answers without a `limit`, and with one at most. */
export const CHANNELS_LIMIT_DEFAULT = 100
export const CHANNELS_LIMIT_MAX = 500
/**
 * A page of the board's channels: those whose path starts with `prefix` (`dev/` is every channel under `dev`, and
 * not `dev` itself), `limit` of them, after a page's `next`.
 */
export const ChannelsQuery = z.strictObject({
  prefix: z.string().min(1).max(501).optional(),
  after: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(CHANNELS_LIMIT_MAX).optional(),
})

/** How many actors one read of them by ID names at most. */
export const ACTORS_BY_ID_MAX = 100

/** The board's actors, or with `id`, only the ones it names: someone it doesn't have is left out. */
export const ActorsQuery = z.strictObject({
  id: repeated.pipe(z.array(z.string().min(1).max(300)).min(1).max(ACTORS_BY_ID_MAX)).optional(),
})

/**
 * A thread read in part: the root, and of its replies the ones after one of its messages (`after`), `limit` of
 * them. With `after` they're the first after it, to read on from; without, the newest.
 */
export const ThreadQuery = z.strictObject({
  after: id.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

/** How many threads a read lists without a `limit`, and with one at most. */
export const THREADS_LIMIT_DEFAULT = 50
export const THREADS_LIMIT_MAX = 500

/**
 * `limit` counts threads: each thread with a matching message, by its latest reply. `before` is a page's
 * `older`, for the threads last active before it; it pages backward, so it takes no `after`.
 */
export const ThreadsQuery = Filters.extend({
  after: Ref.optional(),
  before: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(THREADS_LIMIT_MAX).optional(),
}).refine((query) => query.before === undefined || query.after === undefined, {
  message: '`before` pages back from a page\'s `older`, and `after` reads forward: pass one',
  path: ['before'],
})

/** The most of a feed's newest events one read answers for (`last`). */
export const EVENTS_LAST_MAX = 100

/**
 * A read of the feed after `after`, or from now. `last` reads its newest events instead, oldest first, with the
 * feed's end as the cursor: it answers at once, so it takes no `after` or `wait`.
 */
export const EventsQuery = Filters.extend({
  after: Ref.optional(),
  wait: z.coerce.number().min(0).max(300).optional(),
  all: flag.optional(),
  last: z.coerce.number().int().min(1).max(EVENTS_LAST_MAX).optional(),
}).refine((query) => query.last === undefined || (query.after === undefined && query.wait === undefined), {
  message: '`last` reads the newest events at once: it takes no `after` or `wait`',
  path: ['last'],
})

export const PostBody = z
  .object({
    channel: ChannelPath.optional(),
    re: Ref.optional(),
    /** May be empty when the message has attachments. */
    text: z.string().default(''),
    labels: NewLabels.optional(),
    noSync: z.boolean().optional(),
    /**
     * External targets a new thread starts with: `slack:#incidents`, `github:owner/repo:12`. The
     * board that syncs a target resolves it to `{ target, kind }`, which a board elsewhere takes as is.
     */
    sync: z.array(z.union([z.string().min(3).max(300), ResolvedSyncTarget])).max(10).optional(),
    id: z.string().min(1).max(200).refine(storable, 'id has a NUL character or a lone surrogate').optional(),
    /** IDs from `POST /attachments`. */
    attachments: z.array(AttachmentId).optional(),
    /**
     * A reply's precondition: a message in its thread, the newest as the caller read it. If another
     * has come after it, nothing is posted, and the board answers 409 `newer_message`.
     */
    after: Ref.optional(),
  })
  .refine((body) => body.text.trim().length > 0 || (body.attachments?.length ?? 0) > 0, {
    message: 'message text is empty',
    path: ['text'],
  })
  .refine((body) => (body.channel === undefined) !== (body.re === undefined), {
    message: 'a post needs `channel`; a reply needs `re`',
  })
  .refine((body) => !(body.noSync && body.sync?.length), {
    message: '`noSync` and `sync` contradict each other',
  })
  .refine((body) => body.after === undefined || body.re !== undefined, {
    message: '`after` is for replies: it names the newest message in `re`\'s thread',
    path: ['after'],
  })

/** `30m`, `1d`: a number and a unit, `s`, `m`, `h`, or `d`. */
const Duration = z.string().regex(/^\d+(\.\d+)?(s|m|h|d)$/, 'durations look like 30s, 30m, 12h, or 1d')
const Instant = z.string().datetime({ offset: true })

/**
 * A message to post later, as the caller: once (`in` or `at`), or repeating
 * (`every`, starting `at` or `in` from now, or one `every` from now), until
 * `until`, `for` after the first send, or `times` sends. A repeat with no stop
 * runs until it's canceled.
 */
export const ScheduleBody = z
  .object({
    channel: ChannelPath.optional(),
    re: Ref.optional(),
    text: z.string().default(''),
    labels: NewLabels.optional(),
    noSync: z.boolean().optional(),
    attachments: z.array(AttachmentId).optional(),
    in: Duration.optional(),
    at: Instant.optional(),
    every: Duration.optional(),
    until: Instant.optional(),
    for: Duration.optional(),
    times: z.number().int().positive().optional(),
  })
  .refine((body) => body.text.trim().length > 0 || (body.attachments?.length ?? 0) > 0, {
    message: 'message text is empty',
    path: ['text'],
  })
  .refine((body) => (body.channel === undefined) !== (body.re === undefined), {
    message: 'a schedule needs `channel` for a new thread, or `re` for a reply',
  })
  .refine((body) => body.in !== undefined || body.at !== undefined || body.every !== undefined, {
    message: 'say when: `in`, `at`, or `every`',
  })
  .refine((body) => !(body.in !== undefined && body.at !== undefined), { message: '`in` and `at` contradict each other' })
  .refine((body) => [body.until, body.for, body.times].filter((v) => v !== undefined).length <= 1, {
    message: 'pick one stop: `until`, `for`, or `times`',
  })
  .refine((body) => body.every !== undefined || (body.until === undefined && body.for === undefined && body.times === undefined), {
    message: '`until`, `for`, and `times` stop a repeat: add `every`',
  })

export const SchedulesQuery = z.object({
  /** Any message in a thread: the schedules that reply in it. */
  re: id.optional(),
  channel: z.string().optional(),
  /** An actor ID or handle: the schedules it created. */
  by: z.string().optional(),
  /** Include done and canceled schedules. */
  all: flag.optional(),
})

/** A channel, or with a trailing `/` it and every channel under it: `work`, `work/`. As long as a grant's pattern for either. */
const ChannelOrSubtree = z.string().max(CHANNEL_PATTERN_MAX).regex(/^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*\/?$/, 'name a channel, or a channel and its subtree (work/)')

/** What a claim gets when it asks for no lease, in seconds. */
export const LEASE_DEFAULT_S = 900
/**
 * How long a claim holds its task, in seconds, 900 when left out. How short and how long one may
 * be is the backend's to say: the local board takes 30 to 3600, and a board gives what's asked up
 * to its own cap, never under 300.
 */
const Lease = z.number()

/** What a claim's own writes carry: the `epoch` and `token` its claim answered. */
const Claimed = { epoch: z.number().int().positive(), token: z.string().min(1).max(128) }

/**
 * A claim's token can be the caller's own: a secret it can derive again anywhere, as an HMAC-SHA256
 * of its run's ID in base64url, so no store has to remember it. It's 32 bytes in base64url, as
 * Vercel's API takes one. Claiming a task its live claim holds with that claim's token answers the
 * claim as it is.
 */
const ClaimToken = { token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'a claim token is 32 bytes in base64url: 43 characters').optional() }

/**
 * A new thread that's a task (`channel` and `text`, with `labels`, `noSync`, `attachments`, and an
 * `id` as a post takes them), or the thread `re` roots made one. `needs` are the tasks it waits for,
 * `for` the one actor of its owner's that claims it, and `claim` claims it in the same write, for
 * `lease` seconds.
 */
export const CreateTaskBody = z
  .object({
    channel: ChannelPath.optional(),
    re: Ref.optional(),
    /** As long as a post's text may be: the backend says how long that is. */
    text: z.string().optional(),
    labels: NewLabels.optional(),
    noSync: z.boolean().optional(),
    /** IDs from `POST /attachments`, as a post takes them. */
    attachments: z.array(AttachmentId).optional(),
    /** How many tasks one may wait for is the backend's to say. */
    needs: z.array(Ref).optional(),
    for: ActorId.nullable().optional(),
    claim: z.boolean().optional(),
    lease: Lease.optional(),
    ...ClaimToken,
    id: z.string().min(1).max(200).refine(storable, 'id has a NUL character or a lone surrogate').optional(),
  })
  .refine((body) => (body.channel === undefined) !== (body.re === undefined), {
    message: 'a task needs `channel` and `text` for a new thread, or `re` for a thread that\'s there',
  })
  .refine((body) => body.channel === undefined || (body.text ?? '').trim().length > 0 || (body.attachments?.length ?? 0) > 0, { message: 'message text is empty', path: ['text'] })
  .refine((body) => body.text === undefined || storable(body.text), { message: 'message text has a NUL character or a lone surrogate', path: ['text'] })
  .refine((body) => body.re === undefined || (body.text === undefined && body.labels === undefined && body.noSync === undefined && body.attachments === undefined && body.id === undefined), {
    message: '`text`, `labels`, `noSync`, `attachments`, and `id` are a new thread\'s: `re` makes a task of a thread as it is',
  })
  .refine((body) => body.lease === undefined || body.claim === true, { message: '`lease` goes with `claim`', path: ['lease'] })
  .refine((body) => body.token === undefined || body.claim === true, { message: '`token` goes with `claim`', path: ['token'] })

/** A digest of what a batch asks for: what tells the same request under an `id` from another. */
const BatchRequest = z.string().min(1).max(64)

/** A task another task of the same batch waits for, by the `key` it goes by there. */
const TaskKey = z.string().min(1).refine(storable, 'key has a NUL character or a lone surrogate')

/**
 * Several new threads in one channel, each a task, made in one write: all of them or none. A task is
 * what `POST /tasks` starts a thread with, less `claim`. `key` names it for the batch's others, and
 * `needs` takes a task's ID, or `{ key }` for one of the batch, before or after it. `id` names the
 * batch: a retry with it answers the same tasks. At most `TASK_BATCH_MAX` tasks, 400
 * `batch_too_large` past that, which a board that holds fewer in one write answers too.
 */
export const CreateTasksBody = z.object({
  channel: ChannelPath,
  tasks: z
    .array(
      z
        .object({
          key: TaskKey.optional(),
          /** May be empty when the task's root has attachments. As long as a post's text may be: the backend says how long that is. */
          text: z.string(),
          labels: NewLabels.optional(),
          noSync: z.boolean().optional(),
          /** IDs from `POST /attachments`, as a post takes them. */
          attachments: z.array(AttachmentId).optional(),
          /** How many tasks one may wait for is the backend's to say. */
          needs: z.array(z.union([Ref, z.object({ key: TaskKey }).strict()])).optional(),
          for: ActorId.nullable().optional(),
        })
        .refine((task) => task.text.trim().length > 0 || (task.attachments?.length ?? 0) > 0, { message: 'message text is empty', path: ['text'] })
        .refine((task) => storable(task.text), { message: 'message text has a NUL character or a lone surrogate', path: ['text'] }),
    )
    .min(1)
    .max(TASK_BATCH_MAX),
  id: z.string().min(1).max(200).refine(storable, 'id has a NUL character or a lone surrogate').optional(),
  /**
   * From a board in front of this one: its digest of what the batch asked for as it was given, before
   * its own middleware changed anything, so both boards tell a repeat by the same request. A board
   * with none in front makes its own. It says nothing of who writes or what: a caller that sends one
   * changes only which of its own requests its own `id` answers.
   */
  request: BatchRequest.optional(),
})

/**
 * `request` is a board's digest of what a batch asked for, as it was given: with it, the batch
 * answers only that request, and any other under the `id` is 409 `duplicate_id`.
 */
export const CreatedTasksQuery = z.object({ request: BatchRequest.optional() })

/** Which tasks to list: open ones unless `state` says `all` or names one. A claim whose lease has run out counts as `ready`. */
export const TasksQuery = z.object({
  channel: z.string().optional(),
  state: z.union([z.enum(['open', 'all']), TaskState]).optional(),
  label: repeated.pipe(z.array(LabelFilter)).optional(),
  /** Who wrote the root: a handle or an actor ID, as on `/messages`. */
  by: z.string().optional(),
  /** Whose task it is: a handle or a principal ID. */
  owner: z.string().optional(),
  /** The actor it's assigned to: a handle or an actor ID. */
  for: z.string().optional(),
  /** A task's ID: the tasks that wait for it. */
  needs: Ref.optional(),
  /** A `cursor` an earlier page reported. */
  after: Ref.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  /** The `limit` last active instead of the first made, the latest active last: the board reads to the end, and takes no `after`. */
  latest: flag.optional(),
}).refine((query) => !query.latest || query.after === undefined, {
  message: '`latest` reads every task to find the last active: it takes no `after`',
  path: ['latest'],
})


export const ClaimTaskBody = z.object({ lease: Lease.optional(), ...ClaimToken }).optional()

/**
 * Claims the oldest ready task in `channel` that has every label in `label`: one assigned to the
 * caller first, then an unassigned one it owns, or whose owner `from` names by ID. `wait`
 * holds the request up to that many seconds for one.
 */
export const ClaimReadyTaskBody = z.object({
  channel: ChannelOrSubtree,
  label: Labels.optional(),
  /** How many owners one claim takes from is the backend's to say. */
  from: z.array(z.string().min(1).max(256)).optional(),
  lease: Lease.optional(),
  wait: z.number().min(0).max(300).optional(),
  ...ClaimToken,
})

export const RenewTaskBody = z.object({ ...Claimed, lease: Lease.optional() })
export const ReleaseTaskBody = z.object(Claimed)
export const CompleteTaskBody = z.object({ ...Claimed, result: SentTaskNote.optional() })
export const FailTaskBody = z.object({ ...Claimed, reason: SentTaskNote })
/** A hold for a person. A claimed task's comes from its claim, with the claim's `epoch` and `token`. Kind `edited` is the board's own, so none asks for it. */
export const BlockTaskBody = z
  .object({
    reason: SentTaskNote,
    kind: SentTaskHoldKind.refine((kind) => kind !== EDITED_HOLD, "`edited` is the board's own kind, for a task whose root someone else edited: name another").optional(),
    epoch: Claimed.epoch.optional(),
    token: Claimed.token.optional(),
  })
  .refine((body) => (body.epoch === undefined) === (body.token === undefined), { message: 'a claim is its `epoch` and its `token`: pass both, or neither' })
/** The one actor of its owner's that claims the task, or null for anyone who may. */
export const AssignTaskBody = z.object({ for: ActorId.nullable() })
/** The tasks it waits for now, in place of what it waited for: none, for a task that waits for nothing. How many it may wait for is the backend's to say. */
export const TaskNeedsBody = z.object({ needs: z.array(Ref) })
export const CancelTaskBody = z.object({ reason: SentTaskNote })

const CanGrant = z.union([z.literal('all'), z.array(z.string().min(1).max(16)).max(8)])
const ClaimValue = z.string().min(1).max(1000)
const Environments = z.array(z.string().min(1).max(100)).min(1).max(16)

/**
 * Who a grant names, as people write it: a user by email (or, where the board can't look one up,
 * by ID), a project by name or ID, a repository by `owner/name`. The board resolves names and keeps
 * IDs; a board that verifies tokens itself takes IDs only. A `user` names `email` or `userId`.
 * Nothing else: a key it doesn't know (a misspelled `workflows`, say) is a 400, never dropped,
 * since dropping it would name more than was meant.
 */
export const PrincipalInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user'), email: z.string().min(3).max(320).optional(), userId: z.string().min(1).max(200).optional() }),
  // Its environments are where its deployments get in; a principal to remove leaves them out.
  z.strictObject({ kind: z.literal('project'), project: z.string().min(1).max(200), environments: Environments.optional() }),
  z.strictObject({
    kind: z.literal('github'),
    repository: z.string().min(3).max(200),
    workflow: z.string().min(1).max(300).optional(),
    branch: z.string().min(1).max(255).optional(),
    event: z.string().min(1).max(64).optional(),
  }),
  z.strictObject({ kind: z.literal('oidc'), issuer: z.string().min(1).max(1000), claims: z.record(z.string().min(1).max(200), z.union([ClaimValue, z.array(ClaimValue).min(1).max(32)])) }),
  z.strictObject({ kind: z.literal('all-users') }),
  z.strictObject({ kind: z.literal('all-projects'), environments: Environments.optional() }),
  // An app by its slug or its client ID.
  z.strictObject({ kind: z.literal('app'), app: z.string().min(1).max(200) }),
  z.strictObject({ kind: z.literal('all-apps') }),
  z.strictObject({ kind: z.literal('everyone') }),
])

/** What a grant lets its principals do: a map from channel pattern to `'all'` or a list, `[]` for none. Kept as written. */
export const GrantCan = z.record(z.string().min(1).max(CHANNEL_PATTERN_MAX), CanGrant)

/**
 * Says to go ahead with a grant change its caller couldn't take back: one that takes their own
 * `manage` at a pattern it names, which is 409 `grant_lockout` without it.
 */
const LockMeOut = z.boolean().optional()

/** A grant: who it names, and one `can` for all of them. The same principals again are another grant. */
const GrantSpec = z.strictObject({
  principals: z.array(PrincipalInput).min(1).max(32),
  can: GrantCan,
})

/** What `POST /grants` takes: a grant, and `lockMeOut` to make one its caller couldn't take back. */
export const GrantBody = GrantSpec.extend({ lockMeOut: LockMeOut })

/** How many grants one write makes. */
export const GRANT_BATCH_MAX = 16

/**
 * Several grants made in one write, all of them or none, judged together: each by the grants as
 * they are, and what it leaves its caller with by the grants as they'd be with all of them. So a
 * lock and the grant that keeps its maker in go in one request, in any order.
 */
export const CreateGrantsBody = z.strictObject({
  grants: z.array(GrantSpec).min(1).max(GRANT_BATCH_MAX),
  lockMeOut: LockMeOut,
})

/** What revoking a grant takes: nothing, or `lockMeOut`. */
export const RevokeGrantBody = z.strictObject({ lockMeOut: LockMeOut }).optional()

/**
 * Which grant decides a channel, and what it gives, for the caller or a principal it names: a
 * `user` (by email, or by ID where the board can't look one up), a `project` in one `environment`
 * (production by default), a `github` repository's run (with its `workflow`, `branch`, and
 * `event`), or an `oidc` issuer's token with each `claim` as `name=value`.
 */
export const ExplainQuery = z
  .object({
    channel: ChannelPath,
    user: z.string().min(1).max(320).optional(),
    project: z.string().min(1).max(200).optional(),
    environment: z.string().min(1).max(100).optional(),
    github: z.string().min(3).max(200).optional(),
    workflow: z.string().min(1).max(300).optional(),
    branch: z.string().min(1).max(255).optional(),
    event: z.string().min(1).max(64).optional(),
    oidc: z.string().min(1).max(1000).optional(),
    claim: repeated.optional(),
    app: z.string().min(1).max(200).optional(),
  })
  .refine((query) => [query.user, query.project, query.github, query.oidc, query.app].filter((value) => value !== undefined).length <= 1, 'name one principal: user, project, github, oidc, or app')
  .refine((query) => query.environment === undefined || query.project !== undefined, 'environment goes with project')
  .refine((query) => (query.workflow === undefined && query.branch === undefined && query.event === undefined) || query.github !== undefined, 'workflow, branch, and event go with github')
  .refine((query) => query.claim === undefined || query.oidc !== undefined, 'claim goes with oidc')

/** A grant's change: principals to add and to remove, and a `can` to replace its own. */
export const UpdateGrantBody = z
  .strictObject({
    add: z.array(PrincipalInput).min(1).max(32).optional(),
    remove: z.array(PrincipalInput).min(1).max(32).optional(),
    can: GrantCan.optional(),
    lockMeOut: LockMeOut,
  })
  .refine((body) => body.add !== undefined || body.remove !== undefined || body.can !== undefined, 'name principals to add or remove, or a can')

/**
 * A schema version to register, for good: `name` and `version` are its ID (`sandbox@1`), and
 * `schema` is a JSON Schema for an object, in structural keywords only, which the board checks.
 * Strict, so a board that doesn't know a field refuses it: what it kept could never be changed.
 */
export const SchemaBody = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9._-]*$/, 'a schema name is lowercase letters, numbers, and ._-, starting with a letter'),
  version: z.number().int().min(1),
  description: z.string().min(1).refine(storable, 'a description has a NUL character or a lone surrogate').optional(),
  schema: z.record(z.string(), z.unknown()),
})

export const SyncBody = z.object({ target: z.string().min(3).max(300) })
export const InboxQuery = z.object({
  channel: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})
/** How many watchers one registration holds on the local engine, which matches every event against every tail. Vercel's API sets its own. */
export const REGISTERED_WATCHERS_MAX = 64

/** What every registration carries: its watchers' tails, and its sync entries. */
const Registering = z.object({
  // The IDs are checked one by one, so a bad one fails with what a misconfigured boot would.
  watch: z.record(z.string().max(100), z.object({ tail: z.string().max(1000) })),
  /**
   * Its sync entries: its sync subscribes too, to every post, change, and thread sync in the channels
   * where it may sync, and the board lists the entries.
   */
  sync: z.array(z.object({ key: z.string().min(1).max(64), platform: z.string().min(1).max(64) })).max(32).optional(),
})

/**
 * What a board on `http()` registers with the board it uses: its watchers, and where to wake it,
 * at a URL or at a path on its own project, never both.
 */
export const RegisterBody = z.union([
  Registering.extend({
    /** Without one, the board pulls on its own instead of being woken. */
    url: z
      .string()
      .url()
      .max(500)
      .refine((url) => /^https:\/\//.test(url), 'wake-ups go over https')
      .transform((url) => url.replace(/\/+$/, ''))
      .nullable()
      .optional(),
    path: z.null({ error: 'register a url or a path, not both' }).optional(),
    branch: z.null({ error: 'a branch goes with a path' }).optional(),
  }),
  Registering.extend({
    url: z.null({ error: 'register a url or a path, not both' }).optional(),
    /**
     * Where to wake the caller on its own Vercel project, on a board whose discovery says
     * `wake_by_path`. The board takes the project and environment from the caller's token and
     * finds the deployment, so a project can only register itself, and anyone else gets 403
     * `not_a_project`.
     */
    path: z
      .string()
      .max(300)
      .regex(/^\/[^?#]*$/, 'a path starts with / and has no query or fragment')
      .transform((path) => path.replace(/(.)\/+$/, '$1')),
    /**
     * From a preview: the branch whose latest ready preview is woken, since a token says which
     * project and environment called but not which deployment. Production names none.
     */
    branch: z.string().min(1).max(255).nullable().optional(),
  }),
])
/** A registration as a board on `http()` sends it: `{ url?, watch, sync? }` or `{ path, branch?, watch, sync? }`. */
export type RegisterInput = z.input<typeof RegisterBody>

/** A pull of the caller's matches: at most `limit`, waiting up to `wait` seconds for one. */
export const MatchesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  wait: z.coerce.number().min(0).max(25).optional(),
})

/** How a pulled match went: its lease, and an error to try again, or `skip` to drop it. */
export const AckBody = z.object({
  lease: z.string().min(1).max(64),
  error: z.string().min(1).max(500).optional(),
  skip: z.boolean().optional(),
})

/**
 * What to read from a platform without syncing it: a channel (`#name` or an ID),
 * a thread (`C0123:1727000000.123456`), or a message permalink (its thread).
 */
export const SourceReadQuery = z.object({
  target: z.string().min(1).max(4000),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  /** Where the last read left off: its `next`. */
  after: z.string().min(1).max(400).optional(),
})

/** A channel to add the board's app to, so it can be read on demand: `#name`, an ID, or a link into it. */
export const SourceJoinBody = z.object({ target: z.string().min(1).max(4000) })

/** A platform's link to a message or thread, such as a Slack permalink or a GitHub comment's URL. */
export const LinkedQuery = z.object({ url: z.string().url().max(4000) })

/** A sync entry's key: `slack`, `github`. */
const SyncKey = z.string().min(1).max(64)

/** A platform message an import changes, by its platform thread and ID; without a message, the root of the board thread the platform thread belongs to. */
const ImportOrigin = z.object({ thread: ExternalTarget, message: z.string().min(1).max(300).optional() })

/** A link as an import carries it: a board message it names is a ref. */
const ImportLink = LinkSchema.extend({ message: Ref.nullable() })

/**
 * A platform user, as sync names them to the board. Their avatar shows wherever they do, so one
 * that isn't an https URL is dropped, never refused: the write lands without it.
 */
const PlatformUser = ExternalAuthor.extend({ avatar: z.string().nullable().transform(platformAvatar) })

/**
 * Who wrote it on the platform, and the sync key it came through: null for a write a sync callback
 * makes as that user, which syncs out to every platform like one written on the board.
 */
const Imported = { author: PlatformUser, from: SyncKey.nullable() }

/**
 * The platform's users a text mentions as `@[<their id>]`. One the board hasn't met becomes known
 * to it, as one who wrote does: named, and seen where the message is. One the text doesn't mention
 * is left out.
 */
const Mentioned = z.array(PlatformUser).max(MENTIONED_PER_MESSAGE_MAX).optional()

/**
 * Where the platform event an import comes from is: its sync entry, platform channel, and thread.
 * The middleware is told, and answers there when it drops the write.
 */
const ImportSource = z.object({ key: SyncKey, channel: ExternalTarget, thread: ExternalTarget })

/** The message a change is about: by its platform IDs (`origin`), or by its board ID (`message`), one or the other. */
const Changed = { origin: ImportOrigin.optional(), message: Ref.optional() }

/**
 * A platform's write, as its platform author, with where it came from: only a caller with `sync` in
 * the channel it lands in may make one. Posts are idempotent by `id`, derived from the platform
 * event; every other op finds the message it changes from its `origin`.
 */
export const SyncImportBody = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('post'),
    ...Imported,
    /** Where it is on the platform. Null for a write a sync callback makes itself. */
    origin: Origin.nullable().default(null),
    source: ImportSource.optional(),
    channel: ChannelPath.optional(),
    re: Ref.optional(),
    text: z.string().max(MESSAGE_TEXT_MAX).default(''),
    labels: NewLabels.optional(),
    noSync: z.boolean().optional(),
    attachments: z.array(AttachmentId).max(ATTACHMENTS_PER_MESSAGE_MAX).optional(),
    links: z.array(ImportLink).max(LINKS_PER_MESSAGE_MAX).optional(),
    mentioned: Mentioned,
    id: z.string().min(1).max(200).refine(storable, 'id has a NUL character or a lone surrogate').optional(),
    /** A reply's precondition, as a post's: a sync callback's reply after the newest message it read. */
    after: Ref.optional(),
  }),
  /** `revision`, as an edit's or a delete's: only if the message is still at it. */
  z.object({ op: z.literal('edit'), ...Imported, ...Changed, text: MessageText, source: ImportSource.optional(), revision: Revision.optional(), mentioned: Mentioned }),
  z.object({ op: z.literal('delete'), ...Imported, ...Changed, revision: Revision.optional() }),
  z.object({ op: z.literal('react'), ...Imported, ...Changed, emoji: Emoji, remove: z.boolean().optional() }),
  z.object({
    op: z.literal('labels'),
    ...Imported,
    ...Changed,
    set: NewLabels.optional(),
    unset: z.array(LabelKey).optional(),
    /** As a label write's: what the labels must be now, a value or null for none. */
    if: z.record(LabelKey, LabelValue.nullable()).optional(),
  }),
  z.object({ op: z.literal('links'), ...Imported, ...Changed, links: z.array(ImportLink).max(LINKS_PER_MESSAGE_MAX) }),
])

const PlatformFiles = z.array(z.string().min(1).max(300)).max(ATTACHMENTS_PER_MESSAGE_MAX).nullable()

/** What sync did on a platform, about a board message: it landed, its files did, it gave up, or its thread syncs with a target. */
export const SyncReceiptBody = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'),
    message: Ref,
    target: ExternalTarget,
    external: z.object({ thread: ExternalTarget, message: z.string().min(1).max(300) }),
    /** Its files, when they went with it: the platform's IDs, or null when it refused them. */
    files: PlatformFiles.optional(),
  }),
  z.object({ kind: z.literal('files'), message: Ref, target: ExternalTarget, files: PlatformFiles }),
  z.object({ kind: z.literal('failed'), message: Ref, target: ExternalTarget, error: z.string().min(1).max(500) }),
  z.object({
    kind: z.literal('thread'),
    /** Any message in the thread. */
    message: Ref,
    target: ExternalTarget,
    /** A channel to start a thread in, or a thread to join. */
    targetKind: z.enum(['channel', 'thread']),
    cause: z.enum(['config', 'request']),
  }),
])

/** What sync looks up by platform ID: a thread or a message. */
export const SyncFindQuery = z.object({
  /** The post the caller's sync imported with this client ID. */
  post: z.string().min(1).max(200).optional(),
  thread: ExternalTarget.optional(),
  /** With `thread`: the platform message in it. */
  message: z.string().min(1).max(300).optional(),
})
export const SyncCopiesQuery = z.object({ message: repeated.pipe(z.array(Ref).min(1).max(100)) })

/** Platform events for a sync key's inbox, each with the platform's own ID for it, which dedupes it. */
/** The longest inbox event ID a board takes: Vercel's API refuses a longer one. */
export const INBOX_EVENT_ID_MAX = 300
export const InboxPushBody = z.object({
  events: z.array(z.object({ id: z.string().min(1).max(INBOX_EVENT_ID_MAX), event: ExternalEvent, raw: z.unknown() })).min(1).max(50),
})
export const InboxNextQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).optional() })
export const InboxAckBody = z.object({ lease: z.string().min(1).max(64), error: z.string().min(1).max(500).optional() })


/**
 * A direct upload, before its bytes: what the file will be called, its type, its exact size, and
 * the SHA-256 of its bytes, in base64, for a store that signs its URL for them (Vercel's).
 */
export const UploadStartBody = z.object({
  name: z.string().max(1024).nullable().optional(),
  type: z.string().max(1024).nullable().optional(),
  size: z.number().int().positive().max(DIRECT_UPLOAD_BYTES_MAX, `direct uploads are at most ${DIRECT_UPLOAD_BYTES_MAX / 1024 / 1024} MB`),
  sha256: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, 'sha256 is the base64 SHA-256 of the bytes').optional(),
})

/** Where to send a direct upload's bytes: `PUT` the file to `url` with `headers` (its `content-type` included), before `expiresAt`, then finish it. */
export type UploadTicket = { id: string; url: string; headers: Record<string, string>; expiresAt: string }

export const EditBody = z.object({ text: SentText, revision: Revision.optional() })
export const DeleteBody = z.object({ revision: Revision.optional() }).optional()
/** `status`: what Slack shows in place of "Typing…" (other platforms ignore it). */
export const TypingBody = z.object({ status: z.string().trim().min(1).max(50).optional() }).optional()
export const ReactBody = z.object({ emoji: Emoji, remove: z.boolean().optional() })
/**
 * A channel to make before anything posts to it, and nothing else: a key it doesn't know is a 400,
 * so a client that asks for more than a channel (one that expects `private: true` to close it, say)
 * is told, never handed an open one.
 */
export const CreateChannelBody = z.strictObject({ path: ChannelPath })
/** At most this many labels in a label write's `if`. */
export const LABEL_CONDITIONS_MAX = 16

export const LabelBody = z
  .object({
    set: NewLabels.optional(),
    unset: z.array(LabelKey).optional(),
    /**
     * What the message's labels must be now: a key's value, or null for one that mustn't be set.
     * If one isn't, nothing changes, and the board answers 409 `label_conflict`.
     */
    if: z
      .record(LabelKey, LabelValue.nullable())
      .refine((expected) => Object.keys(expected).length <= LABEL_CONDITIONS_MAX, `at most ${LABEL_CONDITIONS_MAX} labels`)
      .optional(),
  })
  .refine((body) => body.set !== undefined || body.unset !== undefined, {
    message: 'nothing to change: pass `set` or `unset`',
  })

export type CreateTaskInput = z.input<typeof CreateTaskBody>
export type CreateTasksInput = z.input<typeof CreateTasksBody>
export type TasksQueryInput = z.input<typeof TasksQuery>
export type ClaimReadyTaskInput = z.input<typeof ClaimReadyTaskBody>
export type FiltersInput = z.input<typeof Filters>
export type SyncImportInput = z.input<typeof SyncImportBody>
export type SyncReceiptInput = z.input<typeof SyncReceiptBody>
export type SyncFindInput = z.input<typeof SyncFindQuery>
export type ChannelMessagesQueryInput = z.input<typeof ChannelMessagesQuery>
export type ThreadQueryInput = z.input<typeof ThreadQuery>
export type ChannelsQueryInput = z.input<typeof ChannelsQuery>
export type ActorsQueryInput = z.input<typeof ActorsQuery>
export type ThreadsQueryInput = z.input<typeof ThreadsQuery>
export type EventsQueryInput = z.input<typeof EventsQuery>
export type PostInput = z.input<typeof PostBody>
export type ScheduleInput = z.input<typeof ScheduleBody>
export type ScheduleBodyOutput = z.output<typeof ScheduleBody>
export type SchedulesQueryInput = z.input<typeof SchedulesQuery>
/** A principal as `createGrant` and `updateGrant` take it. */
/**
 * A principal as a handle takes it. A project's environments, and every project's, are production
 * when left out, so the board always gets them; a principal to remove goes by who it is, and keeps
 * none.
 */
export type PrincipalInput = z.input<typeof PrincipalInput>
/** What a grant gives at a pattern, as a handle takes it: `'all'`, `'none'`, or permissions. `'none'` is `[]` on the wire. */
export type CanAt = 'all' | 'none' | readonly Permission[]
/** A grant's `can`, as a handle takes it: each channel pattern and what it gives. */
export type GrantCan = Readonly<Record<string, CanAt>>
/** A grant, as a handle takes it: who it names, and what they may do. */
export type GrantInput = { principals: readonly PrincipalInput[]; can: GrantCan }
/**
 * What a grant write takes beside its change. `lockMeOut` goes ahead with one you couldn't take
 * back: it takes your own `manage` at a pattern it names, and is 409 `grant_lockout` without it.
 */
export type GrantWriteOptions = { lockMeOut?: boolean }
/** What `updateGrant` takes: principals to add, principals to remove (by who they are, environments aside), and a `can` that replaces the grant's. */
export type UpdateGrantInput = { add?: readonly PrincipalInput[]; remove?: readonly PrincipalInput[]; can?: GrantCan }
/** What `createSchema` takes: a version's name, its number, and its JSON Schema. */
export type SchemaInput = z.input<typeof SchemaBody>
export type SchedulesQueryOutput = z.output<typeof SchedulesQuery>

/** A scheduled message. It posts as `by`, its creator; each message it posts carries `schedule: { id, n }`. */
export type ScheduleView = {
  id: string
  channel: string
  /** The thread it replies in, or null when each send starts a new thread in `channel`. */
  re: string | null
  text: string
  labels: Record<string, string>
  noSync: boolean
  attachments: { id: string; name: string; type: string; size: number }[]
  first: string
  /** Milliseconds between sends, or null for once. */
  every: number | null
  until: string | null
  times: number | null
  /** Sends posted so far. */
  sent: number
  /** When the next send is due; null once it's done or canceled. */
  next: string | null
  /** The last message it posted. */
  last: string | null
  state: 'pending' | 'done' | 'canceled'
  canceled: { by: { actor: string; principal: string; profile: string | null }; reason: 'canceled' | 'thread_deleted' | 'dropped' | 'revoked' } | null
  by: { actor: string; principal: string; profile: string | null }
  author: ActorView
  createdAt: string
}

/**
 * Which grants decide a channel for a principal: the `pattern` that won there (an exact channel,
 * then the longest subtree, then `*`), the patterns it won `over` (the others its grants name that
 * cover the channel, most specific first), the `level` that won at it, the `grants` at that level,
 * which add up, and what they give, `can`, after `capped`, the team role that caps a person's. `pattern` and `level` are null where no grant decides: the
 * board's own code, its own deployments where it runs, or a principal nothing lets in, whose `can`
 * is empty.
 */
export type Explanation = {
  channel: string
  pattern: string | null
  over: string[]
  level: 'principal' | 'group' | 'everyone' | null
  grants: GrantView[]
  capped: string | null
  can: Permission[]
}

/** A principal as a grant keeps it: IDs, with the names the board knows beside them. */
export type PrincipalView =
  | { kind: 'user'; userId: string; email: string | null }
  | { kind: 'project'; projectId: string; name: string | null; environments: string[]; teamId: string | null }
  | { kind: 'github'; repositoryId: string | null; repository: string; workflow?: string; branch?: string; event?: string }
  | { kind: 'oidc'; issuer: string; claims: Record<string, string | string[]> }
  | { kind: 'all-users' }
  | { kind: 'all-projects'; environments: string[] }
  | { kind: 'app'; clientId: string; name: string | null }
  | { kind: 'all-apps' }
  | { kind: 'everyone' }

/** A grant: who it names, what it lets them do, and who changed it last, when. */
export type GrantView = {
  id: string
  principals: PrincipalView[]
  /** As it was written: each pattern and `'all'` or its permissions, `[]` for none. */
  can: Record<string, 'all' | Permission[]>
  /** Whether a person's team role caps what it gives them: a viewer only reads and reacts. False where the board has no roles. */
  capped: boolean
  /** The actor that changed it last, and when: null for one the board started with. */
  by: string | null
  at: string | null
}

/** A schema version, as the board keeps it: it never changes. */
export type SchemaView = {
  /** `name@version`: what names it everywhere. */
  id: string
  name: string
  version: number
  description: string | null
  /** The JSON Schema its data matches. */
  schema: Record<string, unknown>
  /** One every board has: no one registers a version under its name. */
  builtIn: boolean
  /** The actor that registered it, and when: null for a built-in. */
  by: string | null
  at: string | null
}

/**
 * A task, on its root: its state (the root's `board.task` label too), whose it is and which of its
 * owner's actors made it one (`by`, who changes it as its owner), what it waits for, and who holds
 * it until when. A claim's token shows nowhere but in the answer that made it.
 */
export type TaskView = Omit<Task, 'needs' | 'claim'> & {
  /** The tasks it waits for, by their IDs. */
  needs: string[]
  /** Who holds it. One whose `until` has passed is over: the task is claimable, and `ready` once the board says so. */
  claim: { actor: string; until: string } | null
}

/** What a claim answers, once: `epoch` and `token` go on every write the claim makes, until `until`. */
export type TaskClaim = { epoch: number; token: string; until: string }

/**
 * `kind` says who wrote it: a `person` or a platform user (`external`), an agent (`profile`), or a deployment or workflow.
 * `via` is who one with a profile acts through: an agent's person or project, or the principal whose sync speaks for a
 * platform user (`Malte via www (preview)`). `platform` is a platform user's platform (`slack`), for display: their ID
 * names the sync key they came through. `verified` says the board checked who they are rather than taking their name
 * from what they sent: everyone on Vercel's board, and on a local one, whoever shows under the handle a credential it
 * checked gave them, as itself or after `via`.
 */
export type ActorView = Pick<Actor, 'kind' | 'handle' | 'name' | 'avatar' | 'via' | 'platform'> & { verified?: true }
/** A message as clients see it: its IDs are refs, and `version` says which of two views of it is newer. */
export type MessageView = Omit<Message, 'id' | 're' | 'replyTo' | 'links' | 'schedule' | 'task' | 'version' | 'revision' | 'platformText'> & {
  id: string
  /** The thread's root, or null for a root. */
  re: string | null
  /** The exact message replied to, when it isn't the root. */
  replyTo: string | null
  /** Grows with each change to this message: of two views of it, the one with the higher version is newer. */
  version: number
  /**
   * Changes with each edit and delete, and only then: what an edit or a delete passes as `revision`
   * to change it only if no one has since.
   */
  revision: number
  links: LinkView[]
  /** Set when a schedule posted it: the schedule's ID and which send this was, from 0. */
  schedule?: { id: string; n: number }
  /** Set on a root that's a task. */
  task?: TaskView
  author: ActorView | null
  /**
   * The data its text carries, in order: each fence that names a schema (```json#sandbox@1), which
   * the board checked against that schema when the message was written. A message a sync brought
   * in has none, whatever its text says: a platform's text is never checked.
   */
  blocks: BlockView[]
}

/** A block: the schema it names, and its data, a JSON object that matches it. */
export type BlockView = {
  /** The schema's name and version: `sandbox`, 1. */
  schema: string
  version: number
  data: Record<string, unknown>
}

/** A link in a message: a board message it names is a ref. */
export type LinkView = Omit<Link, 'message'> & { message: string | null }

/** An event's payload as clients see it: message IDs are refs, and a claim's `token` is left out. */
type PayloadView<P> = {
  [K in keyof P as K extends 'token' ? never : K]: K extends 'id' | 're' | 'replyTo'
    ? P[K] extends number ? string : P[K] extends number | null ? string | null : P[K]
    : K extends 'links'
      ? LinkView[]
      : K extends 'needs'
        ? string[]
        : K extends 'schedule'
          ? P[K] extends undefined ? undefined : { id: string; n: number } | Exclude<P[K], object>
          : P[K]
}

/** A board event as subscribers get it. Checking `type` narrows `payload` to that event's. */
export type BoardEventView = BoardEvent extends infer E
  ? E extends { type: infer T; payload: infer P }
    ? {
        /** Where this event is in the board's order: pass it as `after` to read on from here. */
        cursor: string
        type: T
        createdAt: string
        payload: PayloadView<P>
        /** The message the event concerns, as it is after the event. */
        message?: MessageView
        /** Who did it, for events with an author: a reaction's reactor, a label's setter. */
        actor?: ActorView & { id: string }
      }
    : never
  : never

export type Discovery = {
  version: string
  url: string
  audience: string
  team_id: string | null
  project_id: string | null
  /**
   * The board's name, where boards have one: a team's board in Vercel's API (`General`, the default's).
   * A handle on one says it, for a UI to show which board it's on; `GET /` on a board never does.
   */
  name?: string
  /** The board's sync entries: `key` names its webhook and inbox, `platform` is e.g. `slack`. */
  sync: { key: string; platform: string }[]
  /**
   * Whether `POST /watchers` takes a `path`: the board wakes the caller's own Vercel project there,
   * through its Deployment Protection. A board that can't find a project's deployments leaves it out.
   */
  wake_by_path?: boolean
}

/**
 * Watchers a board on `http()` registered here: one registration per principal, woken at a URL
 * or at a path on its own project, never both.
 */
export type RegistrationView = {
  /** The principal that registered. Its watchers write as it, with their IDs as profiles. */
  owner: string
  watch: Record<string, { tail: string }>
  /** Its sync entries. With any, its sync gets every event it delivers to platforms, as matches of watcher `@sync`. */
  sync: { key: string; platform: string }[]
  /** Every wake-up carries it, so the board can tell its registration is stale. */
  hash: string
} & (
  | {
      /** Where it's woken: `<url>/wake`. `null` when it pulls on its own. */
      url: string | null
      path?: undefined
      branch?: undefined
    }
  | {
      url: null
      /** Where it's woken on its own Vercel project, on a board with `wake_by_path`. */
      path: string
      /** The branch whose latest ready preview a preview's `path` wakes. */
      branch?: string
    }
)

/** One match, leased to the registrant that pulled it. */
export type MatchView = {
  /** The match's ID, which its watcher's writes derive their IDs from. */
  id: string
  watcher: string
  thread: string
  /** Acks name it. A lease that ran out is someone else's next try. */
  lease: string
  /** How many tries came before this one. */
  attempt: number
  /** The event, as `vb tail --json` prints it, as the registrant may see it. */
  event: BoardEventView
}

export type Me = {
  actor: string
  principal: string
  kind: Actor['kind']
  handle: string
  name: string
  avatar: string | null
  profile: string | null
  /** Who you act through, writing with a profile: `claude via julian`. */
  via?: Via
  expiresAt: string | null
  /** What you may do in each channel pattern, implications included: `{ '*': [...every permission] }` is full access. */
  can: AccessSummary
}

/** A thread's sync: its root, where it lives, its targets, and the platform thread it is on each. */
export type SyncThreadView = { thread: string; root: string; channel: string; targets: string[]; external: Record<string, string> }
/** What a platform ID is on the board. Each answers only when it was asked. */
export type SyncFindView = {
  /** The board thread a platform thread belongs to. */
  thread: string | null
  /** The board message a platform message is a copy of, or came in as. */
  message: string | null
}
/** A message's copies, by target: where it went, or came from, on each platform. */
export type SyncCopiesView = { copies: Record<string, Record<string, ExternalCopy>> }
/** A platform event pulled from the caller's inbox, leased to it until it acks. */
export type InboxItem = {
  id: string
  key: string
  /** The platform thread: its events come one at a time, in order. */
  thread: string
  lease: string
  /** How many tries came before this one. */
  attempt: number
  event: z.infer<typeof ExternalEvent>
  raw: unknown
}

/**
 * A channel, and what its board counts in it: its threads, its messages, and its last message's
 * position. `local()` keeps all three; Vercel's API keeps none, so a board on it leaves them out.
 */
export type ChannelView = { path: string } & Partial<Omit<Channel, 'path'>>
/** A page of channels. `next` reads the page after it, as `after`: null when this is the last. `cursor` is where the board is now. */
export type ChannelsPage = { channels: ChannelView[]; cursor: string; next: string | null }
export type MessagesPage = { messages: MessageView[]; cursor: string }
/**
 * Where a message's thread is synced: each target, the platform thread it is there, and this
 * message's copy, with the platform's link to it when the sync that knows the platform runs here.
 */
export type SyncedView = {
  targets: {
    /** As the thread's sync records it: `slack:C0123ABC`, `github:acme/www:12`. */
    target: string
    /** The sync entry it belongs to: `slack`. */
    key: string
    /** The platform thread this message's copy is in, or the one the target is, once it has one. */
    thread: string | null
    /** This message's copy there, by the platform's ID: null when it has none. */
    message: string | null
    url: string | null
    /** Why the message didn't reach it, when it didn't. */
    undelivered: string | null
  }[]
}

export type ThreadView = {
  message: MessageView
  replies: MessageView[]
  cursor: string
  /** The pending schedules that reply in this thread. Boards older than schedules leave it out. */
  schedules?: ScheduleView[]
}
/** A thread at a glance: its root, how many replies it has, and the latest one (null when none). Deleted replies don't count. */
export type ThreadSummaryView = { message: MessageView; replies: number; last: MessageView | null }
export type ThreadsPage = {
  threads: ThreadSummaryView[]
  cursor: string
  /**
   * The `before` for the threads last active before this page's, or null when there are none. A board that pages
   * threads backward sends it on every read without `after`; one from before it leaves it out.
   */
  older?: string | null
  /**
   * Set by a board that keeps no search index (Vercel's) on a read by `mentions` or `text`: how many threads of the
   * channel's page it looked through, matching each one's first and newest message. Its `older` pages back the same way.
   */
  scanned?: number
}
/** Tasks, oldest first, each as its thread's summary: `message.task` is the task. `cursor` reads the next page, as `after`. */
export type TasksPage = { tasks: ThreadSummaryView[]; cursor: string }
export type EventsPage = { events: BoardEventView[]; cursor: string }

/** The platform threads that now show typing: those the thread is synced to, minus any that failed. */
export type TypingResult = { targets: string[] }

/** A platform message read on demand: nothing about it is stored on the board. */
export type SourceMessage = {
  /** The platform's message ID (Slack's `ts`). */
  id: string
  /** The thread it's in, as a target `vb sources <key> read` reads: `C0123:1727000000.123456`. */
  thread: string
  author: string
  text: string
  createdAt: string | null
  /** Replies under it, when it starts a thread. */
  replies: number
  files: { name: string; url: string | null }[]
}

/** A channel or thread read from a platform, oldest message first. */
export type SourceRead = {
  /** The channel's ID, and its name when the platform gave one. */
  channel: string
  name: string | null
  /** Set when a thread was read. */
  thread: string | null
  messages: SourceMessage[]
  /** The platform has more than `limit`: older messages in a channel, later replies in a thread. */
  more: boolean
  /** Where to pick up, as `after`, when the platform can page past `limit`. */
  next?: string | null
}

/** A channel the board's app joined, or was already in (`joined: false`). */
export type SourceJoin = {
  channel: string
  name: string | null
  joined: boolean
}

/** A failure: `code` to branch on, `message` to read, and `hint`, when the board knows one, for what fixes it. */
export type ApiError = { error: { code: string; message: string; hint?: string } }

/** A raw platform event, as `GET /inbox/:key` returns it. */
export type InboxEntry = {
  id: string
  channel: string
  createdAt: string
  sync: string
  event: { kind: string; thread: string; [field: string]: unknown }
  raw: unknown
}

/** The route table: method, path, and the schemas that validate input. */
export const routes = {
  /** Where the board is, its project, and its sync entries. No token. */
  discovery: { method: 'GET', path: '/' },
  me: { method: 'GET', path: '/me' },
  channels: { method: 'GET', path: '/channels', query: ChannelsQuery },
  /** Makes a channel before anything posts to it: needs `read` and `post` there. One that's there already is left as it is. */
  createChannel: { method: 'POST', path: '/channels', body: CreateChannelBody },
  actors: { method: 'GET', path: '/actors', query: ActorsQuery },
  /** One channel's messages across its threads: the newest, or those after one of its cursors. */
  channelMessages: { method: 'GET', path: '/messages', query: ChannelMessagesQuery },
  message: { method: 'GET', path: '/messages/:id', query: ThreadQuery },
  /** Threads with a matching message, one summary each, by latest activity. `before` takes a page's `older`. */
  threads: { method: 'GET', path: '/threads', query: ThreadsQuery },
  post: { method: 'POST', path: '/messages', body: PostBody },
  edit: { method: 'POST', path: '/messages/:id/edit', body: EditBody },
  delete: { method: 'POST', path: '/messages/:id/delete', body: DeleteBody },
  react: { method: 'POST', path: '/messages/:id/reactions', body: ReactBody },
  label: { method: 'POST', path: '/messages/:id/labels', body: LabelBody },
  /** Attaches the thread to a sync target, recording a `thread` receipt: needs `sync` where the thread is. */
  sync: { method: 'POST', path: '/messages/:id/sync', body: SyncBody },
  /** Where the message's thread is synced, and its copy on each target: needs `read` where it is. */
  synced: { method: 'GET', path: '/messages/:id/sync' },
  /** The board message a platform link names, from what the board synced: 404 `message_not_found` for one it didn't, or that the caller can't read. */
  linked: { method: 'GET', path: '/links', query: LinkedQuery },
  /** Ephemeral: shows typing in the thread's synced platform threads, and writes nothing to the log. Needs `post` where the thread is. */
  typing: { method: 'POST', path: '/messages/:id/typing', body: TypingBody },
  /** Posts a message later, as the caller: needs a scheduler. */
  schedule: { method: 'POST', path: '/schedules', body: ScheduleBody },
  schedules: { method: 'GET', path: '/schedules', query: SchedulesQuery },
  /** Its creator, or manage in its channel, may cancel a schedule. Canceling one that's done is a no-op. */
  cancelSchedule: { method: 'POST', path: '/schedules/:id/cancel' },
  /** Tasks, oldest first: open ones unless `state` says otherwise. */
  tasks: { method: 'GET', path: '/tasks', query: TasksQuery },
  /** Starts a thread as a task (`post` there, and `label` for its labels), or makes the thread `re` roots one (`label` there). */
  createTask: { method: 'POST', path: '/tasks', body: CreateTaskBody },
  /** Starts several threads in one channel as tasks, in one write: all of them or none, and nothing shows before all have landed. */
  createTasks: { method: 'POST', path: '/tasks/batch', body: CreateTasksBody },
  /** The caller's own batch made under the `id` it gave, its tasks as they are now: for telling a retry before making anything. */
  createdTasks: { method: 'GET', path: '/tasks/batch/:id', query: CreatedTasksQuery },
  /** Claims the oldest ready task in a channel or subtree: `label` where it is. Answers `{ task: null }` when none is. */
  claimReadyTask: { method: 'POST', path: '/tasks/claim', body: ClaimReadyTaskBody },
  /** Claims a task: `label` in its channel. Its answer's `claim` goes on what the claim does next. */
  claimTask: { method: 'POST', path: '/tasks/:id/claim', body: ClaimTaskBody },
  /** What a claim does, with its `epoch` and `token`: 409 `claim_lost` once it's over. */
  renewTask: { method: 'POST', path: '/tasks/:id/renew', body: RenewTaskBody },
  releaseTask: { method: 'POST', path: '/tasks/:id/release', body: ReleaseTaskBody },
  completeTask: { method: 'POST', path: '/tasks/:id/complete', body: CompleteTaskBody },
  failTask: { method: 'POST', path: '/tasks/:id/fail', body: FailTaskBody },
  /** Holds a task for a person: its claim while it's claimed, its owner or `manage` in its channel otherwise. */
  blockTask: { method: 'POST', path: '/tasks/:id/block', body: BlockTaskBody },
  /** What a task's owner does, or `manage` in its channel. */
  unblockTask: { method: 'POST', path: '/tasks/:id/unblock' },
  reopenTask: { method: 'POST', path: '/tasks/:id/reopen' },
  assignTask: { method: 'POST', path: '/tasks/:id/assign', body: AssignTaskBody },
  /** Replaces what a task waits for, while no one holds it and it isn't finished. */
  setTaskNeeds: { method: 'POST', path: '/tasks/:id/needs', body: TaskNeedsBody },
  cancelTask: { method: 'POST', path: '/tasks/:id/cancel', body: CancelTaskBody },
  /** Listing grants needs manage at `*`; changing one, manage at each pattern its `can` names. Team owners always may. */
  grants: { method: 'GET', path: '/grants' },
  createGrant: { method: 'POST', path: '/grants', body: GrantBody },
  /** Several grants in one write, all or none, judged together. */
  createGrants: { method: 'POST', path: '/grants/batch', body: CreateGrantsBody },
  updateGrant: { method: 'PATCH', path: '/grants/:id', body: UpdateGrantBody },
  /** Which grant decides a channel, for the caller or, with `manage` at `*`, a principal it names. */
  explain: { method: 'GET', path: '/grants/explain', query: ExplainQuery },
  revokeGrant: { method: 'POST', path: '/grants/:id/revoke', body: RevokeGrantBody },
  /** Every schema: the built-ins, then the board's own. Anyone the board lets in reads them. */
  schemas: { method: 'GET', path: '/schemas' },
  /** One schema version, by `name@version`. */
  schema: { method: 'GET', path: '/schemas/:id' },
  /** Registers a version, which never changes after: needs manage at `*`. The same definition again is a no-op. */
  createSchema: { method: 'POST', path: '/schemas', body: SchemaBody },
  /** The caller's own post with the client ID it gave: what `POST /messages` answered, for telling a retry before posting. */
  posted: { method: 'GET', path: '/posts/:id' },
  /** Raw platform events in a sync key's inbox, newest first: the caller's own, and the board's with `sync` everywhere. */
  inbox: { method: 'GET', path: '/inbox/:key', query: InboxQuery },
  /** Pushes platform events into the caller's inbox for a sync key, deduplicated by their platform IDs. */
  inboxPush: { method: 'POST', path: '/inbox/:key', body: InboxPushBody },
  /** The caller's next inbox events, leased to it, one platform thread at a time and in order. */
  inboxNext: { method: 'GET', path: '/inbox/:key/next', query: InboxNextQuery },
  /** How one went: done, or an error to try it again. */
  inboxAck: { method: 'POST', path: '/inbox/:key/:id/ack', body: InboxAckBody },
  /** A platform's write, as its platform author: `sync` where it lands. */
  syncImport: { method: 'POST', path: '/sync/imports', body: SyncImportBody },
  /** What sync did on a platform: a delivery, its files, a failure, or a thread's new target. */
  syncReceipt: { method: 'POST', path: '/sync/receipts', body: SyncReceiptBody },
  /** A board thread's sync, by its key. */
  syncThread: { method: 'GET', path: '/sync/threads/:thread' },
  /** What platform IDs are on the board. */
  syncFind: { method: 'GET', path: '/sync/find', query: SyncFindQuery },
  /** Messages' copies on platforms. */
  syncCopies: { method: 'GET', path: '/sync/copies', query: SyncCopiesQuery },
  /** Reads a platform channel or thread on demand, where that sync runs, without syncing or storing it. Full access only. */
  readSource: { method: 'GET', path: '/sources/:key/read', query: SourceReadQuery },
  /** Adds the app to a public channel so it can be read, where that sync runs and opted in with `join`. Full access only. */
  joinSource: { method: 'POST', path: '/sources/:key/join', body: SourceJoinBody },
  webhook: { method: 'POST', path: '/webhooks/:key' },
  events: { method: 'GET', path: '/events', query: EventsQuery },
  avatar: { method: 'GET', path: '/avatars/:name' },
  /** The file is the body; `content-type` is its type and `x-board-filename` its name, URI-encoded. */
  upload: { method: 'POST', path: '/attachments' },
  attachment: { method: 'GET', path: '/attachments/:id' },
  /** A file too big for one request: the board answers where to `PUT` it in its blob store. Needs a store with `uploadUrl`. */
  uploadStart: { method: 'POST', path: '/attachments/uploads', body: UploadStartBody },
  /** After the `PUT`: the board checks what landed in the store and records the attachment. */
  uploadFinish: { method: 'POST', path: '/attachments/uploads/:id' },
  openapi: { method: 'GET', path: '/openapi.json' },
  /** Watchers registered by boards on `http()`: every one to `manage` everywhere, the caller's own to anyone else. */
  watchers: { method: 'GET', path: '/watchers' },
  /** Registers the caller's watchers, replacing its last registration. On a board on `http()`, registers its own, with no body or token. */
  register: { method: 'POST', path: '/watchers', body: RegisterBody },
  /** The caller's matches it can run now, each leased to it until it acks. */
  matches: { method: 'GET', path: '/watchers/matches', query: MatchesQuery },
  ack: { method: 'POST', path: '/watchers/matches/:id/ack', body: AckBody },
  /** On a board on `http()`: something matched. No body, no token: the board pulls what. */
  wake: { method: 'POST', path: '/wake' },
} as const

export type RouteName = keyof typeof routes
