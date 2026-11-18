import type { BoardEvent } from '../contract/events.ts'
import { setOwn } from '../contract/own.ts'
import type { ExternalCopy, Message, SyncedThread } from '../contract/folds.ts'
import { externalMessageKey } from '../contract/external.ts'
import { mentionTerms } from '../contract/mentions.ts'
import { concernedMessageId, project, projectSync, syncReads, type Before, type Change, type SyncChange } from './project.ts'
import type { MessageFilter, MessageTables, Page, ThreadsPage, ThreadSummary } from './types.ts'

/** One statement, with `$1`-style placeholders. */
export type Sql = { text: string; values: unknown[] }

/** A database the tables run on, SQLite, behind three calls. */
export type Db = {
  all(query: Sql): Promise<Record<string, unknown>[]>
  /** Each query's rows, all from one snapshot. */
  read(queries: Sql[]): Promise<Record<string, unknown>[][]>
  /**
   * Runs `claim`, then `writes`, in one transaction. False, with nothing
   * written, when the claim returns no row.
   */
  commit(claim: Sql, writes: Sql[]): Promise<boolean>
  close(): Promise<void>
}

/** The projection's name in `board_positions`, and the A2 consumer that runs it. */
export const TABLES_CONSUMER = 'board-tables'

/** The tables, as statements. */
export function ddl(): string[] {
  return [
    `create table if not exists board_positions (
  consumer text primary key,
  log_index integer not null
)`,
    `create table if not exists board_messages (
  id integer primary key,
  event_id text not null unique,
  channel text not null,
  re integer,
  by_actor text not null,
  by_principal text not null,
  by_profile text,
  from_key text,
  no_sync integer not null,
  text_lower text not null,
  deleted integer not null,
  created_at integer not null,
  replies integer not null default 0,
  at integer,
  data text not null
)`,
    'create index if not exists board_messages_channel on board_messages (channel, id)',
    'create index if not exists board_messages_re on board_messages (re, id)',
    'create index if not exists board_messages_by_actor on board_messages (by_actor, id)',
    'create index if not exists board_messages_by_principal on board_messages (by_principal, id)',
    'create index if not exists board_threads_at on board_messages (at) where re is null',
    'create index if not exists board_threads_channel on board_messages (channel, at) where re is null',
    `create table if not exists board_versions (
  log_index integer primary key,
  message_id integer not null,
  data text not null
)`,
    'create index if not exists board_versions_message on board_versions (message_id, log_index)',
    `create table if not exists board_terms (
  message_id integer not null,
  term text not null,
  value text not null,
  primary key (message_id, term, value)
)`,
    'create index if not exists board_terms_term on board_terms (term, value, message_id)',
    // The sync state: where each thread and message lives on each platform.
    'create table if not exists board_sync_threads (\n  thread text primary key,\n  data text not null\n)',
    'create table if not exists board_external_threads (\n  external text primary key,\n  thread text not null\n)',
    `create table if not exists board_copies (
  message_id integer not null,
  target text not null,
  data text not null,
  primary key (message_id, target)
)`,
    `create table if not exists board_external_messages (
  key text primary key,
  message_id integer not null
)`,
    // A person's recent roots were for telling their own posts' echoes apart, which nothing does now.
    'drop index if exists board_messages_recent',
    // What's been done to the tables once, for all: `mention_terms`, the mentions reindexed from text.
    'create table if not exists board_meta (\n  key text primary key,\n  value text not null\n)',
  ]
}

/** `board_meta`'s key for the mention index taken from each message's text. */
const MENTION_TERMS = 'mention_terms'

/**
 * The board refuses NUL in text and a lone surrogate, and a log from before
 * that may hold them. Nothing a reader filters on needs either, so keys and
 * columns go without NUL and with U+FFFD for a lone surrogate, and the lookups
 * that find them do the same.
 */
const clean = (value: string) => value.replaceAll('\u0000', '').toWellFormed()

/**
 * A mention's term, each one as the text has it (`mentionTerms`). Label keys start with a letter or
 * digit, so it's never a label's.
 */
