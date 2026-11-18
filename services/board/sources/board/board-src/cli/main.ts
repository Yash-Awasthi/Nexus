import { spawn } from 'node:child_process'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'
import { CHANNELS_LIMIT_MAX, GRANT_BATCH_MAX, THREADS_LIMIT_DEFAULT, THREADS_LIMIT_MAX, type GrantInput, type Me, type MessageView } from '../api/routes.ts'
import { everyChannel } from '../client/channels.ts'
import { withMentions } from '../api/tail.ts'
import { BoardError, type ClaimedTask, type Filters, type ProfileOption, type TaskInBatch, type Written } from '../client/client.ts'
import type { Mentioned } from '../contract/mentions.ts'
import { createTasksInChunks, TasksInChunksError } from '../client/chunks.ts'
import { boardUrl, connect, environmentProfile, handFetch, handLogin, handToken, PASSED, vercelProjectFile } from '../client/node.ts'
import { http } from '../backend-http/index.ts'
import { credentialed, credentialSource, handTeam, vercel } from '../backend-vercel/index.ts'
import { board as boardAt, type Board } from '../server/index.ts'
import { isBoardName } from '../server/board.ts'
import { isApiMessageId } from '../server/backend-vercel.ts'
import { normalizeEmoji } from '../contract/emoji.ts'
import { ATTACHMENTS_PER_MESSAGE_MAX, DIRECT_UPLOAD_BYTES_MAX, MESSAGE_TEXT_MAX, type Attachment, AttachmentId } from '../contract/schemas.ts'
import { VERSION } from '../version.ts'
import { conformance } from '../conformance/index.ts'
import { explainPrincipalOf, explanationLine, GrantMisuse, grantCanOf, KINDS, patternsIn, principalsIn, type OptionToken } from './grants.ts'
import { formatSchema, formatSchemas } from './schemas.ts'
import { parseSchemaId } from '../contract/data-schemas.ts'
import { block } from '../contract/blocks.ts'
import { actorName, claimLine, formatAccess, formatConformance, formatEvent, formatGrants, grantRow, formatSchedule, formatTasks, mentionedIn, reactionNames, formatSourceRead, formatSynced, formatThreadSummaries, formatThreads, terminalText, who } from './format.ts'
import { fileClaims, memoryClaims, tokenClaims, type Claims } from './claims.ts'
import { runCommand } from './run.ts'
import { AGENTS, allowRules, cliOf, disallow, installedHook, tilde, uninstallHook, type HookAgent } from './hooks.ts'
import { commands, filters as filterOptions, globalOptions, options, type CliCommand } from './commands.ts'
import { commandHelp, commandPath, rootHelp } from './help.ts'
import { closest, commandLine, exitCode, failureDocument, formatFailure, type Failure, type Recovery, type Warning } from './failure.ts'

/** A failure this run says in its own words: what a command throws to stop with it. */
export class Failed extends Error {
  readonly failure: Failure
  constructor(failure: Failure) {
    super(failure.message)
    this.failure = failure
  }
}

/**
 * Misuse: `message` says what's wrong with the command as typed. It exits 2, and points at the
 * command's help unless `next` says something better.
 */
function usage(message: string, options: { reason?: string; next?: Recovery[] } = {}): Failed {
  return new Failed({ class: 'usage', reason: options.reason ?? 'invalid_arguments', message, next: options.next ?? [helpRecovery()] })
}

/** A command's help page, which says how to use it. */
const helpRecovery = (command = current.command): Recovery => ({ instruction: 'See how to use it', argv: [...cli(), ...(command ? [command] : []), '--help'] })

/** This CLI's name as argv, to build a command a person runs: `['vb']`, `['vercel', 'board']`. */
const cli = () => named().split(' ')

/** This run's command as typed, with `extra` where options go: before any `--`, after which everything is text. */
function rerun(...extra: string[]): string[] {
  const at = typed.indexOf('--')
  return [...cli(), ...(at === -1 ? [...typed, ...extra] : [...typed.slice(0, at), ...extra, ...typed.slice(at)])]
}

/** A command line without `options` and their values: a bare `--mentions` has none, so what follows it stays. */
const without = (argv: string[], ...options: string[]): string[] =>
  argv.filter(
    (arg, at) =>
      !options.some(
        (option) =>
          arg === option ||
          arg.startsWith(`${option}=`) ||
          (argv[at - 1] === option && !((OPTIONS as Record<string, { optionalValue?: true }>)[option.slice(2)]?.optionalValue && arg.startsWith('-'))),
      ),
  )

/**
 * This run's command line without `options`, with `extra` in their place: both before any `--`,
 * since what follows it is text, which a way out mustn't change or add options to.
 */
function rerunWithout(options: string[], ...extra: string[]): string[] {
  const at = typed.indexOf('--')
  const before = at === -1 ? typed : typed.slice(0, at)
  return [...cli(), ...without(before, ...options), ...extra, ...(at === -1 ? [] : typed.slice(at))]
}

/** What the parser accepts: every option, by name (`commands.ts`). */
const OPTIONS = options

/** Options by their short letter: `n` is `limit`. */
const SHORT: Record<string, string> = Object.fromEntries(
  Object.entries(OPTIONS).flatMap(([name, option]) => ('short' in option ? [[option.short, name]] : [])),
)

/**
 * Whether `arg` is a string option written apart from its value, whose value is the next argument:
 * `--limit 5`, `-n 5`, or the last of a group of short ones, `-an 5`.
 */
function takesValue(arg: string): boolean {
  if (arg.includes('=')) return false
  const string = (name: string | undefined) => name !== undefined && OPTIONS[name as keyof typeof OPTIONS]?.type === 'string'
  if (arg.startsWith('--')) return string(arg.slice(2))
  // In a group, a string option takes what follows it in the group, or, last, the next argument.
  const letters = arg.slice(1)
  const first = [...letters].findIndex((letter) => string(SHORT[letter]))
  return first === letters.length - 1
}

/** A command's own name for `word`, which may be one of its aliases (`rm` is `delete`). */
const canonical = (word: string | undefined) => (word === undefined ? word : (commands.find((command) => command.aliases?.includes(word))?.name ?? word))

// No argument can hold a NUL, so a marked one can't be anything else.
const MARK = '\0'

/**
 * Attachment IDs are base64url, so boards minted some that start with `-`,
 * which `parseArgs` reads as a flag. Where `download` takes its ID, a token
 * shaped like one is the ID: this marks it to parse as a positional.
 */
function markAttachmentId(args: string[]): string[] {
  const positionals: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') break
    if (!arg.startsWith('-') || arg === '-') positionals.push(arg)
    else if (positionals.length === 1 && positionals[0] === 'download' && AttachmentId.safeParse(arg).success)
      return [...args.slice(0, i), `${MARK}${arg}`, ...args.slice(i + 1)]
    else if (takesValue(arg)) i++
  }
  return args
}
/** Commands that are gone, and what to run instead. Their flags don't matter: an old hook's `vb update --skip` gets this too. */
function removedCommand(word: string): Failed | undefined {
  const gone = (next: Recovery[], why = '') => usage(`\`${named()} ${word}\` is gone.${why}`, { reason: 'unknown_command', next })
  const url: Recovery[] = [
    { instruction: "Pass the board's URL", argv: [...cli(), 'read', 'dev', '--url', '<URL>'] },
    { instruction: "Or, in a Vercel project, its team's board needs no URL" },
  ]
  const removed: Record<string, () => Failed> = {
    update: () =>
      gone([
        { instruction: "Reply in the thread you're working in", argv: [...cli(), 'reply', '<ID>', '<TEXT>'] },
        { instruction: 'Or post where it fits', argv: [...cli(), 'post', '<CHANNEL>', '<TEXT>'] },
      ]),
    stuck: () => gone([]),
    link: () => gone(url),
    use: () => gone(url),
  }
  return Object.hasOwn(removed, word) ? removed[word]!() : undefined
}

/**
 * The command `argv` runs, by its own name (`delete` for `rm`), as the parser reads it: the
 * first positional, past every flag and value however they're written (`-an 1`, `--limit=1`). A
 * bare `--mentions` takes none.
 */
export function commandWord(argv: string[]): string | undefined {
  const { positionals } = parseArgs({ args: markAttachmentId(withMentions(argv)), allowPositionals: true, options: OPTIONS, strict: false })
  return canonical(positionals[0])
}

const parseAll = (args: string[]) => parseArgs({ args, allowPositionals: true, options: OPTIONS })

/**
 * What the parser accepts for `word`'s command: every option, with the command's own definition
 * where it has one. `--claim` takes a value on `grants` and none on `tasks`, and each command's
 * data says which. The command is found before this applies, so one that's its command's own way
 * goes after the command's name.
 */
function optionsFor(word: string | undefined): typeof OPTIONS {
  const command = [...commands, ...Object.values(app.commands).map((own) => own.spec)].find((known) => known.name === word)
  if (!command) return OPTIONS
  const own = [command, ...(command.subcommands ?? [])].flatMap((c) => c.options)
  const table: Record<string, { type: 'string' | 'boolean'; short?: string; multiple?: true }> = { ...OPTIONS }
  for (const { name, type, short, multiple } of own) table[name] = { type, ...(short ? { short } : {}), ...(multiple ? { multiple } : {}) }
  return table as typeof OPTIONS
}

/** A command an app adds to board's: `serve`, in the standalone `board`. */
export type Command = {
  /** What it is, as help shows it, with the options it takes from `commands.ts`'s. */
  spec: CliCommand
  run(args: string[], context: CommandContext): Promise<number>
}

/** What a command an app adds gets from the CLI it runs in. */
export type CommandContext = {
  flags: Flags
  out: (text: string) => void
  usage: (message: string) => Error
  portFlag: () => number | undefined
  connection: typeof connection
  client: () => Board
  openBrowser: (url: string) => void
}

/**
 * The CLI an app runs: its name, as help, usage, and errors say it (`board`, `vercel board`),
 * and its own commands.
 */
export type App = {
  name: string
  commands: Record<string, Command>
  /**
   * With no board URL, it talks to the team's board in Vercel's API even outside a Vercel project:
   * your login's team, as `vercel board` does. Without it, only in one (or with `--scope`).
   */
  teamBoard?: boolean
  /** Shows a failure as this app shows its own; without it, the CLI prints `error: …`, or with `--json`, its JSON document. */
  onError?: (failure: Failure, mode: { json: boolean }) => void
  /** Shows a warning, outside `--json` (where it's in the result's `warnings`); without it, the CLI prints `warning: …`. */
  onWarning?: (warning: Warning) => void
  /**
   * Your Vercel login, asked for only when a request needs it: the app's own, refreshed when it's
   * asked. It's who every command runs as, wherever the app runs: nothing the environment holds
   * goes ahead of it, a deployment's own token and `BOARD_TOKEN` included.
   */
  login?: () => Promise<string>
  /**
   * A Vercel token someone passed the app for this run (`vercel board --token`): the login to use
   * in place of `login`. Board sends it itself, as a Bearer token, never through `fetch`.
   */
  token?: string
  /**
   * How board's requests to Vercel's API go with that login: the app's own fetch, which adds the
   * login's credentials (a DPoP proof, say). Without it, board sends the login as a Bearer token.
   */
  fetch?: typeof fetch
  /**
   * The team whose board to use when `--scope` names none, as the app resolves its own (its link,
   * its saved team), asked for only when a request needs it. Null is your login's default team.
   */
  team?: () => Promise<string | null>
}

type Flags = ReturnType<typeof parseAll>['values']

// What one run parsed, which every command reads. A process runs one command at a time.
let app: App = { name: 'board', commands: {} }
let flags = {} as Flags
let positionals: string[] = []
/** Every option as it was typed, in order: what reads principal flags and the modifiers after each. */
let ordered: OptionToken[] = []
/** The command this run runs, by its own name, and what follows it: what a failure says it was doing. */
let current: { command: string | undefined; args: string[] } = { command: undefined, args: [] }
/** What this run was given, as typed: what a recovery runs again, with what it lacked. */
let typed: string[] = []
/** What this run's writes had to say, for its JSON result. */
let warnings: Warning[] = []
/** The board this run reached by its URL, for a failure to name. */
let reached: string | null = null
/** The team whose default board this run reached, nothing naming one of its boards: `--scope`'s, or the one the environment finds. */
let teamDefault: { team: string | undefined } | null = null
/** Where the credential this run sent came from, as `whoami` says it, for a refusal to say which to replace. */
let sent: () => string | null = () => null
/** How long the message text this run sends is, for a backend's refusal of it to say what to do instead. */
let sentLength = 0

/**
 * The help `words` ask for: a command's page when they name one (`read`, `sources read`), or with
 * none, every command. A word that names no command is unknown, as it is without `--help`.
 */
function help(words: readonly string[] = []): string {
  const own = Object.values(app.commands).map((command) => command.spec)
  const path = commandPath(words, [...commands, ...own])
  if (path) return commandHelp(app.name, path)
  if (words[0] !== undefined && words[0] !== 'help') throw unknownCommand(words[0])
  return rootHelp({ name: app.name, commands: own }, VERSION)
}

/** How messages name this CLI: `vb` for the standalone one, as they always have, or the app's own name. */
const named = () => (app.name === 'board' ? 'vb' : app.name)

/** The commands that take their text as an argument, where text that starts with `-` goes after `--`. */
const TEXT = new Set(['post', 'reply', 'edit', 'schedule'])

/** Parses `argv` for this run, or throws what's wrong with it. */
function parse(argv: string[]) {
  const args = withMentions(argv)
  const word = commandWord(args)
  current = { command: word, args: [] }
  const removed = removedCommand(word ?? '')
  if (removed) throw removed
  try {
    const table = optionsFor(word)
    const parsed = parseArgs({ args: markAttachmentId(args), allowPositionals: true, options: table }) as ReturnType<typeof parseAll>
    ordered = parseArgs({ args: markAttachmentId(args), allowPositionals: true, options: table, tokens: true }).tokens.flatMap((token) =>
      token.kind === 'option' ? [{ name: token.name, value: token.value }] : [],
    )
    flags = parsed.values
    positionals = parsed.positionals.map((arg) => (arg.startsWith(MARK) ? arg.slice(MARK.length) : arg))
  } catch (error) {
    throw parseFailure(error as Error & { code?: string }, argv, word)
  }
  // An option only another command takes would be dropped without a word (`edit --attach`): it's unknown here too.
  const known = specOf(word) && new Set(optionsOf(word))
  const foreign = known && ordered.find((option) => !known.has(option.name))
  if (foreign) throw foreignOption(foreign.name, word!)
  // What was found is what runs. A command's own reading of an option can leave another word first
  // (`--claim delete tasks`: a value until `tasks` is found, none after), and whoever screened the
  // command, as vb() does for the ones it refuses, screened the one found.
  if (canonical(positionals[0]) !== word) throw misplaced(args, word)
}

/**
 * An option that has another name now, `--file`: passing the old one says so, as a command that's
 * gone does. Where the old one has no `--file` to become (one task's text, a schema written
 * inline), it says where that goes instead.
 */
function renamedOption(name: string, word: string | undefined, argv: string[]): Failed | undefined {
  // Only where the old option was: anywhere else its name is as unknown as any, and --file may
  // be no option there, or another thing (a claim has none, and a grant's is its grants).
  const creates = word !== undefined && argv[argv.indexOf(word) + 1] === 'create'
  if (name === 'text-file' && word === 'tasks' && creates)
    return usage('--text-file is gone from tasks create.', { reason: 'unknown_option', next: [{ instruction: 'Pass the text, or - to read it from stdin: --file there is a plan of several' }] })
  if (name === 'schema' && word === 'schemas' && creates) {
    // What it held says which it is now: a file as @<path> and stdin as - are --file's, and JSON written inline is --data's.
    const at = argv.findIndex((arg) => arg === '--schema' || arg.startsWith('--schema='))
    const joined = argv[at]?.startsWith('--schema=') ?? false
    const given = joined ? argv[at]!.slice('--schema='.length) : argv[at + 1]
    if (at === -1 || given === undefined) return usage('--schema is --file now, or --data for JSON written inline.', { reason: 'unknown_option' })
    const [option, value] = given === '-' ? ['--file', '-'] : given.startsWith('@') ? ['--file', given.slice(1)] : ['--data', given]
    const again = [...argv.slice(0, at), option, value, ...argv.slice(at + (joined ? 1 : 2))]
    return usage(`--schema is ${option} now.`, { reason: 'unknown_option', next: [{ instruction: `Run it with ${option}`, argv: [...cli(), ...again] }] })
  }
  const was = (name === 'text-file' && word !== undefined && TEXT.has(word)) || (name === 'tasks-file' && word === 'tasks' && creates)
  if (!was) return undefined
  const again = argv.map((arg) => (arg === `--${name}` ? '--file' : arg.startsWith(`--${name}=`) ? `--file=${arg.slice(name.length + 3)}` : arg))
  return usage(`--${name} is --file now.`, { reason: 'unknown_option', next: [{ instruction: 'Run it with --file', argv: [...cli(), ...again] }] })
}

/** An option `word` doesn't take: what to do instead, where there's something better to say than that. */
function foreignOption(name: string, word: string): Failed {
  const renamed = renamedOption(name, word, typed)
  if (renamed) return renamed
  if (name === 'text' && TEXT.has(word)) return usage(`--text is a filter for read, tail, and wait. ${word} takes its text as an argument, in quotes.`)
  if (name === 'sync' && word === 'schedule') return usage("Can't use --sync with schedule. A schedule posts where you point it.")
  if (name === 'attach' && word === 'edit') return usage("edit can't attach files: reply with the file instead.", { reason: 'unknown_option', next: [{ instruction: 'Reply with it', argv: [...cli(), 'reply', '<ID>', '<TEXT>', '--attach', '<FILE>'] }] })
  return usage(`Unknown option --${name} for ${named()} ${word}.`, { reason: 'unknown_option', next: [{ instruction: 'See all options', argv: [...cli(), word, '--help'] }] })
}

/** An option `word`'s command reads its own way, written before the command: it goes after it. */
function misplaced(args: string[], word: string | undefined): Failed {
  const at = args.indexOf(word ?? '')
  const before = (at === -1 ? args : args.slice(0, at)).filter((arg) => arg.startsWith('-'))
  const own = optionsFor(word)
  const option = before.map((arg) => arg.replace(/=.*$/, '')).find((arg) => arg.startsWith('--') && own[arg.slice(2) as keyof typeof own] !== OPTIONS[arg.slice(2) as keyof typeof OPTIONS])
  return usage(`Put ${option ?? 'its options'} after ${word}.`, { reason: 'misplaced_option' })
}

/** What the parser rejected, as misuse: an unknown option (with the likeliest one meant), or an option without its value. */
function parseFailure(error: Error & { code?: string }, argv: string[], word: string | undefined): Failed {
  const option = error.message.match(/--[a-z][\w-]*/)?.[0] ?? /'(-[^' ,]+)/.exec(error.message)?.[1]
  if (error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && option) {
    // One argument can hold several words (a shell variable that wasn't split): it's that argument
    // that's unknown, not the option it starts with, which may well be real. The parser names a long
    // one whole, and only a short group's start (`- `, `-z`), and nothing after `--` is an option.
    const token = /^Unknown option '(.*?)'\. /.exec(error.message)?.[1]
    const dash = argv.indexOf('--')
    const options = dash === -1 ? argv : argv.slice(0, dash)
    const spaced = token === undefined ? undefined : options.find((arg) => /\s/.test(arg) && (token.startsWith('--') ? arg === token : arg.startsWith(token)))
    const renamed = !spaced && option.startsWith('--') ? renamedOption(option.slice(2), word, argv) : undefined
    if (renamed) return renamed
    const guess = !spaced && option.startsWith('--') ? closest(option.slice(2), optionsOf(word)) : undefined
    const next: Recovery[] = [{ instruction: 'See all options', argv: [...cli(), ...(word ? [word] : []), '--help'] }]
    const unknown = spaced ?? option
    const at = argv.indexOf(unknown)
    if (word && TEXT.has(word) && at !== -1) {
      // The text goes first after the `--` there is, or a new one.
      const rest = [...argv.slice(0, at), ...argv.slice(at + 1)]
      const dash = rest.indexOf('--')
      const text = dash === -1 ? [...rest, '--', unknown] : [...rest.slice(0, dash + 1), unknown, ...rest.slice(dash + 1)]
      next.push({ instruction: 'Or, for text that starts with -, put it after --', argv: [...cli(), ...text] })
    }
    const where = `${named()}${word ? ` ${word}` : ''}`
    return usage(`Unknown option ${spaced ? JSON.stringify(spaced) : option} for ${where}.${guess ? ` Did you mean --${guess}?` : ''}`, { reason: 'unknown_option', next })
  }
  if (error.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' && option) return usage(`${option} needs a value.`, { reason: 'missing_value' })
  return usage(sentence(error.message))
}

