import { contract, type ContractEvent } from 'experimental-a2'
import { z } from 'zod'
import {
  ActorId,
  Attachment,
  ATTACHMENTS_PER_MESSAGE_MAX,
  CHANNEL_PATTERN_MAX,
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
} from './schemas.ts'
import { ExternalEvent, ExternalTarget, Link, LINKS_PER_MESSAGE_MAX, Origin } from './external.ts'
import { boardEvents } from './events.ts'
import { SCHEMA_DESCRIPTION_MAX, SCHEMA_NAME, SCHEMA_VERSION_MAX } from './data-schemas.ts'

// A2's contracts. The board log's events are plain zod in `events.ts`, so a handle on any backend
// reads them without loading A2; this module and what imports it run only on the local board's engine.

/** The board's one log. Every board fact is an event in session `board`. */
export const boardContract = contract({ name: 'board', events: boardEvents })

/** Raw platform events live outside the board log, one session per external channel. */
export const inboxContract = contract({
  name: 'board-inbox',
  events: {
    'external.received': z.object({
      sync: z.string().min(1),
      event: ExternalEvent,
      raw: z.unknown(),
    }),
    /** An inbox got its first event: session `inboxes` lists them, so a sync key's inbox lists every channel's. */
    'inbox.opened': z.object({ channel: ExternalTarget }),
  },
})

export type InboxEvents = typeof inboxContract.events
export type InboxEvent = ContractEvent<InboxEvents>

/** `inbox:slack:C0123ABC`: the inbox session for one external channel. */
export const inboxSession = (channel: string) => `inbox:${channel}`

/** The session that lists the inboxes: one `inbox.opened` each. */
export const INBOXES_SESSION = 'inboxes'

/** What watchers matched, outside the board log: one session per watcher, so each fails on its own. */
const MatchId = z.string().min(1).max(200)
const LeaseId = z.string().min(1).max(64)
/** What a queue keeps in order: a board thread's key, or a platform thread for an inbox. */
const QueueLane = z.string().min(1).max(300).refine(storable, 'lane has a NUL character or a lone surrogate')

export const watchContract = contract({
  name: 'board-watch',
  events: {
    'watch.matched': z.object({
      /** The board thread, or for an inbox the platform thread: each one's matches go one at a time. */
      thread: QueueLane,
      /** The board event, as `vb tail --json` prints it, as the watcher may see it, or a platform event for an inbox. */
      event: z.unknown(),
      /** A registered watcher's ID: its registrant's session holds all of its watchers' matches. */
      watcher: RemoteWatcherId.optional(),
      /** The registrant's sync, which gets every event it delivers to platforms. */
      sync: z.literal(true).optional(),
      /** A platform event the registrant pushed to its inbox for this sync key, to pull back and import. */
      inbox: z.string().min(1).max(64).optional(),
    }),
    /** The watcher gave up on one match: `run` kept failing, and the thread's later events go on without it. */
    'watch.failed': z.object({
      /** The `watch.matched` event's ID. */
      matched: MatchId,
      thread: QueueLane,
      error: z.string().min(1).max(500),
    }),
    /** A registrant pulled a match: it's theirs to run until `until`, or until they ack it. */
    'watch.leased': z.object({ matched: MatchId, lease: LeaseId, until: z.number().int().nonnegative() }),
    /** The registrant ran it: done, or an error to try again after `retryAt`. A stale lease's ack changes nothing. */
    'watch.acked': z.object({
      matched: MatchId,
      lease: LeaseId,
      error: z.string().min(1).max(500).optional(),
      retryAt: z.number().int().nonnegative().optional(),
    }),
    /** A lease ran out with no ack: a try that didn't finish. */
    'watch.expired': z.object({ matched: MatchId, lease: LeaseId }),
    /** A match's wait after an error is over: it can be pulled again. */
    'watch.retry': z.object({ matched: MatchId }),
    /** A match its registrant can't have anymore: it may not read it, or the watcher is gone. */
    'watch.skipped': z.object({ matched: MatchId, reason: z.string().min(1).max(200) }),
    /** A sweep is set for `at`: one timer for every lease that runs out before it, or a wake-up to try again. */
    'watch.armed': z.object({ at: z.number().int().nonnegative() }),
    /** A timer: an error's wait is over (`matched`), or a sweep (`sweep`). Its consumer decides what it still means. */
    'watch.due': z.object({ matched: MatchId.optional(), retry: z.boolean().optional(), sweep: z.number().int().nonnegative().optional() }),
    /** A wake-up didn't get there, `failures` in a row: nothing wakes the registrant again before `until`. */
    'watch.unreachable': z.object({
      failures: z.number().int().positive(),
      until: z.number().int().nonnegative(),
      /** Its answer's status, or the error. */
      why: z.string().min(1).max(200),
    }),
    /** The registrant's board answered a wake-up, pulled, or registered: its next match wakes it. */
    'watch.reachable': z.object({ by: z.enum(['wake', 'pull', 'registration']) }),
  },
})

