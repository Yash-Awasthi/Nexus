// What a CLI run that failed says, as data: the CLI renders it, and so can the CLI that runs board's
// (`vercel board`), in its own layout. The shape is the Vercel CLI's (its guide's "Errors and
// Warnings" and "Machine Output"), so both say the same thing about the same failure.

/**
 * What kind of failure it is, which fixes the exit code: 2 for `usage` and `missing_input`, 130
 * for `canceled`, and 1 for the rest, `timeout` included, as the Vercel CLI's waits exit.
 */
export type FailureClass =
  | 'usage'
  | 'missing_input'
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'conflict'
  | 'limit'
  | 'rate_limit'
  | 'network'
  | 'platform'
  | 'timeout'
  | 'canceled'
  | 'unknown'

/** One way out: what to do, and the command that does it, whole (`['vb', 'read', 'dev', '--scope', '<TEAM>']`). */
export type Recovery = { instruction: string; argv?: string[] }

export type Failure = {
  class: FailureClass
  /** Stable and snake_case: what a program branches on. */
  reason: string
  /** The headline: what failed, then the known cause, as sentences. */
  message: string
  /** What the headline can't hold, a line each: the board's own message, say. */
  details?: string[]
  /** Facts needed to act on it, as rows: `['Board', 'https://…']`. */
  context?: [string, string][]
  /** At most two, likeliest first. */
  next?: Recovery[]
  /** Blocked before anything happened, until someone gives it what it needs (a team, say). */
  actionRequired?: boolean
  /** For programs: what the CLI resolved, and the board's own error (`{ code, message }`) when it answered with one. */
  data?: Record<string, unknown>
}

/** A write went through, with something to say about it. */
export type Warning = { reason: string; message: string }

export function exitCode(failure: Pick<Failure, 'class'>): number {
  if (failure.class === 'usage' || failure.class === 'missing_input') return 2
  if (failure.class === 'canceled') return 130
  return 1
}

/** An argument as a shell reads it back: bare when it's safe, quoted otherwise. A placeholder (`<TEAM>`) stays as it is. */
const shellWord = (arg: string): string =>
  /^<[A-Z_]+>$/.test(arg) || /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`

/** A recovery's command, as a person types it. */
export const commandLine = (argv: readonly string[]): string => argv.map(shellWord).join(' ')

/**
 * The failure as lines, the headline first and the rest as they sit under it, before the indent a
 * CLI adds under its own mark (`error: `, `✗ `): details, context rows, then each way out after a
 * blank line, its command two spaces in.
 */
export function failureLines(failure: Failure): string[] {
  const lines = [failure.message, ...(failure.details ?? [])]
  for (const [label, value] of failure.context ?? []) lines.push(`${label.padEnd(14)}  ${value}`)
  if (failure.next?.length) {
    lines.push('')
    for (const { instruction, argv } of failure.next) {
      if (!argv) lines.push(instruction)
      else lines.push(`${instruction}:`, `  ${commandLine(argv)}`)
    }
  }
  return lines
}

/** How board's own CLI prints it: `error: ` and the headline, the rest two spaces in. */
export function formatFailure(failure: Failure): string {
  return failureLines(failure)
    .map((line, index) => (index === 0 ? `error: ${line}` : line ? `  ${line}` : ''))
    .join('\n')
}

/**
 * The JSON error document `--json` prints on stderr, one line: each way out with a command in
 * `next`, and the ones that are only words in `hint`.
 */
export function failureDocument(failure: Failure) {
  const next = (failure.next ?? []).flatMap(({ instruction, argv }) => (argv ? [{ command: commandLine(argv), argv, when: instruction }] : []))
  const hint = (failure.next ?? []).flatMap(({ instruction, argv }) => (argv ? [] : [instruction]))
  return {
    status: failure.actionRequired ? ('action_required' as const) : ('error' as const),
    reason: failure.reason,
    message: failure.message,
    ...(next.length ? { next } : {}),
    ...(hint.length ? { hint: hint.join(' ') } : {}),
    ...(failure.data ? { data: failure.data } : {}),
  }
}

/**
 * The closest of `known` to `word`, when it's a likely typo: one edit away (a letter added, dropped,
 * changed, or two swapped), or two for a word of six letters or more.
 */
export function closest(word: string, known: Iterable<string>): string | undefined {
  let best: string | undefined
  let distance = Infinity
  for (const candidate of known) {
    const d = edits(word.toLowerCase(), candidate.toLowerCase())
    if (d < distance) [best, distance] = [candidate, d]
  }
  return best !== undefined && distance > 0 && distance <= (word.length >= 6 ? 2 : 1) ? best : undefined
}

/** How many edits turn `a` into `b`, a swap of neighbors counting as one. */
function edits(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1)
    }
  return d[a.length]![b.length]!
}