const MENTION = '@'
/** An attachment's term, the same way. */
const ATTACHMENT = '^'

/** Terms one insert takes, three parameters each. */
const TERMS_PER_INSERT = 300

class Params {
  readonly values: unknown[] = []
  add(value: unknown): string {
    this.values.push(value)
    return `$${this.values.length}`
  }
  list(values: readonly unknown[]): string {
    return values.map((value) => this.add(value)).join(', ')
  }
}

const likeEscape = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`)

/** A channel, or a channel and everything under it, on the messages table aliased `alias`. */
function channelClause(alias: string, channel: NonNullable<MessageFilter['channel']>, p: Params): string {
  const path = p.add(channel.path)
  if (!channel.subtree) return `${alias}.channel = ${path}`
  // Compared, not matched with `like`: channel segments may hold `_`.
  const prefix = `cast(${p.add(`${channel.path}/`)} as text)`
  return `(${alias}.channel = ${path} or substr(${alias}.channel, 1, length(${prefix})) = ${prefix})`
}

/** The filter as `where` clauses on the messages table aliased `m`. */
function clauses(filter: MessageFilter, p: Params): string[] {
  const out: string[] = []
  if (filter.channel) out.push(channelClause('m', filter.channel, p))
  if (filter.channels) out.push(filter.channels.length ? `m.channel in (${p.list(filter.channels)})` : '1 = 0')
  if (filter.re !== undefined) {
    const re = p.add(filter.re)
    out.push(`(m.id = ${re} or m.re = ${re})`)
  }
  if (filter.by) {
    const { actors, principals } = filter.by
    const either = [
      ...(actors.length ? [`m.by_actor in (${p.list(actors)})`] : []),
      ...(principals.length ? [`m.by_principal in (${p.list(principals)})`] : []),
    ]
    out.push(either.length ? `(${either.join(' or ')})` : '1 = 0')
  }
  if (filter.mentions) {
    const { terms, prefixes } = filter.mentions
    const either = [
      ...(terms.length ? [`t.value in (${p.list(terms)})`] : []),
      ...prefixes.map((prefix) => {
        const at = `cast(${p.add(prefix)} as text)`
        return `substr(t.value, 1, length(${at})) = ${at}`
      }),
    ]
    out.push(either.length ? `exists (select 1 from board_terms t where t.message_id = m.id and t.term = '${MENTION}' and (${either.join(' or ')}))` : '1 = 0')
  }
  if (filter.from !== undefined) out.push(`coalesce(m.from_key, 'board') = ${p.add(filter.from)}`)
  if (filter.text !== undefined) out.push(`m.text_lower like ${p.add(`%${likeEscape(filter.text)}%`)} escape '\\'`)
  for (const label of filter.labels ?? []) {
    const values = label.values === null ? '' : ` and t.value in (${p.list(label.values)})`
    out.push(`exists (select 1 from board_terms t where t.message_id in (m.id, m.re) and t.term = ${p.add(label.key)}${values})`)
  }
  return out
}

const parse = (row: Record<string, unknown> | undefined): Message | null =>
  row === undefined || row.data === null || row.data === undefined ? null : (JSON.parse(String(row.data)) as Message)

/** The tables on a SQL database. */
export function sqlTables(db: Db): MessageTables {
  /**
   * Tables from before mentions were text index a message's mentions as the actor IDs its write
   * resolved them to. Once per database, each message whose text has an `@` gets the terms its
   * text has instead, unless a writer changed its text in between, which reindexed it already.
   * A read that filters on mentions waits for it.
   */
  async function reindexMentions() {
    if ((await db.all({ text: 'select 1 from board_meta where key = $1', values: [MENTION_TERMS] })).length > 0) return
    const rows = await db.all({ text: "select id, data from board_messages where text_lower like '%@%'", values: [] })
    const writes: Sql[] = []
    for (const row of rows) {
      const message = parse(row)!
      const unchanged = "json_extract((select data from board_messages where id = $1), '$.text') = $2"
      writes.push({ text: `delete from board_terms where message_id = $1 and term = '${MENTION}' and ${unchanged}`, values: [message.id, message.text] })
      for (const term of mentionTerms(message.text))
        writes.push({ text: `insert or ignore into board_terms (message_id, term, value) select $1, '${MENTION}', $3 where ${unchanged}`, values: [message.id, message.text, clean(term)] })
    }
    await db.commit({ text: "insert into board_meta (key, value) values ($1, 'text') on conflict (key) do nothing returning 1 as claimed", values: [MENTION_TERMS] }, writes)
  }
  let reindexed: Promise<void> | null = null
  const mentionsReady = () => {
    reindexed ??= reindexMentions().catch((error: unknown) => {
      reindexed = null
      throw error
    })
    return reindexed
  }

  const positionSql: Sql = { text: 'select log_index from board_positions where consumer = $1', values: [TABLES_CONSUMER] }
  const position = (rows: Record<string, unknown>[]) => (rows[0] ? Number(rows[0].log_index) : 0)

  const claim = (index: number): Sql => ({
    text: `insert into board_positions (consumer, log_index) values ($1, $2)
  on conflict (consumer) do update set log_index = excluded.log_index
  where board_positions.log_index < excluded.log_index
  returning 1 as claimed`,
    values: [TABLES_CONSUMER, index],
  })

  /** Only the event right after the position: never ahead of events the tables haven't applied. */
  const claimNext = (index: number): Sql => ({
    text: 'update board_positions set log_index = $2 where consumer = $1 and log_index = $3 returning 1 as claimed',
    values: [TABLES_CONSUMER, index, index - 1],
  })

  async function row(id: number) {
    const [found] = await db.all({ text: 'select data, replies, at from board_messages where id = $1', values: [id] })
    return found
  }

  async function before(event: BoardEvent, id: number): Promise<Before> {
    const found = event.type === 'message.posted' ? undefined : await row(id)
    const message = parse(found) ?? undefined
    const rootId = event.type === 'message.posted' ? event.payload.re : (message?.re ?? null)
    if (rootId === null) return { message, root: undefined }
    const rootRow = await row(rootId)
    const root = rootRow ? { replies: Number(rootRow.replies), at: Number(rootRow.at) } : undefined
    if (event.type === 'message.deleted' && message && !message.deleted && root?.at === id) {
      const [newest] = await db.all({
        text: 'select max(id) as id from board_messages where re = $1 and not deleted and id <> $2',
        values: [rootId, id],
      })
      return { message, root, previousLast: newest?.id === null || newest?.id === undefined ? null : Number(newest.id) }
    }
    return { message, root }
  }

  async function syncBefore(event: BoardEvent) {
    const reads = syncReads(event)
    const [thread] = reads.thread === null ? [] : await db.all({ text: 'select data from board_sync_threads where thread = $1', values: [clean(reads.thread)] })
    const [copy] =
      reads.copy === null
        ? []
        : await db.all({ text: 'select data from board_copies where message_id = $1 and target = $2', values: [reads.copy[0], clean(reads.copy[1])] })
    const [owner] = reads.external === undefined ? [] : await db.all({ text: 'select thread from board_external_threads where external = $1', values: [clean(reads.external)] })
    return {
      ...(owner ? { owner: String(owner.thread) } : {}),
      thread: thread ? (JSON.parse(String(thread.data)) as SyncedThread) : undefined,
      copy: copy ? (JSON.parse(String(copy.data)) as ExternalCopy) : undefined,
    }
  }

  /** The sync rows an event writes, as values; null when it writes none. */
  function syncPayload(change: SyncChange) {
    if (!change.thread && !change.externalThreads.length && !change.copies.length && !change.externalMessages.length) return null
    return {
      thread: change.thread ? { key: clean(change.thread.key), data: JSON.stringify(change.thread.data) } : null,
      external_threads: change.externalThreads.map(([external, thread]) => [clean(external), clean(thread)]),
      copies: change.copies.map(([message, target, copy]) => [message, clean(target), JSON.stringify(copy)]),
      external_messages: change.externalMessages.map(([key, message]) => [clean(key), message]),
    }
  }

  /** What an event writes, as column values: the one place they're derived. */
  function payload(event: BoardEvent, change: Change, sync: SyncChange) {
    const m = change.message?.after
    return {
      message: m && {
        id: m.id,
        created: change.message!.created,
        event_id: clean(event.id),
        channel: m.channel,
        re: m.re,
        by_actor: clean(m.by.actor),
        by_principal: clean(m.by.principal),
        by_profile: m.by.profile === null ? null : clean(m.by.profile),
        from_key: m.from,
        no_sync: m.noSync,
        text_lower: clean(m.text.toLowerCase()),
        deleted: m.deleted,
        created_at: Date.parse(m.createdAt),
        data: JSON.stringify(m),
      },
      terms:
        m && change.message!.terms
          ? [
              ...Object.entries(m.labels).map(([key, value]) => [key, clean(value)] as const),
              ...mentionTerms(m.text).map((term) => [MENTION, clean(term)] as const),
              ...[...new Set(m.attachments.map((file) => file.id))].map((id) => [ATTACHMENT, clean(id)] as const),
            ]
          : null,
      summary: change.summary ?? null,
      sync: syncPayload(sync),
    }
  }

  /** The writes, as statements. */
  function statements(index: number, { message: m, terms, summary, sync }: ReturnType<typeof payload>): Sql[] {
    const out: Sql[] = []
    if (m) {
      if (m.created)
        out.push({
          text: `insert into board_messages
  (id, event_id, channel, re, by_actor, by_principal, by_profile, from_key, no_sync, text_lower, deleted, created_at, data)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          values: [m.id, m.event_id, m.channel, m.re, m.by_actor, m.by_principal, m.by_profile, m.from_key, m.no_sync, m.text_lower, m.deleted, m.created_at, m.data],
        })
      else
        out.push({ text: 'update board_messages set text_lower = $1, deleted = $2, data = $3 where id = $4', values: [m.text_lower, m.deleted, m.data, m.id] })
      out.push({ text: 'insert into board_versions (log_index, message_id, data) values ($1, $2, $3)', values: [index, m.id, m.data] })
      if (terms) {
        if (!m.created) out.push({ text: 'delete from board_terms where message_id = $1', values: [m.id] })
        // A few hundred rows to a statement: a message's terms can outnumber SQLite's bound parameters.
        for (let first = 0; first < terms.length; first += TERMS_PER_INSERT) {
          const p = new Params()
          const tuples = terms
            .slice(first, first + TERMS_PER_INSERT)
            .map(([term, value]) => `(${p.add(m.id)}, ${p.add(term)}, ${p.add(value)})`)
          out.push({ text: `insert into board_terms (message_id, term, value) values ${tuples.join(', ')}`, values: p.values })
        }
      }
    }
    if (summary)
      out.push({ text: 'update board_messages set replies = $1, at = $2 where id = $3', values: [summary.replies, summary.at, summary.root] })
    if (sync) {
      if (sync.thread)
        out.push({
          text: 'insert into board_sync_threads (thread, data) values ($1, $2) on conflict (thread) do update set data = excluded.data',
          values: [sync.thread.key, sync.thread.data],
        })
      for (const [external, thread] of sync.external_threads)
        out.push({
          text: 'insert into board_external_threads (external, thread) values ($1, $2) on conflict (external) do update set thread = excluded.thread',
          values: [external, thread],
        })
      for (const [message, target, data] of sync.copies)
        out.push({
          text: 'insert into board_copies (message_id, target, data) values ($1, $2, $3) on conflict (message_id, target) do update set data = excluded.data',
          values: [message, target, data],
        })
      for (const [key, message] of sync.external_messages)
        out.push({
          text: 'insert into board_external_messages (key, message_id) values ($1, $2) on conflict (key) do update set message_id = excluded.message_id',
          values: [key, message],
        })
    }
    return out
  }

  /** Claims `event` (only if it's the next one, with `next`) and writes what it changes, atomically. */
  async function commit(event: BoardEvent, next: boolean): Promise<boolean> {
    // Only once the event before it has landed: until then, what it reads could be older than the
    // state it would fold onto. After, only this event moves the position, and its claim checks that.
    if (next && position(await db.all(positionSql)) !== event.index - 1) return false
    const id = concernedMessageId(event)
    const [change, sync] = await Promise.all([
      id === null ? {} : before(event, id).then((read) => project(read, event)),
      syncBefore(event).then((read) => projectSync(read, event)),
    ])
    const written = payload(event, change, sync)
    return db.commit(next ? claimNext(event.index) : claim(event.index), statements(event.index, written))
  }

  function threadsQuery(filter: MessageFilter, page: ThreadsPage): Sql {
    const p = new Params()
    const where = ['r.re is null']
    // A thread's messages are all in its root's channel: that filter goes on the root, where an index has it.
    const { channel, channels, ...rest } = filter
    if (channel) where.push(channelClause('r', channel, p))
    if (channels) where.push(channels.length ? `r.channel in (${p.list(channels)})` : '1 = 0')
    const matching = clauses(rest, p)
    if (matching.length > 0)
      where.push(`r.id in (select coalesce(m.re, m.id) from board_messages m where ${matching.join(' and ')})`)
    if (page.after !== undefined) where.push(`r.at > ${p.add(page.after)}`)
    if (page.before !== undefined) where.push(`(r.at < ${p.add(page.before.at)} or (r.at = ${p.add(page.before.at)} and r.id < ${p.add(page.before.id)}))`)
    const order = page.after !== undefined ? 'asc' : 'desc'
    // Backward, one more than the page: whether it's there says if an older page is.
    const limit = page.after !== undefined ? page.limit : page.limit + 1
    return {
      text: `select r.data as data, r.replies as replies, r.at as at, l.data as last
from board_messages r left join board_messages l on l.id = r.at and r.at <> r.id
where ${where.join(' and ')}
order by r.at ${order}, r.id ${order} limit ${p.add(limit)}`,
      values: p.values,
    }
  }

  /** Roots that match, each with its summary, by ID: a root's own row holds its reply count and its latest reply. */
  function rootsQuery(filter: MessageFilter, page: Page): Sql {
    const p = new Params()
    const where = ['m.re is null', ...clauses(filter, p)]
    if (page.before !== undefined) where.push(`m.id < ${p.add(page.before)}`)
    if (page.after !== undefined) where.push(`m.id > ${p.add(page.after)}`)
    const order = page.after !== undefined ? 'asc' : 'desc'
    return {
      text: `select m.data as data, m.replies as replies, l.data as last
from board_messages m left join board_messages l on l.id = m.at and m.at <> m.id
where ${where.join(' and ')}
order by m.id ${order} limit ${p.add(page.limit)}`,
      values: p.values,
    }
  }

  /** A thread summary from a row of a root joined with its latest reply. */
  const summary = (found: Record<string, unknown>): ThreadSummary => ({
    root: parse(found)!,
    replies: Number(found.replies),
    last: found.last === null || found.last === undefined ? null : (JSON.parse(String(found.last)) as Message),
  })

  return {
    async position() {
      return position(await db.all(positionSql))
    },

    async apply(event) {
      // Applied already, most often by the writer that wrote it: skip the reads.
      if (position(await db.all(positionSql)) >= event.index) return
      await commit(event, false)
    },

    applyNext: (event) => commit(event, true),

    async message(id) {
      return parse(await row(id))
    },

    async byEventId(eventId) {
      const [found] = await db.all({ text: 'select data from board_messages where event_id = $1', values: [clean(eventId)] })
      return parse(found)
    },

    async messagesAt(ids, index) {
      const out = new Map<number, Message>()
      if (ids.length === 0) return out
      const p = new Params()
      const rows = await db.all({
        text: `select v.message_id as id, v.data as data from board_versions v
where v.message_id in (${p.list([...new Set(ids)])})
  and v.log_index = (select max(w.log_index) from board_versions w where w.message_id = v.message_id and w.log_index <= ${p.add(index)})`,
        values: p.values,
      })
      for (const found of rows) out.set(Number(found.id), parse(found)!)
      return out
    },

    async thread(root) {
      const rows = await db.all({ text: 'select data from board_messages where id = $1 or re = $1 order by id', values: [root] })
      return rows.map((found) => parse(found)!)
    },

    async messages(filter, page) {
      if (filter.mentions) await mentionsReady()
      const p = new Params()
      const where = clauses(filter, p)
      if (page.before !== undefined) where.push(`m.id < ${p.add(page.before)}`)
      if (page.after !== undefined) where.push(`m.id > ${p.add(page.after)}`)
      const order = page.after !== undefined ? 'asc' : 'desc'
      const query: Sql = {
        text: `select m.data as data from board_messages m${where.length ? ` where ${where.join(' and ')}` : ''} order by m.id ${order} limit ${p.add(page.limit)}`,
        values: p.values,
      }
      const [positions, rows] = await db.read([positionSql, query])
      const messages = rows!.map((found) => parse(found)!)
      return { messages: page.after !== undefined ? messages : messages.reverse(), position: position(positions!) }
    },

    async threads(filter, page) {
      if (filter.mentions) await mentionsReady()
      const [positions, rows] = await db.read([positionSql, threadsQuery(filter, page)])
      const listed = rows!.map((found) => ({ ...summary(found), at: Number(found.at) }))
      if (page.after !== undefined) return { threads: listed.map(({ at: _, ...thread }) => thread), position: position(positions!) }
      const shown = listed.slice(0, page.limit)
      const oldest = shown.at(-1)
      const older = listed.length > page.limit && oldest ? { at: oldest.at, id: oldest.root.id } : null
      return { threads: shown.reverse().map(({ at: _, ...thread }) => thread), position: position(positions!), older }
    },

    async roots(filter, page) {
      const [positions, rows] = await db.read([positionSql, rootsQuery(filter, page)])
      const threads = rows!.map(summary)
      return { threads: page.after !== undefined ? threads : threads.reverse(), position: position(positions!) }
    },

    async syncOf(thread) {
      const [found] = await db.all({ text: 'select data from board_sync_threads where thread = $1', values: [clean(thread)] })
      return found ? (JSON.parse(String(found.data)) as SyncedThread) : null
    },

    async threadOf(external) {
      const [found] = await db.all({ text: 'select thread from board_external_threads where external = $1', values: [clean(external)] })
      return found ? String(found.thread) : null
    },

    async copiesOf(ids) {
      const out = new Map<number, Record<string, ExternalCopy>>()
      if (ids.length === 0) return out
      const p = new Params()
      const rows = await db.all({
        text: `select message_id, target, data from board_copies where message_id in (${p.list([...new Set(ids)])})`,
        values: p.values,
      })
      for (const found of rows) {
        const copies = out.get(Number(found.message_id)) ?? {}
        setOwn(copies, String(found.target), JSON.parse(String(found.data)) as ExternalCopy)
        out.set(Number(found.message_id), copies)
      }
      return out
    },

    async messageOf(externalThread, platformMessage) {
      const [found] = await db.all({
        text: 'select message_id from board_external_messages where key = $1',
        values: [clean(externalMessageKey(externalThread, platformMessage))],
      })
      return found ? Number(found.message_id) : null
    },

    async externalThreads() {
      return (await db.all({ text: 'select external from board_external_threads', values: [] })).map((found) => String(found.external))
    },

    async withAttachment(attachment) {
      const rows = await db.all({
        text: `select m.data as data from board_messages m
where exists (select 1 from board_terms t where t.message_id = m.id and t.term = '${ATTACHMENT}' and t.value = $1)
order by m.id`,
        values: [clean(attachment)],
      })
      return rows.map((found) => parse(found)!)
    },

    close: () => db.close(),
  }
}
