import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// Earlier boards' `vb hooks install` added a turn-end hook to coding agents (Pi, as an extension) that
// reminded the agent to update the board. Those reminders are gone; what's left finds an installed hook
// and removes it, with the allow rules it added, for `vb hooks uninstall`.

type Shape = 'nested' | 'flat' | 'extension'

/**
 * Where each agent keeps hooks, and which of its events run ours. Claude Code
 * and Codex read `{ hooks: { Stop: [{ hooks: [entry] }] } }`; Cursor reads
 * `{ version: 1, hooks: { stop: [entry] } }`, and its stop can't block, so it's
 * reminded with a follow-up message instead. Pi has no hook files: its hook is
 * an extension we write whole (`piExtension`), in `$PI_CODING_AGENT_DIR/extensions`.
 */
export const AGENTS = {
  claude: { name: 'Claude Code', shape: 'nested', event: 'Stop', file: () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json') },
  codex: { name: 'Codex', shape: 'nested', event: 'Stop', file: () => join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'hooks.json') },
  cursor: { name: 'Cursor', shape: 'flat', event: 'stop', file: () => join(homedir(), '.cursor', 'hooks.json') },
  pi: { name: 'Pi', shape: 'extension', event: 'agent_before_settle', file: () => join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'extensions', 'board.ts') },
} as const satisfies Record<string, { name: string; shape: Shape; event: string; file: () => string }>

export type HookAgent = keyof typeof AGENTS

type HookEntry = { type?: string; command: string; timeout?: number }
type Group = { matcher?: string; hooks?: HookEntry[] }
type Entries = (Group | HookEntry)[]
type Config = { version?: number; hooks?: Record<string, Entries>; permissions?: { allow?: string[] } & Record<string, unknown> } & Record<
  string,
  unknown
>

/** A command an install wrote: `<vb> hook stop --agent <one of AGENTS>`, with whatever flags followed. Another tool's `hook stop` isn't ours. */
const ours = (entry: { command?: string }) => / hook stop --agent (?:claude|codex|cursor|pi)(?:\s|$)/.test(entry.command ?? '')

function readConfig(path: string): Config {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Config
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`can't read ${path}: ${(error as Error).message}`)
  }
}

/** Written to a sibling, then renamed: a crash never leaves an agent's settings half-written. */
function writeConfig(path: string, config: Config) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.board-tmp`, `${JSON.stringify(config, null, 2)}\n`)
  renameSync(`${path}.board-tmp`, path)
}

/** An event's entries without ours; a group left with no hooks goes too. */
function without(entries: Entries, shape: Shape): Entries {
  if (shape === 'flat') return entries.filter((entry) => !ours(entry as HookEntry))
  return entries
    .map((group) => ({ ...group, hooks: ((group as Group).hooks ?? []).filter((h) => !ours(h)) }))
    .filter((group) => group.hooks.length > 0)
}

/** The line of our Pi extension that holds the command it runs: how status finds it. */
const PI_COMMAND = /^const COMMAND = (".*")$/m

/** Removes our hook. A file that held only it (Cursor's, which we created) goes away with it. */
export function uninstallHook(agent: HookAgent): boolean {
  const spec = AGENTS[agent]
  if (installedHook(agent) === null) return false
  if (spec.shape === 'extension') return unlinkSync(spec.file()), true
  const config = readConfig(spec.file())
  const hooks = { ...config.hooks }
  const kept = without(hooks[spec.event] ?? [], spec.shape)
  if (kept.length > 0) hooks[spec.event] = kept
  else delete hooks[spec.event]
  const rest = Object.keys(config).filter((key) => key !== 'hooks' && key !== 'version')
  if (rest.length === 0 && Object.keys(hooks).length === 0) unlinkSync(spec.file())
  else writeConfig(spec.file(), { ...config, hooks })
  return true
}

/** The command our hook runs for `agent`, if it's installed. */
export function installedHook(agent: HookAgent): string | null {
  const spec = AGENTS[agent]
  if (spec.shape === 'extension') {
    try {
      const line = PI_COMMAND.exec(readFileSync(spec.file(), 'utf8'))
      const command = line ? (JSON.parse(line[1]!) as string) : null
      // Someone else's extension at this path, with a COMMAND of its own, isn't ours to remove.
      return command !== null && ours({ command }) ? command : null
    } catch {
      return null
    }
  }
  const entries = readConfig(spec.file()).hooks?.[spec.event] ?? []
  const commands = spec.shape === 'flat' ? (entries as HookEntry[]) : entries.flatMap((group) => (group as Group).hooks ?? [])
  return commands.find(ours)?.command ?? null
}

/** A path under the home directory as `~/…`, the way people write it. */
export function tilde(path: string): string {
  const home = homedir()
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path
}

/** The CLI an installed hook runs: everything before ` hook stop`. */
export const cliOf = (command: string) => command.slice(0, command.indexOf(' hook stop '))

// --- what the agent could run without asking -----------------------------------------

/**
 * The allow rules an install added, so the reminded commands ran without a prompt: Claude Code's
 * command prefixes (`vb update` from the oldest installs), and Cursor's `vb` on PATH.
 */
export function allowRules(agent: HookAgent, cli: string): { file: string; rules: string[] } | null {
  if (agent === 'claude') return { file: AGENTS.claude.file(), rules: ['reply', 'post', 'read', 'channels', 'update'].map((sub) => `Bash(${cli} ${sub}:*)`) }
  if (agent === 'cursor' && cli === 'vb') return { file: join(homedir(), '.cursor', 'cli-config.json'), rules: ['Shell(vb)'] }
  return null
}

/** Removes the rules a file has. Answers whether it removed any. */
export function disallow(file: string, rules: string[]): boolean {
  const config = readConfig(file)
  const allowed = config.permissions?.allow
  if (!allowed?.some((rule) => rules.includes(rule))) return false
  writeConfig(file, { ...config, permissions: { ...config.permissions, allow: allowed.filter((rule) => !rules.includes(rule)) } })
  return true
}

