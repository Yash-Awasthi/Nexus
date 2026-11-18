import { derivedId } from '../client/ids.ts'
import { ALONG_MAX, type BoardEvent } from '../contract/events.ts'
import type { Link, Origin } from '../contract/external.ts'
import { actorsReducer, channelsReducer } from '../contract/reducers.ts'
import { foldMessages, type Actor, type ActorsState, type Channel, type Message, type MessagesState, type Task } from '../contract/folds.ts'
import { own } from '../contract/own.ts'
import { channelOf, isThreadTarget } from '../contract/external.ts'
import { EDITED_HOLD, type Attachment, type Author, type Labels } from '../contract/schemas.ts'
import { platformProfile } from '../contract/profiles.ts'
import { wroteAs, type Granted } from './auth.ts'
import { authorize, FULL_ACCESS, type Access, type Permission, type Proof } from './access.ts'
import { actorSeen, ownedActor } from './actors.ts'
import { replaceMentions } from '../contract/mentions.ts'
import { syncTarget, type SyncTarget } from './targets.ts'
import type { BoardSession } from './a2.ts'
import type { BoardReads } from './reads.ts'
import { badRequest, duplicateId, forbidden, HttpError, notFound } from './errors.ts'
import { view, type Reader } from './feed.ts'
import type { MessageView } from '../api/routes.ts'
import type { WriteSource } from './middleware.ts'
import type { Via, WriteOrigin } from './origin.ts'

export { syncTarget, type SyncTarget }

import type { Identity } from './backend.ts'
export type { Identity }

/** A piece of the board's own deployment, writing as `actor` with full access. */
export function deploymentIdentity(actor: string, handle: string): Identity {
  return {
    principal: { id: actor, kind: 'deployment', handle, access: FULL_ACCESS, expiresAt: null },
    author: { actor, principal: actor, profile: null },
    actor: { id: actor, kind: 'deployment', handle, name: handle, avatar: null },
  }
}

export type WriteContext = {
  session: BoardSession
  /** The board's tables, where writes check what they write to. */
  reads: BoardReads
}


/**
 * The `actor.seen` a write carries, or null: who its author is, as the board's record of them
 * says, unless the board knows that already. A host's principal and its profiles are recorded as
 * the host's, which sync never writes as.
 */
export function seenFor(identity: Identity, actors: ActorsState) {
  const { verified: _verified, ...actor } = identity.actor
  return actorSeen(verifiedAs(identity) ? { ...actor, verified: true } : actor, actors, identity.principal.facts?.issuer === 'host')
}

/**
 * The `actor.seen` of each platform user an import's text mentions that the board hasn't met: who
 * they are, as the import names them. One it knows keeps its record, which their own writes keep
 * current: a mention only introduces.
 */
function metBy(introduces: readonly Actor[] | undefined, actors: ActorsState, author: string) {
  const met = new Set([author])
  return (introduces ?? []).flatMap((actor) => {
    if (met.has(actor.id) || own(actors.byId, actor.id)) return []
    met.add(actor.id)
    const seen = actorSeen(actor, actors)
    return seen ? [seen] : []
  })
}

/**
 * Whether the board checked who a write is by, as it shows them: a principal a credential named (an
 * OIDC token it trusts, or a host's verifier; never the board's own code), shown as
 * that principal names it: its handle and name, and for an agent, that principal after `via`, its
 * profile name the principal's to choose. A stored actor that shows otherwise (a schedule's, from
 * before handles were checked) isn't. An import says for itself.
 */
function verifiedAs({ principal, author, actor }: Identity): boolean {
  if (principal.kind === 'external') return actor.verified === true
  if (principal.id.startsWith('board:')) return false
  const named = ownedActor(principal, author, actor)
  return named.handle === actor.handle && named.name === actor.name && named.avatar === actor.avatar && named.via?.name === actor.via?.name && named.via?.environment === actor.via?.environment
}

/**
 * Whether `identity` wrote `message`, to change it as its author: its principal did, as itself or
 * any of its agents, and a platform user a sync speaks for only as that same user.
 */
const authored = (message: Message, identity: Identity) =>
  message.by.principal === identity.principal.id && (platformProfile(identity.author.profile) === null || message.by.actor === identity.author.actor)

/**
 * Whether `identity` is a task's owner, to change it or what it says: the principal that made it a
 * task, as itself, or as the profile it made it as. Another of its profiles isn't: they share a
 * credential, and nothing else keeps one's work from another.
 */
export const ownedBy = (task: Pick<Task, 'owner' | 'by'>, identity: Pick<Identity, 'principal' | 'actor'>) => wroteAs(identity, { principal: task.owner, actor: task.by })

const messageNotFound = (id: number) => () => notFound(`message not found: #${id}`, 'message_not_found')

/**
 * A message the board looked up, and a proof of what the caller may do to it.
 * By-ID writes take one and spend the proof on that message, so they act on
 * what the board found, never on what the request said.
 */
export type Authorized<P extends Permission> = { readonly message: Message; readonly proof: Proof<P> }

/**
 * A message the board looked up and the caller may act on with `permission`,
 * proved against its own channel. A message they can't read answers 404, as if
 * it didn't exist: IDs are sequential, so a 403 would confirm it does.
 */
export async function authorizeMessage<P extends Permission>(
  ctx: WriteContext,
  access: Access,
  permission: P,
  id: number,
): Promise<Authorized<P>> {
  const message = await ctx.reads.message(id)
  if (!message) throw messageNotFound(id)()
  return { message, proof: authorize(access, permission, message.channel, messageNotFound(id)) }
}

