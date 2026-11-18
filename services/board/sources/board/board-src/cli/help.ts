// Board's help, rendered from its commands' data (`commands.ts`): the list every command is in,
// and each command's own page. A CLI that runs board's renders the same data its own way.
import { commands, filters, globalOptions, groups, usage, type CliCommand, type CliOption } from './commands.ts'

/** The widest a row's subject pads to before its value moves to the next line. */
const SUBJECT_MAX = 34
/** Help fits 80 columns: a value wraps under its column. */
const COLUMNS = 80

/** The padding `entries`' subjects line up at: the widest, up to `SUBJECT_MAX`. */
const padOf = (entries: readonly (readonly [string, string])[]) => Math.min(SUBJECT_MAX, Math.max(0, ...entries.map(([subject]) => subject.length)))

/**
 * `text` in lines of at most `width`, split where `gap` separates its words (two spaces, for a
 * list of flags); a word longer than that keeps its own line.
 */
function wrap(text: string, width: number, gap = ' '): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(gap)) {
    if (line && line.length + gap.length + word.length > width) {
      lines.push(line)
      line = word
    } else line = line ? `${line}${gap}${word}` : word
  }
  return line ? [...lines, line] : lines
}

/** A line headed `label` (`filters:`), its value wrapped at 80 columns under where it starts. */
const labeled = (label: string, value: string, gap = ' ') => {
  const indent = ' '.repeat(10)
  return wrap(value, COLUMNS - indent.length, gap).map((line, index) => `${index === 0 ? label.padEnd(indent.length) : indent}${line}`)
}

/** Rows as columns: each subject padded to `pad`, then two spaces and its value, wrapped under it. */
function rows(entries: readonly (readonly [string, string])[], pad = padOf(entries)): string[] {
  const indent = ' '.repeat(2 + pad + 2)
  return entries.map(([subject, value]) => {
    const [first = '', ...rest] = wrap(value, Math.max(20, COLUMNS - indent.length))
    const head = subject.length > pad ? `  ${subject}\n${indent}${first}` : `  ${subject.padEnd(pad)}  ${first}`.trimEnd()
    return [head, ...rest.map((line) => `${indent}${line}`)].join('\n')
  })
}

/** An option as help writes it: `--limit <N>`, `-h, --help`, `--label <k[=v|w]>...`. */
export const flag = (option: CliOption): string =>
  `${option.short ? `-${option.short}, ` : ''}--${option.name}${option.value ? (option.optionalValue ? ` [${option.value}]` : ` <${option.value}>`) : ''}${option.multiple ? '...' : ''}`

const shown = (list: readonly CliOption[]) => list.filter((option) => !option.hidden)

/** A command's rows in the list: itself, when it runs alone and no subcommand is what it runs, and each of its subcommands. */
function listed(command: CliCommand): [string, string][] {
  const alone = !command.subcommands || (command.runsWithoutSubcommand && !command.subcommands.some((sub) => sub.default))
  const own: [string, string][] = alone ? [[`${usage([command])}${command.brief ? ` ${command.brief}` : ''}`, command.description]] : []
  return [...own, ...(command.subcommands ?? []).filter((sub) => !sub.hidden).map((sub): [string, string] => [usage([command, sub]), sub.description])]
}

/** Every command, by group, then what the app adds (`serve`, `inspect`), and the options they share. */
export function rootHelp(app: { name: string; commands: readonly CliCommand[] }, version: string): string {
  const sections = [...groups.map((group) => commands.filter((command) => command.group === group)), app.commands].map((list) =>
    list.filter((command) => !command.hidden),
  )
  const lines = [
    `${app.name} ${version}: your Vercel team's message board, for people and agents`,
    '',
    `usage: ${app.name} <command> [options]${app.name === 'board' ? '      (also installed as `vb`)' : ''}`,
  ]
  // One column for every section, so they line up.
  const listedSections = sections.filter((list) => list.length > 0).map((list) => list.flatMap(listed))
  const pad = padOf(listedSections.flat())
  for (const section of listedSections) lines.push('', ...rows(section, pad))
  const everywhere = shown(globalOptions).filter((option) => option.name !== 'help' && option.name !== 'version')
  lines.push(
    '',
    ...labeled('filters:', shown(filters).map(flag).join('  '), '  '),
    ...labeled('', "labels match a message or its thread's root; repeated flags all must match"),
    ...labeled('global:', everywhere.map(flag).join('  '), '  '),
    ...labeled('json:', 'one object: { threads, cursor } for read <channel>, { message, replies, cursor } for read <id> (message is the thread root)'),
    ...labeled('text:', 'pass "-" to read it from stdin; it may be left out when you --attach'),
    ...labeled('env:', 'BOARD_URL  BOARD_NAME  BOARD_TOKEN  BOARD_PROFILE  BOARD_AVATAR', '  '),
    '',
    `a command's own help: ${app.name} <command> --help`,
  )
  return lines.join('\n')
}

/** One command's page: its usage, what it does, and its arguments, subcommands, options, and examples. */
export function commandHelp(name: string, path: readonly CliCommand[]): string {
  const command = path.at(-1)!
  const options = shown(command.options)
  const subcommands = (command.subcommands ?? []).filter((sub) => !sub.hidden)
  const lines = [`usage: ${name} ${usage(path)}${options.length || command.filters ? ' [options]' : ''}`, '', ...wrap(command.description, COLUMNS)]
  if (command.aliases?.length) lines.push('', `also: ${command.aliases.map((alias) => `${name} ${alias}`).join(', ')}`)
  const section = (title: string, entries: readonly (readonly [string, string])[]) => {
    if (entries.length) lines.push('', `${title}:`, ...rows(entries))
  }
  section(
    'arguments',
    command.arguments.filter((argument) => argument.description).map((argument) => [argument.name, argument.description!]),
  )
  section(
    'commands',
    subcommands.map((sub) => [usage([...path, sub]), sub.description]),
  )
  section('options', options.map((option) => [flag(option), option.description]))
  if (command.filters) {
    section('filters', shown(filters).map((option) => [flag(option), option.description]))
    lines.push("  labels match a message or its thread's root; repeated flags all must match")
    if (command.filtersNote) lines.push(...wrap(command.filtersNote, COLUMNS - 2).map((line) => `  ${line}`))
  }
  // Each is its label, then the command, paste-complete, indented four spaces.
  if (command.examples.length)
    lines.push('', 'examples:', ...command.examples.flatMap((example, index) => [...(index ? [''] : []), `  ${example.name}`, `    ${name} ${example.value}`]))
  // The ones an agent needs on every page, and where the rest are.
  lines.push('', ...labeled('global:', COMMON.map((option) => flag(globalOptions.find((known) => known.name === option)!)).join('  '), '  '), ...labeled('', `and the rest every command takes: ${name} help`))
  return lines.join('\n')
}

/** The global options a command's page shows: a program's output, who it writes as, and which board. */
const COMMON = ['json', 'as', 'scope', 'url'] as const

/**
 * The command `words` name, and its subcommand when they name one (`schedule cancel`, `sources slack
 * read`): what `--help` shows the page of. Null when the first word names no command.
 */
export function commandPath(words: readonly string[], all: readonly CliCommand[]): CliCommand[] | null {
  const command = all.find((candidate) => candidate.name === words[0] || candidate.aliases?.includes(words[0]!))
  if (!command) return null
  const at = command.argumentsBeforeSubcommand ? command.arguments.length + 1 : 1
  const sub = command.subcommands?.find((candidate) => candidate.name === words[at])
  return sub ? [command, sub] : [command]
}