/** The options `word`'s command takes, its subcommands' and the filters included, and the ones every command takes. */
/** The command `word` names, board's or the app's, as help shows it. */
const specOf = (word: string | undefined): CliCommand | undefined =>
  word === undefined ? undefined : [...commands, ...Object.values(app.commands).map((own) => own.spec)].find((known) => known.name === word)

function optionsOf(word: string | undefined): string[] {
  const command = specOf(word)
  const own = command ? [command, ...(command.subcommands ?? [])].flatMap((c) => [...c.options, ...(c.filters ? filterOptions : [])]) : []
  return [...own, ...globalOptions].map((option) => option.name)
}

/** `text` as a sentence: a capital first, and a period last. */
const sentence = (text: string) => {
  const trimmed = text.trim()
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}${/[.!?]$/.test(trimmed) ? '' : '.'}`
}

/**
 * Where a run's output goes and its files come from: the terminal and this machine's, or for
 * `vb()`, its caller's, with the board handle it runs on.
 */
export type Io = {
  write(chunk: string | Uint8Array): void
  error(chunk: string): void
  /** A file's bytes, for `--attach`; null when there's no such file. */
  readFile(path: string): Promise<Uint8Array | null>
  /** Saves a file, for `download`; with `exclusive`, fails with `EEXIST` rather than replace one that's there. */
  writeFile(path: string, data: Uint8Array, options?: { exclusive?: boolean }): Promise<void>
  /** What `-` reads. */
  stdin(): Promise<string>
  /** Stops `tail` and `wait`, and fails any other command its requests haven't finished, as `board`'s handle ends them; without one, Ctrl-C stops `tail` and `wait`. */
  signal?: AbortSignal
  /** The handle to run on, in place of the one the environment and `--url` find. */
  board?: Board
  /** What `board`'s task claims are kept by, where `board` is made for one call: the handle its caller holds. */
  claimsOf?: object
  /** Where `board`'s task claims are kept, for the profile a run writes as, in place of memory: a store that outlives the call, the process, or the instance. */
  claims?: (profile: string | null) => Claims
  /** The token `board`'s claims take, the caller's own: with it, a claim needs no store, as any call that has the token settles it. */
  claimToken?: string
  /** Whether a person reads it at a terminal: JSON is indented there. */
  tty?: boolean
}

const TERMINAL: Io = {
  write: (chunk) => void process.stdout.write(chunk),
  error: (chunk) => void process.stderr.write(chunk),
  async readFile(path) {
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) return null
    if (info.size > DIRECT_UPLOAD_BYTES_MAX) throw tooLarge(path)
    return new Uint8Array(await readFile(path))
  },
  writeFile: (path, data, { exclusive = false } = {}) => writeFile(path, data, { flag: exclusive ? 'wx' : 'w' }),
  stdin: readStdin,
  tty: process.stdout.isTTY === true,
}
let io: Io = TERMINAL

// What a person reads can't drive their terminal; what a program reads is byte for byte what the board said.
const out = (text: string) => io.write(`${terminalText(text)}\n`)
/** `--json`'s result: one document, with what the run's writes warned about, indented at a terminal. */
const result = (value: object) => io.write(`${JSON.stringify(warnings.length ? { ...value, warnings } : value, null, io.tty ? 2 : undefined)}\n`)
/** One line of a JSON stream (`tail`): compact, wherever it goes. */
const line = (value: object) => io.write(`${JSON.stringify(value)}\n`)

/** A message's ID as you'd write it: `#812` or `812`. It's passed to the board as it is. */
function messageId(value: string | undefined, what = 'message ID'): string {
  const id = value?.replace(/^#/, '') ?? ''
  if (value === undefined) throw usage(`Missing the ${what}.`, { reason: 'missing_arguments' })
  if (!/^[^\s/]+$/.test(id)) throw usage(`${value} isn't a ${what}.`)
  return id
}

/** Characters that change how a name reads without showing: invisible formatting (bidi overrides, zero-width), and line and paragraph separators. */
const INVISIBLE = /[\p{Cf}\u2028\u2029]/gu

/** A download that would replace a file, which only a path given to download may. */
const exists = (path: string) =>
  usage(`${path} is already here, and download keeps it: give download a path to save the attachment elsewhere.`, {
    reason: 'file_exists',
    next: [{ instruction: 'Save it under another name', argv: [...cli(), 'download', '<ID>', '<PATH>'] }],
  })

/** A file over what a direct upload takes. */
const tooLarge = (path: string) =>
  new Failed({ class: 'limit', reason: 'payload_too_large', message: `Can't attach ${path}. It's over ${DIRECT_UPLOAD_BYTES_MAX / 1024 / 1024} MB, the most an attachment can be.` })

/** Whether an ID goes in and out bare: a number, or one Vercel's API hands out (`msg_…`), a message even where a channel has its name. */
const bareId = (value: string) => /^\d+$/.test(value) || isApiMessageId(value)

/** Whether an argument names a message rather than a channel: `#<id>`, or an ID that goes bare. */
const isMessageRef = (value: string) => /^#[^\s/]+$/.test(value) || bareId(value)

/** A message's ID as it's passed back: bare when it goes bare, `#<id>` when it could be a channel's name. */
const messageRef = (id: string) => (bareId(id) ? id : `#${id}`)

/**
 * A thread's replies as `--after` and `--label` narrow them, from the replies its read answered: those after the
 * message `--after` names, which is one of the thread's, and those that wear every `--label`, or whose root does.
 */
function narrowedReplies(thread: { message: MessageView; replies: MessageView[] }, cut: { after: boolean }): MessageView[] {
  let replies = thread.replies
  if (flags.after !== undefined) {
    const id = flags.after.replace(/^#/, '')
    const at = [thread.message, ...replies].findIndex((message) => message.id === id)
    // A board asked for the replies after it answered them alone: one from before that answers the whole thread, cut here.
    if (at === -1 && cut.after) throw usage(`--after ${flags.after} isn't a message of this thread. On one thread, it takes one of its messages.`)
    if (at !== -1) replies = replies.slice(at)
  }
  const labels = (flags.label ?? []).map((label) => {
    const eq = label.indexOf('=')
    return eq === -1 ? { key: label, values: null } : { key: label.slice(0, eq), values: label.slice(eq + 1).split('|') }
  })
  const wears = (message: MessageView, { key, values }: (typeof labels)[number]) =>
    Object.hasOwn(message.labels, key) && (values === null || values.includes(message.labels[key]!))
  return replies.filter((reply) => labels.every((label) => wears(reply, label) || wears(thread.message, label)))
}

/** `--if-revision N`, as an edit or a delete takes it. */
function ifRevision(): { revision?: number } {
  const given = flags['if-revision']
  if (given === undefined) return {}
  if (!/^[1-9]\d{0,15}$/.test(given)) throw usage(`--if-revision takes the message's revision, a number, and ${given} isn't one.`)
  return { revision: Number(given) }
}

function labelPairs(
  values: string[] | undefined,
  wrong = "Labels look like key=value, and {value} isn't one.",
  /** What to say of `key=`, a label with no value, where one can't be meant: none lets it through, as `--if key=` matches a label that has none. */
  empty: string | null = '{value} has no value: a label needs one.',
): Record<string, string> {
  const pairs: Record<string, string> = {}
  for (const value of values ?? []) {
    const at = value.indexOf('=')
    if (at <= 0) throw usage(wrong.replace('{value}', value))
    // `owner=` would set a label with no value, which still counts as set.
    if (at === value.length - 1 && empty !== null) throw usage(empty.replace('{value}', value).replace('{key}', value.slice(0, at)))
    pairs[value.slice(0, at)] = value.slice(at + 1)
  }
  return pairs
}

/**
 * A post or reply takes one text. What follows it was meant to be part of the message, or a label,
 * and would be dropped without a word: say so, and how each is written.
 */
function oneText(command: string, target: string, extra: string[]) {
  const [first] = extra
  if (first === undefined) return
  if (/^[\w.-]+=/.test(first))
    throw usage(`${first} looks like a label, and ${command} takes labels with --label.`, {
      next: [{ instruction: 'Label it as you post it', argv: [...cli(), command, target, '<TEXT>', '--label', first] }],
    })
  throw usage(
    first === '-'
      ? `${command} takes one text, and - (stdin) is a second. For a long message, pass - alone as the text: it has no title.`
      : `${command} takes one text, and ${first.length > 40 ? `${first.slice(0, 40)}…` : first} is one too many. Quote the whole message as one argument: it has no title.`,
  )
}

/**
 * A message's text: the argument, stdin for `-`, or the file `--file` names (`-` for stdin).
 * `optional` when the message can go without, as one with `--attach` files can. `missing` is
 * what's said when there's none: a task's `--file` holds a plan, so it says so itself.
 */
async function text(value: string | undefined, { optional = false, missing = "Missing the message's text: pass it, - to read it from stdin, or --file <path>." } = {}): Promise<string> {
  const file = flags.file
  if (file !== undefined) {
    if (value !== undefined) throw usage("Can't use --file with text: a message has no title, so its whole text comes from one or the other.")
    if (file === '-') return (await io.stdin()).replace(/\n$/, '')
    const data = await io.readFile(file).catch((error: unknown) => {
      // A file too big to attach is far too long for a message: say it of the text, not of --attach.
      if (!(error instanceof Failed) || error.failure.reason !== 'payload_too_large') throw error
      throw new Failed({ class: 'limit', reason: 'payload_too_large', message: `Can't use ${file} as the text. A message's text is at most ${MESSAGE_TEXT_MAX.toLocaleString('en-US')} characters.` })
    })
    if (!data) throw usage(`Can't read ${file}. There's no such file.`, { reason: 'file_not_found', next: [] })
    return new TextDecoder().decode(data).replace(/\n$/, '')
  }
  if (value === undefined) {
    if (optional) return ''
    throw usage(missing, { reason: 'missing_arguments' })
  }
  if (value !== '-') return value
  return (await io.stdin()).replace(/\n$/, '')
}


/** Uploads each `--attach` file, reading them all before sending any. */
async function attachments(board: ReturnType<typeof client>): Promise<Attachment[]> {
  const paths = flags.attach ?? []
  // The board takes at most this many on a message: say so before uploading any, not after uploading them all.
  if (paths.length > ATTACHMENTS_PER_MESSAGE_MAX)
    throw usage(`Can't attach ${paths.length} files. A message carries at most ${ATTACHMENTS_PER_MESSAGE_MAX}.`, {
      reason: 'too_many_attachments',
      next: [{ instruction: `Attach the rest in another reply, or bundle them into one file (a zip or tarball)`, argv: [...cli(), 'reply', '<ID>', '<TEXT>', '--attach', '<FILE>'] }],
    })
  const files: { path: string; data: Uint8Array }[] = []
  for (const path of paths) {
    const data = await io.readFile(path)
    // `--attach -` is someone piping the message's text: stdin is the text's, as `-` or `--file -`.
    if (!data && path === '-')
      throw usage("Can't attach -: stdin is for the message's text. Pass - as the text to read it from stdin.", {
        reason: 'file_not_found',
        next: [{ instruction: 'Post text from stdin', argv: [...cli(), current.command ?? 'post', '<channel|id>', '-'] }],
      })
    if (!data) throw usage(`Can't attach ${path}. There's no such file.`, { reason: 'file_not_found', next: [] })
    if (data.byteLength > DIRECT_UPLOAD_BYTES_MAX) throw tooLarge(path)
    files.push({ path, data })
  }
  const uploaded: Attachment[] = []
  for (const { path, data } of files) uploaded.push(await board.upload({ data: new Uint8Array(data), name: basename(path) }))
  return uploaded
}

/**
 * Whether `value` is a schedule's own ID and not a message's: `s12` on a local board, `sch_…` on
 * Vercel's. A message's is a number or `msg_…`, so neither is ever one.
 */
export const isScheduleId = (value: string): boolean => /^(?:s\d+|sch_\S+)$/i.test(value)

/** A schedule's ID as the board gave it: `s12`, or `sch_…` on Vercel's board. */
function scheduleId(value: string | undefined): string {
  if (value === undefined) throw usage('Missing the schedule ID, like s12.', { reason: 'missing_arguments' })
  if (!/^[^\s/]+$/.test(value)) throw usage(`${value} isn't a schedule ID like s12.`)
  return value
}

/** A grant's ID as the board gave it: `g3`, or another board's own. */
function grantId(value: string | undefined): string {
  if (value === undefined) throw usage('Missing the grant ID, like g3.', { reason: 'missing_arguments' })
  if (!/^[^\s/]+$/.test(value)) throw usage(`${value} isn't a grant ID like g3.`)
  return value
}

/** What a grant's flags say, or the misuse in them. */
function grantFlags<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof GrantMisuse) throw usage(error.message, error.next ? { next: error.next } : {})
    throw error
  }
}

/** `--lock-me-out`, as a grant write takes it: go ahead with a change this caller couldn't take back. */
const lockMeOut = () => (flags['lock-me-out'] ? { lockMeOut: true } : {})

/** Whoever runs this, as the flags that name them in a grant, once a lockout has asked: null when no flag does. */
let self: string[] | null = null

/** The flags that name a caller in a grant: a person, a project's deployment where it runs, an app, or a repository's runs. */
function selfFlags({ principal, handle }: Pick<Me, 'principal' | 'handle'>): string[] | null {
  const [source, kind, ...rest] = principal.split(':')
  if ((source === 'vercel' || source === 'local') && kind === 'user' && rest.length > 0) return ['--user', rest.join(':')]
  if (source === 'vercel' && kind === 'project' && rest.length === 2) return ['--project', rest[0]!, '--environment', rest[1]!]
  if (source === 'vercel' && kind === 'app' && rest.length > 0) return ['--app', rest.join(':')]
  if (source === 'github' && kind === 'repo' && /^[^/\s]+\/[^/\s]+$/.test(handle)) return ['--github', handle]
  return null
}

/** A grant write's refusal, on its way out: a lockout's way out names whoever runs this, which is a read away. */
async function namingSelf(error: unknown): Promise<never> {
  if ((error as { code?: unknown } | null)?.code === 'grant_lockout') self = await client().me().then(selfFlags, () => null)
  throw error
}

/** The options that say which board this run acts on, as it was given them: a command suggested for the same board carries them. */
const onSameBoard = (): string[] => [
  ...(flags.url !== undefined ? ['--url', flags.url] : []),
  ...(flags.scope !== undefined || flags.team !== undefined ? ['--scope', (flags.scope ?? flags.team)!] : []),
  ...(flags.name !== undefined ? ['--name', flags.name] : []),
]

/**
 * The ways out of a grant change the board refused as a lockout. A new grant: first, the grant
 * that keeps manage, for whoever runs this, at each pattern it names, after which this one is no
 * lockout. Any of them: the same command, told to go ahead.
 */
function lockoutRecoveries(): Recovery[] {
  const [verb] = current.args
  const anyway: Recovery = { instruction: verb === 'create' ? 'Make it anyway' : verb === 'revoke' ? 'Revoke it anyway' : 'Update it anyway', argv: rerun('--lock-me-out') }
  if (verb !== 'create') return [{ instruction: 'Keep manage there first, with another grant that names you' }, anyway]
  // A file's grants go together: the one that keeps its maker in belongs in it.
  if (flags.file !== undefined) return [{ instruction: 'Keep manage there yourself: add a grant to the file that names you, with all there' }, anyway]
  const all = patternsIn(flags.can ?? []).map((pattern) => `${pattern}=all`).join(';')
  // Whoever no grant flag names (the board's own code, another issuer's token) is told what to make.
  return [self ? { instruction: 'Keep manage there yourself first', argv: [...cli(), 'grants', 'create', ...self, '--can', all, ...onSameBoard()] } : { instruction: `Keep manage there yourself first, with a grant that names you: --can '${all}'` }, anyway]
}

/** The grants a `--file` holds: a JSON array, from the file or from stdin for `-`, each as `createGrants` takes one. The board checks what's in them. */
async function grantsFrom(path: string): Promise<GrantInput[]> {
  const where = path === '-' ? 'stdin' : path
  let source: string
  if (path === '-') source = await io.stdin()
  else {
    const data = await io.readFile(path)
    if (!data) throw usage(`Can't read ${path}. There's no such file.`, { reason: 'file_not_found', next: [] })
    source = new TextDecoder().decode(data)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw usage(`${where} isn't JSON.`)
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((grant) => typeof grant !== 'object' || grant === null || Array.isArray(grant)))
    throw usage(`${where} holds no grants. It's a JSON array of them: [{"principals": [{"kind": "everyone"}], "can": {"ci/": ["read"]}}].`)
  if (parsed.length > GRANT_BATCH_MAX) throw usage(`${where} holds ${parsed.length} grants, and one write makes ${GRANT_BATCH_MAX} at most.`)
  return parsed as GrantInput[]
}

/** Refuses the principal flags `verb` doesn't take: plain ones on update, `--add-` and `--remove-` ones elsewhere. */
function onlyPrincipalFlags(verb: 'create' | 'update' | 'explain') {
  for (const { name } of ordered) {
    const kind = name.replace(/^(add|remove)-/, '')
    if (!(KINDS as readonly string[]).includes(kind)) continue
    const prefixed = kind !== name
    if (verb === 'update' && !prefixed) throw usage(`grants update adds and removes principals: --add-${kind} or --remove-${kind}, not --${kind}.`)
    if (verb !== 'update' && prefixed) throw usage(`--${name} is for grants update: grants ${verb} names principals as --${kind}.`)
  }
}

/** A time flag: anything `Date` reads, as ISO. */
function instant(flag: string, value: string): string {
  const time = new Date(value)
  if (Number.isNaN(time.getTime())) throw usage(`--${flag} takes a time like 2026-10-08T09:00:00Z, and ${value} isn't one.`)
  return time.toISOString()
}

