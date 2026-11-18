// `@vercel/board/cli`: board's CLI, to run inside another one, as `vercel board`. It has every
// command but `inspect` and `serve`, which run something on this machine, so neither the inspector
// nor A2 reaches an app that bundles it.
import { stoppedBy } from '../server/board.ts'
import type { Board } from '../server/index.ts'
import type { Claims } from './claims.ts'
import { exitCode, failureDocument, formatFailure, type Failure, type Warning } from './failure.ts'
import { commandWord, Failed, main, mainWith } from './main.ts'

export { commandWord }
export { commandLine, failureLines } from './failure.ts'
export type { Failure, FailureClass, Recovery, Warning } from './failure.ts'
export type { Claims, HeldClaim } from './claims.ts'

/**
 * Board's CLI as `appName` names it in help, usage, and errors (`vercel board`). With no board
 * URL anywhere, it talks to the team's board in Vercel's API: `VERCEL_ORG_ID`'s, the nearest linked
 * project's team's (`.vercel`), your login's, or `--scope`'s. `run` takes what follows the name, and answers the exit code:
 * 0 success, 1 error (a `wait` that timed out included), 2 misuse, 130 when Ctrl-C stops it. It never exits the process itself. One `run`
 * at a time: a run's flags are the CLI's while it runs.
 *
 * A failure goes to `onError`, with whether the run asked for `--json`, to show as the app shows
 * its own, and a warning to `onWarning` (with `--json`, it's in the result). Without them, the CLI
 * prints its own on stderr. `login` is the app's Vercel login and `team` the team it resolves
 * (`--scope` still wins): board asks for each only when a request needs it, so help, a typo, or
 * misuse never refreshes a login or looks a team up. With `fetch`, board's requests to Vercel's API
 * with that login go through the app's own, which adds its credentials (a DPoP proof, say).
 *
 * The app says who its commands run as: its `login` is the one that goes, wherever the app runs,
 * and nothing the environment holds goes ahead of it, a deployment's own token and `BOARD_TOKEN`
 * included. Those are `vb`'s to send, and this CLI's only when the app gives it no login.
 *
 * `token` is a Vercel token someone passed the app for this run, as `vercel board --token` takes
 * one: the login to use in place of `login`. Board sends it itself, as a Bearer token, never
 * through `fetch`, which would add the app's own login's.
 */
export function createApp(options: {
  appName: string
  onError?: (failure: Failure, mode: { json: boolean }) => void
  onWarning?: (warning: Warning) => void
  login?: () => Promise<string>
  token?: string
  team?: () => Promise<string | null>
  fetch?: typeof globalThis.fetch
}): { run(args: string[]): Promise<number> } {
  const { appName, onError, onWarning, login, token, team, fetch } = options
  return {
    run: (args) =>
      main(args, {
        name: appName,
        commands: {},
        teamBoard: true,
        ...(onError ? { onError } : {}),
        ...(onWarning ? { onWarning } : {}),
        ...(login ? { login } : {}),
        ...(token ? { token } : {}),
        ...(team ? { team } : {}),
        ...(fetch ? { fetch } : {}),
      }),
  }
}

/** Where a `vb()` command's files come from and go, and what stops it. A command that needs one it lacks says so. */
export type VbOptions = {
  /** A file's bytes, for `--attach`; null when there's no such file. */
  readFile?: (path: string) => Promise<Uint8Array | null> | PromiseLike<Uint8Array | null>
  /**
   * Saves a file, for `download`. With `exclusive`, the name came from the attachment, so
   * throw an error whose `code` is `EEXIST` rather than replace a file that's there.
   */
  writeFile?: (path: string, data: Uint8Array, options?: { exclusive?: boolean }) => Promise<void> | PromiseLike<void>
  /** The text `-` reads, as stdin would hold it. */
  stdin?: string
  /**
   * Ends the command and its requests: `tail` and `wait` as Ctrl-C does (0), any other with a
   * failure, 1 when it's `AbortSignal.timeout()`'s and 130 otherwise. A write it stopped may have
   * landed. Every request ends, whether or not the backend heeds it, on a handle `board()` made.
   */
  signal?: AbortSignal
  /** Commands this caller doesn't run, which answer 2: `['tail', 'wait']` for an agent's tool. */
  refuse?: string[]
  /**
   * Where the task claims this call takes and settles are kept, for the profile it writes as (null
   * as the handle's own), in place of the handle's memory: a store in KV or a file, so a claim one
   * call takes is settled by a call on another handle, process, or instance. It holds tokens, so
   * only you read it, and it's one board's: key it by the board too when it holds several.
   */
  claims?: (profile: string | null) => Claims
  /**
   * The token the task claims this call takes carry, in place of one the board makes: a secret you
   * can derive again on any instance, as an HMAC of your run's ID, so a call that has it settles
   * the claim with no store, and claiming a task you hold again answers the claim you hold. It
   * never reaches stdout. Anyone who can label in the task's channel and has it writes through
   * the claim, so keep it as secret as a token.
   */
  claimToken?: string
}

