import type { z } from 'zod'
import type { Actor } from '../contract/folds.ts'
import type { Mentioned } from '../contract/mentions.ts'
import type { Attachment } from '../contract/schemas.ts'
import type {
  AckBody,
  ActorsQuery,
  ActorView,
  AssignTaskBody,
  TaskNeedsBody,
  BlockTaskBody,
  CancelTaskBody,
  ChannelMessagesQuery,
  ChannelsPage,
  ChannelsQuery,
  ChannelView,
  ClaimReadyTaskBody,
  ClaimTaskBody,
  CompleteTaskBody,
  CreateTaskBody,
  CreateTasksBody,
  CreatedTasksQuery,
  FailTaskBody,
  ReleaseTaskBody,
  RenewTaskBody,
  TaskClaim,
  TasksPage,
  TasksQuery,
  CreateChannelBody,
  Discovery,
  DeleteBody,
  EditBody,
  EventsPage,
  CreateGrantsBody,
  GrantBody,
  RevokeGrantBody,
  GrantView,
  UpdateGrantBody,
  ExplainQuery,
  Explanation,
  EventsQuery,
  InboxAckBody,
  InboxEntry,
  InboxItem,
  InboxNextQuery,
  InboxPushBody,
  InboxQuery,
  LinkedQuery,
  LabelBody,
  MatchesQuery,
  MatchView,
  Me,
  MessagesPage,
  MessageView,
  PostBody,
  ReactBody,
  RegisterBody,
  RegistrationView,
  ScheduleBody,
  SchedulesQuery,
  ScheduleView,
  SchemaBody,
  SchemaView,
  SourceJoin,
  SourceJoinBody,
  SourceRead,
  SourceReadQuery,
  ThreadsPage,
  SyncCopiesQuery,
  SyncCopiesView,
  SyncFindQuery,
  SyncFindView,
  SyncImportBody,
  SyncReceiptBody,
  SyncThreadView,
  SyncedView,
  ThreadQuery,
  ThreadsQuery,
  ThreadView,
  TypingBody,
  UploadStartBody,
  UploadTicket,
} from './routes.ts'

type Input<S extends z.ZodType> = NonNullable<z.output<S>>
type Id = { id: string }
type Key = { key: string }
type Nothing = Record<string, never>

/**
 * The protocol, method by method: what each takes and what it answers, as the wire carries them.
 * board() serves each at its route in `routes` and calls the backend's method of the same name.
 */
