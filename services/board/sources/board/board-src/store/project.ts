import type { BoardEvent } from '../contract/events.ts'
import { own, setOwn } from '../contract/own.ts'
import { foldMessages, foldSync, type ExternalCopy, type Message, type SyncedThread, type SyncState } from '../contract/folds.ts'
import { mentionTerms } from '../contract/mentions.ts'

/** The message an event concerns, if any. */
export function concernedMessageId(event: BoardEvent): number | null {
  if (event.type === 'message.posted') return event.index
  if ('id' in event.payload) return event.payload.id
  return null
}

/** A root's thread summary: replies that aren't deleted, and the latest one's ID (its own when none). */
export type Summary = { replies: number; at: number }

/** What the tables hold before an event, as far as it matters to that event. */
export type Before = {
  message: Message | undefined
  /** Its root's summary, when it's a reply. */
  root: Summary | undefined
  /** For a delete of a root's latest reply: the newest other reply that isn't deleted. */
  previousLast?: number | null
}

/** What an event changes. */
export type Change = {
  /** The message as it is after the event, when the event changed it. */
  message?: { after: Message; created: boolean; terms: boolean }
  /** A root's new summary. */
  summary?: { root: number } & Summary
}

const termsOf = (message: Message) => JSON.stringify([message.labels, mentionTerms(message.text), message.attachments.map((file) => file.id)])

/**
 * Applies one event to what the tables hold, with the same fold the board has
 * always used, on a state of just that message. Pure: the caller reads `before`
 * and writes the change.
 */
export function project(before: Before, event: BoardEvent): Change {
  const id = concernedMessageId(event)
  if (id === null) return {}
  const current = before.message
  if (event.type !== 'message.posted' && !current) return {}
  const state = { byId: current ? { [id]: structuredClone(current) } : {}, replies: {} }
  foldMessages(state, event)
  const after = state.byId[id]
  if (!after) return {}
  const change: Change = {}
  const created = current === undefined
  if (created || JSON.stringify(after) !== JSON.stringify(current))
    change.message = { after, created, terms: created || termsOf(after) !== termsOf(current!) }

  if (event.type === 'message.posted') {
    if (after.re === null) change.summary = { root: id, replies: 0, at: id }
    else if (before.root) change.summary = { root: after.re, replies: before.root.replies + 1, at: id }
  } else if (event.type === 'message.deleted' && current && !current.deleted && current.re !== null && before.root) {
    const at = before.root.at === id ? (before.previousLast ?? current.re) : before.root.at
    change.summary = { root: current.re, replies: before.root.replies - 1, at }
  }
  return change
}

/** The sync state an event touches: its thread's sync, and for a file receipt, the copy it's about. */
export type SyncBefore = {
  thread: SyncedThread | undefined
  copy: ExternalCopy | undefined
  /** For a `thread.synced`, the board thread its target is already synced with, if any. */
  owner?: string | undefined
}

/** What an event changes in the sync state: rows to write, each replacing what was there. */
export type SyncChange = {
  thread?: { key: string; data: SyncedThread }
  externalThreads: [external: string, thread: string][]
  copies: [message: number, target: string, copy: ExternalCopy][]
  externalMessages: [key: string, message: number][]
}

/** The sync rows `event` reads before it applies: none for events that don't touch the sync state. */
export function syncReads(event: BoardEvent): { thread: string | null; copy: [number, string] | null; external?: string } {
  switch (event.type) {
    case 'message.posted':
      // A reply's thread is only read for a root, which the event itself creates.
      return { thread: null, copy: null }
    case 'thread.synced':
      return { thread: event.payload.thread, copy: null, external: event.payload.target }
    case 'message.synced':
      return { thread: event.payload.thread, copy: null }
    case 'message.files_synced':
      return { thread: null, copy: [event.payload.id, event.payload.target] }
    default:
      return { thread: null, copy: null }
  }
}

/**
 * Applies one event to the sync state, with the fold the board has always used,
 * on a state of just what the event touches. Pure, like `project`.
 */
export function projectSync(before: SyncBefore, event: BoardEvent): SyncChange {
  const change: SyncChange = { externalThreads: [], copies: [], externalMessages: [] }
  if (!['message.posted', 'thread.synced', 'message.synced', 'message.files_synced'].includes(event.type)) return change
  const key = (event.payload as { thread: string }).thread
  const state: SyncState = { threads: {}, byExternalThread: {}, copies: {}, byExternalMessage: {} }
  if (before.thread) setOwn(state.threads, key, structuredClone(before.thread))
  const reads = syncReads(event)
  if (reads.copy && before.copy) state.copies[reads.copy[0]] = { [reads.copy[1]]: structuredClone(before.copy) }
  if (reads.external !== undefined && before.owner !== undefined) setOwn(state.byExternalThread, reads.external, before.owner)
  foldSync(state, event)
  const thread = own(state.threads, key)
  if (thread && JSON.stringify(thread) !== JSON.stringify(before.thread)) change.thread = { key, data: thread }
  for (const [external, owner] of Object.entries(state.byExternalThread))
    if (!(external === reads.external && owner === before.owner)) change.externalThreads.push([external, owner])
  for (const [message, targets] of Object.entries(state.copies))
    for (const [target, copy] of Object.entries(targets)) {
      const unchanged = reads.copy?.[0] === Number(message) && reads.copy[1] === target && JSON.stringify(copy) === JSON.stringify(before.copy)
      if (!unchanged) change.copies.push([Number(message), target, copy])
    }
  for (const [externalKey, message] of Object.entries(state.byExternalMessage)) change.externalMessages.push([externalKey, message])
  return change
}