/**
 * Your own message, to edit or delete: `post` in its channel. Where you can't
 * read, it's yours only if it was posted without reading too: a write-only
 * source fixes what it wrote, but a principal ID it shares with a caller that
 * reads (a repo's workflows share one) doesn't reach that caller's messages.
 * A profile owns only what was written as it; its principal, as no profile, owns all of them (`wroteAs`).
 * Someone else's answers 404 where you can't read it, and 403 where you can.
 */
export async function authorizeOwn(
  ctx: WriteContext,
  identity: Pick<Identity, 'principal' | 'actor'>,
  id: number,
  verb: 'edit' | 'delete',
): Promise<Authorized<'post'>> {
  const { principal } = identity
  const message = await ctx.reads.message(id)
  if (!message) throw messageNotFound(id)()
  const readable = principal.access.readable(message.channel)
  if (!wroteAs(identity, message.by) || (!readable && !message.blind)) {
    if (!readable) throw messageNotFound(id)()
    throw forbidden(`only the author can ${verb} a message`)
  }
  return { message, proof: authorize(principal.access, 'post', message.channel) }
}

/**
 * What a post was proved for: `post` where it lands, and `label` and `sync`
 * when it carries them. A reply's also carry the message it answers, as the
 * board looked it up.
 */
export type PostProofs = { post: Proof<'post'>; label?: Proof<'label'>; sync?: Proof<'sync'>; re?: Message }

const hasLabels = (labels: Labels | undefined) => Object.keys(labels ?? {}).length > 0

/**
 * Proofs for a post. A root lands in the channel it names, which the caller
 * needn't read: write-only is `['post']`. A reply lands in its root's channel,
 * looked up here and never taken from the request, and needs `read` there too,
 * since addressing a thread you can't see would confirm it exists.
 */
export async function authorizePost(
  ctx: WriteContext,
  access: Access,
  input: { channel?: string | undefined; re?: number | undefined; labels?: Labels | undefined; sync?: readonly unknown[] | undefined },
): Promise<PostProofs> {
  let channel: string
  let re: Message | undefined
  if (input.re !== undefined) {
    re = (await authorizeMessage(ctx, access, 'read', input.re)).message
    channel = re.channel
  } else {
    if (!input.channel) throw badRequest('a post needs a channel')
    channel = input.channel
  }
  return {
    post: authorize(access, 'post', channel),
    ...(re ? { re } : {}),
    ...(hasLabels(input.labels) ? { label: authorize(access, 'label', channel) } : {}),
    ...(input.sync?.length ? { sync: authorize(access, 'sync', channel) } : {}),
  }
}

/**
 * Spends a proof on its target: a write checked against one channel can't land
 * in another. A mismatch is the board's own bug, never the caller's.
 */
function spend(proof: Proof | undefined, permission: Permission, target: { channel: string }) {
  if (!proof || proof.permission !== permission || proof.channel !== target.channel)
    throw new Error(`a ${permission} write in ${target.channel} needs a proof for that channel`)
}

/** Full-access proofs for the board's own code (sync), still checked against the channel each write lands in. */
export const trusted = {
  message: <P extends Permission>(ctx: WriteContext, permission: P, id: number) => authorizeMessage(ctx, FULL_ACCESS, permission, id),
  post: (ctx: WriteContext, input: Parameters<typeof authorizePost>[2]) => authorizePost(ctx, FULL_ACCESS, input),
}

export type PostInput = WriteOrigin & {
  identity: Identity
  /** From `authorizePost`. */
  proofs: PostProofs
  channel?: string | undefined
  re?: number | undefined
  text: string
  labels?: Labels | undefined
  noSync?: boolean | undefined
  id?: string | undefined
  /** Targets the new thread starts with, as the board that syncs them resolved them; a plain one's kind goes by its shape. */
  sync?: (string | SyncTarget)[] | undefined
  origin?: Origin | null
  from?: string | null
  /** Files the board stored, as it recorded them. */
  attachments?: Attachment[]
  /** Platform messages it links to. */
  links?: Link[]
  /** The platform users an import's text mentions, for the board to meet: see `metBy`. */
  introduces?: Actor[] | undefined
  /** The schedule send that posts it. */
  schedule?: { id: number; n: number }
  /** The principal of the sync elsewhere that imports it, whose copy its `origin` is. */
  importedBy?: string | undefined
  /** A reply's precondition: the message in its thread that must still be the newest. */
  after?: number | undefined
  /** More to write with a new thread's root, in the same append: what makes it a task. */
  with?: Along | undefined
}

/** A batch of board events, as an append takes it. */
export type Events = Parameters<BoardSession['append']>

/**
 * More events for a root's own append, about the message it posts: it reads the tables, throws what
 * refuses the write, and returns the index its reads reflect with what to append for the root, given
 * the ID and thread key it will have. The whole batch lands only while that index is the log's last.
 */
export type Along = () => Promise<{ position: number; events: (root: { id: number; thread: string }) => Events }>