export type WatchEvents = typeof watchContract.events

/** `watch:triage`: the session for one watcher, or `watch:@<principal>` for everything a registrant registered. */
export const watchSession = (id: string) => `watch:${id}`

/**
 * A principal as the board keeps it, to work out its access again later under
 * the rules as they are then: who it is, and the token facts rules match on.
 */
export const StoredPrincipal = z.object({
  id: z.string().min(1),
  kind: z.enum(['person', 'deployment', 'workflow', 'external']),
  handle: Handle,
  facts: z
    .object({
      issuer: z.enum(['vercel', 'github', 'oidc', 'host']),
      iss: z.string().max(1000),
      claims: z.record(z.string(), z.union([z.string().max(1000), z.number(), z.boolean()])),
      /** The board's own Vercel team, as the board knew it when it verified the token. */
      team: z.string().max(200).optional(),
    })
    .optional(),
  scope: z.string().max(CAN_MAX).optional(),
  /** The board token it came with, from when boards issued them: what it stored stopped with them. */
  token: z.string().min(1).max(64).optional(),
})

/** A watcher as a board on `http()` registers it: its tail. */
export const WatcherSpec = z.object({
  tail: z.string().max(1000),
})

/**
 * Watchers that boards on `http()` registered with this one, outside the board
 * log: one session, `registry`. Each principal has one registration, and its
 * newest replaces the last.
 */
export const registryContract = contract({
  name: 'board-registry',
  events: {
    'watchers.registered': z.object({
      /** The principal that registered, which its watchers' writes are by, with their IDs as profiles. */
      owner: z.string().min(1).max(200),
      /** It, to work out what it may read at each match: a watcher sees only what its registrant can. */
      principal: StoredPrincipal,
      /** Where to wake it: `<url>/wake`. Without one, it pulls on its own. */
      url: z.string().url().max(500).nullable(),
      watch: z.record(RemoteWatcherId, WatcherSpec),
      /**
       * Its sync entries: with any, its sync subscribes too, to every post, change, and thread sync
       * where it may sync. Older registrations have none.
       */
      sync: z.array(z.object({ key: z.string().min(1).max(64), platform: z.string().min(1).max(64) })).max(32).optional(),
      /** `watchersHash(watch)`, which every wake-up carries so the board can tell it's stale. */
      hash: z.string().min(1).max(100),
    }),
  },
})

export type RegistryEvents = typeof registryContract.events

export const REGISTRY_SESSION = 'registry'

/** Epoch milliseconds. */
const Millis = z.number().int().nonnegative()

/**
 * Who a schedule posts as: the identity that created it, as the board resolved
 * it then. A token's verified claims (`facts`) and the scope it was narrowed by
 * let each send work out its access again, under the rules as they are then.
 * Schedules from before they were kept have neither.
 */