export type Protocol = {
  /** Where the board is and what it syncs, for a client to mint a token from: it needs none itself. */
  discovery: { input: Nothing; output: Discovery }
  me: { input: Nothing; output: Me }
  channels: { input: Input<typeof ChannelsQuery>; output: ChannelsPage }
  /** `created` is false for a channel that was there already, made by a post or another create. */
  createChannel: { input: Input<typeof CreateChannelBody>; output: { channel: ChannelView; created: boolean } }
  /** Everyone, or with `id`, only those: a board that doesn't narrow by ID may answer everyone. */
  actors: { input: Input<typeof ActorsQuery>; output: { actors: (Actor & Pick<ActorView, 'verified'>)[]; cursor: string } }
  /** One channel's messages across its threads, oldest first: the newest `limit`, or those after one of the channel's cursors. */
  channelMessages: { input: Input<typeof ChannelMessagesQuery>; output: MessagesPage }
  threads: { input: Input<typeof ThreadsQuery>; output: ThreadsPage }
  message: { input: Id & Input<typeof ThreadQuery>; output: ThreadView }
  /** `mentions` says what became of each `@handle` the text typed, when it typed any: see `Mentioned`. A write that takes a text answers it the same way. */
  post: { input: Input<typeof PostBody>; output: { message: MessageView; mentions?: Mentioned[] } }
  /** The caller's own post with client ID `id`, as it landed: 404 `post_not_found` when there's none. */
  posted: { input: Id; output: { message: MessageView } }
  edit: { input: Id & Input<typeof EditBody>; output: { ok: true; mentions?: Mentioned[] } }
  delete: { input: Id & Input<typeof DeleteBody>; output: { ok: true } }
  react: { input: Id & Input<typeof ReactBody>; output: { ok: true } }
  label: { input: Id & Input<typeof LabelBody>; output: { ok: true } }
  schedule: { input: Input<typeof ScheduleBody>; output: { schedule: ScheduleView; mentions?: Mentioned[] } }
  schedules: { input: Input<typeof SchedulesQuery>; output: { schedules: ScheduleView[] } }
  cancelSchedule: { input: Id; output: { schedule: ScheduleView; canceled: boolean } }
  /** Tasks, oldest first, each as its thread's summary. 501 `no_tasks` where the board keeps none, as every task method answers there. */
  tasks: { input: Input<typeof TasksQuery>; output: TasksPage }
  /** `task` is the task's root. `claim` comes with a task made with `claim`; a retry of one that landed gets the task without it. */
  createTask: { input: Input<typeof CreateTaskBody>; output: { task: MessageView; claim?: TaskClaim; mentions?: Mentioned[] } }
  /**
   * `tasks` are the tasks' roots, in the body's order. 400 `invalid_needs` for a `key` two tasks go by, one no task has,
   * or tasks that wait for each other; 400 `batch_too_large` for more than a board holds in one write. Nothing is made
   * then, and a retry with the same `id` answers the tasks the first made.
   */
  createTasks: { input: Input<typeof CreateTasksBody>; output: { tasks: MessageView[]; mentions?: Mentioned[] } }
  /**
   * The caller's own batch made under `id`, its tasks' roots as they are now, in order: 404 `batch_not_found` when
   * there's none. With `request`, 409 `duplicate_id` when the batch was made for another one.
   */
  createdTasks: { input: Id & Input<typeof CreatedTasksQuery>; output: { tasks: MessageView[] } }
  /** The oldest ready task there, claimed, or `{ task: null }` when there's none, after waiting up to `wait` seconds. */
  claimReadyTask: { input: Input<typeof ClaimReadyTaskBody>; output: { task: MessageView; claim: TaskClaim } | { task: null } }
  /** 409 `task_claimed` while someone holds it, and of claims that race, for all but one. */
  claimTask: { input: Id & Input<typeof ClaimTaskBody>; output: { task: MessageView; claim: TaskClaim } }
  /** `until` is the lease's new end. */
  renewTask: { input: Id & Input<typeof RenewTaskBody>; output: { task: MessageView; until: string } }
  releaseTask: { input: Id & Input<typeof ReleaseTaskBody>; output: { task: MessageView } }
  completeTask: { input: Id & Input<typeof CompleteTaskBody>; output: { task: MessageView } }
  failTask: { input: Id & Input<typeof FailTaskBody>; output: { task: MessageView } }
  blockTask: { input: Id & Input<typeof BlockTaskBody>; output: { task: MessageView } }
  /** A task that isn't blocked is left as it is. */
  unblockTask: { input: Id; output: { task: MessageView } }
  /** A failed task is ready again; one that's open is left as it is. */
  reopenTask: { input: Id; output: { task: MessageView } }
  assignTask: { input: Id & Input<typeof AssignTaskBody>; output: { task: MessageView } }
  /** 400 `invalid_needs` for a prerequisite that isn't one, or that would make the task wait for itself. The same set is left as it is. */
  setTaskNeeds: { input: Id & Input<typeof TaskNeedsBody>; output: { task: MessageView } }
  cancelTask: { input: Id & Input<typeof CancelTaskBody>; output: { task: MessageView } }
  /** The board's grants: needs `manage` at `*`, or a team owner. 501 `no_grants` where the board keeps none. */
  grants: { input: Nothing; output: { grants: GrantView[] } }
  /**
   * A new grant, always: the same principals again are another. Needs `manage` at each pattern its
   * `can` names. One its caller couldn't take back is 409 `grant_lockout`, unless it says `lockMeOut`.
   */
  createGrant: { input: Input<typeof GrantBody>; output: { grant: GrantView } }
  /** Several grants in one write, all or none, in the order given: each needs what `createGrant` does, on the grants as they are, and a lockout is judged with all of them made. */
  createGrants: { input: Input<typeof CreateGrantsBody>; output: { grants: GrantView[] } }
  /** Adds and removes principals, or replaces its `can`: needs what `checkGrantChange` says, for the grant as it was and as it'd be. 404 `grant_not_found`. */
  updateGrant: { input: Id & Input<typeof UpdateGrantBody>; output: { grant: GrantView } }
  /** Which grant decides `channel` for the caller, or with `manage` at `*` (or a team owner), the principal it names. */
  explain: { input: Input<typeof ExplainQuery>; output: Explanation }
  /** `revoked` is false when it was already gone. */
  revokeGrant: { input: Id & Input<typeof RevokeGrantBody>; output: { revoked: boolean } }
  /** Every schema: the built-ins, then the board's own, by name and version. 501 `no_schemas` where the board keeps none. */
  schemas: { input: Nothing; output: { schemas: SchemaView[] } }
  /** One schema version, by `name@version`: 400 `invalid_schema_id` for anything else, 404 `schema_not_found` for one that isn't there. */
  schema: { input: Id; output: { schema: SchemaView } }
  /**
   * Registers a version, for good: needs `manage` at `*`. `created` is false for one that's there
   * with the same definition, and another definition is 409 `schema_immutable`. A built-in's name is
   * 409 `reserved_schema`, and a definition the board won't keep 400 `invalid_schema`.
   */
  createSchema: { input: Input<typeof SchemaBody>; output: { schema: SchemaView; created: boolean } }
  upload: { input: { data: Uint8Array; name: string | null; type: string | null }; output: { attachment: Attachment } }
  attachment: { input: Id; output: { attachment: Attachment; data: Uint8Array | ReadableStream<Uint8Array> } }
  /** A direct upload's ticket: where to `PUT` a file too big for `upload`. 501 `no_direct_uploads` when the blob store can't sign one. */
  uploadStart: { input: Input<typeof UploadStartBody>; output: UploadTicket }
  /** The attachment, once the bytes are in the store: 409 `not_uploaded` before. Finishing one twice answers the same. */
  uploadFinish: { input: Id; output: { attachment: Attachment } }
  watchers: { input: Nothing; output: { watchers: RegistrationView[] } }
  register: { input: Input<typeof RegisterBody>; output: RegistrationView }
  matches: { input: Input<typeof MatchesQuery>; output: { matches: MatchView[] } }
  ack: { input: Id & Input<typeof AckBody>; output: { ok: true } }
  /** Long-polls with `wait`. board() serves SSE from it, so a backend has one way to read events. */
  events: { input: Input<typeof EventsQuery>; output: EventsPage }
  /** Typing in the platform threads the message's thread is synced to: needs `post` there. Answers the threads that took it. */
  typing: { input: Id & Input<typeof TypingBody>; output: { targets: string[] } }
  /** A platform channel or thread, read with sync entry `key`'s app where that sync runs: needs `manage` everywhere. */
  readSource: { input: Key & Input<typeof SourceReadQuery>; output: SourceRead }
  /** Adds sync entry `key`'s app to a public channel, where that sync runs and opted in: needs `manage` everywhere. */
  joinSource: { input: Key & Input<typeof SourceJoinBody>; output: SourceJoin }
  /** Where a message's thread is synced, and its copy on each target, from sync's records: needs `read` where it is. */
  synced: { input: Id; output: SyncedView }
  /**
   * The thread of the board message a platform link names, from sync's records: the platform is
   * never asked. 404 `message_not_found` for a link the board didn't sync, or one the caller can't read.
   */
  linked: { input: Input<typeof LinkedQuery>; output: ThreadView }

  // Sync's records, which sync in board() keeps through these wherever the board lives. Each needs `sync`.
  /**
   * A platform's write as its platform author, idempotent per platform event. `dropped`: the
   * middleware kept a post or an edit off the board, and what it responded, for sync to tell the
   * author on the platform.
   */
  syncImport: { input: Input<typeof SyncImportBody>; output: { message: string | null; dropped?: string[] } }
  /** A delivery, its files, a failure, or a thread's new target. `attached` is false for a target the thread had. */
  syncReceipt: { input: Input<typeof SyncReceiptBody>; output: { ok: true; attached?: boolean } }
  syncThread: { input: { thread: string }; output: SyncThreadView }
  syncFind: { input: Input<typeof SyncFindQuery>; output: SyncFindView }
  /** Messages' copies on platforms that the caller's sync recorded, by target: another sync's never show. */
  syncCopies: { input: Input<typeof SyncCopiesQuery>; output: SyncCopiesView }
  /** Platform events into the caller's inbox, deduplicated by their platform IDs. */
  inboxPush: { input: Key & Input<typeof InboxPushBody>; output: { ok: true } }
  /** The caller's next inbox events, leased, one platform thread at a time and in order. */
  inboxNext: { input: Key & Input<typeof InboxNextQuery>; output: { items: InboxItem[] } }
  inboxAck: { input: Key & Id & Input<typeof InboxAckBody>; output: { ok: true } }
  /** Raw platform events, newest first, for debugging sync. */
  inbox: { input: Key & Input<typeof InboxQuery>; output: { events: InboxEntry[] } }
}

export type Method = keyof Protocol