export async function writePost(ctx: WriteContext, input: PostInput): Promise<MessageView> {
  const { identity } = input
  const sent = input.text
  let channel = input.channel
  let re: number | null = null
  let replyTo: number | null = null
  let thread: string
  const id = input.id ?? (input.re === undefined ? crypto.randomUUID() : undefined)
  if (input.re !== undefined) {
    // The message authorizePost looked up: a reply lands in its thread, never where the request said.
    const target = input.proofs.re
    if (target?.id !== input.re) throw new Error(`a reply to #${input.re} needs proofs for that message`)
    re = target.re ?? target.id
    replyTo = target.id === re ? null : target.id
    channel = target.channel
    thread = target.thread
    if (input.sync?.length)
      throw badRequest('sync attaches whole threads: use `board sync <id> <target>`')
  } else {
    if (!channel) throw badRequest('a post needs a channel')
    if (input.noSync && input.sync?.length) throw badRequest('`noSync` and `sync` contradict each other')
    if (input.after !== undefined) throw badRequest('`after` is for replies', 'invalid_after')
    thread = id!
  }
  if (input.with && re !== null) throw new Error('only a new thread is posted with more: a reply has no task to be')
  spend(input.proofs.post, 'post', { channel })
  if (hasLabels(input.labels)) spend(input.proofs.label, 'label', { channel })
  if (input.sync?.length) spend(input.proofs.sync, 'sync', { channel })

  // A retry of a write that landed (only a caller's own ID can be one): what's on the board
  // stands, whatever its `after` says now.
  const replayed = await replayOf(ctx, input, { channel: channel!, re, replyTo }, sent)
  if (replayed) return replayed
  if (input.after !== undefined) {
    const named = await ctx.reads.message(input.after)
    // The same words for a message elsewhere and none: which one it is is a read's to tell.
    if (named?.thread !== thread) throw badRequest(`after names no message in #${re}'s thread`, 'invalid_after')
  }
  return commitPost(ctx, input, { channel: channel!, re, replyTo, thread, id, sent })
}

/** The post a caller's own ID already landed, as its retry gets it back: null when there's none. */
async function replayOf(ctx: WriteContext, input: PostInput, place: { channel: string; re: number | null; replyTo: number | null }, sent: string): Promise<MessageView | null> {
  if (input.id === undefined) return null
  const landed = await ctx.reads.byEventId(input.id)
  if (!landed) return null
  // Only the same author's post in the same place is a retry. Text and labels can't tell:
  // the middleware may have changed them, and edits may have since.
  if (landed.channel !== place.channel || landed.re !== place.re || landed.replyTo !== place.replyTo) throw duplicateId()
  const shown = await landedFor(ctx, input.identity, landed)
  if (!shown) throw duplicateId()
  return shownTo(shown, input.identity.principal.access, sent)
}

/**
 * A post that landed, as its author may have it back: only the same author's, and one in a
 * channel it can't read only if it posted without reading too. A caller that can't read gets back
 * what it sent, as it landed: never what others have added since. Null for anyone else.
 */
export async function landedFor(ctx: WriteContext, identity: Identity, landed: Message): Promise<MessageView | null> {
  if (!sameAuthor(landed.by, identity.author)) return null
  const { access } = identity.principal
  const { state: actors } = await ctx.session.state(actorsReducer)
  if (access.readable(landed.channel)) return view(landed, actors, await readerFor(ctx, access, landed))
  // A post written by a caller that could read isn't its to replay, as `authorizeOwn` holds.
  if (!landed.blind) return null
  // Its post, and what its own append made of it: the task it started as, which the post counts.
  // Never what follows by its type or author: another caller of the same principal may have made
  // the thread a task since, with what this one can't read.
  const events = (await ctx.session.history({ gte: landed.id, lte: landed.id + ALONG_MAX })) as BoardEvent[]
  const along = (events[0] as BoardEvent<'message.posted'>).payload.along ?? 0
  const folded: MessagesState = { byId: {}, replies: {} }
  for (const event of events.slice(0, 1 + along)) foldMessages(folded, event)
  const posted = folded.byId[landed.id]!
  return { ...view(posted, actors, await readerFor(ctx, access, posted)), text: blindText(posted.text, identity.actor.id) }
}

/**
 * A message's text for its writer where it can't read: each exact mention but of itself shows as
 * `@…`. The board turned an email it wrote into an actor ID before mentions were text, and a sync's
 * import names its own profiles: who those are, `/actors` doesn't show it either.
 */
export const blindText = (text: string, own: string) => replaceMentions(text, (token) => (token.kind === 'actor' && token.actor !== own ? '@…' : null))

const sameAuthor = (a: Author, b: Author) =>
  a.actor === b.actor && a.principal === b.principal && a.profile === b.profile