/** What a `vb()` command printed, and its exit code: 0, 1 for an error (a `wait` that timed out included), 2 for misuse. */
export type VbResult = { code: number; stdout: string; stderr: string }

const lacking = (what: string, option: string) => async (): Promise<never> => {
  throw new Failed({ class: 'usage', reason: 'not_available', message: `${what} here: pass ${option} in vb()'s options.` })
}

/** A call `vb()` answers itself, printed as the CLI would print it. */
function refused(argv: string[], failure: Failure): Promise<VbResult> {
  const json = argv.slice(0, argv.includes('--') ? argv.indexOf('--') : undefined).includes('--json')
  const stderr = json ? JSON.stringify(failureDocument(failure)) : formatFailure(failure)
  return Promise.resolve({ code: exitCode(failure), stdout: '', stderr: `${stderr}\n` })
}

// Runs share the CLI's flags, so one runs at a time; the rest wait their turn.
let queue: Promise<unknown> = Promise.resolve()

/**
 * Runs the vb command `argv` (`['read', '42']`, `['reply', '42', 'on it']`) on `board`, in this
 * process, and returns what the CLI would print. `board` already says which board and who, so
 * `--url` doesn't apply, and the commands about your machine (`whoami`, `identity`,
 * `hooks`, `serve`, `inspect`) answer 2. Calls run one at a time, in order, so
 * `tail` and `wait`, which hold the rest until they end, need `options.signal`; it bounds any
 * other call too: `{ signal: AbortSignal.timeout(30_000) }`.
 */
export function vb(board: Board, argv: string[], options: VbOptions = {}): Promise<VbResult> {
  // `tail` never ends by itself and `wait` runs up to 30 minutes, holding every later call: only with a way to stop them.
  const word = commandWord(argv)
  if (word !== undefined && options.refuse?.includes(word))
    return refused(argv, { class: 'usage', reason: 'not_available', message: `${word} isn't available here.` })
  if ((word === 'tail' || word === 'wait') && !options.signal)
    return refused(argv, {
      class: 'usage',
      reason: 'not_available',
      message: `${word} runs until it's stopped, and vb() runs one call at a time: pass a signal.`,
    })
  const result = queue.then(async () => {
    let stdout = ''
    let stderr = ''
    const decoder = new TextDecoder()
    const code = await mainWith(argv, { name: 'board', commands: {} }, {
      board: (options.signal && stoppedBy(board, options.signal)) || board,
      // A call with a signal runs on a handle of its own: its claims are the caller's handle's all the same.
      claimsOf: board,
      ...(options.claims ? { claims: options.claims } : {}),
      ...(options.claimToken !== undefined ? { claimToken: options.claimToken } : {}),
      write: (chunk) => void (stdout += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })),
      error: (chunk) => void (stderr += chunk),
      readFile: options.readFile ? async (path) => options.readFile!(path) : lacking("--attach and --file can't read files", 'readFile'),
      writeFile: options.writeFile ? async (path, data, writeOptions) => options.writeFile!(path, data, writeOptions) : lacking("download can't save files", 'writeFile'),
      stdin: options.stdin !== undefined ? async () => options.stdin! : lacking("- can't read stdin", 'stdin'),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    return { code, stdout, stderr }
  })
  queue = result.catch(() => {})
  return result
}