export const ScheduleIdentity = z.object({
  author: Author,
  principal: StoredPrincipal,
  actor: z.object({
    id: ActorId,
    kind: SeenActorKind,
    handle: Handle,
    name: z.string().min(1).max(128),
    avatar: z.string().nullable(),
    via: z.object({ name: Handle, environment: z.string().min(1).max(128).nullable() }).optional(),
  }),
})

/**
 * Scheduled messages, outside the board log: one session, `schedules`. A schedule's ID is
 * its `schedule.created` index. Each send is an A2 timer carrying `schedule.due`; timers
 * can't be revoked, so a canceled or superseded one fires into a no-op.
 */
export const schedulesContract = contract({
  name: 'board-schedules',
  events: {
    'schedule.created': z.object({
      /** A new root in `channel`, or a reply in the thread rooted at `re`. */
      channel: ChannelPath,
      re: MessageId.nullable(),
      text: z.union([MessageText, z.literal('')]),
      labels: Labels,
      noSync: z.boolean(),
      attachments: z.array(Attachment).max(ATTACHMENTS_PER_MESSAGE_MAX).optional(),
      /** The first send. */
      first: Millis,
      /** Repeats this often after the first send, or null for once. */
      every: Millis.nullable(),
      /** Stops repeating after this time, or after this many sends. Null: never. */
      until: Millis.nullable(),
      times: z.number().int().positive().nullable(),
      as: ScheduleIdentity,
      /**
       * (server) Its creator couldn't read its channel. Where a caller can't
       * read, it sees and cancels only these of its own. Schedules from before
       * channel access have none.
       */
      blind: z.literal(true).optional(),
    }),
    'schedule.canceled': z.object({
      id: z.number().int().positive(),
      by: Author,
      /**
       * `canceled`: someone canceled it; `thread_deleted`: the thread it replies in is gone;
       * `dropped`: the board's middleware dropped a send, so it would drop the rest;
       * `revoked`: its creator can no longer post there.
       */
      reason: z.enum(['canceled', 'thread_deleted', 'dropped', 'revoked']),
    }),
    /** (server) A timer: send `n` is due at `at`. */
    'schedule.due': z.object({ id: z.number().int().positive(), n: z.number().int().nonnegative(), at: Millis }),
    /** (server) Send `n` was posted as `message`; the next is due at `next`, or never. */
    'schedule.fired': z.object({
      id: z.number().int().positive(),
      n: z.number().int().nonnegative(),
      message: MessageId,
      next: Millis.nullable(),
    }),
    /** (server) The Vercel deployment `deployment` took over every send: an earlier one's timers no longer post. */
    'schedule.takeover': z.object({ deployment: z.string().min(1) }),
  },
})

export type ScheduleEvents = typeof schedulesContract.events
export type ScheduleEvent = ContractEvent<ScheduleEvents>
export const SCHEDULES_SESSION = 'schedules'

/**
 * A claim's lease timers, outside the board log: one session, `leases`. Each claim and renewal arms
 * one for when its lease runs out, carrying `lease.due`. Timers can't be revoked, so one for a claim
 * that's over, or renewed since, fires into a no-op: the board log holds only a real `task.expired`.
 */
export const leasesContract = contract({
  name: 'board-leases',
  events: {
    /** (server) A timer: task `id`'s claim at `epoch` was to run out at `at`. */
    'lease.due': z.object({ id: MessageId, epoch: z.number().int().positive(), at: Millis }),
  },
})

export type LeaseEvents = typeof leasesContract.events
export const LEASES_SESSION = 'leases'

const Grant = z.union([z.literal('all'), z.array(z.string().min(1).max(16)).max(8)])
/** A `can`, as config writes it: board() checks it before it's kept. */
const Can = z.union([Grant, z.record(z.string().min(1).max(CHANNEL_PATTERN_MAX), Grant)])
const ClaimValue = z.string().min(1).max(1000)

const Environments = z.array(z.string().min(1).max(100)).max(16)