async function commitPost(
  ctx: WriteContext,
  input: PostInput,
  placed: { channel: string; re: number | null; replyTo: number | null; thread: string; id: string | undefined; sent: string },
) {
  const { identity } = input
  const { channel, re, replyTo, thread, id, sent } = placed
  const { state: actors } = await ctx.session.state(actorsReducer)
  // The targets it asks for.
  const targets: { target: string; kind: 'channel' | 'thread'; cause: 'request' }[] = []
  if (re === null) {
    for (const requested of input.sync ?? []) {
      const target = syncTarget(requested)
      if (!targets.some((t) => t.target === target.target)) targets.push({ ...target, cause: 'request' })
    }
  }

  const seen = seenFor(identity, actors)
  const synced = await Promise.all(
    targets.map(async ({ target, kind, cause }) => ({
      type: 'thread.synced' as const,
      id: await derivedId('board', thread, 'sync', target),
      payload: { thread, target, kind, cause, by: identity.author },
    })),
  )
  const events: Events = [
    ...(seen ? [seen] : []),
    ...metBy(input.introduces, actors, identity.actor.id),
    {
      type: 'message.posted',
      ...(id ? { id } : {}),
      payload: {
        channel: channel!,
        text: input.text,
        re,
        replyTo,
        thread,
        labels: input.labels ?? {},
        noSync: input.noSync ?? false,
        by: identity.author,
        origin: input.origin ?? null,
        from: input.from ?? null,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.links?.length ? { links: input.links } : {}),
        ...(input.schedule ? { schedule: input.schedule } : {}),
        ...(identity.principal.access.readable(channel!) ? {} : { blind: true as const }),
        ...(input.importedBy !== undefined ? { importedBy: input.importedBy } : {}),
      },
    },
    ...synced,
  ]
  let rows: Awaited<ReturnType<BoardSession['append']>>
  try {
    if (input.with) {
      const along = input.with
      // The batch lands right after the index it read at, so the root's ID is known before it's written.
      const before = events.findIndex((event) => event.type === 'message.posted')
      rows = await appendFrom(ctx, async () => {
        const { position, events: more } = await along()
        // As of the same index the batch is conditioned on: see `unclaimedAt`.
        for (const target of targets) await unclaimed(ctx, target, thread, identity.principal.access)
        const came = more({ id: position + 1 + before, thread })
        // The post says how many came with it, so a replay tells its own append from what was written since.
        const batch = events.map((event) => (event.type === 'message.posted' ? { ...event, payload: { ...event.payload, along: came.length } } : event)) as Events
        return { position, events: [...batch, ...came] }
      })
    } else if (targets.some((target) => target.kind === 'thread'))
      // A thread it claims must still be unclaimed as the append lands: two posts can't both take one.
      rows = await appendWhile(ctx, unclaimedAt(ctx, targets, thread, identity.principal.access), events)
    else rows = input.after === undefined || re === null ? await ctx.session.append(...events) : await appendWhile(ctx, nothingAfter(ctx, re, input.after), events)
  } catch (error) {
    // The same request sent twice at once: what came after `after`, or took its ID, may be the other one.
    const twice = (error instanceof HttpError && error.code === 'newer_message') || (input.with !== undefined && duplicateEvent(error))
    const replayed = twice ? await replayOf(ctx, input, { channel, re, replyTo }, sent) : null
    if (replayed) return replayed
    throw error
  }
  const posted = rows.find((row) => row.type === 'message.posted') as BoardEvent
  await untilApplied(ctx, rows)
  // Every event of the batch that's about the message: its post, and what came along with it.
  const folded: MessagesState = { byId: {}, replies: {} }
  for (const row of [...rows].sort((a, b) => a.index - b.index)) foldMessages(folded, row as BoardEvent)
  const message = folded.byId[posted.index]!
  return shownTo(view(message, knownWith(actors, identity, seen), await readerFor(ctx, identity.principal.access, message)), identity.principal.access, sent)
}

/** The actors with a write's author as the board now records them: a host's principal stays the host's. */
const knownWith = (actors: ActorsState, identity: Identity, seen: ReturnType<typeof seenFor>): ActorsState =>
  seen ? { ...actors, byId: { ...actors.byId, [identity.actor.id]: { ...identity.actor, ...(seen.payload.host ? { host: true as const } : {}), ...(seen.payload.verified ? { verified: true as const } : {}) } } } : actors

/** One of several new threads' roots, as a post's: `id` is its event's, and its thread's key. */
export type RootInput = { id: string; text: string; labels?: Labels | undefined; noSync?: boolean | undefined; attachments?: Attachment[] | undefined }

/**
 * More events for several roots' one append, as `Along` is for one: it reads the tables, throws what
 * refuses the write, and returns the index its reads reflect, how many events come with each root,
 * which says where every root lands before any is written, and then each root's events, given all
 * their IDs.
 */
export type AlongEach = () => Promise<{ position: number; counts: readonly number[]; events: (roots: readonly { id: number; thread: string }[]) => Events[] }>

/**
 * A batch made under an `id`, as its sender finds it again: the tasks' roots it landed with, as they
 * are now, or why there are none for it. `made`: none landed. `yours`: someone else's did. `asked`:
 * it landed for another request.
 */
export type LandedBatch = { tasks: MessageView[] } | { not: 'made' | 'yours' | 'asked' }

/**
 * Several new threads in `channel`, in one append: each root with what `with` makes of it right
 * after it, in the order given, all of them or none. Answers the roots as the append left them.
 * With `again`, the roots are a caller's own to send again: `again.landed` finds the ones the same
 * request landed already, which are answered as they are with nothing written, and `again.asked`
 * is the ID the event right after the first root carries, which says what was asked for.
 */