function filters(channel?: string): Filters & { after?: string } {
  return {
    ...(channel ? { channel } : {}),
    ...(flags.re ? { re: messageId(flags.re) } : {}),
    ...(flags.by ? { by: flags.by.replace(/^@/, '') } : {}),
    ...(flags.mentions ? { mentions: flags.mentions.replace(/^@/, '') } : {}),
    ...(flags.label?.length ? { label: flags.label } : {}),
    ...(flags.source ? { from: flags.source } : {}),
    ...(flags.text ? { text: flags.text } : {}),
    ...(flags.after !== undefined ? { after: flags.after.replace(/^#/, '') } : {}),
  }
}

/**
 * The board the environment points at. With none, the team's board for an app that has one
 * (null), or else how to point at one, with the commands this app has.
 */
function configuredUrl(): string | null {
  try {
    return boardUrl()
  } catch (error) {
    if (!(error instanceof BoardError) || error.code !== 'no_board') throw error
    // In a Vercel project, its team's board.
    if (app.teamBoard || process.env.VERCEL_ORG_ID || vercelProjectFile()) return null
    throw new Failed({
      class: 'missing_input',
      reason: 'missing_scope',
      actionRequired: true,
      message: "No board to use. Nothing sets one, and this directory isn't in a Vercel project.",
      next: [
        { instruction: "Use a team's board", argv: rerun('--scope', '<TEAM>') },
        { instruction: 'Or a board at a URL', argv: rerun('--url', '<URL>') },
      ],
    })
  }
}

/**
 * What a message says: its text, or with `--schema`, a block of that schema and nothing else, whose
 * JSON the text is, from wherever text comes (the argument, stdin, `--file`).
 */
async function content(value: string | undefined, options: { optional?: boolean } = {}): Promise<string> {
  const said = await given(value, options)
  sentLength = said.length
  return said
}

async function given(value: string | undefined, options: { optional?: boolean }): Promise<string> {
  const schema = flags.schema
  if (schema === undefined) return text(value, options)
  if (!parseSchemaId(schema)) throw usage(`${schema} doesn't name a schema. One is name@version, like sandbox@1.`)
  let data: unknown
  try {
    data = JSON.parse(await text(value))
  } catch (error) {
    if (error instanceof Failed) throw error
    throw usage(`With --schema, the text is ${schema}'s JSON, and this isn't JSON.`)
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw usage(`With --schema, the text is a JSON object, like {"id":"sbx-123"}.`)
  return block(schema, data as Record<string, unknown>)
}

/** A schema's JSON Schema: from the file `--file` names, or stdin for `-`, or written inline as `--data`. */
async function definition(): Promise<Record<string, unknown>> {
  const { file, data: inline } = flags
  if (file !== undefined && inline !== undefined) throw usage('--file and --data both give the JSON Schema: pass one.')
  if (file === undefined && inline === undefined) throw usage('Missing its JSON Schema: --file <path>, - for stdin, or --data <json>.', { reason: 'missing_arguments' })
  let source: string
  if (inline !== undefined) source = inline
  else if (file === '-') source = await io.stdin()
  else {
    const data = await io.readFile(file!)
    if (!data) throw usage(`Can't read ${file}. There's no such file.`, { reason: 'file_not_found', next: [] })
    source = new TextDecoder().decode(data)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    if (inline === undefined) throw usage(`${file === '-' ? 'stdin' : file} isn't JSON.`)
    // A path, or - for stdin, is the likeliest slip: those are --file's.
    throw usage(`--data takes the JSON itself, and ${inline.length > 40 ? `${inline.slice(0, 40)}…` : inline} isn't JSON.`, { next: [{ instruction: 'A file, or - for stdin, goes in --file' }] })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw usage('A schema is a JSON object: {"type":"object", …}.')
  return parsed as Record<string, unknown>
}
/** A board that predates what this run asked of it. */
const outdated = (message: string) =>
  new Failed({
    class: 'platform',
    reason: 'board_outdated',
    message: `${message} It's older than this CLI.`,
    next: [{ instruction: 'Update @vercel/board where the board is deployed' }],
  })

/** A message ID as a failure names it: `#812`. */
const ref = (value: string | undefined) => (value === undefined ? 'a message' : `#${value.replace(/^#/, '')}`)

/** What this run was doing, as a failure's headline says it: `post to dev`, `reply to #812`. */
function doing(): string {
  const { command, args } = current
  const [a, b, c] = args
  const message = a !== undefined && isMessageRef(a)
  switch (command) {
    case 'read':
      return a === undefined ? 'read the board' : /^https?:\/\//i.test(a) ? 'read that link' : `read ${message ? ref(a) : a}`
    case 'post':
      return message ? `reply to ${ref(a)}` : `post to ${a ?? 'a channel'}`
    case 'reply':
      return `reply to ${ref(a)}`
    case 'edit':
    case 'delete':
    case 'label':
      return `${command} ${ref(a)}`
    case 'react':
      return `react to ${ref(a)}`
    case 'typing':
      return `show typing in ${ref(a)}`
    case 'sync':
      return b === undefined ? `list where ${ref(a)} is synced` : `sync ${ref(a)} with ${b}`
    case 'schedule':
      return a === 'cancel' ? `cancel schedule ${b}` : `schedule a message in ${message ? ref(a) : (a ?? 'a channel')}`
    case 'channels':
      return a === 'create' ? `create ${b ?? 'the channel'}` : 'list channels'
    case 'schedules':
    case 'actors':
      return `list ${command}`
    case 'tasks': {
      if (a === undefined || !TASK_VERBS.has(a)) return a === undefined ? 'list tasks' : `list tasks in ${a}`
      const one = b === undefined ? 'a task' : `task ${ref(b)}`
      // `run` fails as its claim does, before its command starts, or as what it settles with after.
      if (a === 'claim' || a === 'run') return flags.ready ? `claim a task in ${b ?? 'a channel'}` : `claim ${one}`
      if (a === 'create' && flags.file !== undefined) return `create tasks in ${b ?? 'a channel'}`
      if (a === 'create') return b !== undefined && isMessageRef(b) ? `make ${ref(b)} a task` : `create a task in ${b ?? 'a channel'}`
      if (a === 'renew') return `renew the claim on ${one}`
      if (a === 'needs') return `change what ${one} needs`
      return `${a} ${one}`
    }
    case 'grants':
      return a === 'create' ? (flags.file !== undefined ? 'create the grants' : 'create the grant') : a === 'update' ? `update grant ${b}` : a === 'explain' ? `explain ${b ?? 'the channel'}` : a === 'revoke' ? `revoke grant ${b}` : 'list grants'
    case 'schemas':
      return a === 'create' ? `register schema ${b ?? ''}`.trimEnd() : a === 'inspect' ? `read schema ${b ?? ''}`.trimEnd() : 'list schemas'
    case 'sources':
      return b === undefined ? 'list sources' : `${b} ${c ?? 'it'} on ${a}`
    case 'download':
      return `download ${a ?? 'the attachment'}`
    case 'inbox':
      return `read ${a}'s inbox`
    case 'tail':
      return `follow ${a ?? 'the board'}`
    case 'wait':
      return `wait on ${a ?? 'the board'}`
    case 'whoami':
      return 'reach the board'
    case 'conformance':
      return 'check the board'
    default:
      return `run ${named()}${command ? ` ${command}` : ''}`
  }
}

/** The commands whose first argument is always a message. */
const ON_MESSAGE = new Set(['reply', 'edit', 'delete', 'react', 'label', 'typing', 'sync', 'schedules'])

/** What a 404 means this run couldn't find, when its arguments name it: `message #812`. */
function missing(): string | undefined {
  const { command = '', args } = current
  const [a, b] = args
  if (a === undefined) return undefined
  if (command === 'read' && /^https?:\/\//i.test(a)) return "that link's message on this board"
  if (ON_MESSAGE.has(command) || (['read', 'post', 'schedule'].includes(command) && isMessageRef(a))) return `message ${ref(a)}`
  if (command === 'schedule' && a === 'cancel' && b !== undefined) return `schedule ${b}`
  // A task is its thread: one that isn't there is a message that isn't.
  if (command === 'tasks' && TASK_VERBS.has(a) && b !== undefined && isMessageRef(b)) return `message ${ref(b)}`
  if (command === 'grants' && (a === 'revoke' || a === 'update') && b !== undefined) return `grant ${b}`
  if (command === 'schemas' && a === 'inspect' && b !== undefined) return `schema ${b}`
  if (command === 'download') return `attachment ${a}`
  return undefined
}

/**
 * What `error` means for this run, in the Vercel CLI's terms. What the handle raised itself says
 * what and why, and its hint what fixes it. What a board answered is said by what this run was
 * doing, with the board's words under it and in `data`, never in what to run: a board can answer
 * with any code, the handle's own included.
 */
function failureOf(error: unknown): Failure {
  if (error instanceof Failed) return error.failure
  const message = error instanceof Error ? error.message : String(error)
  const { code, status, hint, origin, retryAfter } = error as { code?: unknown; status?: unknown; hint?: unknown; origin?: unknown; retryAfter?: unknown }
  // Not the board's or the handle's: the system's (a file it couldn't write), or a bug.
  if (typeof code !== 'string' || typeof status !== 'number')
    return { class: 'unknown', reason: 'unexpected_error', message: `Failed to ${doing()}.`, details: [message] }
  const wait = typeof retryAfter === 'number' && Number.isInteger(retryAfter) && retryAfter >= 0 ? retryAfter : undefined
  const said = { error: { code, message, status, ...(typeof hint === 'string' ? { hint } : {}), ...(wait !== undefined ? { retryAfter: wait } : {}) } }
  if (origin === 'handle') {
    const fix: Recovery[] = typeof hint === 'string' ? [{ instruction: hint }] : []
    const own = (kind: Failure['class'], reason: string, next: Recovery[] = fix): Failure => ({
      class: kind, reason, message, ...(next.length ? { next } : {}), data: said,
    })
    switch (code) {
      case 'not_logged_in':
        return { class: 'auth', reason: 'login_required', message: "You're not logged in to Vercel.", next: [{ instruction: 'Log in', argv: ['vercel', 'login'] }], data: said }
      case 'no_access':
        return own('permission', 'permission_denied')
      case 'wrong_project':
        return own('permission', 'wrong_project')
      case 'protected':
        return own('permission', 'deployment_protected')
      case 'no_project':
        return own('platform', 'no_project')
      case 'no_token':
        return own('auth', 'token_unavailable')
      case 'no_board':
        // A person's named board that isn't there, or that they can't see: this command again makes it.
        return own('not_found', 'board_not_found', [{ instruction: 'Check the name, or make it', argv: rerun('--ensure') }])
      case 'board_name_taken':
        return own('conflict', 'board_name_taken')
      case 'board_not_granted':
        return own('permission', 'board_not_granted')
      case 'watchers_need_project':
        return own('permission', 'watchers_need_project')
      case 'missing_team':
        return {
          // A CI log is read widely: this names the option without the command's text.
          ...own('missing_input', 'missing_scope', [
            { instruction: "Use a team's board: add --scope <TEAM_ID>" },
            { instruction: 'Or set VERCEL_ORG_ID to its ID' },
          ]),
          actionRequired: true,
        }
      case 'invalid_board_name':
        return own('usage', 'invalid_arguments', [helpRecovery()])
      case 'too_many_redirects':
        return own('network', 'network_error')
      case 'invalid_duration':
        return own('usage', 'invalid_arguments', [helpRecovery()])
      case 'wrong_audience':
      case 'redirected':
        return own('usage', 'wrong_url')
      case 'too_large':
        return { ...own('limit', 'payload_too_large'), message: `Can't ${doing()}. ${sentence(message)}` }
      case 'no_team':
        return { ...own('platform', 'api_error'), message: "Couldn't tell which team's board to use.", details: [message] }
      case 'upload_failed':
        return { ...own('platform', 'upload_failed'), message: `Failed to ${doing()}.`, details: [message] }
      case 'channel_exists':
        return own('conflict', 'channel_exists')
      case 'channel_granted':
        return own('conflict', 'channel_granted')
      case 'no_own_principal':
        return own('usage', 'no_own_principal')
      case 'port_taken':
        return own('conflict', 'port_taken', [{ instruction: 'Pick another port', argv: [...cli(), current.command ?? 'serve', '--port', '<PORT>'] }])
    }
  }
  // The board's, said by what this run was doing, with its own words under it. Which board it was
  // matters when reaching it is what failed.
  const theirs = (kind: Failure['class'], reason: string, headline: string, next: Recovery[] = []): Failure => ({
    class: kind,
    reason,
    message: headline,
    details: [message],
    ...(reached && ['auth', 'permission', 'network', 'platform'].includes(kind) ? { context: [['Board', reached]] as [string, string][] } : {}),
    ...(next.length ? { next } : {}),
    data: said,
  })
  const specific = (fallback: string) => (/^[a-z]+(_[a-z]+)+$/.test(code) && code !== 'invalid_request' && code !== 'remote_error' ? code : fallback)
  // What a board says about a task, said by what this run was doing, with a way on from here.
  const about = taskFailure(code, status)
  // Where the headline is all the board said (`#812 isn't a task`), its words aren't said twice.
  if (about) return { ...theirs(about.class, code, about.message, about.next), ...(about.whole ? { details: [] } : {}) }
  // A block the board refused, written with --schema: what that schema holds is a read away.
  if (status === 400 && code === 'invalid_block' && flags.schema !== undefined && parseSchemaId(flags.schema))
    return theirs('usage', code, `Can't ${doing()}.`, [{ instruction: `See what ${flags.schema} holds`, argv: [...cli(), 'schemas', 'inspect', flags.schema] }])
  if (status === 400 && code === 'schema_not_found' && current.command !== 'schemas')
    return theirs('usage', code, `Can't ${doing()}.`, [{ instruction: 'See the schemas this board has', argv: [...cli(), 'schemas'] }])
  // Too much text: what it can't hold goes in a file, on a message that can take one (an edit can't).
  // Vercel's API says it as `invalid_message`, which also means empty text: only text over the limit is too long.
  if (status === 400 && (code === 'text_too_long' || (code === 'invalid_message' && sentLength > MESSAGE_TEXT_MAX)))
    return {
      ...theirs('limit', 'payload_too_large', `Can't ${doing()}. A message's text is at most ${MESSAGE_TEXT_MAX.toLocaleString('en-US')} characters.`, [
        // A task's root takes no file, and neither does an edit: the long part goes in a reply that does.
        {
          instruction:
            current.command === 'edit'
              ? 'Keep the edit short, and reply with the long part in a file with --attach'
              : current.command === 'tasks'
                ? 'Keep it short, and reply to the task with the long part in a file with --attach'
                : 'Put the long part in a file and --attach it, with a short summary as the text',
        },
      ]),
      details: [],
    }
  // A limit on the team's boards, which the team's plan sets: no argument fixes it, and the team's own board is still there.
  if (code === 'too_many_boards')
    return theirs(
      'limit',
      code,
      `Can't ${doing()}. The team has all the boards it can.`,
      current.command === 'conformance'
        ? [
            // It refuses the team's board unnamed: another board by its URL, or the team's own by its name, which it posts to and changes the grants of.
            { instruction: 'Check a board by its URL, such as one from vb serve', argv: [...rerunWithout(['--name', '--scope']).filter((arg) => arg !== '--ensure'), '--url', '<URL>'] },
            { instruction: "Or the team's own board, which it posts to and changes the grants of", argv: [...rerunWithout(['--name']).filter((arg) => arg !== '--ensure'), '--name', 'General'] },
          ]
        : flags.name !== undefined
        ? [{ instruction: "Use the team's board instead", argv: rerunWithout(['--name']).filter((arg) => arg !== '--ensure') }]
        : process.env.BOARD_NAME
          ? [{ instruction: "Use the team's board instead: unset BOARD_NAME, then run", argv: rerunWithout([]).filter((arg) => arg !== '--ensure') }]
          : [],
    )
  if (code === 'private_boards_unavailable')
    return theirs('limit', code, `Can't ${doing()}. This team's plan has no private boards.`, [
      { instruction: 'Keep the board open to the whole team, or move the team to a plan with private boards' },
    ])
  // What the board said is what to fix.
  if (status === 400) return theirs('usage', specific('invalid_arguments'), `Can't ${doing()}.`)
  if (status === 401)
    return theirs(
      'auth',
      'login_required',
      "The board didn't accept your credentials.",
      // A token you passed is yours to replace, and so is BOARD_TOKEN: logging in changes nothing while either is the one
      // sent, or a workflow's own, where there's no login.
      sent() === PASSED
        ? [{ instruction: 'Pass a token it accepts' }]
        : sent() === 'BOARD_TOKEN'
          ? [{ instruction: 'Pass a token it accepts in BOARD_TOKEN, or unset it' }]
          : sent() === 'GitHub Actions OIDC'
            ? [{ instruction: 'Pass a token it accepts in BOARD_TOKEN' }]
            : [{ instruction: 'Log in again', argv: ['vercel', 'login'] }],
    )
  if (status === 403) return theirs('permission', 'permission_denied', `You can't ${doing()}.`, refusedRecoveries())
  if (status === 404) {
    const thing = missing()
    // What it names says it, and the board's "message not found: 812" says no more.
    return thing ? { ...theirs('not_found', specific('not_found'), `Couldn't find ${thing}.`), details: [] } : theirs('not_found', specific('not_found'), `Can't ${doing()}.`)
  }
  if (status === 409) {
    // A grant change this caller couldn't take back: it keeps itself in, or says to go ahead.
    if (code === 'grant_lockout' && current.command === 'grants') return theirs('conflict', code, `Can't ${doing()}: it would lock you out.`, lockoutRecoveries())
    // A reply's --after: what's newer is in its thread, after the message it named.
    const { args } = current
    const newer = code === 'newer_message' && flags.after !== undefined && args[0] !== undefined
    // A label write's --if: who holds it now is a read away.
    const labeled = code === 'label_conflict' && (flags.if !== undefined || flags['if-unset'] !== undefined) && args[0] !== undefined
    // An edit's or a delete's --if-revision: the message as it is now has the revision to pass.
    const changed = code === 'revision_conflict' && flags['if-revision'] !== undefined && args[0] !== undefined
    // A schema version that's there with another definition: what it holds is a read away.
    if (code === 'schema_immutable' && current.command === 'schemas' && args[1] !== undefined)
      return theirs('conflict', code, `Can't ${doing()}.`, [{ instruction: "See what it's registered as", argv: [...cli(), 'schemas', 'inspect', args[1]] }])
    return theirs('conflict', specific('conflict'), `Can't ${doing()}.`, newer
      ? [{ instruction: `Read what came after ${ref(flags.after)}`, argv: [...cli(), 'read', args[0]!.replace(/^#/, ''), '--after', flags.after!.replace(/^#/, '')] }]
      : labeled
        ? [{ instruction: 'See its labels now', argv: [...cli(), 'read', args[0]!.replace(/^#/, '')] }]
        : changed
          ? [{ instruction: 'Read it as it is now', argv: [...cli(), 'read', args[0]!.replace(/^#/, ''), '--json'] }]
          : [])
  }
  if (status === 413) return theirs('limit', 'payload_too_large', `Can't ${doing()}. It's too large for the board.`)
  // A file too big for one request, on a board whose store takes none bigger: a limit, which the board's words give.
  if (status === 501 && code === 'no_direct_uploads')
    return theirs('limit', 'payload_too_large', `Can't ${doing()}. The file is too large for this board.`, [{ instruction: 'Compress it, or split it into smaller files' }])
  // How long to wait is what the board said, when it said: a minute is only a guess.
  if (status === 429)
    return theirs('rate_limit', 'rate_limited', `Can't ${doing()}. Too many requests to the board.`, [
      { instruction: wait !== undefined ? `Wait ${waitFor(wait)}, then run it again` : 'Wait a minute, then run it again' },
    ])
  if (status === 501) return theirs('platform', specific('not_supported'), `Can't ${doing()}. This board doesn't support it.`, unsupportedRecoveries())
  if (code === 'unreachable') return theirs('network', 'network_error', "Couldn't reach the board.")
  return theirs('platform', 'api_error', `Failed to ${doing()}.`)
}

/** The options that say which board this run is on, and as whom, as typed: what a way out to another command keeps. */
const onThisBoard = (): string[] => [
  ...(flags.url !== undefined ? ['--url', flags.url] : []),
  ...((flags.scope ?? flags.team) !== undefined ? ['--scope', (flags.scope ?? flags.team)!] : []),
  ...(flags.name !== undefined ? ['--name', flags.name] : []),
  ...(flags.as ? ['--as', flags.as] : []),
]

/** Where to go from a 403: what you may do on this board, and who can let you do more. */
const refusedRecoveries = (): Recovery[] => [
  { instruction: 'See what you can do on this board', argv: [...cli(), 'whoami', ...onThisBoard()] },
  { instruction: "Or ask someone who manages the board's grants to give you access" },
]

/** The filters a board answers 501 to on a read when it keeps no index of them, as Vercel's does. */
const UNINDEXED = ['--by', '--mentions', '--source', '--text']

/**
 * What to run instead of what a board answered 501 to, by what this run asked for: the same without
 * the part a board may not do (a read's search filters or its every channel, a post's `--sync`, a
 * schedule's files). Nothing when it asked for none of them.
 */
function unsupportedRecoveries(): Recovery[] {
  const { command, args } = current
  const given = (option: string) => (flags as Record<string, unknown>)[option.slice(2)] !== undefined
  if (command === 'read') {
    const filtered = UNINDEXED.filter(given)
    const target = args[0]
    const whole = target === undefined || (target.endsWith('/') && !isMessageRef(target))
    if (!filtered.length && !whole) return []
    const argv = rerunWithout(filtered)
    if (whole) {
      // One channel in place of every one (or every one under a prefix), whose names the channel list has.
      const at = argv.indexOf(positionals[0]!, cli().length)
      argv.splice(at + 1, target === undefined ? 0 : 1, '<CHANNEL>')
    }
    return [
      ...(whole ? [{ instruction: 'See the channels', argv: [...cli(), 'channels', ...(target !== undefined ? [target] : []), ...onThisBoard()] }] : []),
      { instruction: whole ? `Read one channel at a time${filtered.length ? `, without ${filtered.join(' or ')}` : ''}` : `Read it without ${filtered.join(' or ')}, and look through it`, argv },
    ]
  }
  if ((command === 'post' || command === 'reply') && given('--sync')) return [{ instruction: 'Post it without --sync', argv: rerunWithout(['--sync']) }]
  if (command === 'schedule' && given('--attach')) return [{ instruction: 'Schedule the text without its files', argv: rerunWithout(['--attach']) }]
  return []
}

/** `42s`, `2m`: a wait the way people say it. */
const waitFor = (seconds: number) => (seconds < 120 ? `${Math.max(1, seconds)}s` : `${Math.ceil(seconds / 60)}m`)

/** How this run ends with `failure`: shown on stderr, or by the app, and its exit code. */
function report(failure: Failure, json: boolean): number {
  if (app.onError) app.onError(failure, { json })
  else if (json) io.error(`${JSON.stringify(failureDocument(failure))}\n`)
  else io.error(`${terminalText(formatFailure(failure))}\n`)
  return exitCode(failure)
}

/**
 * A team's board in Vercel's API, by the URL its discovery names it with
 * (`https://api.vercel.com/v1/messageboard/boards/<board>?teamId=<team>`): its board and team.
 */
function vercelBoard(url: string): { board: string; team?: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const found = /^\/v1\/messageboard\/boards\/([^/]+)\/?$/.exec(parsed.pathname)
  if (parsed.origin !== 'https://api.vercel.com' || !found) return null
  const team = parsed.searchParams.get('teamId')
  return { board: decodeURIComponent(found[1]!), ...(team ? { team } : {}) }
}

/**
 * Whether this run's board is a team's board in Vercel's API, as its flags and environment say,
 * without a request: undefined when they don't say (an in-process handle, or no board to use).
 */
function onTeamBoard(): boolean | undefined {
  if (io.board) return undefined
  try {
    if (flags.url !== undefined) return vercelBoard(flags.url) !== null
    if (flags.scope !== undefined || flags.team !== undefined || flags.name !== undefined) return true
    const url = configuredUrl()
    return url === null || vercelBoard(url) !== null
  } catch {
    return undefined
  }
}

/** Who the handle writes as: `--as`'s profile (with `--avatar`), or what the environment says (`BOARD_PROFILE`), else yourself. */
function profileFlag(): ProfileOption | undefined {
  if (flags.avatar !== undefined && !flags.as) throw usage('--avatar is the avatar of the profile --as names: pass --as too.', { reason: 'missing_arguments' })
  if (!flags.as) return undefined
  return flags.avatar ? { name: flags.as, avatar: flags.avatar } : flags.as
}

/**
 * The board this command talks to, as `--as` says: a handle on it, where it is (null until its
 * discovery says, for a team's board), and how it reaches it. It's `--url`'s; a team's board in
 * Vercel's API for `--scope` or `--team`; the one the environment points at; or the team's board
 * of the Vercel project it runs in, or, for an app with a team board, your login's.
 */
function connection(url: string | undefined = flags.url, options: { token?: string; can?: string; headers?: Record<string, string> } = {}) {
  const profile = profileFlag()
  const team = flags.scope ?? flags.team
  const name = boardNameFlag(url, team)
  // A name names a team's board as --scope does, so it goes before BOARD_URL too.
  const configured = url ?? (team === undefined && name === undefined ? configuredUrl() : null)
  if (configured === null) {
    if (name === undefined) teamDefault = { team }
    const board = boardAt({ backend: vercel({ ...(team !== undefined ? { team } : {}), ...sending(options.token, options.can, options.headers) }), ...(name !== undefined ? { name, ensure: flags.ensure === true } : {}) })
    sent = credentialSource
    return { url: null, transport: { source: credentialSource }, board: profile !== undefined ? board.as(profile) : board }
  }
  const at = configured.replace(/\/+$/, '')
  reached = at
  // A team's board in Vercel's API (what `whoami` prints for one) is reached through the API, as `--scope` is.
  const onVercel = vercelBoard(at)
  if (onVercel) {
    const board = boardAt({ backend: vercel({ ...onVercel, ...sending(options.token, options.can, options.headers) }) })
    sent = credentialSource
    return { url: at as string | null, transport: { source: credentialSource }, board: profile !== undefined ? board.as(profile) : board }
  }
  const extra = { ...options.headers, ...(options.can !== undefined ? { 'x-board-can': options.can } : {}) }
  const transport = connect(at, { ...(options.token !== undefined ? { token: options.token } : {}), ...(Object.keys(extra).length > 0 ? { fetch: withHeaders(extra) } : {}) })
  const board = boardAt({ backend: http(at, { fetch: transport.fetch }) })
  sent = transport.source
  return { url: at as string | null, transport: transport as { source(): string | null }, board: profile !== undefined ? board.as(profile) : board }
}

/**
 * The team's board this run names: `--name`, or `BOARD_NAME`, on `--scope`'s team or the one the
 * environment finds. A URL names a board itself, its team included. `BOARD_NAME` is read only
 * where it picks the board: beside `BOARD_URL`, which names another, nothing says which one.
 */
function boardNameFlag(url: string | undefined, team: string | undefined): string | undefined {
  if (flags.name !== undefined && flags.url !== undefined)
    throw usage("--name names a team's board, and --url a board by its URL: pass one of them.", { reason: 'conflicting_options' })
  if (team !== undefined && flags.url !== undefined)
    throw usage("--url names its board, its team included, and --scope a team's board: pass one of them.", { reason: 'conflicting_options' })
  if (flags.ensure && flags.url !== undefined)
    throw usage("--ensure makes a team's board by its name, and --url names a board by its URL: pass one of them.", { reason: 'conflicting_options' })
  if (url !== undefined) return undefined
  const named = process.env.BOARD_NAME || undefined
  if (flags.name === undefined && team === undefined && named !== undefined && process.env.BOARD_URL?.trim())
    throw usage("BOARD_NAME names a team's board, and BOARD_URL a board by its URL: unset one.", { reason: 'conflicting_options' })
  const given = flags.name ?? named
  if (given === undefined && flags.ensure) throw usage('--ensure makes the board --name names: pass --name too.', { reason: 'missing_arguments' })
  if (given === undefined) return undefined
  const from = flags.name !== undefined ? '--name' : 'BOARD_NAME'
  if (given.includes('/')) {
    // Another team's board is its team, with --scope, and its name.
    const [owner, ...rest] = given.split('/')
    const argv = rerunWithout(['--name', '--scope', '--team'], '--scope', owner || '<TEAM>', '--name', rest.join('/') || '<NAME>')
    throw usage(`${from} takes a board's name alone, not its team's.`, {
      next: [flags.name !== undefined ? { instruction: 'Pass its team with --scope', argv } : { instruction: 'Set BOARD_NAME to the name alone, and pass its team with --scope' }],
    })
  }
  if (!isBoardName(given)) throw usage(`${from} ${given} isn't a board's name: one is 1 to 64 characters.`)
  return given
}

/** For Vercel's API, `token` in place of your own credentials, `can` narrowing them, and `headers` beside them. */
function sending(token: string | undefined, can?: string, extra: Record<string, string> = {}): { fetch?: typeof fetch } {
  if (token === undefined && can === undefined && Object.keys(extra).length === 0) return {}
  return {
    fetch: (input, init = {}) => {
      // The headers go in init: vercel()'s own fetch builds its credentials onto init's, and a Request's would be lost.
      const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
      if (token !== undefined) headers.set('authorization', `Bearer ${token}`)
      if (can !== undefined) headers.set('x-board-can', can)
      for (const [name, value] of Object.entries(extra)) headers.set(name, value)
      // Without a token of its own, it goes with the credentials vercel() would find.
      return (token === undefined ? credentialed() : globalThis.fetch)(input, { ...init, headers })
    },
  }
}

/** A fetch that adds `headers` to each request to a board on HTTP, as a proxy holding its credentials would: `x-board-can`, say. */
function withHeaders(headers: Record<string, string>): typeof fetch {
  return (input, init) => {
    const request = new Request(input, init)
    for (const [name, value] of Object.entries(headers)) request.headers.set(name, value)
    return globalThis.fetch(request)
  }
}

/** A handle on the board this command talks to: `vb()`'s, as `--as` says, or the one `connection()` finds. */
function client(): Board {
  if (!io.board) return connection().board
  const profile = profileFlag()
  return profile === undefined ? io.board : io.board.as(profile)
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function hookAgents(names: string[]): HookAgent[] {
  const known = Object.keys(AGENTS) as HookAgent[]
  for (const name of names)
    if (!known.includes(name as HookAgent)) throw usage(`Unknown agent ${name}. The agents are ${known.join(', ')}.`)
  return names.length ? (names as HookAgent[]) : known
}

/** Says what a write that went through had to say: in its JSON result with `--json`, on stderr otherwise. */
function warn(warning: Warning) {
  if (flags.json) warnings.push(warning)
  else if (app.onWarning) app.onWarning(warning)
  else io.error(`${terminalText(`warning: ${warning.message}`)}\n`)
}

/**
 * What became of the `@handle`s a write's text typed: a line for each one that's now a mention, with
 * who it mentions, and a warning for each that names no one or several, which is still text. With
 * `--json` the lines are the result's `mentions`.
 */
function sayMentions(mentions: Mentioned[] | undefined) {
  for (const { written, actor, candidates } of mentions ?? []) {
    if (actor) {
      if (!flags.json) out(`mentioned  ${actor.name}  @${actor.handle}`)
    } else if (candidates.length === 0) {
      warn({ reason: 'unknown_mention', message: `${written} names no one here: it stays text, and mentions no one.` })
    } else {
      // Each by their handle, where that's theirs alone and more than what was typed, and by their ID otherwise.
      const handles = candidates.map(({ handle }) => handle.toLowerCase())
      const choices = candidates.map(({ id, handle }) =>
        `@${handle}`.toLowerCase() !== written.toLowerCase() && handles.filter((other) => other === handle.toLowerCase()).length === 1 ? `@${handle}` : `@[${id}]`,
      )
      warn({ reason: 'ambiguous_mention', message: `${written} mentions no one here, and stays text: write ${choices.join(' or ')}.` })
    }
  }
}

/** A post or reply: its ID, or with `--json`, the message. Then what became of its mentions. */
function printMessage(written: Written<MessageView>) {
  const { mentions, ...message } = written
  if (flags.json) {
    sayMentions(mentions)
    result({ message, outcome: 'posted', ...(mentions ? { mentions } : {}) })
  } else {
    out(messageRef(message.id))
    sayMentions(mentions)
  }
}

/** A write that answers nothing but that it went through: with `--json`, which message, and what happened to it. */
function printDone(id: string, outcome: string, mentions?: Mentioned[]) {
  if (flags.json) {
    sayMentions(mentions)
    result({ message: { id }, outcome, ...(mentions ? { mentions } : {}) })
  } else {
    out(`${outcome} ${messageRef(id)}`)
    sayMentions(mentions)
  }
}

/** Best-effort: the URL is printed either way. */
/** `url`, when it's an http or https URL as `new URL` reads it: the only kind the CLI opens, so a board can't hand the opener a flag or another scheme. */
function browsable(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null
  } catch {
    return null
  }
}

/** Opens an http(s) URL in the browser, as one argument to the opener: no shell reads it, Windows' included. */
function openBrowser(url: string) {
  const at = browsable(url)
  if (at === null) return
  const [command, ...args] =
    process.platform === 'darwin' ? ['open', at] : process.platform === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler', at] : ['xdg-open', at]
  const child = spawn(command!, args, { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

function portFlag(): number | undefined {
  const port = flags.port === undefined ? undefined : Number(flags.port)
  if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port <= 65535))
    throw usage(`${flags.port} isn't a port.`, { reason: 'invalid_port' })
  return port
}

async function run(command: string | undefined, args: string[]): Promise<number> {
  switch (command) {
    case undefined:
    case 'help':
      out(help(args))
      return 0

    case 'whoami': {
      const { board, url: given, transport } = connection()
      // Its discovery too, so a URL to a board that isn't there, or you can't reach, says so.
      const [me, discovered] = await Promise.all([board.me(), board.discovery()])
      const url = given ?? discovered.url
      const source = transport.source()
      if (flags.json) {
        result({ ...me, board: url, source })
        return 0
      }
      out(`${who(me)} (${me.actor})`)
      const rows: [string, string][] = [['board', url]]
      if (source) rows.push(['source', source])
      if (me.expiresAt) {
        const minutes = Math.max(0, Math.round((Date.parse(me.expiresAt) - Date.now()) / 60_000))
        rows.push(['token', `expires in ${Math.floor(minutes / 60)}h ${minutes % 60}m`])
      }
      // Full access says nothing; anything less says what it is, one pattern a row.
      ;(me.can === undefined ? [] : formatAccess(me.can)).forEach((line, index) => rows.push([index === 0 ? 'can' : '', line]))
      const width = Math.max(...rows.map(([subject]) => subject.length))
      for (const [subject, value] of rows) out(`${subject.padEnd(width)}  ${value}`)
      return 0
    }

    case 'conformance': {
      if (args.length > 0) throw usage('conformance takes no arguments: pass its channel with --channel.')
      // It posts and changes grants, so it checks a board someone named, never the team's by default.
      const named = flags.name !== undefined || flags.url !== undefined || Boolean(process.env.BOARD_URL?.trim()) || Boolean(process.env.BOARD_NAME)
      if (!io.board && !named)
        throw usage('conformance posts and changes grants, so name a scratch board for it.', {
          reason: 'needs_scratch_board',
          next: [
            { instruction: 'Check a scratch board on this team, by its name', argv: rerun('--name', '<BOARD>') },
            { instruction: 'Or a board by its URL', argv: rerun('--url', '<URL>') },
          ],
        })
      // The same board with this run's own credential and headers of the run's (x-board-can, a profile), as a proxy holding it sends them:
      // what `vb()` was handed can't be opened again.
      const withHeaders = io.board ? {} : { withHeaders: (headers: Record<string, string>) => connection(undefined, { headers }).board }
      // Open the board first: one it can't reach (no room for it, no grant, a lapsed login) is this run's error, not a check the board failed.
      await client().me()
      const report = await conformance(client(), { ...(flags.channel ? { channel: flags.channel } : {}), ...withHeaders })
      if (flags.json) result(report)
      else out(formatConformance(report))
      return report.ok ? 0 : 1
    }

    case 'channels': {
      const [sub, ...rest] = args
      if (sub === 'create') {
        const [path, extra] = rest
        if (!path) throw usage('Missing the channel to create, such as dev/alerts.', { reason: 'missing_arguments' })
        if (extra !== undefined) throw usage(`channels create takes one channel: ${extra} is one too many.`)
        const { channel, created, grants } = await client().createChannel(path, flags.private ? { private: true } : {})
        if (flags.json) result({ channel, outcome: created ? 'created' : 'unchanged', ...(grants ? { grants } : {}) })
        else if (grants) {
          // The channel, then the two grants that close it, each a line.
          out(`created channel ${channel.path}`)
          for (const grant of grants) out(`created ${grantRow(grant)}`)
        } else out(created ? `created ${channel.path}` : `${channel.path} already exists`)
        return 0
      }
      // What isn't `list` or `create` is the prefix of a list, `channels dev/`: with more after it, a command there isn't.
      if (sub !== undefined && sub !== 'list' && rest.length > 0) throw usage(`Unknown command ${sub} for ${named()} channels.`, { reason: 'unknown_command' })
      const [prefix, extra] = sub === 'list' ? rest : args
      if (extra !== undefined) throw usage(`channels list takes one prefix: ${extra} is one too many.`)
      if (flags.limit !== undefined && !(/^[1-9]\d*$/.test(flags.limit) && Number(flags.limit) <= CHANNELS_LIMIT_MAX)) throw usage(`--limit takes 1 to ${CHANNELS_LIMIT_MAX} channels, and ${flags.limit} isn't one.`)
      const listed = await client().channels({ ...(prefix !== undefined ? { prefix } : {}), ...(flags.limit !== undefined ? { limit: Number(flags.limit) } : {}), ...(flags.after !== undefined ? { after: flags.after } : {}) })
      if (flags.json) return result({ channels: listed.channels, next: listed.next }), 0
      // A page comes in the board's order: shown by path, so the ones under one prefix are together.
      const channels = [...listed.channels].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      if (channels.length === 0) return out(prefix === undefined && flags.after === undefined ? 'no channels yet' : `no channels${prefix !== undefined ? ` under ${prefix}` : ''}${flags.after !== undefined ? ' after that page' : ''}`), 0
      let group = ''
      for (const channel of channels) {
        const prefix = channel.path.includes('/') ? channel.path.slice(0, channel.path.lastIndexOf('/') + 1) : ''
        if (prefix !== group) {
          if (prefix) out(prefix)
          group = prefix
        }
        const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
        const { threads, messages, lastIndex } = channel
        // Counts only where the board keeps them: a team board in Vercel's API doesn't. One made
        // before anything posted to it has no last message.
        const counted = threads !== undefined && messages !== undefined
          ? `  ${count(threads, 'thread', 'threads')} · ${count(messages, 'message', 'messages')}${lastIndex ? ` · last #${lastIndex}` : ''}`
          : ''
        out(`${prefix ? '  ' : ''}${channel.path}${counted}`)
      }
      // A page that isn't the last says how to read the next.
      if (listed.next !== null) out(`\n(more not shown: ${commandLine(rerunWithout(['--after'], '--after', listed.next))})`)
      return 0
    }

    case 'actors': {
      const actors = await client().actors()
      if (flags.json) return result({ actors }), 0
      for (const actor of actors) out(`@${actor.handle}  ${actorName(actor)}  ${actor.id}`)
      return 0
    }

    case 'read': {
      const target = args[0]
      const board = client()
      // A platform's link to a message (a Slack permalink, a GitHub comment) reads the board's thread it synced.
      const link = target !== undefined && /^https?:\/\//i.test(target)
      if (target && (link || isMessageRef(target))) {
        // A thread is read whole: what finds threads doesn't narrow one, and it's said before anything is read.
        const across = (['by', 'text', 'mentions', 'source', 're', 'before'] as const).find((name) => flags[name] !== undefined)
        if (across !== undefined) throw usage(`Can't use --${across} on one thread. It's read whole: --after and --label narrow its replies.`)
        // A board reads the replies after a message itself, so a long thread isn't read whole for its last few.
        const after = !link && flags.after !== undefined ? flags.after.replace(/^#/, '') : undefined
        const thread = link
          ? await board.linked(target)
          : await board.thread(messageId(target), after !== undefined && isMessageRef(after) ? { after: messageId(after) } : {}).catch((error: unknown) => {
              // A message of another thread is no place in this one, which is the flag's to say.
              if (error instanceof BoardError && error.status === 400 && /isn't a message of this thread/.test(error.message))
                throw usage(`--after ${flags.after} isn't a message of this thread. On one thread, it takes one of its messages.`)
              throw error
            })
        // A board older than this CLI answers /links with its discovery document. Its 404 stays: a
        // current board's means the link isn't one it synced.
        if (link && !Array.isArray((thread as { replies?: unknown }).replies)) throw outdated("This board can't read links.")
        // What narrows it is narrowed here, from the replies it came with.
        const narrowed = flags.after !== undefined || (flags.label?.length ?? 0) > 0
        const replies = narrowed ? narrowedReplies(thread, { after: link || after === undefined || !isMessageRef(after) }) : thread.replies
        if (flags.json) return result({ ...thread, replies }), 0
        // Reactions name people who may not have written here: look up the ones that show.
        const authors = new Set([thread.message, ...replies].map((m) => m.by.actor))
        // And a task names who holds it, and its owner when that isn't its root's author.
        const { task } = thread.message
        const working = task ? [...(task.claim ? [task.claim.actor] : []), ...(task.owner !== thread.message.by.principal ? [task.owner] : [])] : []
        // And a text mentions people by ID, who show by name.
        const unnamed = [...new Set([...reactionNames([thread.message, ...replies]), ...working, ...mentionedIn([thread.message, ...replies])])].filter((id) => !authors.has(id))
        const listed = unnamed.length ? await board.actors({ id: unnamed }).catch(() => []) : []
        const known = new Map(listed.map((a) => [a.id, actorName(a)]))
        out(formatThreads([thread.message, ...replies], known, new Map(listed.map((a) => [a.id, a.handle]))))
        if (!narrowed) for (const schedule of thread.schedules ?? []) out(formatSchedule(schedule, { pad: '  ' }))
        return 0
      }
      const limit = flags.limit ? Number(flags.limit) : THREADS_LIMIT_DEFAULT
      if (flags.before !== undefined && flags.after !== undefined) throw usage("Can't use --before with --after. One pages back, the other reads forward.")
      // A read of one channel's threads as they are is the one a board pages back, by the `older` its page answers:
      // it's asked for the page as shown, so that `older` goes on from the last thread listed.
      // So is one by mentions or text, which a board with no search index answers from that page.
      const paged = target !== undefined && !target.endsWith('/') && Object.keys(filters()).every((key) => key === 'mentions' || key === 'text')
      // Otherwise one thread more than asked for, where a read lists that many, tells whether the page is all of
      // them. Not for --json, which is the board's page as it answered.
      const peek = !paged && !flags.json && flags.before === undefined && Number.isInteger(limit) && limit >= 1 && limit < THREADS_LIMIT_MAX
      const query = { ...filters(target), ...(flags.before !== undefined ? { before: flags.before } : {}), ...(peek ? { limit: limit + 1 } : flags.limit ? { limit } : {}) }
      // A board older than this CLI answers /threads with its discovery document, or a 404 under a basePath.
      const old = outdated("This board can't list threads.")
      // Only a board's own "no route" is one without the route: any other 404 says what it is.
      const listed = await board.threads(query).catch((error: unknown) => {
        throw error instanceof BoardError && error.status === 404 && /^no route: /.test(error.message) ? old : error
      })
      if (!Array.isArray((listed as { threads?: unknown }).threads)) throw old
      // The latest activity comes last: the one more is the oldest, or after a cursor, the newest. A page asked for
      // as shown says itself whether there are more, by its `older`. One asked for a thread more doesn't: its `older`
      // is past the thread it left out.
      const older = !peek && typeof listed.older === 'string' ? listed.older : undefined
      const more = peek ? listed.threads.length > limit : listed.older === null ? false : older !== undefined || listed.threads.length === limit
      const page = listed.threads.length > limit ? { ...listed, threads: flags.after !== undefined ? listed.threads.slice(0, limit) : listed.threads.slice(-limit) } : listed
      // A board that looked through threads to find none says by that the channel has some.
      const scanned = typeof listed.scanned === 'number' ? listed.scanned : undefined
      // Nothing in a channel that doesn't exist is a typo, not an empty channel.
      if (!page.threads.length && target && !scanned) {
        // Every channel, a page at a time: a name close to the one typed could be any of them.
        const channels = (await everyChannel(board)).map((c) => c.path)
        if (!channels.some((path) => path === target || path.startsWith(target.replace(/\/?$/, '/')))) {
          const guess = closest(target, channels)
          throw new Failed({
            class: 'not_found',
            reason: 'channel_not_found',
            message: `Couldn't find channel ${target}.${guess ? ` Did you mean ${guess}?` : ''}`,
            details: [
              'A channel appears with its first post: one nobody has posted in yet is not there to read.',
              ...(teamDefault ? [`This is ${teamDefault.team ?? 'the team'}'s default board: --name reads another of its boards.`] : []),
            ],
            next: [
              { instruction: 'See its channels', argv: [...cli(), 'channels', ...(teamDefault?.team !== undefined ? ['--scope', teamDefault.team] : [])] },
              ...(teamDefault ? [{ instruction: "Read it on another of the team's boards", argv: rerun('--name', '<BOARD>') }] : []),
            ],
          })
        }
      }
      if (flags.json) return result(page), 0
      const count = `${page.threads.length} ${page.threads.length === 1 ? 'thread' : 'threads'}`
      out(`${target ?? 'all channels'} · ${count} · cursor ${page.cursor}${page.threads.length ? '\n' : ''}`)
      if (page.threads.length) {
        // A root's first line may mention, by ID, someone who wrote none of what's listed: they show by handle.
        const roots = page.threads.map(({ message }) => message)
        const wrote = new Set(page.threads.flatMap(({ message, last }) => (last ? [message.by.actor, last.by.actor] : [message.by.actor])))
        const unnamed = mentionedIn(roots).filter((id) => !wrote.has(id))
        const handles = new Map(unnamed.length ? (await board.actors({ id: unnamed }).catch(() => [])).map((a) => [a.id, a.handle]) : [])
        out(formatThreadSummaries(page.threads, { channel: !target || target.endsWith('/'), handles }))
      }
      // What it looked through is all it says: a mention further up a thread, or on an older page, isn't on this one.
      if (scanned !== undefined) out(`\n(looked through ${scanned} ${scanned === 1 ? 'thread' : 'threads'}, at the first and latest message of each: a match under a newer reply is not found)`)
      // A page that isn't all of them says where the rest are. Without --after, they're older: --before the
      // page's `older` reaches them where the board answered one, and a bigger --limit where it didn't. After
      // a cursor, they're newer than the page, and its cursor is past them
      // too: what reads on is --after the newest message of the page's last thread, the latest active.
      // With a filter on messages, a board may place a thread by its newest match, which its summary
      // doesn't show (`last` is its latest reply, whoever wrote it), so nothing on the page says where
      // it stopped: a bigger page after the same cursor is what's sure to miss none.
      const latest = page.threads.at(-1)
      if (more && flags.after !== undefined && latest) {
        const byMessage = ['re', 'by', 'mentions', 'from', 'text'].some((key) => key in query)
        if (!byMessage) out(`\nmore since then: ${commandLine(rerunWithout(['--after'], '--after', (latest.last ?? latest.message).id))}`)
        else if (limit < THREADS_LIMIT_MAX) out(`\nmore since then: ${commandLine(rerunWithout(['--limit', '-n'], '--limit', String(Math.min(THREADS_LIMIT_MAX, limit * 2))))}`)
        else out(`\n(more not shown: ${THREADS_LIMIT_MAX} is the most a read lists, so narrow it with --label)`)
        return 0
      }
      if (more)
        out(
          older !== undefined
            ? `\n(older not shown: ${commandLine(rerunWithout(['--before'], '--before', older))})`
            : limit < THREADS_LIMIT_MAX
              ? `\n(older not shown: ${commandLine(rerunWithout(['--limit', '-n'], '--limit', String(Math.min(THREADS_LIMIT_MAX, limit * 2))))})`
              : `\n(older not shown: ${THREADS_LIMIT_MAX} is the most a read lists, so read one channel and page back with --before, or narrow it with --label)`,
        )
      // A page back from one isn't where the board is now: only a read of the latest says what's new since.
      if (flags.before !== undefined) return 0
      // Such a board reads no further by its cursor: a wait with the same filters from it sees what comes next, and
      // misses nothing posted since this read.
      if (scanned !== undefined) {
        const argv = rerunWithout(['--after', '--limit', '-n'], '--after', String(page.cursor))
        argv[argv.indexOf('read', cli().length)] = 'wait'
        out(`\nnew since then: ${commandLine(argv)}`)
        return 0
      }
      // The cursor is where this read stopped: the next command is the one that reads on from it.
      // It's this run as typed, its board, identity and filters included, from where it stopped.
      out(`\nnew since then: ${commandLine(rerunWithout(['--after'], '--after', String(page.cursor)))}`)
      return 0
    }

    case 'post': {
      const [target, body] = args
      if (!target) throw usage('Missing the channel or message to post to.', { reason: 'missing_arguments' })
      oneText('post', target, args.slice(2))
      const re = isMessageRef(target) ? messageId(target) : undefined
      if (re !== undefined && flags.sync?.length)
        throw usage("Can't use --sync on a reply. It syncs whole threads.", {
          next: [{ instruction: 'Sync the thread instead', argv: [...cli(), 'sync', re, '<TARGET>'] }],
        })
      if (flags.sync?.length && flags['no-sync']) throw usage("Can't use --sync with --no-sync.")
      if (re === undefined && flags.after !== undefined)
        throw usage("Can't use --after on a new thread. It's for replies: the thread's newest message.")
      const board = client()
      const said = await content(body, { optional: !!flags.attach?.length })
      const files = await attachments(board)
      const options = {
        text: said,
        ...(files.length ? { attachments: files } : {}),
        ...(flags.label?.length ? { labels: labelPairs(flags.label) } : {}),
        ...(flags['idempotency-key'] ? { id: flags['idempotency-key'] } : {}),
        ...(flags['no-sync'] ? { noSync: true } : {}),
      }
      const message = re === undefined
        ? await board.post(target, { ...options, ...(flags.sync?.length ? { sync: flags.sync } : {}) })
        : await board.reply(re, { ...options, ...(flags.after !== undefined ? { after: messageId(flags.after) } : {}) })
      printMessage(message)
      return 0
    }

    case 'reply': {
      const id = messageId(args[0])
      oneText('reply', args[0]!, args.slice(2))
      const board = client()
      const said = await content(args[1], { optional: !!flags.attach?.length })
      const files = await attachments(board)
      const message = await board.reply(id, {
        text: said,
        ...(files.length ? { attachments: files } : {}),
        ...(flags.label?.length ? { labels: labelPairs(flags.label) } : {}),
        ...(flags['idempotency-key'] ? { id: flags['idempotency-key'] } : {}),
        ...(flags['no-sync'] ? { noSync: true } : {}),
        ...(flags.after !== undefined ? { after: messageId(flags.after) } : {}),
      })
      printMessage(message)
      return 0
    }

    case 'schedule': {
      if (args[0] === 'cancel' && args.length === 2) {
        const { schedule, canceled } = await client().cancelSchedule(scheduleId(args[1]))
        if (flags.json) result({ schedule, outcome: canceled ? 'canceled' : 'unchanged' })
        else out(canceled ? `canceled ${schedule.id}` : `${schedule.id} is already ${schedule.state}`)
        return 0
      }
      const [target, body] = args
      if (!target) throw usage('Missing the channel or message to schedule a message in.', { reason: 'missing_arguments' })
      if (!flags.in && !flags.at && !flags.every) throw usage("Can't schedule a message without a time: pass --in 1d, --at <time>, or --every 30m.", { reason: 'missing_arguments' })
      const times = flags.times === undefined ? undefined : Number(flags.times)
      if (times !== undefined && !(Number.isInteger(times) && times > 0)) throw usage(`--times takes a count, and ${flags.times} isn't one.`)
      const board = client()
      const said = await content(body, { optional: !!flags.attach?.length })
      const files = await attachments(board)
      const where = isMessageRef(target) ? { re: messageId(target) } : target
      const schedule = await board.schedule(where, {
        text: said,
        ...(files.length ? { attachments: files } : {}),
        ...(flags.label?.length ? { labels: labelPairs(flags.label) } : {}),
        ...(flags['no-sync'] ? { noSync: true } : {}),
        ...(flags.in ? { in: flags.in } : {}),
        ...(flags.at ? { at: instant('at', flags.at) } : {}),
        ...(flags.every ? { every: flags.every } : {}),
        ...(flags.until ? { until: instant('until', flags.until) } : {}),
        ...(flags.for ? { for: flags.for } : {}),
        ...(times !== undefined ? { times } : {}),
      })
      const { mentions, ...made } = schedule
      if (flags.json) {
        sayMentions(mentions)
        result({ schedule: made, outcome: 'scheduled', ...(mentions ? { mentions } : {}) })
      } else {
        out(formatSchedule(made))
        sayMentions(mentions)
      }
      return 0
    }

    case 'grants': {
      const [verb, ...rest] = args
      if (verb === undefined || verb === 'list') {
        if (rest.length > 0) throw usage(`grants list takes no arguments: ${rest[0]} is one too many.`)
        const list = await client().grants()
        if (flags.json) return result({ grants: list }), 0
        out(list.length === 0 ? 'no grants' : formatGrants(list))
        return 0
      }
      if (verb === 'create') {
        if (rest.length > 0) throw usage(`grants create takes no arguments: ${rest[0]} is one too many.`)
        onlyPrincipalFlags('create')
        const principals = grantFlags(() => principalsIn(ordered, [''])).map(({ principal }) => principal)
        // Several grants, from a file: one write makes them all, or none.
        if (flags.file !== undefined) {
          if (principals.length > 0 || flags.can !== undefined) throw usage("--file holds the grants: each one in it names its own principals and can, so it goes without theirs.")
          const { grants } = await client().createGrants(await grantsFrom(flags.file), lockMeOut()).catch(namingSelf)
          if (flags.json) result({ grants, outcome: 'created' })
          else for (const grant of grants) out(`created ${grantRow(grant)}`)
          return 0
        }
        if (principals.length === 0)
          throw usage('A grant names whom it lets in: --user, --project, --github, --oidc, --all-users, --all-projects, or --everyone.', { reason: 'missing_arguments' })
        const can = grantFlags(() => grantCanOf(flags.can ?? []))
        if (Object.keys(can).length === 0) throw usage("A grant says what it lets them do: --can pattern=permissions, like --can 'ci/=read,post'.", { reason: 'missing_arguments' })
        const { grant } = await client().createGrant({ principals, can }, lockMeOut()).catch(namingSelf)
        if (flags.json) result({ grant, outcome: 'created' })
        else out(`created ${grantRow(grant)}`)
        return 0
      }
      if (verb === 'update') {
        const id = grantId(rest[0])
        if (rest.length > 1) throw usage(`grants update takes one grant: ${rest[1]} is one too many.`)
        onlyPrincipalFlags('update')
        const named = grantFlags(() =>
          // To drop an environment, remove the principal and add it back with the ones it keeps, in one
          // update: as two, removing a grant's only principal would leave it naming no one.
          principalsIn(ordered, ['add-', 'remove-'], ({ kind, value }) => {
            const named = value !== undefined ? [value] : []
            return [
              {
                instruction: 'Remove it and add it back with the environments it keeps',
                argv: [...cli(), 'grants', 'update', id, `--remove-${kind}`, ...named, `--add-${kind}`, ...named, '--environment', '<ENVIRONMENTS>'],
              },
            ]
          }),
        )
        const add = named.filter(({ prefix }) => prefix === 'add-').map(({ principal }) => principal)
        const remove = named.filter(({ prefix }) => prefix === 'remove-').map(({ principal }) => principal)
        const can = flags.can !== undefined ? grantFlags(() => grantCanOf(flags.can!)) : undefined
        if (add.length === 0 && remove.length === 0 && can === undefined)
          throw usage(`grants update ${id} changes nothing: add or remove a principal (--add-user, --remove-project, …), or give --can.`, { reason: 'missing_arguments' })
        const { grant } = await client().updateGrant(id, { ...(add.length > 0 ? { add } : {}), ...(remove.length > 0 ? { remove } : {}), ...(can !== undefined ? { can } : {}) }, lockMeOut())
        if (flags.json) result({ grant, outcome: 'updated' })
        else out(`updated ${grantRow(grant)}`)
        return 0
      }
      if (verb === 'explain') {
        const [channel, extra] = rest
        if (channel === undefined) throw usage('Missing the channel to explain, such as security/incidents.', { reason: 'missing_arguments' })
        if (extra !== undefined) throw usage(`grants explain takes one channel: ${extra} is one too many.`)
        onlyPrincipalFlags('explain')
        const { principal, subject, kind } = grantFlags(() => explainPrincipalOf(ordered))
        const explanation = await client().explain(channel, principal)
        if (flags.json) result({ explanation })
        else out(explanationLine(explanation, subject, kind))
        return 0
      }
      if (verb === 'revoke') {
        const id = grantId(rest[0])
        const { revoked } = await client().revokeGrant(id, lockMeOut())
        if (flags.json) result({ grant: id, outcome: revoked ? 'revoked' : 'unchanged' })
        else out(revoked ? `revoked ${id}` : `${id} is already gone`)
        return 0
      }
      throw usage(`Unknown command ${verb} for ${named()} grants.`, { reason: 'unknown_command' })
    }

    case 'schemas': {
      const [verb, ...rest] = args
      if (verb === undefined || verb === 'list') {
        if (rest.length > 0) throw usage(`schemas list takes no arguments: ${rest[0]} is one too many.`)
        const list = await client().schemas()
        if (flags.json) return result({ schemas: list }), 0
        out(formatSchemas(list))
        return 0
      }
      if (verb !== 'inspect' && verb !== 'create') throw usage(`Unknown command ${verb} for ${named()} schemas.`, { reason: 'unknown_command' })
      const [id, extra] = rest
      if (id === undefined) throw usage(`Missing the schema to ${verb}: its name and version, like sandbox@1.`, { reason: 'missing_arguments' })
      if (extra !== undefined) throw usage(`schemas ${verb} takes one schema: ${extra} is one too many.`)
      const wanted = parseSchemaId(id)
      if (!wanted) throw usage(`${id} doesn't name a schema. One is name@version, like sandbox@1.`)
      if (verb === 'inspect') {
        const schema = await client().schema(id)
        if (flags.json) result({ schema })
        else out(formatSchema(schema))
        return 0
      }
      const { schema, created } = await client().createSchema({
        ...wanted,
        schema: await definition(),
        ...(flags.description !== undefined ? { description: flags.description } : {}),
      })
      if (flags.json) result({ schema, outcome: created ? 'created' : 'unchanged' })
      else out(created ? `created ${schema.id}` : `${schema.id} is already registered`)
      return 0
    }

    case 'schedules': {
      // A schedule's own ID (s12) shows that schedule, whatever became of it: sent, canceled, or still pending.
      if (args[0] !== undefined && isScheduleId(args[0])) {
        const one = (await client().schedules({ all: true })).find((schedule) => schedule.id.toLowerCase() === args[0]!.toLowerCase())
        if (!one)
          throw new Failed({
            class: 'not_found',
            reason: 'schedule_not_found',
            message: `Couldn't find schedule ${args[0]}.`,
            next: [{ instruction: 'See every schedule, done and canceled ones too', argv: [...cli(), 'schedules', '--all'] }],
          })
        if (flags.json) return result({ schedules: [one] }), 0
        return out(formatSchedule(one)), 0
      }
      const list = await client().schedules({
        ...(args[0] ? { re: messageId(args[0]) } : {}),
        ...(flags.by ? { by: flags.by.replace(/^@/, '') } : {}),
        ...(flags.channel ? { channel: flags.channel } : {}),
        ...(flags.all ? { all: true } : {}),
      })
      if (flags.json) return result({ schedules: list }), 0
      if (list.length === 0) return out(flags.all ? 'no schedules' : 'no pending schedules'), 0
      out(list.map((schedule) => formatSchedule(schedule)).join('\n'))
      return 0
    }

    case 'hooks': {
      const [action, ...names] = args
      if (action !== 'uninstall')
        throw usage(`\`${`${named()} hooks ${action ?? ''}`.trimEnd()}\` is gone. Turn-end hooks were removed.`, {
          reason: 'unknown_command',
          next: [{ instruction: 'Clear an earlier install', argv: [...cli(), 'hooks', 'uninstall'] }],
        })
      const agents = hookAgents(names)
      const width = Math.max(...agents.map((agent) => AGENTS[agent].name.length))
      const hooks: { agent: string; outcome: string; file: string | null }[] = []
      for (const agent of agents) {
        const installed = installedHook(agent)
        const by = installed ? cliOf(installed) : null
        const rules = by ? allowRules(agent, by) : null
        if (rules) disallow(rules.file, rules.rules)
        const removed = uninstallHook(agent)
        hooks.push({ agent, outcome: removed ? 'removed' : 'unchanged', file: installed ? AGENTS[agent].file() : null })
        if (!flags.json) out([AGENTS[agent].name.padEnd(width), removed ? 'removed' : 'not installed', installed ? tilde(AGENTS[agent].file()) : ''].join('  ').trimEnd())
      }
      if (flags.json) result({ hooks })
      return 0
    }

    // What an earlier board's turn-end hook still runs: it does nothing, so those turns end as they would without it.
    // `hooks uninstall` clears it.
    case 'hook':
      return 0

    case 'edit': {
      const id = messageId(args[0])
      const { mentions } = await client().edit(id, await content(args[1]), ifRevision())
      printDone(id, 'edited', mentions)
      return 0
    }

    case 'delete': {
      const id = messageId(args[0])
      await client().delete(id, ifRevision())
      printDone(id, 'deleted')
      return 0
    }

    case 'react': {
      const id = messageId(args[0])
      if (!args[1]) throw usage('Missing the emoji to react with, like eyes or thumbs_up.', { reason: 'missing_arguments' })
      let emoji: string
      try {
        emoji = normalizeEmoji(args[1])
      } catch {
        throw usage(`Unknown emoji ${args[1]}. Use a short name, like eyes or thumbs_up.`)
      }
      await client().react(id, emoji, flags.remove ? { remove: true } : {})
      printDone(id, flags.remove ? 'unreacted' : 'reacted')
      return 0
    }

    case 'label': {
      const id = messageId(args[0])
      const set = labelPairs(args.slice(1), undefined, '{value} has no value. To remove the label, --unset {key}.')
      const unset = flags.unset ?? []
      if (Object.keys(set).length === 0 && unset.length === 0)
        throw usage('Missing the labels: k=v to set one, --unset k to remove one.', { reason: 'missing_arguments' })
      // What the labels must be now: --if k=v has the value, --if-unset k has none.
      const expected: Record<string, string | null> = labelPairs(flags.if, "--if takes key=value, and {value} isn't one. For a label that mustn't be set, --if-unset key.", null)
      for (const key of flags['if-unset'] ?? []) {
        if (Object.hasOwn(expected, key)) throw usage(`Can't use --if ${key}=… with --if-unset ${key}.`)
        expected[key] = null
      }
      await client().label(id, { set, unset, ...(Object.keys(expected).length ? { if: expected } : {}) })
      printDone(id, 'labeled')
      return 0
    }

    case 'typing': {
      const id = messageId(args[0])
      const status = args.slice(1).join(' ').trim()
      const targets = await client().typing(id, status || undefined)
      if (flags.json) result({ targets })
      return 0
    }

    case 'sync': {
      const id = messageId(args[0])
      if (!args[1]) {
        const { targets } = await client().sync(id)
        if (flags.json) return result({ targets }), 0
        out(targets.length ? formatSynced(targets) : 'not synced anywhere')
        return 0
      }
      const synced = await client().sync(id, args[1])
      if (flags.json) result({ ...synced, outcome: synced.attached ? 'synced' : 'unchanged' })
      else out(synced.attached ? `synced with ${synced.target}` : `already synced with ${synced.target}`)
      return 0
    }

    case 'download': {
      const id = args[0]
      if (!id) throw usage(`Missing the attachment to download: the ID \`${named()} read\` shows on a file line.`, { reason: 'missing_arguments' })
      // An ID has no dot or slash: this is the file's name, which many attachments may share.
      if (/[./]/.test(id))
        throw usage(`${id} is a file's name, and download takes the attachment's ID: the last thing on its file line when you read its thread.`, {
          next: [{ instruction: 'Read the thread to see the ID', argv: [...cli(), 'read', '<ID>'] }],
        })
      const response = await client().download(id)
      const data = new Uint8Array(await response.arrayBuffer())
      if (args[1] === '-') return io.write(data), 0
      const disposition = response.headers.get('content-disposition') ?? ''
      const filename = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1]
      // Whoever posted the file chose its name: saved by it, it never lands as a dotfile or replaces a file.
      const saveAs = basename(filename ? decodeURIComponent(filename) : id)
        .replace(INVISIBLE, '')
        .replace(/^[.\s]+/, '')
      const path = args[1] ?? (saveAs || id)
      try {
        await io.writeFile(path, data, { exclusive: args[1] === undefined })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw exists(path)
        }
        throw error
      }
      if (flags.json) result({ attachment: { id }, path, outcome: 'downloaded' })
      else out(path)
      return 0
    }

    case 'inbox': {
      const key = args[0]
      if (!key) throw usage('Missing the sync entry whose inbox to read, such as slack.', { reason: 'missing_arguments' })
      const events = await client().inbox(key, {
        ...(args[1] ? { channel: args[1] } : {}),
        ...(flags.limit ? { limit: Number(flags.limit) } : {}),
      })
      if (flags.json) return result({ events }), 0
      if (events.length === 0) return out('no events'), 0
      for (const entry of events) {
        const event = entry.event as { kind: string; thread: string; text?: string; type?: string; emoji?: string; author?: { handle: string } }
        const detail = event.text ?? event.type ?? event.emoji ?? ''
        out(`${entry.createdAt}  ${entry.channel}  ${event.kind}  ${event.author?.handle ?? ''}  ${detail.split('\n')[0]}`)
      }
      return 0
    }

    case 'sources': {
      const [key, sub, target] = args
      if (!key) {
        const { sync } = await client().discovery()
        if (flags.json) return result({ sources: sync }), 0
        if (sync.length === 0) return out('no sources: this board has no sync configured'), 0
        for (const entry of sync) out(`${entry.key}  ${entry.platform}`)
        return 0
      }
      if (sub === 'join' && target) {
        const joined = await client().joinSource(key, target)
        if (flags.json) return result({ ...joined, outcome: joined.joined ? 'joined' : 'unchanged' }), 0
        const label = joined.name ? `#${joined.name}` : joined.channel
        return out(joined.joined ? `joined ${label}` : `already in ${label}`), 0
      }
      if (sub !== 'read' && sub !== 'join') throw usage(sub === undefined ? `Missing what to do with ${key}: read or join.` : `Unknown command ${sub} for ${named()} sources.`, { reason: sub === undefined ? 'missing_arguments' : 'unknown_command' })
      if (!target) throw usage(`Missing the channel, thread, or link to ${sub}.`, { reason: 'missing_arguments' })
      const read = await client().readSource(key, target, { ...(flags.limit ? { limit: Number(flags.limit) } : {}), ...(flags.after ? { after: String(flags.after) } : {}) })
      if (flags.json) return result(read), 0
      return out(formatSourceRead(key, read, Date.now(), named())), 0
    }

    case 'tail': {
      const controller = new AbortController()
      // Its handler goes when it's done: inside another CLI, the process goes on, and Ctrl-C should stop it.
      const stop = stopOn(controller)
      try {
        for await (const event of client().events(
          { ...filters(args[0]), ...(flags.all ? { all: true } : {}), ...(flags.last !== undefined ? { last: Number(flags.last) } : {}) },
          { signal: controller.signal },
        ))
          if (flags.json) line(event)
          else out(formatEvent(event))
      } finally {
        stop.release()
      }
      // Ctrl-C is a cancel; the caller's signal is how `vb()` ends a tail.
      return stop.interrupted() ? 130 : 0
    }

    case 'wait': {
      const controller = new AbortController()
      const stop = stopOn(controller)
      // A bare number is seconds, as `timeout 30` and `sleep 30` are: the client's own bare number is milliseconds.
      const timeout = /^\d+$/.test(flags.timeout ?? '') ? `${flags.timeout}s` : (flags.timeout ?? '30m')
      // A message's ID where a channel goes is its thread: a channel of that name would never answer.
      const thread = args[0] !== undefined && isMessageRef(args[0]) && flags.re === undefined ? args[0] : undefined
      // Its thread is its root's, and what's wanted is what comes after it: an answer already there is one.
      const root = thread === undefined ? undefined : (await client().thread(messageId(thread))).message.id
      const waitsOn = root === undefined ? filters(args[0]) : { ...filters(), re: root, ...(flags.after === undefined ? { after: messageId(thread!) } : {}) }
      const event = await client()
        .wait(waitsOn, { timeout, signal: controller.signal })
        .finally(stop.release)
      if (!event) {
        // Stopped, it says nothing, and answers as `tail` does: whoever stopped it knows.
        if (controller.signal.aborted) return stop.interrupted() ? 130 : 0
        throw new Failed({
          class: 'timeout',
          reason: 'timeout',
          message: `Nothing matched within ${timeout}.`,
          // What was already there when it started never matches: the commonest reason a wait comes back empty.
          details: [waitsOn.after === undefined ? 'wait sees only what arrives after it starts. For what is already there, read, or pass --after <id>.' : `Nothing came after ${waitsOn.after}.`],
          next: [{ instruction: 'See what is there now', argv: [...cli(), 'read', ...(thread ?? flags.re ?? args[0] ? [(thread ?? flags.re ?? args[0])!] : [])] }],
        })
      }
      if (flags.json) result({ event })
      else {
        out(formatEvent(event))
        // One event a wait: this is where it stopped, so the next wait misses nothing after it.
        // This run as typed, its board, identity and filters included, from where it stopped.
        out(`next: ${commandLine(rerunWithout(['--after'], '--after', String(event.cursor)))}`)
      }
      return 0
    }

    case 'tasks':
      return tasks(args)

    default: {
      const own = app.commands[command]
      if (own) return own.run(args, context())
      throw unknownCommand(command)
    }
  }
}

/** Every name a command runs by here: board's, their aliases, and the app's own. */
const commandNames = () => [...commands.flatMap((known) => [known.name, ...(known.aliases ?? [])]), ...Object.keys(app.commands)]

/** `command` names nothing here: the closest that does, or what it goes by here. */
function unknownCommand(command: string): Failed {
  const guess = closest(command, commandNames())
  // What people and agents type for a command that goes by another name here.
  const other = Object.hasOwn(OTHER_NAMES, command.toLowerCase()) ? OTHER_NAMES[command.toLowerCase()] : undefined
  // On a team's board, what works there; where nothing says which board, what works on every one.
  const said = other?.teams && onTeamBoard() !== false ? other.teams : other
  return usage(`Unknown command ${command} for ${named()}.${said ? '' : guess ? ` Did you mean ${guess}?` : ''}`, {
    reason: 'unknown_command',
    next: [
      ...(said ? [{ instruction: said.instruction, argv: [...cli(), ...said.argv] }] : []),
      { instruction: 'See all commands', argv: [...cli(), '--help'] },
    ],
  })
}

/** What `tasks` does to a task, by the word after it: any other word is a channel to list. */
const TASK_VERBS = new Set(['create', 'claim', 'run', 'renew', 'release', 'complete', 'fail', 'block', 'unblock', 'reopen', 'assign', 'needs', 'cancel'])
const TASK_STATES = ['waiting', 'ready', 'claimed', 'blocked', 'completed', 'failed', 'canceled']

/** A task's ID as you'd write it: `#812` or `812`. */
const taskId = (value: string | undefined) => messageId(value, 'task ID')

/** `--wait` or `--lease` in seconds: a number and a unit, as `schedule` takes a duration. A lease is 30s to 1h. */
function seconds(flag: 'wait' | 'lease'): number | undefined {
  const value = flags[flag]
  if (value === undefined) return undefined
  const found = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(value)
  if (!found) throw usage(`--${flag} takes a duration like 30s or 10m, and ${value} isn't one.`)
  const total = Number(found[1]) * { s: 1, m: 60, h: 3600, d: 86_400 }[found[2] as 's' | 'm' | 'h' | 'd']
  if (flag === 'lease' && (total < 30 || total > 3600)) throw usage(`--lease takes 30s to 1h, and ${value} isn't in it.`)
  return total
}

/**
 * `tasks create <channel> --file <path>`: the tasks a JSON file holds, as `tasks.createMany`
 * takes them, made in as many writes as the board needs. It prints each as the list shows one.
 * The whole plan goes under one key, `--idempotency-key`'s or this run's own, so one that stops
 * midway says what was made and is finished by the same command.
 */
async function createPlan(target: string, text: string | undefined, path: string): Promise<number> {
  if (isMessageRef(target)) throw usage(`--file holds a plan, which starts threads in a channel, and ${ref(target)} is a thread.`)
  if (text !== undefined) throw usage("Text is one task's: with --file, each task in the file has its own.")
  // What the file holds comes first: one task's text in it means these options are that task's, on stdin.
  const parsed = await planSource(path)
  const own = (['label', 'needs', 'for', 'claim', 'lease', 'no-sync'] as const).find((name) => (flags as Record<string, unknown>)[name] !== undefined && (flags as Record<string, unknown>)[name] !== false)
  if (own !== undefined) throw usage(`--${own} is one task's: with --file, each task in the file has its own.`)
  const board = client()
  const tasks = await planFrom(parsed, path, board)
  // Each root is a message: the longest says what a backend's refusal of one's text means, as for a task made alone.
  sentLength = Math.max(0, ...tasks.map((task) => (typeof task.text === 'string' ? task.text.length : 0)))
  const key = flags['idempotency-key'] ?? crypto.randomUUID()
  let made: MessageView[]
  try {
    made = await createTasksInChunks(board, target, tasks, { id: key })
  } catch (error) {
    if (!(error instanceof TasksInChunksError)) throw error
    const there = error.created.filter((task) => task !== undefined)
    const failed = failureOf(error)
    // The key made another plan: other tasks, or these and no more. What it found of this one was there before, and
    // the same command again would end the same way.
    if (error.code === 'duplicate_id')
      throw new Failed({
        ...failed,
        message: `${failed.message} That key made another plan.`,
        next: [{ instruction: 'Leave what the key made as it was, or make new tasks under another key' }],
      })
    // Nothing made is the failure alone. Some made: which, and the command that makes the rest, under the same key.
    if (there.length === 0) throw new Failed(failed)
    throw new Failed({
      ...failed,
      details: [...(failed.details ?? []), `made ${there.length} of ${tasks.length}: ${ref(there[0]!.id)} to ${ref(there.at(-1)!.id)}`],
      next: [{ instruction: 'Make the rest, under the same key: what was made stays as it is', argv: rerunWithout(['--idempotency-key'], '--idempotency-key', key) }],
      data: { ...failed.data, created: there.map((task) => task.id), total: tasks.length },
    })
  }
  if (flags.json) result({ tasks: made })
  else out(formatTasks(made.map((message) => ({ message, replies: 0, last: null }))))
  return 0
}

/** What a task of a plan's `--file` takes, as `tasks.createMany` does. */
const PLAN_KEYS = ['key', 'text', 'labels', 'needs', 'for', 'noSync', 'attachments']

/** The help page that says what a plan holds. */
const planHelp = (): Recovery => ({ instruction: 'See what a plan takes', argv: [...cli(), 'tasks', 'create', '--help'] })

/** One of a plan task's `needs`: a task that's there, by its ID as text, as a number, or as `{ "id": … }`, or `{ "key": … }` for one of the plan's own. */
function isNeed(need: unknown): boolean {
  if (typeof need === 'string') return need.replace(/^#/, '').length > 0
  if (typeof need === 'number') return Number.isSafeInteger(need) && need >= 0
  if (typeof need !== 'object' || need === null) return false
  const keys = Object.keys(need)
  if (keys.length !== 1) return false
  const value = (need as Record<string, unknown>)[keys[0]!]
  if (keys[0] === 'id') return typeof value === 'string' && isNeed(value)
  return keys[0] === 'key' && typeof value === 'string'
}

/** A need as the board takes it: an ID as it is, or `{ "key": … }`, which a bare string is when it's a key of the plan's own. */
function boardNeed(need: unknown, keys: ReadonlySet<string>): unknown {
  if (typeof need === 'string' && keys.has(need)) return { key: need }
  return idNeed(need)
}

function idNeed(need: unknown): unknown {
  if (typeof need === 'string') return need.replace(/^#/, '')
  if (typeof need === 'number') return String(need)
  if (typeof need === 'object' && need !== null && 'id' in need) return idNeed(need.id)
  return need
}

/**
 * Refuses a plan that says something a task doesn't take, before anything is sent. The board
 * drops a key it doesn't know, so a `need` for `needs` would make a task that waits for nothing,
 * without a word: here the file can say which task, and the key that was meant.
 */
function checkPlan(plan: Record<string, unknown>[], where: string): void {
  for (const [at, task] of plan.entries()) {
    const unknown = Object.keys(task).find((name) => !PLAN_KEYS.includes(name))
    if (unknown !== undefined) {
      const meant = PLAN_KEYS.find((known) => known.toLowerCase() === unknown.toLowerCase()) ?? closest(unknown, PLAN_KEYS)
      throw new Failed({
        class: 'usage',
        reason: 'invalid_arguments',
        message: `Unknown key ${JSON.stringify(unknown)} on task ${at + 1} of ${where}.${meant ? ` Did you mean ${JSON.stringify(meant)}?` : ''}`,
        ...(meant ? {} : { details: [`a task takes ${PLAN_KEYS.join(', ')}`] }),
        next: [planHelp()],
      })
    }
    if (!('needs' in task)) continue
    const needs = '[{"key": "fix"}, "812"]'
    if (!Array.isArray(task.needs)) throw usage(`Task ${at + 1} of ${where} has needs that aren't a list, such as ${needs}.`, { next: [planHelp()] })
    const odd = task.needs.find((need) => !isNeed(need))
    if (odd !== undefined) {
      const said = JSON.stringify(odd)
      throw usage(`Task ${at + 1} of ${where} needs ${said.length > 60 ? `${said.slice(0, 59)}…` : said}. A need is a key of the plan's own, like "fix" or {"key": "fix"}, or a task's ID as vb prints it or as {"id": "…"}.`, { next: [planHelp()] })
    }
  }
}

/**
 * What a plan's `--file` holds, as JSON: the file, or stdin for `-`. Prose is the likeliest slip,
 * --file carried over from post, where it's the text: it says the same command with the file on
 * stdin, `-` as the text, and the options it was given.
 */
async function planSource(path: string): Promise<unknown> {
  const where = path === '-' ? 'stdin' : path
  let source: string
  if (path === '-') source = await io.stdin()
  else {
    const data = await io.readFile(path)
    if (!data) throw usage(`Can't read ${path}. There's no such file.`, { reason: 'file_not_found', next: [] })
    source = new TextDecoder().decode(data)
  }
  try {
    return JSON.parse(source)
  } catch {
    const piped = `${commandLine(rerunWithout(['--file'], '-'))}${path === '-' ? '' : ` < ${commandLine([path])}`}`
    throw usage(`${where} isn't JSON: --file on tasks create is a plan of tasks.`, { next: [{ instruction: `One task's text goes on stdin, as -: ${piped}` }, planHelp()] })
  }
}

/** The tasks a plan's `--file` holds: a JSON array. An ID may be written `#812`, and `for` as a profile's name. */
async function planFrom(parsed: unknown, path: string, board: Board): Promise<TaskInBatch[]> {
  const where = path === '-' ? 'stdin' : path
  const shape = 'A plan is a JSON array of tasks: [{"key": "fix", "text": "…"}, {"text": "…", "needs": [{"key": "fix"}]}].'
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((task) => typeof task !== 'object' || task === null || Array.isArray(task))) throw usage(`${where} holds no tasks. ${shape}`, { next: [planHelp()] })
  const plan = parsed as (Record<string, unknown> & { needs?: unknown; for?: unknown })[]
  checkPlan(plan, where)
  // A profile's name is the caller's own profile, as --for takes one: an actor's ID goes as it is.
  const named = plan.some((task) => typeof task.for === 'string' && !task.for.includes(':'))
  const principal = named ? (await board.me()).principal : ''
  const keys = new Set(plan.flatMap((task) => (typeof task.key === 'string' ? [task.key] : [])))
  return plan.map((task) => ({
    ...task,
    ...(Array.isArray(task.needs) ? { needs: task.needs.map((need) => boardNeed(need, keys)) } : {}),
    ...(typeof task.for === 'string' && !task.for.includes(':') ? { for: profileActor(principal, task.for) } : {}),
  })) as TaskInBatch[]
}

/** `--claim`, on `tasks create`: a flag there (`optionsFor`), where a grant's takes a value. */
const claimFlag = () => (flags as { claim?: unknown }).claim === true

/**
 * The profile this run writes as, as an actor's ID has it: `--as`'s, or the environment's
 * (`BOARD_PROFILE`), or null as yourself. `vb()`'s board is a handle that already is someone, so
 * only `--as` names one there.
 */
function writesAs(): string | null {
  const profile = profileFlag() ?? (io.board ? null : environmentProfile())
  const name = typeof profile === 'string' ? profile : (profile?.name ?? null)
  return name === null ? null : name.toLowerCase()
}

/** `--as` as this run typed it, for a way out that claims: the claim it takes is then the one the next command, typed the same way, finds. */
const asTyped = () => (flags.as ? ['--as', flags.as] : [])

/**
 * This run's board, and the claims it holds there as whoever it writes as. A claim's token is the
 * CLI's to keep: in a file under its config directory, by the board's URL, the task, and the
 * profile this run writes as; or for `vb()`, whose board is a handle, in the store its caller
 * passes, or else in memory for as long as the handle lasts.
 */
function tasksOn(): { board: Board; claims: Claims } {
  const profile = writesAs()
  if (io.board && io.claimToken !== undefined) return { board: client(), claims: tokenClaims(client(), io.claimToken) }
  if (io.board) return { board: client(), claims: io.claims?.(profile) ?? memoryClaims(io.claimsOf ?? io.board, profile) }
  const { board, url } = connection()
  return { board, claims: fileClaims(async () => url ?? (await board.discovery()).url, profile) }
}

/** The actor `profile` names under `principal`: a task is assigned to one of its owner's profiles. */
const profileActor = (principal: string, profile: string) => `${principal}+${profile.toLowerCase()}`

/** A write to a task that answers its root: with `--json`, the task and what happened to it. */
function printTask(task: MessageView, outcome: string, more: object = {}) {
  if (flags.json) result({ task, outcome, ...more })
  else out(`${outcome} ${messageRef(task.id)}`)
}

/** A claim: the task, how long it's yours, and what it is. With `--json`, the task and the claim, without its token, which the CLI keeps. */
function printClaim(task: MessageView, claim: { epoch: number; until: string }, more: object = {}) {
  if (flags.json) result({ task, claim: { epoch: claim.epoch, until: claim.until }, ...more })
  else out(claimLine(task, claim.until))
}

/**
 * This run's claim on task `id`, as the board's handle acts on it, or the failure that says it
 * holds none as whoever it writes as: a claim taken as one profile isn't another's, or yours.
 */
async function heldBy(board: Board, claims: Claims, id: string) {
  const stored = await claims.get(id)
  if (stored) return board.tasks.held(id, stored)
  const none = `You hold no claim on task ${ref(id)} as ${writesAs() ?? 'yourself'}.`
  const claim: Recovery = { instruction: 'Claim it', argv: [...cli(), 'tasks', 'claim', id, ...asTyped()] }
  // A claim of one that's held, waiting, or finished would be refused too: what it is says the step that comes first, or that there's none.
  const task = await board.thread(id).then(({ message }) => message.task, () => undefined)
  const see: Recovery = { instruction: 'See where it stands', argv: [...cli(), 'read', id] }
  if (task?.state === 'blocked')
    throw new Failed({
      class: 'conflict',
      reason: 'claim_not_held',
      message: `${none} It's held for a person: claim it once the hold lifts.`,
      next: [{ instruction: 'As its owner, lift the hold, then claim it', argv: [...cli(), 'tasks', 'unblock', id] }, see],
    })
  if (task?.state === 'waiting') {
    const needs = task.needs.map(ref)
    throw new Failed({
      class: 'conflict',
      reason: 'claim_not_held',
      message: `${none} It waits for what it needs${needs.length ? ` (${needs.join(', ')})` : ''}: claim it once those complete.`,
      next: [{ instruction: 'See what it waits for', argv: [...cli(), 'read', id] }],
    })
  }
  if (task?.state === 'completed' || task?.state === 'failed' || task?.state === 'canceled')
    throw new Failed({ class: 'conflict', reason: 'claim_not_held', message: `${none} It's ${task.state} already.`, next: [see] })
  throw new Failed({ class: 'conflict', reason: 'claim_not_held', message: none, next: [claim] })
}

/** A write a claim makes. One the board answers `claim_lost` is over: the CLI forgets it, and the failure says how to claim again. */
async function withClaim<T>(claims: Claims, id: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    if (error instanceof BoardError && error.code === 'claim_lost') await claims.drop(id)
    throw error
  }
}

/**
 * `--label` on `claim --ready` and `run --ready`: each an exact `key=value`, the one thing a claim
 * matches. The list's `key=a|b` and bare `key` would match nothing, or the value `a|b`, and wait
 * out its `--wait` without a word: they're refused, with the claim of one value and the list.
 */
function readyLabels(values: string[], target: string, verb: 'claim' | 'run'): Record<string, string> {
  for (const value of values) {
    const at = value.indexOf('=')
    const options = at > 0 ? value.slice(at + 1).split('|') : []
    if (at > 0 && options.length < 2) continue
    const key = at > 0 ? value.slice(0, at) : value
    if (at === 0) throw usage(`--label on ${verb} --ready takes key=value, and ${value} has no key before its =.`)
    const listed = { instruction: "See what's ready, and their labels", argv: [...cli(), 'tasks', target, '--state', 'ready', '--label', value] }
    if (at === -1)
      throw usage(`--label on ${verb} --ready takes key=value: ${value} has no value, and a claim matches one exactly.`, { next: [listed] })
    // The same command with the first value alone, the label written as it was. What follows `--` is run's
    // command, which it hands over as it is: the same text there is the command's own, and stays.
    const one = `${key}=${options[0]}`
    const dash = typed.indexOf('--')
    const ours = (index: number) => dash === -1 || index < dash
    const again = [...cli(), ...typed.map((arg, index) => (!ours(index) ? arg : arg === value && typed[index - 1] === '--label' ? one : arg === `--label=${value}` ? `--label=${one}` : arg))]
    throw usage(`--label on ${verb} --ready takes one value: ${value} has ${options.length}, and a claim matches one exactly.`, {
      next: [{ instruction: `Claim one with ${one}`, argv: again }, listed],
    })
  }
  return labelPairs(values)
}

/**
 * Claims a task for this run, by its ID or with `--ready` the oldest ready one in `target`, and
 * keeps the claim. With nothing ready it fails: `nothing_ready`, or `timeout` once `--wait` ran
 * out, as `wait` does. Stopped while it waits, it answers the exit code instead.
 */
async function claimFor(board: Board, claims: Claims, target: string | undefined, verb: 'claim' | 'run'): Promise<ClaimedTask | number> {
  const lease = seconds('lease')
  if (!flags.ready) {
    for (const given of ['label', 'from', 'wait'] as const)
      if (flags[given] !== undefined) throw usage(`--${given} goes with --ready, which claims the next ready task in a channel.`)
    const claim = await board.tasks.claim(taskId(target), { ...(lease !== undefined ? { lease } : {}), ...(io.claimToken !== undefined ? { token: io.claimToken } : {}) })
    await claims.put(claim.task.id, { epoch: claim.epoch, token: claim.token, until: claim.until })
    return claim
  }
  if (target === undefined) throw usage('Missing the channel to claim a task in: work, or work/ for all under it.', { reason: 'missing_arguments' })
  const wait = seconds('wait')
  // In-process, calls run one at a time: one that waits holds the rest, so it needs a way to be stopped, as `wait` does.
  if (io.board && !io.signal && wait !== undefined)
    throw usage('--wait holds every later call, as vb() runs one at a time: pass a signal.', { reason: 'not_available', next: [] })
  const controller = new AbortController()
  const stop = stopOn(controller)
  let claim: ClaimedTask | null
  try {
    claim = await board.tasks.claim(
      {
        channel: target,
        ...(flags.label?.length ? { label: readyLabels(flags.label, target, verb) } : {}),
        // Owners by their IDs: a handle names no owner.
        ...(flags.from?.length ? { from: flags.from } : {}),
        ...(wait !== undefined ? { wait } : {}),
        ...(lease !== undefined ? { lease } : {}),
        ...(io.claimToken !== undefined ? { token: io.claimToken } : {}),
      },
      { signal: controller.signal },
    )
  } catch (error) {
    // Stopped while it waited: it says nothing, as `wait` does.
    if (controller.signal.aborted) return stop.interrupted() ? 130 : 0
    throw error
  } finally {
    stop.release()
  }
  if (claim) {
    await claims.put(claim.task.id, { epoch: claim.epoch, token: claim.token, until: claim.until })
    return claim
  }
  if (controller.signal.aborted) return stop.interrupted() ? 130 : 0
  if (wait !== undefined) throw new Failed({ class: 'timeout', reason: 'timeout', message: `Nothing was ready in ${target} within ${flags.wait}.` })
  throw new Failed({
    class: 'not_found',
    reason: 'nothing_ready',
    message: `Nothing is ready in ${target}.`,
    next: [
      { instruction: 'Wait for one', argv: rerun('--wait', '10m') },
      { instruction: "Or see what's there", argv: [...cli(), 'tasks', target] },
    ],
  })
}

/** `tasks`: the list, or what the word after it does to a task. */
async function tasks(args: string[]): Promise<number> {
  const [verb, ...rest] = args
  if (verb === undefined || !TASK_VERBS.has(verb)) {
    if (rest.length > 0) {
      // Two words, the first no verb: the list takes one channel, so it's a command this one doesn't have.
      const guess = closest(verb!, TASK_VERBS)
      throw usage(`Unknown command ${verb} for ${named()} tasks.${guess ? ` Did you mean ${guess}?` : ''}`, { reason: 'unknown_command' })
    }
    const state = flags.state
    if (state !== undefined && state !== 'open' && state !== 'all' && !TASK_STATES.includes(state))
      throw usage(`--state takes a task's state, open, or all, and ${state} isn't one.`)
    const board = client()
    const limit = flags.limit ? Number(flags.limit) : 50
    const page = await board.tasks.list({
      ...(verb ? { channel: verb } : {}),
      ...(state ? { state: state as 'open' } : {}),
      ...(flags.label?.length ? { label: flags.label } : {}),
      ...(flags.by ? { by: flags.by.replace(/^@/, '') } : {}),
      ...(flags.for ? { for: profileActor((await board.me()).principal, flags.for) } : {}),
      ...(flags.after !== undefined ? { after: flags.after.replace(/^#/, '') } : {}),
      limit,
    })
    // Nothing in a channel that doesn't exist is a typo, of a channel or of what to do.
    if (page.tasks.length === 0 && verb && flags.after === undefined) {
      const channels = (await everyChannel(board)).map((c) => c.path)
      // `work/` is `work` and what's under it: the channel itself is enough for it to be there.
      const name = verb.replace(/\/$/, '')
      if (!channels.some((path) => path === name || path.startsWith(`${name}/`))) {
        const meant = closest(verb, TASK_VERBS)
        if (meant) throw usage(`Unknown command ${verb} for ${named()} tasks. Did you mean ${meant}?`, { reason: 'unknown_command' })
        const guess = closest(verb, channels)
        throw new Failed({
          class: 'not_found',
          reason: 'channel_not_found',
          message: `Couldn't find channel ${verb}.${guess ? ` Did you mean ${guess}?` : ''}`,
          next: [{ instruction: 'See its channels', argv: [...cli(), 'channels'] }],
        })
      }
    }
    if (flags.json) return result(page), 0
    if (page.tasks.length === 0) {
      const which = state === undefined || state === 'open' ? 'open ' : state === 'all' ? '' : `${state} `
      return out(`no ${which}tasks${verb ? ` in ${verb}` : ''}`), 0
    }
    out(formatTasks(page.tasks))
    // A full page may not be all of them: where the next one starts.
    // A command to paste: each word quoted for a shell, the board's cursor among them, as `read` and `tail` print theirs.
    if (page.tasks.length === limit) out(`(more not shown: ${commandLine(rerunWithout(['--after'], '--after', page.cursor))})`)
    return 0
  }

  if (verb === 'create') {
    const [target, body, extra] = rest
    if (!target) throw usage("Missing a channel to start a task in, or a thread's ID to make one of.", { reason: 'missing_arguments' })
    if (extra !== undefined) throw usage(`tasks create takes a channel and quoted text: ${extra} is one too many.`)
    if (flags.file !== undefined) return createPlan(target, body, flags.file)
    const lease = seconds('lease')
    if (lease !== undefined && !claimFlag()) throw usage('--lease is how long a claim holds the task: pass --claim too.')
    const { board, claims } = tasksOn()
    const about = {
      ...(flags.needs?.length ? { needs: flags.needs.map((id) => taskId(id)) } : {}),
      ...(flags.for ? { for: profileActor((await board.me()).principal, flags.for) } : {}),
      ...(claimFlag() ? { claim: true } : {}),
      ...(lease !== undefined ? { lease } : {}),
      ...(claimFlag() && io.claimToken !== undefined ? { token: io.claimToken } : {}),
    }
    let made: Awaited<ReturnType<Board['tasks']['create']>>
    if (isMessageRef(target)) {
      // A thread that's there becomes a task as it is: what it says and wears are its author's.
      const own = body !== undefined ? 'text' : (['label', 'no-sync', 'idempotency-key'] as const).find((name) => flags[name] !== undefined && flags[name] !== false)
      if (own !== undefined)
        throw usage(`${ref(target)} becomes a task as it is: ${own === 'text' ? 'text' : `--${own}`} is for a new thread.`, {
          next: [{ instruction: 'Make it a task as it is', argv: [...cli(), 'tasks', 'create', messageId(target)] }],
        })
      made = await board.tasks.create({ re: messageId(target) }, about)
    } else {
      // A task's root is a message: how long its text is says what a backend's refusal of it means, as for a post.
      const said = await text(body, { missing: "Missing the task's text: pass it, or - to read it from stdin. --file takes a plan of several." })
      sentLength = said.length
      made = await board.tasks.create(target, {
        text: said,
        ...(flags.label?.length ? { labels: labelPairs(flags.label) } : {}),
        ...(flags['no-sync'] ? { noSync: true } : {}),
        ...(flags['idempotency-key'] ? { id: flags['idempotency-key'] } : {}),
        ...about,
      })
    }
    // What became of the handles its text typed: in the result with --json, and after the task's line without.
    const mentions = made.mentions ? { mentions: made.mentions } : {}
    if (flags.json) sayMentions(made.mentions)
    if (made.claim) {
      await claims.put(made.task.id, { epoch: made.claim.epoch, token: made.claim.token, until: made.claim.until })
      printClaim(made.task, made.claim, { outcome: 'created', ...mentions })
    } else if (flags.json) result({ task: made.task, outcome: 'created', ...mentions })
    else out(messageRef(made.task.id))
    if (!flags.json) sayMentions(made.mentions)
    return 0
  }

  if (verb === 'claim') {
    if (rest.length > 1) throw usage(`tasks claim takes one ${flags.ready ? 'channel' : 'task'}: ${rest[1]} is one too many.`)
    if (!flags.ready && rest[0] === undefined) throw usage('Missing the task to claim: its ID, or --ready and a channel.', { reason: 'missing_arguments' })
    const { board, claims } = tasksOn()
    const claim = await claimFor(board, claims, rest[0], 'claim')
    if (typeof claim === 'number') return claim
    printClaim(claim.task, claim)
    return 0
  }

  if (verb === 'run') {
    // What follows `--` is the command, whole: the parser hands it over as arguments, after the task or the channel.
    const dash = typed.indexOf('--')
    const command = dash === -1 ? [] : typed.slice(dash + 1)
    if (command.length === 0)
      throw usage('Missing the command to run: put it after --.', { reason: 'missing_arguments', next: [{ instruction: 'Run a command on a task', argv: [...cli(), 'tasks', 'run', '<ID>', '--', '<COMMAND>'] }] })
    const before = rest.slice(0, rest.length - command.length)
    if (before.length > 1) throw usage(`tasks run takes one ${flags.ready ? 'channel' : 'task'} before --: ${before[1]} is one too many.`)
    if (!flags.ready && before[0] === undefined) throw usage('Missing the task to run it on: its ID, or --ready and a channel.', { reason: 'missing_arguments' })
    // It runs a command on this machine, and holds every other call for as long as it runs.
    if (io.board) throw usage("tasks run isn't available in-process: it runs a command on this machine.", { reason: 'not_available', next: [] })
    const { board, claims } = tasksOn()
    const claim = await claimFor(board, claims, before[0], 'run')
    if (typeof claim === 'number') return claim
    const id = claim.task.id
    const lease = seconds('lease')
    const ran = await runCommand(command, {
      env: { ...process.env, BOARD_TASK: id },
      // With --json this run's stdout is one document: what the command prints goes to stderr.
      ...(flags.json ? { stdout: 'stderr' as const } : {}),
      // A third of the lease the board gave, so two renewals can fail before it runs out.
      every: (Date.parse(claim.until) - Date.now()) / 3,
      async renew() {
        try {
          const renewed = await claim.renew(lease)
          await claims.put(id, { epoch: renewed.epoch, token: renewed.token, until: renewed.until })
          return true
        } catch (error) {
          // Lost, the command works a task that's someone else's now: it stops. Anything else is tried again at the next turn.
          return !(error instanceof BoardError && error.code === 'claim_lost')
        }
      },
    })
    if (ran.how === 'lost') {
      await claims.drop(id)
      throw new Failed({
        class: 'conflict',
        reason: 'claim_lost',
        message: `Lost the claim on task ${ref(id)} while the command ran, so it was stopped.`,
        next: [{ instruction: 'See where the task stands', argv: [...cli(), 'read', id] }],
      })
    }
    if (ran.how === 'unstarted') {
      // Nothing ran, so the task goes back as it was.
      await claim.release().catch(() => {})
      await claims.drop(id)
      throw new Failed({ class: 'not_found', reason: 'command_not_found', message: `Couldn't run ${command[0]}. ${sentence(ran.why)}`, details: [`Task ${ref(id)} was released.`] })
    }
    if (ran.how === 'interrupted') {
      await withClaim(claims, id, () => claim.release())
      await claims.drop(id)
      // 130 for Ctrl-C, 143 for a supervisor's SIGTERM: what the signal would have said had it ended this process.
      return ran.code
    }
    const settled = ran.code === 0
      ? await withClaim(claims, id, () => claim.complete(flags.result))
      : await withClaim(claims, id, () => claim.fail(ran.signal ? `killed by ${ran.signal}` : `exited ${ran.code}`))
    await claims.drop(id)
    printTask(settled, ran.code === 0 ? 'completed' : 'failed', ran.code === 0 ? {} : { code: ran.code })
    return ran.code
  }

  const id = taskId(rest[0])
  const one = (extra: string | undefined, takes: string) => {
    if (extra !== undefined) throw usage(`tasks ${verb} takes ${takes}: ${extra} is one too many.`)
  }
  const reason = (what: string) => {
    const given = rest[1]?.trim()
    if (!given) throw usage(`Missing ${what}, in a line.`, { reason: 'missing_arguments' })
    return given
  }
  const { board, claims } = tasksOn()

  switch (verb) {
    case 'renew': {
      one(rest[1], 'one task')
      const lease = seconds('lease')
      const held = await heldBy(board, claims, id)
      const claim = await withClaim(claims, id, () => held.renew(lease))
      await claims.put(id, { epoch: claim.epoch, token: claim.token, until: claim.until })
      printClaim(claim.task, claim)
      return 0
    }
    case 'release': {
      one(rest[1], 'one task')
      const held = await heldBy(board, claims, id)
      const task = await withClaim(claims, id, () => held.release())
      await claims.drop(id)
      printTask(task, 'released')
      return 0
    }
    case 'complete': {
      one(rest[2], 'a task and its result, quoted')
      const held = await heldBy(board, claims, id)
      const task = await withClaim(claims, id, () => held.complete(rest[1]))
      await claims.drop(id)
      printTask(task, 'completed')
      return 0
    }
    case 'fail': {
      one(rest[2], 'a task and a reason, quoted')
      const why = reason('why it failed')
      const held = await heldBy(board, claims, id)
      const task = await withClaim(claims, id, () => held.fail(why))
      await claims.drop(id)
      printTask(task, 'failed')
      return 0
    }
    case 'block': {
      one(rest[2], 'a task and a reason, quoted')
      const why = reason('what you need from a person')
      const hold = flags.kind !== undefined ? { kind: flags.kind } : {}
      // With the claim this run holds, which the hold ends; without one, as the task's owner.
      const stored = await claims.get(id)
      const task = stored ? await withClaim(claims, id, () => board.tasks.held(id, stored).block(why, hold)) : await board.tasks.block(id, why, hold)
      await claims.drop(id)
      printTask(task, 'blocked')
      return 0
    }
    case 'unblock':
    case 'reopen': {
      one(rest[1], 'one task')
      // The board answers the task either way: what it was says whether this changed it.
      const from = verb === 'unblock' ? 'blocked' : 'failed'
      const was = (await board.thread(id)).message.task?.state
      const task = verb === 'unblock' ? await board.tasks.unblock(id) : await board.tasks.reopen(id)
      if (was === from) printTask(task, verb === 'unblock' ? 'unblocked' : 'reopened')
      else if (flags.json) result({ task, outcome: 'unchanged' })
      else out(`${messageRef(id)} wasn't ${from}`)
      return 0
    }
    case 'assign': {
      one(rest[2], 'a task and a profile')
      const profile = rest[1]
      if (flags.pool && profile !== undefined) throw usage(`A profile keeps ${ref(id)} for it, and --pool for no one: pass one of them.`)
      if (!flags.pool && profile === undefined) throw usage('Missing the profile to assign it to, such as fixer, or --pool for anyone.', { reason: 'missing_arguments' })
      // One of its owner's profiles, whoever assigns it: its owner, or someone who manages its channel.
      const owner = profile === undefined ? null : (await board.thread(id)).message.task?.owner
      const task = await board.tasks.assign(id, profile === undefined ? null : profileActor(owner ?? (await board.me()).principal, profile))
      if (flags.json) result({ task, outcome: profile === undefined ? 'unassigned' : 'assigned' })
      else out(profile === undefined ? `unassigned ${messageRef(id)}` : `assigned ${messageRef(id)} to ${profile.toLowerCase()}`)
      return 0
    }
    case 'needs': {
      const needs = rest.slice(1).map((need) => taskId(need))
      if (flags.none && needs.length > 0) throw usage(`Tasks are what ${ref(id)} waits for, and --none for nothing: pass one of them.`)
      if (!flags.none && needs.length === 0) throw usage('Missing the tasks it waits for now, by ID, or --none for nothing.', { reason: 'missing_arguments' })
      const task = await board.tasks.needs(id, needs)
      // What it waits for now, as the board has it: the line `tasks` shows under it, and `tail` when it changes.
      const now = task.task?.needs ?? []
      if (flags.json) result({ task, outcome: 'set' })
      else out(`${messageRef(id)} needs ${now.length ? now.map((need) => ref(need)).join(' ') : 'nothing'}`)
      return 0
    }
    default: {
      // cancel
      one(rest[2], 'a task and a reason, quoted')
      const task = await board.tasks.cancel(id, reason('why'))
      // A claim this run held on it ended with it.
      await claims.drop(id)
      printTask(task, 'canceled')
      return 0
    }
  }
}

/** How a board's own word about a task reads from here: the headline, and the way on. Null for any other code. */
function taskFailure(code: string, status: number): { class: Failure['class']; message: string; next: Recovery[]; whole?: true } | null {
  const { command, args } = current
  const named = command === 'tasks' && args[0] !== undefined && TASK_VERBS.has(args[0]) && args[1] !== undefined && isMessageRef(args[1]) ? messageId(args[1]) : undefined
  const read = (instruction: string): Recovery[] => (named === undefined ? [] : [{ instruction, argv: [...cli(), 'read', named] }])
  const also = (instruction: string, ...words: string[]): Recovery[] => (named === undefined ? [] : [{ instruction, argv: [...cli(), 'tasks', words[0]!, named, ...words.slice(1)] }])
  switch (code) {
    case 'task_claimed':
      return { class: 'conflict', message: `Can't ${doing()}. Someone holds it.`, next: read('See who holds it, and until when') }
    case 'task_assigned':
      return { class: 'conflict', message: `Can't ${doing()}. It's assigned to another profile.`, next: [...read("See whom it's for"), ...also('Or, as its owner, return it to the pool', 'assign', '--pool')] }
    case 'task_waiting':
      return { class: 'conflict', message: `Can't ${doing()}. It waits for other tasks.`, next: read('See what it waits for') }
    case 'task_blocked':
      return { class: 'conflict', message: `Can't ${doing()}. It's held for a person.`, next: [...read("See what it's held for"), ...also('Or, as its owner, lift the hold', 'unblock')] }
    case 'task_finished':
      return { class: 'conflict', message: `Can't ${doing()}. It's finished.`, next: read('See how it ended') }
    case 'claim_lost':
      return { class: 'conflict', message: `Lost the claim on ${named === undefined ? 'the task' : `task ${ref(named)}`}. Its lease ran out, or the task moved on.`, next: [...read('See where it stands'), ...also('Or claim it again', 'claim', ...asTyped())] }
    case 'task_not_owned':
      return { class: 'permission', message: `You can't ${doing()}. It's someone else's.`, next: read('See whose it is') }
    case 'not_a_task':
      return { class: 'not_found', message: `${named === undefined ? 'That' : ref(named)} isn't a task.`, next: also('Make it one', 'create'), whole: true }
    case 'already_a_task':
      return { class: 'conflict', message: `${named === undefined ? 'That' : ref(named)} is a task already.`, next: read('See it'), whole: true }
    case 'invalid_from':
      return { class: 'usage', message: `Can't ${doing()}. --from takes an owner's ID: several can share a handle.`, next: [{ instruction: "See everyone's IDs", argv: [...cli(), 'actors'] }] }
    case 'invalid_needs':
      // A plan's tasks name each other by key too: what's wrong is in the board's words, under this.
      if (flags.file !== undefined) return { class: 'usage', message: `Can't ${doing()}. A task's needs are tasks you can read, or keys of the plan's own.`, next: [{ instruction: 'See the tasks there are', argv: [...cli(), 'tasks', '--state', 'all'] }] }
      // A change of what a task waits for takes what a new task takes, and none that waits for it: the board's words say which.
      if (command === 'tasks' && args[0] === 'needs') return { class: 'usage', message: `Can't ${doing()}. It waits for tasks you can read, and none that waits for it.`, next: [...read('See what it waits for now'), { instruction: 'Or see the tasks there are', argv: [...cli(), 'tasks', '--state', 'all'] }] }
      return { class: 'usage', message: `Can't ${doing()}. --needs takes tasks you can read.`, next: [{ instruction: 'See the tasks there are', argv: [...cli(), 'tasks', '--state', 'all'] }] }
    // A board's own bounds on how much one request looks through, as Vercel's has: less of the tree fits.
    case 'claim_too_wide':
      return { class: 'limit', message: `Can't ${doing()}. That's too many channels and owners.`, next: [{ instruction: 'Name fewer owners with --from, or a smaller subtree' }] }
    case 'channel_tree_too_large':
      return { class: 'limit', message: `Can't ${doing()}. That's too many channels.`, next: [{ instruction: 'Name a channel, or a smaller subtree' }] }
    case 'no_tasks':
      return status === 501 ? { class: 'platform', message: `Can't ${doing()}. This board keeps no tasks.`, next: [] } : null
    case 'reserved_label':
      return { class: 'usage', message: `Can't ${doing()}. Labels under board. are the board's own.`, next: stateCommand() }
    default:
      return null
  }
}

/**
 * The `tasks` command for the change a write under `board.task` was after, from what this run was
 * given: a label write names the state it wanted, and a labeled post a task it meant to start.
 */
function stateCommand(): Recovery[] {
  const { command, args } = current
  const tasksDo = (instruction: string, ...words: string[]): Recovery => ({ instruction, argv: [...cli(), 'tasks', ...words] })
  if (command === 'label' && args[0] !== undefined) {
    const id = messageId(args[0])
    const wanted = args.slice(1).find((pair) => pair.startsWith('board.task='))?.slice('board.task='.length)
    if (wanted === undefined) return flags.unset?.includes('board.task') ? [tasksDo('Cancel the task', 'cancel', id, '<REASON>')] : []
    switch (wanted) {
      case 'ready':
        return [tasksDo('Make the thread a task', 'create', id), tasksDo('Or lift a hold on one', 'unblock', id)]
      case 'waiting':
        return [tasksDo('Make it a task that waits for another', 'create', id, '--needs', '<ID>')]
      case 'claimed':
        return [tasksDo('Claim it', 'claim', id)]
      case 'completed':
        return [tasksDo('Complete it, with the claim you hold', 'complete', id)]
      case 'failed':
        return [tasksDo('Fail it, with the claim you hold', 'fail', id, '<REASON>')]
      case 'blocked':
        return [tasksDo('Hold it for a person', 'block', id, '<REASON>')]
      case 'canceled':
        return [tasksDo('Cancel it', 'cancel', id, '<REASON>')]
      default:
        return [{ instruction: 'See what changes a task', argv: [...cli(), 'tasks', '--help'] }]
    }
  }
  // A new thread labeled as a task is a task to start.
  const labeled = flags.label?.some((pair) => pair === 'board.task' || pair.startsWith('board.task='))
  if (labeled && command === 'post' && args[0] !== undefined && !isMessageRef(args[0])) return [tasksDo('Start it as a task', 'create', args[0], '<TEXT>')]
  return []
}

type OtherName = { instruction: string; argv: string[]; teams?: { instruction: string; argv: string[] } }

/** Search: a filter on read. Vercel's board keeps no index of text, so there it looks through a page of a channel's threads. */
const SEARCH: OtherName = {
  instruction: 'Search is a filter on read',
  argv: ['read', '<CHANNEL>', '--text', '<PHRASE>'],
  teams: { instruction: "Search a channel's latest threads, a page at a time, since this board keeps no text search", argv: ['read', '<CHANNEL>', '--text', '<PHRASE>'] },
}

/**
 * Words for a command this CLI names otherwise, and the command they mean: on a team's board in
 * Vercel's API, `teams`, where it reads one channel's page (or when nothing says which board).
 */
const OTHER_NAMES: Record<string, OtherName> = {
  search: SEARCH,
  find: SEARCH,
  grep: SEARCH,
  list: { instruction: "List a channel's threads with read", argv: ['read', '<CHANNEL>'] },
  ls: { instruction: "List a channel's threads with read", argv: ['read', '<CHANNEL>'] },
  threads: { instruction: "List a channel's threads with read", argv: ['read', '<CHANNEL>'] },
  messages: { instruction: 'Read one thread, every message', argv: ['read', '<ID>'] },
  thread: { instruction: 'Read one thread, every message', argv: ['read', '<ID>'] },
  show: { instruction: 'Read one thread, every message', argv: ['read', '<ID>'] },
  get: { instruction: 'Read one thread, every message', argv: ['read', '<ID>'] },
  view: { instruction: 'Read one thread, every message', argv: ['read', '<ID>'] },
  history: { instruction: 'Read one thread, every message', argv: ['read', '<ID>'] },
  send: { instruction: 'Start a thread with post', argv: ['post', '<CHANNEL>', '<TEXT>'] },
  create: { instruction: 'Start a thread with post', argv: ['post', '<CHANNEL>', '<TEXT>'] },
  comment: { instruction: 'Reply in a thread', argv: ['reply', '<ID>', '<TEXT>'] },
  answer: { instruction: 'Reply in a thread', argv: ['reply', '<ID>', '<TEXT>'] },
  update: { instruction: "Change a message's text with edit", argv: ['edit', '<ID>', '<TEXT>'] },
  remove: { instruction: 'Delete a message', argv: ['delete', '<ID>'] },
  rm: { instruction: 'Delete a message', argv: ['delete', '<ID>'] },
  cancel: { instruction: 'Cancel a schedule', argv: ['schedule', 'cancel', '<SCHEDULE>'] },
  unschedule: { instruction: 'Cancel a schedule', argv: ['schedule', 'cancel', '<SCHEDULE>'] },
  remind: { instruction: 'Post later with schedule', argv: ['schedule', '<TARGET>', '<TEXT>', '--in', '<DURATION>'] },
  attach: { instruction: 'Attach a file to a post', argv: ['post', '<TARGET>', '<TEXT>', '--attach', '<FILE>'] },
  upload: { instruction: 'Attach a file to a post', argv: ['post', '<TARGET>', '<TEXT>', '--attach', '<FILE>'] },
  claim: { instruction: 'Hold a task with tasks claim', argv: ['tasks', 'claim', '<ID>'] },
  assign: { instruction: "Keep a task for one of its owner's profiles", argv: ['tasks', 'assign', '<ID>', '<PROFILE>'] },
  tag: { instruction: 'Set labels on a message', argv: ['label', '<ID>', '<KEY=VALUE>'] },
  labels: { instruction: 'Set labels on a message', argv: ['label', '<ID>', '<KEY=VALUE>'] },
  mentions: {
    instruction: 'Mentions are a filter on read and wait',
    argv: ['read', '--mentions'],
    teams: { instruction: "Read what mentions you in a channel's latest threads, then wait from where it stops", argv: ['read', '<CHANNEL>', '--mentions'] },
  },
  watch: { instruction: 'Block for the next match with wait, or follow live with tail', argv: ['wait', '<CHANNEL>', '--after', '<CURSOR>'] },
  follow: { instruction: 'Block for the next match with wait, or follow live with tail', argv: ['wait', '<CHANNEL>', '--after', '<CURSOR>'] },
  subscribe: { instruction: 'Block for the next match with wait, or follow live with tail', argv: ['wait', '<CHANNEL>', '--after', '<CURSOR>'] },
  listen: { instruction: 'Block for the next match with wait, or follow live with tail', argv: ['wait', '<CHANNEL>', '--after', '<CURSOR>'] },
  users: { instruction: 'See who is on the board', argv: ['actors'] },
  members: { instruction: 'See who is on the board', argv: ['actors'] },
  me: { instruction: 'See who you are', argv: ['whoami'] },
}

/**
 * Aborts `controller` on the run's signal, or Ctrl-C without one. `release` stops listening, and
 * `interrupted` says whether Ctrl-C stopped it.
 */
function stopOn(controller: AbortController): { release: () => void; interrupted: () => boolean } {
  const stop = () => controller.abort()
  if (io.signal) {
    if (io.signal.aborted) stop()
    io.signal.addEventListener('abort', stop, { once: true })
    const signal = io.signal
    return { release: () => signal.removeEventListener('abort', stop), interrupted: () => false }
  }
  process.once('SIGINT', stop)
  return { release: () => process.off('SIGINT', stop), interrupted: () => controller.signal.aborted }
}

/** What a command an app adds gets: this run's flags, and the helpers board's own commands use. */
const context = (): CommandContext => ({
  flags,
  out,
  usage: (message) => usage(message),
  portFlag,
  connection,
  client,
  openBrowser,
})

/**
 * Runs board's CLI on `argv` (what follows the command name) as `app`, and answers its exit
 * code: 0 success, 1 error (a `wait` that timed out included), 2 misuse, 130 when Ctrl-C stops it. A
 * failure goes to `app.onError`, or to stderr: `error: ` and what failed, then how to fix it, or
 * with `--json`, one JSON document. A long-running command (`tail`, `serve`) answers once it's
 * stopped.
 */
export async function main(argv: string[], options: App): Promise<number> {
  // The app's login and team are the run's, and only the run's.
  handLogin(options.login ?? null)
  handToken(options.token ?? null)
  handTeam(options.team ?? null)
  handFetch(options.fetch ?? null)
  try {
    return await runOnce(argv, options)
  } finally {
    handLogin(null)
    handToken(null)
    handTeam(null)
    handFetch(null)
  }
}

async function runOnce(argv: string[], options: App): Promise<number> {
  app = options
  typed = argv
  flags = {} as Flags
  positionals = []
  warnings = []
  reached = null
  teamDefault = null
  sent = () => null
  sentLength = 0
  self = null
  try {
    parse(argv)
    if (flags.version) {
      if (flags.json) result({ version: VERSION })
      else out(VERSION)
      return 0
    }
    // --help is help, never the command it's on: that command's page.
    if (flags.help) {
      out(help(positionals))
      return 0
    }
    const [word, ...args] = positionals
    const command = canonical(word)
    current = { command, args }
    if (io.board) {
      const given = flags.url ? 'url' : flags.name !== undefined ? 'name' : flags.ensure ? 'ensure' : null
      if (given) throw usage(`--${given} doesn't apply in-process: the board handle you pass says which board and who.`, { next: [] })
      if (command !== undefined && MACHINE.has(command))
        throw usage(`${command} isn't available in-process: it's about the machine ${named()} runs on.`, { reason: 'not_available', next: [] })
    }
    return await run(command, args)
  } catch (error) {
    // Its caller's signal ended its requests: `tail` and `wait` end as they do when it stops them, the rest say so.
    if (io.signal?.aborted) {
      if (current.command === 'tail' || current.command === 'wait') return 0
      error = stopped(io.signal.reason)
    }
    // Before the parser says, `--json` is whether it was typed before any `--`.
    const json = flags.json ?? argv.slice(0, argv.includes('--') ? argv.indexOf('--') : undefined).includes('--json')
    return report(failureOf(error), json)
  }
}

/** The commands that change the board, whatever their arguments. */
const WRITES = new Set(['post', 'reply', 'edit', 'delete', 'label', 'react', 'schedule', 'sync'])

/** What a run its caller's signal stopped says: a write it was making may have landed. */
function stopped(reason: unknown): Failed {
  const timedOut = reason instanceof Error && reason.name === 'TimeoutError'
  // A subcommand that writes is `channels create`'s first word, `sources <key> join`'s second.
  const sub = current.command === 'sources' ? current.args[1] : current.args[0]
  // Every task verb writes: a claim, its renewal, and what settles or changes the task.
  const writes = WRITES.has(current.command ?? '') || ['create', 'update', 'revoke', 'cancel', 'join'].includes(sub ?? '') || (current.command === 'tasks' && TASK_VERBS.has(sub ?? ''))
  return new Failed({
    class: timedOut ? 'timeout' : 'canceled',
    reason: timedOut ? 'timeout' : 'canceled',
    message: `${timedOut ? 'Timed out' : 'Stopped'} before it could ${doing()}.`,
    ...(writes ? { next: [{ instruction: 'It may have happened anyway: read before you run it again.' }] } : {}),
  })
}

/** The commands about the machine the CLI runs on, not the board: none of them run in-process. */
const MACHINE = new Set(['whoami', 'hooks', 'hook', 'serve', 'inspect'])

/** `main()` with `io` in place of the terminal, for `vb()`. One run at a time, as `main()`'s. */
export async function mainWith(argv: string[], options: App, with_: Io): Promise<number> {
  io = with_
  try {
    return await main(argv, options)
  } finally {
    io = TERMINAL
  }
}
