// A board kept in this process, which `@vercel/board/backend-local` exports: on the board's log and its
// engine, with its pieces chosen here.
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { a2 } from './a2.ts'
import type { Backend, BoardBinding, Caller, ProtocolMethods, Trust } from './backend.ts'
import { fsBlob, memoryBlob } from './blob.ts'
import { HttpError } from './errors.ts'
import { METHODS } from './routing.ts'
import { localScheduler, type LocalScheduler } from '../scheduler/local.ts'
import type { BoardStore } from '../store/types.ts'

export type LocalOptions = {
  /**
   * Where it keeps its files: `.board` under the working directory by default. Each board is one
   * SQLite file there, `local.db` for the default board and one named for the board otherwise,
   * whatever its team, with its attachments in the folder of the same name.
   */
  dir?: string
  /** Keeps the board in memory, attachments too, for tests: nothing is written, and it's gone with the process. */
  memory?: boolean
}

/** A board kept in this process. `close()` closes its file, once nothing uses it. */
export type LocalBackend = Backend & {
  /** Stops its timers and closes the board's file. What was still to send doesn't, as after a restart. */
  close(): Promise<void>
}

/** A board's name that is its own file's: lowercase letters, digits, `_`, and `-`, and no device name Windows keeps. */
const PLAIN = /^[a-z0-9][a-z0-9_-]{0,63}$/
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/

/**
 * The file a board keeps, without its extension, from its name alone: `local` for the default
 * board, a plain name as it is (whatever its case: names match that way), and any other name,
 * `Security Team` say, as letters and dashes, a `.`, and a hash of it. No plain name has a `.`,
 * and the hash is long enough that no one finds two names that share it, so no two names
 * share a file, and none is `local`'s.
 */
export function localFile(name: string | null): string {
  if (name === null) return 'local'
  const lower = name.toLowerCase()
  if (PLAIN.test(lower) && lower !== 'local' && !RESERVED.test(lower)) return lower
  const slug = lower.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'board'
  return `${slug}.${createHash('sha256').update(lower).digest('hex').slice(0, 32)}`
}

/** Why a file couldn't be opened, in a few words. */
function unwritable(error: unknown): string {
  const { code, message } = error as { code?: unknown; message?: unknown }
  if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM' || /unable to open database|readonly database/i.test(String(message)))
    return "this filesystem isn't writable here"
  return String(message ?? error).split('\n')[0]!
}

/**
 * A board kept in this process: in SQLite under `.board/` (or `dir`), one file per board's name
 * (whatever `board({ team })` says: there's one team here),
 * its attachments next to it, and a scheduler whose timers run here, so schedules send, and
 * watchers and sync retry, while the process runs. `memory` keeps it all in memory, for tests.
 * A restart drops pending timers, so it's for development, `vb serve`, tests, and working offline,
 * never serverless functions.
 */
export function local(options: LocalOptions = {}): LocalBackend {
  const dir = resolve(options.dir ?? '.board')
  let binding: BoardBinding | null = null
  let opening: Promise<{ backend: ReturnType<typeof a2>; store: BoardStore; scheduler: LocalScheduler }> | null = null

  /** The board, opened on its first use: binding does no I/O. One that didn't open is tried again on the next call. */
  function open() {
    if (!binding) throw new Error("local: this backend isn't serving a board yet: pass it to board({ backend })")
    const bound = binding
    opening ??= (async () => {
      const file = localFile(bound.name)
      let store: BoardStore
      if (options.memory) store = (await import('../store/memory.ts')).memory()
      else {
        const { mkdir } = await import('node:fs/promises')
        const { sqlite } = await import('../store/sqlite.ts')
        const path = join(dir, `${file}.db`)
        try {
          await mkdir(dir, { recursive: true, mode: 0o700 })
          store = sqlite({ path })
        } catch (error) {
          throw new HttpError(500, 'no_store', `can't open the board at ${path}: ${unwritable(error)}`)
        }
      }
      const scheduler = localScheduler()
      const backend = a2({ store, scheduler, blob: options.memory ? memoryBlob() : fsBlob(join(dir, file)) })
      backend.bind(bound)
      return { backend, store, scheduler }
    })()
    opening.catch(() => (opening = null))
    return opening
  }

  const methods = Object.fromEntries(
    METHODS.map((name) => [name, async (caller: Caller, input: never, signal: AbortSignal) => ((await open()).backend[name] as (...args: unknown[]) => unknown)(caller, input, signal)]),
  ) as unknown as ProtocolMethods

  return {
    ...methods,
    routes: [],
    // The board lives here: board() lets its people and own deployments in by default.
    keeps: true,
    trust: {
      grants: async () => (await open()).backend.trust.grants(),
    } satisfies Trust,
    bind(given: BoardBinding) {
      if (binding) throw new Error('local: this backend already serves a board: create one local() per board()')
      binding = given
    },
    async close() {
      const opened = opening
      opening = null
      const board = opened && (await opened.catch(() => null))
      // Its timers first: one that fired after would run against a closed file.
      board?.scheduler.stop()
      await board?.store.close()
    },
  }
}