export async function writeRoots(
  ctx: WriteContext,
  input: { identity: Identity; proofs: PostProofs; channel: string; roots: readonly RootInput[]; with: AlongEach; again?: { asked: string; landed: () => Promise<LandedBatch> } | undefined },
): Promise<MessageView[]> {
  const { identity, channel, roots } = input
  const { access } = identity.principal
  spend(input.proofs.post, 'post', { channel })
  if (roots.some((root) => hasLabels(root.labels))) spend(input.proofs.label, 'label', { channel })
  const { state: actors } = await ctx.session.state(actorsReducer)
  const seen = seenFor(identity, actors)
  const blind = !access.readable(channel)
  const read: { landed: MessageView[] | null } = { landed: null }
  const rows = await appendFrom(ctx, async () => {
    // A batch that landed stands, each time it looks: a retry of it, or the same one sent at the same time, which landed first.
    const found = input.again ? await input.again.landed() : null
    if (found && 'not' in found && found.not !== 'made') throw duplicateId()
    read.landed = found && 'tasks' in found ? found.tasks : null
    if (read.landed) return { position: 0, events: [] }
    const { position, counts, events: more } = await input.with()
    // The batch lands right after the index it read at, so every root's ID is known before any is written.
    let next = position + 1 + (seen ? 1 : 0)
    const placed = roots.map((root, at) => {
      const here = { id: next, thread: root.id }
      next += 1 + counts[at]!
      return here
    })
    const came = more(placed)
    // The event right after the first root says what the batch was asked for, by its ID: an `id` again is this batch only for that.
    if (input.again && came[0]?.[0]) came[0][0] = { ...came[0][0], id: input.again.asked } as Events[number]
    const events: Events = seen ? [seen] : []
    for (const [at, root] of roots.entries()) {
      if (came[at]!.length !== counts[at]) throw new Error(`a root's append carries the ${counts[at]} events it said, not ${came[at]!.length}`)
      events.push(
        {
          type: 'message.posted',
          id: root.id,
          payload: {
            channel,
            text: root.text,
            re: null,
            replyTo: null,
            thread: root.id,
            labels: root.labels ?? {},
            noSync: root.noSync ?? false,
            by: identity.author,
            origin: null,
            from: null,
            ...(root.attachments?.length ? { attachments: root.attachments } : {}),
            ...(blind ? { blind: true as const } : {}),
            // Each post says how many came with it, so a replay tells its own from what was written since.
            ...(came[at]!.length > 0 ? { along: came[at]!.length } : {}),
          },
        },
        ...came[at]!,
      )
    }
    return { position, events }
  })
  if (read.landed) return read.landed
  await untilApplied(ctx, rows)
  const folded: MessagesState = { byId: {}, replies: {} }
  const ordered = [...rows].sort((a, b) => a.index - b.index)
  for (const row of ordered) foldMessages(folded, row as BoardEvent)
  const known = knownWith(actors, identity, seen)
  const posted = ordered.filter((row) => row.type === 'message.posted')
  return Promise.all(
    posted.map(async (row, at) => {
      const message = folded.byId[row.index]!
      return shownTo(view(message, known, await readerFor(ctx, access, message)), access, roots[at]!.text)
    }),
  )
}

/**
 * The batch a caller made under an `id`, found by the IDs its events carry, as a post is by its
 * own: `rootId` names each root's post in turn, and `asked`, when the caller says what it asks
 * for, the event right after the first one. What's happened to its tasks since makes it no other
 * batch, and neither does what the middleware made of it: `asked` is of the request as given.
 */
export async function landedBatch(ctx: WriteContext, identity: Identity, rootId: (at: number) => Promise<string>, asked: string | undefined): Promise<LandedBatch> {
  const first = await ctx.reads.byEventId(await rootId(0))
  if (!first) return { not: 'made' }
  const tasks: MessageView[] = []
  for (let at = 0, landed: Message | null = first; landed; landed = await ctx.reads.byEventId(await rootId(++at))) {
    const mine = await landedFor(ctx, identity, landed)
    if (!mine) return { not: 'yours' }
    tasks.push(mine)
  }
  if (asked !== undefined) {
    const [, made] = (await ctx.session.history({ gte: first.id, lte: first.id + 1 })) as BoardEvent[]
    if (made?.id !== asked) return { not: 'asked' }
  }
  return { tasks }
}

/**
 * A post's view for its writer. One that can't read the channel gets back the
 * text it sent: what the board made of it (the middleware's changes) is for its readers.
 */
const shownTo = (shown: MessageView, access: Access, sent: string): MessageView => (!access.readable(shown.channel) ? { ...shown, text: sent } : shown)

/** The writer, as the reader of the view its write returns. Only a link to a board message needs a lookup. */
const readerFor = (ctx: WriteContext, access: Access, message: Message): Promise<Reader> => ctx.reads.reader(access, [message])

/**
 * Refuses an external thread another board thread is synced with: taking it
 * over would send its replies away from that thread, to a caller who may not
 * read it. A reader of that thread's channel learns which thread it is. It
 * reads the tables as they are: it runs inside an append's look, whose
 * `appendFrom` has them apply the log first, and whose append lands only if
 * nothing, another claim included, landed since.
 */
async function unclaimed(ctx: WriteContext, target: SyncTarget, thread: string, access: Access) {
  if (target.kind !== 'thread') return
  const owner = await ctx.reads.tables.threadOf(target.target)
  if (owner === null || owner === thread) return
  const synced = await ctx.reads.tables.syncOf(owner)
  const which = synced && access.readable(synced.channel) ? `#${synced.root}` : 'another thread'
  throw new HttpError(409, 'already_synced', `${target.target} is already synced with ${which}`)
}

/**
 * An append's condition that none of `targets` is another thread's, as `unclaimed` refuses: it
 * returns the index its reads reflect at least, so the append lands only if nothing, another
 * claim included, landed since.
 */
const unclaimedAt = (ctx: WriteContext, targets: readonly SyncTarget[], thread: string, access: Access) => async () => {
  const position = await ctx.reads.tables.position()
  for (const target of targets) await unclaimed(ctx, target, thread, access)
  return position
}

