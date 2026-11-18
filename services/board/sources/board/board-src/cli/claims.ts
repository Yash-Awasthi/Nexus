// Where the CLI keeps the claims it holds, between commands: a claim answers its `epoch` and
// `token` once, and every write the claim makes needs both, so `vb tasks complete 812` is one
// process and `vb tasks claim 812` was another.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { configDir } from '../client/node.ts'

/** A claim as the CLI keeps it: what its writes carry, and when its lease ends. */
export type HeldClaim = { epoch: number; token: string; until: string }

/** The claims one run holds on one board, as whoever it writes as, by task. */
export type Claims = {
  get(task: string): Promise<HeldClaim | null>
  put(task: string, claim: HeldClaim): Promise<void>
  drop(task: string): Promise<void>
}

type Stored = HeldClaim & { board: string; task: string; profile: string | null }

/** A claim whose lease ended this long ago is no one's to settle: its file goes when another is written. */
const DEAD_MS = 24 * 60 * 60_000

/** The claims directory: `~/.config/board/claims`, or under `XDG_CONFIG_HOME`, as the CLI's tokens are. */
export const claimsDir = () => join(configDir(), 'claims')

/**
 * The file one claim lives in: named for its board, task, and profile together, hashed, so a name
 * says nothing of any of them, and never holds a token.
 */
const fileOf = (board: string, task: string, profile: string | null) =>
  join(claimsDir(), `${createHash('sha256').update(JSON.stringify([board, task, profile])).digest('hex').slice(0, 32)}.json`)

async function read(file: string): Promise<Stored | null> {
  try {
    const stored = JSON.parse(await readFile(file, 'utf8')) as Partial<Stored>
    if (typeof stored.epoch !== 'number' || typeof stored.token !== 'string' || typeof stored.until !== 'string') return null
    return stored as Stored
  } catch {
    return null
  }
}

/** Removes the claims whose leases ended long ago: a process that was killed leaves its file behind. */
async function prune(now: number) {
  for (const name of await readdir(claimsDir()).catch(() => [])) {
    if (!name.endsWith('.json')) {
      // A write that never finished: its temporary file, once it's old enough that nothing is still writing it.
      const file = join(claimsDir(), name)
      const info = await stat(file).catch(() => null)
      if (info && now - info.mtimeMs > DEAD_MS) await unlink(file).catch(() => {})
      continue
    }
    const file = join(claimsDir(), name)
    const stored = await read(file)
    if (stored && now - Date.parse(stored.until) > DEAD_MS) await unlink(file).catch(() => {})
  }
}

/**
 * Claims in files, one per board, task, and profile: only this user reads them (the directory is
 * 0700, each file 0600), and each is written whole or not at all. `board` is the board's own URL,
 * asked for only when a claim is read or written; `profile` is the profile this run writes as, as
 * an actor's ID has it, or null as yourself. A claim is its actor's: a run as another profile is
 * another actor, and holds none of it.
 */
export function fileClaims(board: () => Promise<string>, profile: string | null): Claims {
  let key: Promise<string> | null = null
  const at = async (task: string) => fileOf(await (key ??= board()), task, profile)
  return {
    async get(task) {
      const stored = await read(await at(task))
      // The name is a hash: what's in the file says which claim it is.
      if (!stored || stored.board !== (await key) || stored.task !== task || stored.profile !== profile) return null
      return { epoch: stored.epoch, token: stored.token, until: stored.until }
    },
    async put(task, claim) {
      const file = await at(task)
      await mkdir(claimsDir(), { recursive: true, mode: 0o700 })
      const stored: Stored = { board: (await key)!, task, profile, ...claim }
      // Beside it, then into place: a reader finds the old claim or the new one, never half of one.
      const partial = `${file}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(partial, JSON.stringify(stored), { mode: 0o600 })
      await rename(partial, file).catch(async (error: unknown) => {
        await unlink(partial).catch(() => {})
        throw error
      })
      await prune(Date.now()).catch(() => {})
    },
    async drop(task) {
      await unlink(await at(task)).catch(() => {})
    },
  }
}

/** A handle's claims, kept in this process: what `vb()` holds, where the board is a handle and no file is the caller's. */
const held = new WeakMap<object, Map<string, HeldClaim>>()

/** Claims kept in memory, for as long as the process and the handle last: one per task and profile, as the files are. */
export function memoryClaims(board: object, profile: string | null): Claims {
  const claims = held.get(board) ?? held.set(board, new Map()).get(board)!
  const at = (task: string) => JSON.stringify([task, profile])
  return {
    get: async (task) => claims.get(at(task)) ?? null,
    put: async (task, claim) => void claims.set(at(task), claim),
    drop: async (task) => void claims.delete(at(task)),
  }
}

/**
 * Claims by a token the caller chose, kept nowhere: a task's claim is this token's while the task
 * is claimed, at the epoch the board shows, and the board says whether the token holds it. So any
 * call with the token renews and settles the claim, on any handle, process, or instance.
 */
export function tokenClaims(board: { thread(id: string, range: { limit: number }): Promise<{ message: { task?: { state: string; epoch: number; claim: { until: string } | null } | null } }> }, token: string): Claims {
  return {
    async get(task) {
      const held = (await board.thread(task, { limit: 1 })).message.task
      if (held?.state !== 'claimed' || !held.claim) return null
      return { epoch: held.epoch, token, until: held.claim.until }
    },
    put: async () => {},
    drop: async () => {},
  }
}
