import { consumer } from 'experimental-a2/server'
import { boardContract } from '../contract/contract.ts'
import { BOARD_SESSION, type BoardEvent } from '../contract/events.ts'
import type { Message } from '../contract/folds.ts'
import { TABLES_CONSUMER } from '../store/sql.ts'
import type { MessageFilter, MessageTables, Page, ThreadsPage } from '../store/types.ts'
import type { Access } from './access.ts'
import type { BoardSession } from './a2.ts'
import { linkedIds, type Reader } from './feed.ts'
import { waitUntil } from './wait-until.ts'

/** Keeps the tables from the board's log, one event at a time, from the first. */
export function tablesConsumer(tables: MessageTables) {
  return consumer({ contract: boardContract, name: TABLES_CONSUMER, lane: 'tables', backfill: true }).run(async (ctx) => {
    // The tables keep one position, the board session's: another session's indexes would move it.
    if (ctx.session.id !== BOARD_SESSION) return
    await tables.apply(ctx.event as BoardEvent)
  })
}

export type TablesConsumer = ReturnType<typeof tablesConsumer>

/**
 * The board's reads from its tables. A read that names a log index (a message
 * ID is one) waits until the tables have applied it; list reads don't wait, and
 * say which index they reflect.
 */
export function createReads(tables: MessageTables, session: BoardSession, projection: TablesConsumer) {
  /**
   * The first list read on an instance starts the tables catching up, and doesn't wait: after a deploy
   * that adds them, or on a quiet board, nothing else may have yet.
   */
  let catching: Promise<unknown> | null = null
  /**
   * The reader of views whose links point to the board messages `linked`, looked up only for a
   * reader that can't read every channel. A linked message is older than the one linking it, so
   * the tables have it.
   */
  async function readerOf(access: Access, linked: readonly number[]): Promise<Reader> {
    if (access.readsAll) return { access, channelOf: () => undefined }
    const ids = [...new Set(linked)].filter((id) => id > 0)
    const found = ids.length === 0 ? new Map<number, Message>() : await tables.messagesAt(ids, await tables.position())
    return { access, channelOf: (id) => found.get(id)?.channel }
  }
  function catchUp(): void {
    if (catching) return
    catching = session.consume(projection).catch(() => {
      catching = null
    })
    waitUntil(catching)
  }

  /**
   * The tables caught up with the whole log once on this instance. Until then, a read by index waits
   * for all of it: tables rebuilt from the log can be far behind, and a message's later events (an
   * edit, a reaction, a reply) come after its own index. Once caught up, each write applies as it lands.
   */
  let whole: Promise<void> | null = null
  function caughtUp(): Promise<void> {
    whole ??= session.consume(projection).then(
      () => undefined,
      (error: unknown) => {
        whole = null
        throw error
      },
    )
    return whole
  }

  /** `promise`, unless `signal` aborts first: the caller stops waiting, and what it waits for keeps going. */
  function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise
    if (signal.aborted) return Promise.reject(signal.reason)
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }

  /** Waits until the tables have applied `index`, or the whole log when it's omitted. */
  async function ensure(index?: number, signal?: AbortSignal): Promise<void> {
    if (index !== undefined) await untilAborted(caughtUp(), signal)
    if (index !== undefined && (await tables.position()) >= index) return
    await session.consume(projection, { ...(index !== undefined ? { through: index } : {}), ...(signal ? { signal } : {}) })
  }

  return {
    tables,
    ensure,
    position: () => tables.position(),
    async message(id: number, signal?: AbortSignal): Promise<Message | null> {
      await ensure(id, signal)
      return tables.message(id)
    },
    /** A thread's root and replies; `cursor` is the index the tables had applied before reading it. */
    async thread(root: number, signal?: AbortSignal): Promise<{ messages: Message[]; cursor: number }> {
      await ensure(root, signal)
      const cursor = await tables.position()
      return { messages: await tables.thread(root), cursor }
    },
    async messagesAt(ids: readonly number[], index: number, signal?: AbortSignal): Promise<Map<number, Message>> {
      await ensure(index, signal)
      return tables.messagesAt(ids, index)
    },
    /** By event ID, as of the whole log: an ID doesn't say how far to wait. */
    async byEventId(eventId: string, signal?: AbortSignal): Promise<Message | null> {
      await ensure(undefined, signal)
      return tables.byEventId(eventId)
    },
    /** The reader of views of `messages`: what a link shows depends on where the message it points to lives. */
    reader: (access: Access, messages: Iterable<Message>): Promise<Reader> => readerOf(access, [...messages].flatMap((message) => linkedIds(message.links))),
    readerOf,
    async messages(filter: MessageFilter, page: Page) {
      catchUp()
      // A reader of no channel: nothing to look for.
      if (filter.channels?.length === 0) return { messages: [], position: await tables.position() }
      return tables.messages(filter, page)
    },
    async threads(filter: MessageFilter, page: ThreadsPage) {
      catchUp()
      if (filter.channels?.length === 0) return { threads: [], position: await tables.position(), ...(page.after === undefined ? { older: null } : {}) }
      return tables.threads(filter, page)
    },
    async roots(filter: MessageFilter, page: Page) {
      catchUp()
      if (filter.channels?.length === 0) return { threads: [], position: await tables.position() }
      return tables.roots(filter, page)
    },
  }
}

export type BoardReads = ReturnType<typeof createReads>