/**
 * Waits until the tables hold a write, so any read after it includes it. Most often
 * nothing was written in between, and the writer applies its own events itself; else
 * it waits for the tables' consumer. The write landed either way: if the tables are
 * slow or stuck, it still succeeds.
 */
export async function untilApplied(ctx: WriteContext, rows: readonly { index: number }[]) {
  if (rows.length === 0) return
  const events = ([...rows] as unknown as BoardEvent[]).sort((a, b) => a.index - b.index)
  const last = events.at(-1)!.index
  try {
    let caughtUp = true
    for (const event of events) {
      if (await ctx.reads.tables.applyNext(event)) continue
      // The consumer got to this one first: it's applied all the same, and the next may still be the writer's.
      if ((await ctx.reads.tables.position()) >= event.index) continue
      caughtUp = false
      break
    }
    if (caughtUp) return
  } catch {
    // The consumer applies them.
  }
  await ctx.reads.ensure(last, AbortSignal.timeout(LANDED_WAIT_MS)).catch((error: unknown) => {
    console.warn(`[board] the tables haven't applied #${last} yet:`, (error as Error).message)
  })
}

/** How long a write waits for the tables before it answers anyway. */
const LANDED_WAIT_MS = 10_000

/**
 * Appends `events` only while the board, as `holds` reads it, still allows them: `holds` checks
 * the tables, throws what refuses the write, and returns the index its reads reflect. The append
 * holds only while that index is still the log's last, so anything that lands in between,
 * anywhere on the board, moves it, and it looks again from there.
 */
async function appendWhile(ctx: WriteContext, holds: () => Promise<number>, events: Events) {
  return appendFrom(ctx, async () => ({ position: await holds(), events }))
}

/**
 * As `appendWhile`, for a write whose events depend on what it finds: `look` reads the tables,
 * throws what refuses the write, and returns what to append with the index its reads reflect. It
 * looks again, and decides again, each time the board moves on first. Nothing to append appends
 * nothing.
 */
export async function appendFrom(ctx: WriteContext, look: () => Promise<{ position: number; events: Events }>): Promise<Awaited<ReturnType<BoardSession['append']>>> {
  return whileHeadMoves(async () => {
    await ctx.reads.ensure()
    const { position, events } = await look()
    return events.length === 0 ? [] : appendIfLast(ctx.session, position, events)
  })
}

/**
 * What a look throws when its reads don't all reflect one index: the board moved on under it, so
 * `whileHeadMoves` has it look again.
 */
export const movedOn = () => Object.assign(new Error('the board moved on while a write read it'), { code: 'LAST_INDEX_MISMATCH' })

/** An append that holds an event ID already in the log. */
const duplicateEvent = (error: unknown) => ['PARTIAL_DUPLICATE_BATCH', 'DUPLICATE_EVENT_ID'].includes((error as { code?: string } | null)?.code ?? '')

/**
 * Runs `attempt`, a look and a conditional append, again each time the board moves on in
 * between, up to `CONDITIONAL_TRIES` times: how every conditional write here looks again.
 */
export async function whileHeadMoves<T>(attempt: () => Promise<T>): Promise<T> {
  for (let tries = 1; ; tries++) {
    try {
      return await attempt()
    } catch (error) {
      if (!headMoved(error)) throw error
      if (tries === CONDITIONAL_TRIES) throw new HttpError(503, 'unavailable', 'the board kept changing while it checked: try again')
      // Writers the same write moved on look again apart, so they don't keep meeting.
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 5 * tries))
    }
  }
}

/** How many times a conditional write looks again, as the board moves on, before it gives up. */
const CONDITIONAL_TRIES = 10

/** A reply's `after`: nothing came after it in the thread, as of the index the read reflects. */
const nothingAfter = (ctx: WriteContext, root: number, after: number) => async () => {
  const { messages: [newer], position } = await ctx.reads.tables.messages({ re: root }, { after, limit: 1 })
  if (newer) throw new HttpError(409, 'newer_message', `#${newer.id} came after #${after}`)
  return position
}

/** The message a by-ID write targets, as the board looked it up, once its proof is spent on the message's channel. */
function spent<P extends Permission>(authorized: Authorized<P>, permission: P): Message {
  spend(authorized.proof, permission, authorized.message)
  return authorized.message
}

export type EditInput = WriteOrigin & {
  identity: Identity
  authorized: Authorized<'post'>
  text: string
  from?: string | null
  asAuthor?: boolean
  /** The message's revision as the caller read it: an edit or a delete since refuses this one. */
  revision?: number | undefined
  /** As a post's: the platform users an import's text now mentions. */
  introduces?: Actor[] | undefined
}

export async function writeEdit(ctx: WriteContext, input: EditInput): Promise<void> {
  const message = spent(input.authorized, 'post')
  if (input.asAuthor !== false && !authored(message, input.identity))
    throw forbidden('only the author can edit a message')
  if (message.deleted) {
    // Read before the delete, it's that the message changed since that the caller needs to know.
    if (input.revision !== undefined && input.revision !== (message.revision ?? message.id)) throw new HttpError(409, 'revision_conflict', `#${message.id} was deleted since revision ${input.revision}`)
    throw badRequest('message was deleted', 'message_deleted')
  }
  return commitEdit(ctx, input, message)
}