/** Who a grant names, as the board keeps it: IDs, with the names it knows beside them. */
const GrantPrincipal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: z.string().min(1).max(200), email: z.string().max(320).optional() }),
  // A project on the team the board was on when the grant named it, where the board knew it.
  z.object({ kind: z.literal('project'), projectId: z.string().min(1).max(200), name: z.string().max(200).optional(), environments: Environments, teamId: z.string().min(1).max(200).optional() }),
  z.object({
    kind: z.literal('github'),
    repository: z.string().min(1).max(200),
    repositoryId: z.string().min(1).max(64).optional(),
    workflow: z.string().min(1).max(300).optional(),
    branch: z.string().min(1).max(255).optional(),
    event: z.string().min(1).max(64).optional(),
  }),
  z.object({ kind: z.literal('oidc'), issuer: z.string().min(1).max(1000), claims: z.record(z.string().min(1).max(200), z.union([ClaimValue, z.array(ClaimValue).min(1).max(32)])) }),
  z.object({ kind: z.literal('all-users') }),
  z.object({ kind: z.literal('all-projects'), environments: Environments }),
  z.object({ kind: z.literal('app'), clientId: z.string().min(1).max(200), name: z.string().max(200).optional() }),
  z.object({ kind: z.literal('all-apps') }),
  z.object({ kind: z.literal('everyone') }),
])
/** A grant's `can`, as written: each pattern and `'all'` or its permissions. */
const GrantCan = z.record(z.string().min(1).max(CHANNEL_PATTERN_MAX), Grant)

/**
 * Who the board trusts beside its code's rules, outside the board log: its grants. Session
 * `access`. A grant's ID comes from the fold, counting from the one the board starts with.
 */
export const accessContract = contract({
  name: 'board-access',
  events: {
    /** From before grants named principals: kept so older logs load, and folded into nothing. */
    'grant.set': z.object({
      issuer: z.string().min(1).max(1000),
      claims: z.record(z.string().min(1).max(200), z.union([ClaimValue, z.array(ClaimValue).min(1).max(32)])),
      can: Can,
      by: ActorId,
    }),
    /** From before grants named principals: folded into nothing, so it can't take a grant made since. */
    'grant.revoked': z.object({ id: z.number().int().positive(), by: ActorId }),
    /** A new grant: who it names, and what it lets them do. */
    'grant.created': z.object({ principals: z.array(GrantPrincipal).min(1).max(32), can: GrantCan, by: ActorId }),
    /** A grant as it is now, after an update. */
    'grant.updated': z.object({ id: z.number().int().positive(), principals: z.array(GrantPrincipal).min(1).max(32), can: GrantCan, by: ActorId }),
    /** A grant revoked. */
    'grant.deleted': z.object({ id: z.number().int().positive(), by: ActorId }),
    /** From when boards issued tokens: kept so older logs load, and folded into nothing. */
    'token.minted': z.object({ by: ActorId }),
    /** From when boards issued tokens: folded into nothing. */
    'token.revoked': z.object({ by: ActorId }),
  },
})

export type AccessEvents = typeof accessContract.events
export type AccessEvent = ContractEvent<AccessEvents>
export const ACCESS_SESSION = 'access'

/**
 * The board's schema registry, outside the board log: one session, `schemas`. A version is
 * registered once and never changes, so its event is all there is of it.
 */
export const schemasContract = contract({
  name: 'board-schemas',
  events: {
    /** A schema version, for good: `name@version` is its ID, and `schema` the JSON Schema the board checked. */
    'schema.created': z.object({
      name: z.string().regex(SCHEMA_NAME),
      version: z.number().int().min(1).max(SCHEMA_VERSION_MAX),
      description: z.string().min(1).max(SCHEMA_DESCRIPTION_MAX).nullable(),
      schema: z.record(z.string(), z.unknown()),
      by: ActorId,
    }),
  },
})

export type SchemasEvent = ContractEvent<typeof schemasContract.events>
export const SCHEMAS_SESSION = 'schemas'
