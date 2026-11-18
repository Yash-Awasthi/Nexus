// What `tasks run` runs: a command on this machine, for as long as a claim holds its task.
import { spawn } from 'node:child_process'
import { constants } from 'node:os'

/** A claim is never renewed more often than this, however short its lease. */
const RENEW_MIN_MS = 10_000

/**
 * How a command's run ended: it exited (`code` is its own, or 128 and its signal's number when one
 * killed it), Ctrl-C or a supervisor's SIGTERM stopped it (`code` is 128 and that signal's number,
 * as a process it had killed would say), its claim was lost and it was stopped, or it never started.
 */
export type Ran =
  | { how: 'exited'; code: number; signal: NodeJS.Signals | null }
  | { how: 'interrupted'; code: number }
  | { how: 'lost' }
  | { how: 'unstarted'; why: string }

/**
 * Runs `command` with this process's terminal, and calls `renew` every `every` milliseconds (at
 * least 10 seconds apart) while it runs. With `stdout: 'stderr'`, what the command prints on its
 * stdout goes to this process's stderr, for a caller whose own stdout is one document. `renew` answers whether the claim still holds: once it
 * doesn't, the command is stopped. Ctrl-C stops it too. It answers once the command has ended and
 * no renewal is still on its way.
 */
export function runCommand(command: readonly string[], options: { env: NodeJS.ProcessEnv; every: number; renew: () => Promise<boolean>; stdout?: 'inherit' | 'stderr' }): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: ['inherit', options.stdout === 'stderr' ? 2 : 'inherit', 'inherit'], env: options.env })
    let interrupted: 'SIGINT' | 'SIGTERM' | null = null
    let lost = false
    let ended = false
    let renewing: Promise<void> | null = null
    const interrupt = () => {
      interrupted = 'SIGINT'
      // At a terminal, Ctrl-C reaches the command too, as one of the same foreground group. Sent to
      // this process alone (a supervisor's, a script's), it's passed on.
      if (!process.stdin.isTTY) child.kill('SIGINT')
    }
    const terminate = () => {
      interrupted = 'SIGTERM'
      child.kill('SIGTERM')
    }
    process.on('SIGINT', interrupt)
    process.on('SIGTERM', terminate)
    const timer = setInterval(() => {
      // One at a time: a renewal slower than the turn between them is still the one that counts.
      if (renewing || lost) return
      renewing = options
        .renew()
        .then((held) => {
          if (held) return
          lost = true
          child.kill('SIGTERM')
        })
        .finally(() => {
          renewing = null
        })
    }, Math.max(RENEW_MIN_MS, options.every))
    const end = async (ran: Ran) => {
      if (ended) return
      ended = true
      clearInterval(timer)
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', terminate)
      // A renewal on its way says whether the claim still held when the command ended.
      await renewing
      resolve(ran.how === 'unstarted' ? ran : lost ? { how: 'lost' } : interrupted ? { how: 'interrupted', code: 128 + constants.signals[interrupted] } : ran)
    }
    child.once('error', (error: NodeJS.ErrnoException) => void end({ how: 'unstarted', why: error.code === 'ENOENT' ? "there's no such command" : error.message }))
    child.once('exit', (code, signal) => void end({ how: 'exited', code: code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0), signal }))
  })
}