async function commitEdit(ctx: WriteContext, input: EditInput, message: Message): Promise<void> {
  const { state: actors } = await ctx.session.state(actorsReducer)
  const seen = seenFor(input.identity, actors)
  const events: Events = [...(seen ? [seen] : []), ...metBy(input.introduces, actors, input.identity.actor.id), {
    type: 'message.edited',
    payload: {
      id: message.id,
      thread: message.thread,
      text: input.text,
      by: input.identity.author,
      from: input.from ?? null,
    },
  }]
  const { revision } = input
  const rows =
    message.re === null
      ? // A root may be a task, as of the index the edit lands after: one its owner didn't make holds it.
        await appendFrom(ctx, async () => {
          const { position, found } = await asOfNow(ctx, message.id)
          if (revision !== undefined) atRevision(found, message.id, revision)
          return { position, events: [...events, ...heldByEdit(found, input.identity)] }
        })
      : revision === undefined
        ? await ctx.session.append(...events)
        : await appendWhile(ctx, revisionIs(ctx, message.id, revision), events)
  await untilApplied(ctx, rows)
}

/** A message's links, replaced: a platform edit or unfurl changed what it links to. */
export async function writeLinks(
  ctx: WriteContext,
  input: { identity: Identity; authorized: Authorized<'post'>; links: Link[]; from: string | null },
) {
  const message = spent(input.authorized, 'post')
  if (message.deleted) return
  await untilApplied(ctx, await ctx.session.append({
    type: 'message.linked',
    payload: { id: message.id, thread: message.thread, links: input.links, by: input.identity.author, from: input.from },
  }))
}

export async function writeDelete(
  ctx: WriteContext,
  input: { identity: Identity; authorized: Authorized<'post'>; from?: string | null; asAuthor?: boolean; revision?: number | undefined },
) {
  const message = spent(input.authorized, 'post')
  if (input.asAuthor !== false && !authored(message, input.identity))
    throw forbidden('only the author can delete a message')
  // A tombstone changes no more: deleting it again is nothing, unless the caller read it before.
  if (message.deleted) {
    if (input.revision !== undefined && input.revision !== (message.revision ?? message.id)) throw new HttpError(409, 'revision_conflict', `#${message.id} was deleted since revision ${input.revision}`)
    return
  }
  const deleted: Events = [{
    type: 'message.deleted',
    payload: { id: message.id, thread: message.thread, by: input.identity.author, from: input.from ?? null },
  }]
  const { revision } = input
  const rows =
    message.re === null
      ? // A root may be a task, as of the index the delete lands after: it's canceled in the same append.
        await appendFrom(ctx, async () => {
          const { position, found } = await asOfNow(ctx, message.id)
          if (revision !== undefined) atRevision(found, message.id, revision)
          // Deleted in between: there's nothing left to delete, or to cancel.
          return { position, events: found?.deleted ? [] : [...canceledByDelete(found, input.identity), ...deleted] }
        })
      : revision === undefined
        ? await ctx.session.append(...deleted)
        : await appendWhile(ctx, revisionIs(ctx, message.id, revision), deleted)
  await untilApplied(ctx, rows)
}

/** A message as the tables have it now, and the index that read reflects. */
async function asOfNow(ctx: WriteContext, id: number): Promise<{ position: number; found: Message | undefined }> {
  const position = await ctx.reads.tables.position()
  return { position, found: (await ctx.reads.tables.messagesAt([id], position)).get(id) }
}

/** Refuses an edit or a delete at `revision` when the message has been edited or deleted since. */
function atRevision(message: Message | undefined, id: number, revision: number) {
  const now = message ? (message.revision ?? message.id) : null
  if (now !== revision) throw new HttpError(409, 'revision_conflict', message?.deleted ? `#${id} was deleted since revision ${revision}` : `#${id} was edited since revision ${revision}: it's at ${now}`)
}

/** An edit's or a delete's `revision`: no edit or delete since, as of the index the read reflects. */
const revisionIs = (ctx: WriteContext, id: number, revision: number) => async () => {
  const { position, found } = await asOfNow(ctx, id)
  atRevision(found, id, revision)
  return position
}

/** Why a task is held once its root was edited by someone who doesn't own it. */
const EDITED = 'its text was edited by someone who does not own the task'

/**
 * The hold an edit of a task's root brings, by anyone but the task's owner: the thread's author when
 * someone else made it a task, or a platform's edit, whichever principal's sync imported it. The task says what its owner read, so it waits
 * for them to read it again, and whoever held it has lost it. One that's held or finished stays as it is.
 */
function heldByEdit(root: Message | undefined, editor: Identity): Events {
  const task = root?.task
  // A platform user is never the owner, even one the owner's own sync speaks for: they write as its profile.
  const owner = task !== undefined && ownedBy(task, editor) && editor.principal.kind !== 'external'
  if (!root || root.deleted || !task || owner) return []
  if (task.state !== 'waiting' && task.state !== 'ready' && task.state !== 'claimed') return []
  return [{ type: 'task.blocked', payload: { id: root.id, thread: root.thread, kind: EDITED_HOLD, reason: EDITED, by: editor.author } }]
}

/** The cancel a delete of a task's root brings, unless the task has completed or been canceled: before the delete, while the root still wears its labels. */
function canceledByDelete(root: Message | undefined, deleter: Identity): Events {
  const task = root?.task
  if (!root || !task || task.state === 'completed' || task.state === 'canceled') return []
  return [{ type: 'task.canceled', payload: { id: root.id, thread: root.thread, reason: 'deleted', by: deleter.author } }]
}

export async function writeReaction(
  ctx: WriteContext,
  input: { identity: Identity; authorized: Authorized<'react'>; emoji: string; remove?: boolean; from?: string | null },
) {
  const message = spent(input.authorized, 'react')
  if (message.deleted) throw badRequest('message was deleted', 'message_deleted')
  const { state: actors } = await ctx.session.state(actorsReducer)
  const seen = seenFor(input.identity, actors)
  await untilApplied(ctx, await ctx.session.append(...(seen ? [seen] : []), {
    type: input.remove ? 'reaction.removed' : 'reaction.added',
    payload: {
      id: message.id,
      thread: message.thread,
      emoji: input.emoji,
      by: input.identity.author,
      from: input.from ?? null,
    },
  }))
}

export async function writeLabels(
  ctx: WriteContext,
  input: {
    identity: Identity
    authorized: Authorized<'label'>
    set?: Labels | undefined
    unset?: string[] | undefined
    /** What its labels must be now: a value, or null for one that mustn't be set. */
    if?: Record<string, string | null> | undefined
  },
) {
  const message = spent(input.authorized, 'label')
  if (message.deleted) throw badRequest('message was deleted', 'message_deleted')
  const { state: actors } = await ctx.session.state(actorsReducer)
  const seen = seenFor(input.identity, actors)
  const events: Events = [
    ...(seen ? [seen] : []),
    {
      type: 'labels.changed',
      payload: {
        id: message.id,
        thread: message.thread,
        set: input.set ?? {},
        unset: input.unset ?? [],
        by: input.identity.author,
      },
    },
  ]
  const conditional = input.if !== undefined && Object.keys(input.if).length > 0
  await untilApplied(ctx, conditional ? await appendWhile(ctx, labelsAre(ctx, message.id, input.if!), events) : await ctx.session.append(...events))
}

/** A label write's `if`: each label is as it says, as of the index the read reflects. */
const labelsAre = (ctx: WriteContext, id: number, expected: Record<string, string | null>) => async () => {
  const position = await ctx.reads.tables.position()
  const labels = (await ctx.reads.tables.messagesAt([id], position)).get(id)?.labels ?? {}
  for (const key of Object.keys(expected).sort()) {
    const now = own(labels, key)
    if (now === expected[key] || (now === undefined && expected[key] === null)) continue
    // It names what the caller asked about, never what's stored: reading that is a read's to allow.
    const wanted = expected[key]
    throw new HttpError(409, 'label_conflict', wanted === null ? `${key} is set` : now === undefined ? `${key} isn't set` : `${key} isn't ${wanted}`)
  }
  return position
}

/**
 * Syncs a message's thread with a target, resolved by the sync that delivers it. Attaching twice
 * is a no-op; a platform thread another board thread is synced with is a 409.
 */
export async function writeAttach(
  ctx: WriteContext,
  input: { identity: Identity; authorized: Authorized<'sync'>; target: SyncTarget; cause: 'config' | 'request' },
): Promise<{ attached: boolean }> {
  const message = spent(input.authorized, 'sync')
  const { target, kind } = input.target
  const event = {
    type: 'thread.synced' as const,
    id: await derivedId('board', message.thread, 'sync', target),
    payload: { thread: message.thread, target, kind, cause: input.cause, by: input.identity.author },
  }
  // Only while no other thread has claimed it since it looked: two attaches can't both take one.
  const rows = await appendFrom(ctx, async () => {
    const position = await ctx.reads.tables.position()
    if ((await ctx.reads.tables.syncOf(message.thread))?.targets.includes(target)) return { position, events: [] }
    await unclaimed(ctx, input.target, message.thread, input.identity.principal.access)
    return { position, events: [event] }
  })
  // Applied before it answers, so replies from the platform thread find it at once.
  await untilApplied(ctx, rows)
  return { attached: rows.length > 0 }
}

/**
 * A channel made before anything posts to it, or the one that's there, made by a post or another
 * create, which `created: false` says. It needs `read` and `post` there, refused alike whether it's
 * there or not: the answer says whether it was, and shows what it holds.
 */
export async function writeChannel(ctx: WriteContext, input: { identity: Identity; path: string }): Promise<{ channel: Channel; created: boolean }> {
  const { access } = input.identity.principal
  authorize(access, 'read', input.path)
  authorize(access, 'post', input.path)
  const seen = seenFor(input.identity, (await ctx.session.state(actorsReducer)).state)
  const events: Events = [
    ...(seen ? [seen] : []),
    { type: 'channel.created', payload: { channel: input.path, by: input.identity.author } },
  ]
  const made = await whileHeadMoves<{ found: Channel } | { rows: Awaited<ReturnType<typeof appendIfLast>> }>(async () => {
    const { state, index } = await ctx.session.state(channelsReducer, { through: 'latest' })
    const found = own(state, input.path)
    // Only while nothing has landed since it looked: a post or a create in between makes it look again.
    return found ? { found } : { rows: await appendIfLast(ctx.session, index, events) }
  })
  if ('found' in made) return { channel: made.found, created: false }
  await untilApplied(ctx, made.rows)
  return { channel: { path: input.path, lastIndex: 0, messages: 0, threads: 0 }, created: true }
}

/** The batch, only while `index` is still the session's last: A2's conditional append. */
const appendIfLast = (session: BoardSession, index: number, events: Parameters<BoardSession['append']>) => session.append.ifLastIndex(index, ...events)

/** What A2 throws when the session's last index isn't the one a conditional append named. */
const headMoved = (error: unknown) => (error as { code?: unknown } | null)?.code === 'LAST_INDEX_MISMATCH'
