import type { BoardEventView, GrantView, Me, MessageView, PrincipalView, ScheduleView, SourceRead, SyncedView, TaskView, ThreadSummaryView } from '../api/routes.ts'
import { displayEmoji } from '../contract/emoji.ts'
import { fileSize } from '../contract/files.ts'
import { byVercelBot, displayText } from '../contract/bots.ts'
import { extractMentions, isEmail, replaceMentions } from '../contract/mentions.ts'
import { findBlocks } from '../contract/blocks.ts'
import { shownName, type Via } from '../contract/profiles.ts'
import type { CheckResult, ConformanceReport } from '../conformance/index.ts'

/**
 * Text for a terminal. What boards and platforms say can carry control characters, ESC among them,
 * which starts the sequences that clear the screen, move the cursor, or retitle the window: each
 * but tab and newline shows as its picture (`␛`), a C1 control as `�`, and a Windows line end as a
 * newline. `--json` prints what the board said, as it said it.
 */
export const terminalText = (text: string): string =>
  text.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (char) => {
    const code = char.charCodeAt(0)
    return code < 0x20 ? String.fromCharCode(0x2400 + code) : code === 0x7f ? '\u2421' : '\ufffd'
  })

/** As `terminalText`, for what shows within one line: tab and newline show as their pictures too. */
export const lineText = (text: string): string => terminalText(text).replace(/[\t\n]/g, (char) => String.fromCharCode(0x2400 + char.charCodeAt(0)))

/** Who you are, as your messages show you: `claude via julian` with a profile, your name otherwise. */
export const who = (me: Pick<Me, 'name' | 'via'>): string => shownName(me)

/**
 * A message's author as people see them: their name, and who they act through when they have a
 * profile, an agent's person (`claude via julian`) or the principal whose sync imported a
 * platform user (`Malte via www (preview)`).
 */
export function authorName(message: Pick<MessageView, 'author' | 'by'>): string {
  return message.author ? shownName(message.author) : message.by.actor
}

export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

const indent = (text: string, prefix: string) =>
  text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n')

function labels(message: MessageView): string {
  const entries = Object.entries(message.labels)
  // On the message's own line: a newline in a value (one written before values refused them) shows as its picture too.
  return entries.length ? `  [${entries.map(([k, v]) => `${k}=${lineText(v)}`).join(' ')}]` : ''
}

/** How many people a reaction names before it counts the rest: `👀 ada, claude, codex +9`. */
export const REACTION_NAMES = 3

function reactions(message: MessageView, names: Map<string, string>): string {
  const groups = Object.entries(message.reactions)
  if (groups.length === 0) return ''
  return groups
    .map(([emoji, actors]) => {
      const shown = actors.slice(0, REACTION_NAMES).map((id) => names.get(id) ?? id).join(', ')
      return `${displayEmoji(emoji)} ${shown}${actors.length > REACTION_NAMES ? ` +${actors.length - REACTION_NAMES}` : ''}`
    })
    .join('   ')
}

/** The actors a thread's reactions name on screen, for looking up the ones who didn't write in it. */
export function reactionNames(messages: MessageView[]): string[] {
  return [...new Set(messages.flatMap((m) => Object.values(m.reactions).flatMap((actors) => actors.slice(0, REACTION_NAMES))))]
}

/** Each author's handle by ID, and those of `more`: who a mention shows as. */
const handlesOf = (messages: MessageView[], more: Map<string, string> = new Map()) =>
  new Map([...more, ...messages.flatMap((m) => (m.author ? [[m.by.actor, m.author.handle] as const] : []))])

/** The actors a thread's texts mention by ID, for looking up the ones who didn't write in it. */
export function mentionedIn(messages: MessageView[]): string[] {
  return [...new Set(messages.flatMap((m) => (m.deleted ? [] : extractMentions(m.text).flatMap((token) => (token.kind === 'actor' && !isEmail(token.actor) ? [token.actor] : [])))))]
}

/** An actor's display name from `/actors`, the way a message's author shows: `claude via julian`. */
export const actorName = (actor: { name: string; via?: Via | undefined }): string => shownName(actor)

/**
 * A message's text as a terminal shows it: a bot's in its readable form, and each block as one
 * line, its schema and its data, where its fence was. A message that is only a block is that line.
 */
function shownText(message: Pick<MessageView, 'text' | 'by' | 'blocks' | 'from' | 'author'>, handles: Map<string, string> = new Map()): string {
  // A mention is stored as `@[actor-id]`: it reads as the handle of who it mentions, which is what to type for
  // them, where they're known. `--json` has the ID.
  const said = replaceMentions(message.text, (token) => (token.kind === 'actor' && handles.has(token.actor) ? `@${handles.get(token.actor)}` : null))
  const text = displayText(said, byVercelBot(message, message.author))
  // Only what the board lists as blocks: a fence in a platform's text stays as it was written.
  if (!message.blocks?.length || text !== said) return text
  let out = ''
  let at = 0
  for (const found of findBlocks(text)) {
    if (found.data === undefined) continue
    out += `${text.slice(at, found.start)}data ${found.id} · ${JSON.stringify(found.data)}`
    at = found.end
  }
  return out + text.slice(at)
}

/** Lines of a linked message an embed shows before it trails off. */
const EMBED_LINES = 12

/** A linked platform message, quoted under the message that links it, or why the board couldn't read it. */
function embed(link: NonNullable<MessageView['links']>[number], pad: string): string[] {
  if (!link.snapshot) return [`${pad}↪ ${link.url} (couldn't read it: ${link.unavailable ?? 'unknown'})`]
  const { author, text, files } = link.snapshot
  const lines = text.trim() ? text.trim().split('\n') : []
  const shown = lines.length > EMBED_LINES ? [...lines.slice(0, EMBED_LINES), '…'] : lines
  return [
    `${pad}↪ ${author}${link.message !== null ? ` · #${link.message}` : ''} · ${link.url}`,
    ...shown.map((line) => `${pad}> ${line}`),
    ...files.map((file) => `${pad}> file ${file.name}${file.url ? ` ${file.url}` : ''}`),
  ]
}

/** One message as a block: header line, indented text, reactions. */
export function formatMessage(message: MessageView, options: { reply?: boolean; names?: Map<string, string>; handles?: Map<string, string>; now?: number } = {}) {
  const pad = options.reply ? '    ' : '      '
  const head = `${options.reply ? '  ↳ ' : ''}#${message.id}  ${authorName(message)} · ${ago(message.createdAt)}${
    message.editedAt ? ' (edited)' : ''
  }${message.schedule ? ` · scheduled ${message.schedule.id}` : ''}${labels(message)}`
  const body = message.deleted ? `${pad}(message removed)` : indent(shownText(message, options.handles), pad)
  const task = message.task ? [`${pad}task  ${taskState(message, message.task, options.names ?? new Map(), options.now ?? Date.now())}`] : []
  const files = (message.attachments ?? []).map((a) => `${pad}file ${a.name} · ${a.type} · ${fileSize(a.size)} · ${a.id}`)
  const links = message.deleted ? [] : (message.links ?? []).flatMap((link) => embed(link, pad))
  const reacted = reactions(message, options.names ?? new Map())
  const undelivered = Object.entries(message.undelivered ?? {}).map(([target, error]) => `${pad}✗ didn't reach ${target}: ${error}`)
  return [head, body, ...task, ...files, ...links, ...(reacted ? [`${pad}${reacted}`] : []), ...undelivered].join('\n')
}

/** The first line of what a task came to, or of why it's held or ended: the rest is in its thread. */
const noteLine = (text: string, max = 60) => {
  const [line = ''] = text.trim().split(/\r?\n/)
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** The profile an actor ID names (`vercel:user:u_abc+fixer` is `fixer`), or the ID itself when it names none. */
const profileOf = (actor: string) => (actor.includes('+') ? actor.slice(actor.lastIndexOf('+') + 1) : actor)

/** How long a lease has left, as a duration flag would say it, to the minute from a minute up: `15m`, `45s`. */
export function leaseLeft(until: string, now = Date.now()): string {
  const ms = Date.parse(until) - now
  if (ms <= 0) return '0s'
  return span(ms < 60_000 ? Math.ceil(ms / 1000) * 1000 : Math.round(ms / 60_000) * 60_000)
}

/**
 * A task's state as `read` says it under its root: who holds it and for how long, what it's held
 * for or how it ended, then what it waits for, whom it's for, and whose it is when that isn't its
 * root's author. `names` are the display names the reader knows, by actor ID.
 */
function taskState(message: MessageView, task: TaskView, names: Map<string, string>, now: number): string {
  const named = (id: string) => names.get(id) ?? id
  const parts: string[] = []
  if (task.state === 'claimed' && task.claim) {
    const left = Date.parse(task.claim.until) - now
    parts.push(`claimed by ${named(task.claim.actor)}`, left > 0 ? `${leaseLeft(task.claim.until, now)} left` : 'its lease ran out')
  } else if (task.state === 'blocked' && task.blocked) parts.push('blocked', ...(task.blocked.kind ? [task.blocked.kind] : []), noteLine(task.blocked.reason))
  else if (task.state === 'completed') parts.push('completed', ...(task.result ? [noteLine(task.result)] : []))
  else if (task.state === 'failed' || task.state === 'canceled') parts.push(task.state, ...(task.reason ? [noteLine(task.reason)] : []))
  else parts.push(task.state)
  if (task.needs.length) parts.push(`needs ${task.needs.map((id) => `#${id}`).join(' ')}`)
  if (task.for !== null) parts.push(`for ${profileOf(task.for)}`)
  if (task.owner !== message.by.principal) parts.push(`owner ${named(task.owner)}`)
  return parts.join(' · ')
}

/** A claim as the CLI says it: the task, how long it's yours, and what it is. */
export const claimLine = (task: MessageView, until: string, now = Date.now()): string => `#${task.id}  yours for ${leaseLeft(until, now)}  ${firstLine(task, 52)}`

/**
 * What a task's row says after its text: how it ended or what it's held for, in the `room` the row
 * has left, or its own labels, whole, and what it waits for.
 */
function taskNote(message: MessageView, task: TaskView, room: number): string {
  if (task.state === 'completed' && task.result) return noteLine(task.result, room)
  if ((task.state === 'failed' || task.state === 'canceled') && task.reason) return noteLine(task.reason, room)
  if (task.state === 'blocked' && task.blocked) return noteLine(task.blocked.reason, room)
  // Its state has a column of its own, so the label that says it again is left out.
  const own = Object.entries(message.labels).filter(([key]) => !key.startsWith('board.')).map(([key, value]) => `${key}=${lineText(value)}`).join(' ')
  const needs = task.state === 'waiting' && task.needs.length ? `needs ${task.needs.map((id) => `#${id}`).join(' ')}` : ''
  return [own, needs].filter(Boolean).join('  ')
}

/** The widest a task's state is (`completed`), and how wide its first line's column is at least and at most. */
const STATE_WIDTH = 9
const TASK_TEXT_MIN = 30
const TASK_TEXT_MAX = 40
/** The least a row leaves for how a task ended, however long its ID. */
const TASK_NOTE_MIN = 20

/**
 * Tasks, one a row: its ID, its state, its first line, and what's notable about it. The state's
 * column is as wide as any state, and the text's at least 30, so one list lines up with the next.
 * What a person wrote about how it ended is cut to fit 80 columns: the rest is in its thread.
 */
export function formatTasks(tasks: ThreadSummaryView[]): string {
  const rows = tasks.map(({ message }) => [`#${message.id}`, (message.task?.state ?? '').padEnd(STATE_WIDTH), firstLine(message, TASK_TEXT_MAX).padEnd(TASK_TEXT_MIN)])
  const room = Math.max(TASK_NOTE_MIN, 80 - rows.reduce((widest, row) => Math.max(widest, row.join('  ').length), 0) - 2)
  return table(rows.map((row, at) => [...row, tasks[at]!.message.task ? taskNote(tasks[at]!.message, tasks[at]!.message.task!, room) : '']))
}

/** Threads in order, each root followed by its replies. */
export function formatThreads(messages: MessageView[], known: Map<string, string> = new Map(), mentioned: Map<string, string> = new Map()): string {
  const names = new Map([...known, ...messages.map((m) => [m.by.actor, authorName(m)] as const)])
  const handles = handlesOf(messages, mentioned)
  const byRoot = new Map<string, MessageView[]>()
  const roots: MessageView[] = []
  const orphans: MessageView[] = []
  for (const message of messages) {
    if (message.re === null) roots.push(message)
    else (byRoot.get(message.re) ?? byRoot.set(message.re, []).get(message.re)!).push(message)
  }
  const rootIds = new Set(roots.map((r) => r.id))
  for (const [root, replies] of byRoot) if (!rootIds.has(root)) orphans.push(...replies)
  const blocks = roots.map((root) =>
    [formatMessage(root, { names, handles }), ...(byRoot.get(root.id) ?? []).map((r) => formatMessage(r, { reply: true, names, handles }))].join('\n'),
  )
  for (const reply of orphans)
    blocks.push(`(in thread #${reply.re})\n${formatMessage(reply, { reply: true, names, handles })}`)
  return blocks.join('\n\n')
}

/** A root's first line, cut to `max` characters: 74 fits 80 columns under its header. */
function firstLine(message: MessageView, max = 74, handles?: Map<string, string>): string {
  if (message.deleted) return '(message removed)'
  const text = shownText(message, handles).trim()
  const files = message.attachments?.length ?? 0
  if (!text) return files ? `(${files} ${files === 1 ? 'file' : 'files'})` : '(no text)'
  const [line = '', ...rest] = text.split(/\r?\n/)
  const shown = rest.length ? `${line.trimEnd()} …` : line
  return shown.length > max ? `${line.slice(0, max - 1)}…` : shown
}

/**
 * One block per thread, for `read <channel>`: the root's header and first line,
 * then how many replies it has and who wrote the latest, and when.
 */
export function formatThreadSummaries(threads: ThreadSummaryView[], options: { channel?: boolean; now?: number; handles?: Map<string, string> } = {}): string {
  const now = options.now ?? Date.now()
  const handles = handlesOf(threads.flatMap(({ message, last }) => (last ? [message, last] : [message])), options.handles)
  return threads
    .map(({ message, replies, last }) => {
      const where = options.channel ? `${message.channel}  ` : ''
      const head = `#${message.id}  ${where}${authorName(message)} · ${ago(message.createdAt, now)}${labels(message)}`
      const activity = last
        ? `${replies} ${replies === 1 ? 'reply' : 'replies'} · last #${last.id} ${authorName(last)} · ${ago(last.createdAt, now)}`
        : 'no replies'
      // The root's reactions, counted: `read <id>` names who.
      const counted = Object.entries(message.reactions)
        .filter(([, actors]) => actors.length > 0)
        .map(([emoji, actors]) => `${displayEmoji(emoji)} ${actors.length}`)
        .join('   ')
      return [head, `      ${firstLine(message, 74, handles)}`, ...(counted ? [`      ${counted}`] : []), `      ${activity}`].join('\n')
    })
    .join('\n\n')
}

/**
 * `/me`'s `can` as `whoami` rows, a pattern and its permissions each (`ci/  read
 * post`), or none for full access. `manage` brings everything, so it says `all`.
 */
export function formatAccess(access: Me['can']): string[] {
  const patterns = Object.keys(access)
  if (patterns.length === 1 && patterns[0] === '*' && access['*']!.includes('manage')) return []
  if (patterns.length === 0) return ['nothing']
  const width = Math.max(...patterns.map((pattern) => pattern.length))
  return patterns.map((pattern) => {
    const permissions = access[pattern]!
    return `${pattern.padEnd(width)}  ${permissions.includes('manage') ? 'all' : permissions.length === 0 ? 'nothing' : permissions.join(' ')}`
  })
}

/** Rows of cells, each column padded to its widest, two spaces apart. */
const table = (rows: string[][]) => {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)))
  return rows.map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!))).join('  ').trimEnd()).join('\n')
}

/** A workflow as people name it: `ci.yml` for `.github/workflows/ci.yml`. */
const workflowName = (workflow: string) => workflow.replace(/^\.github\/workflows\/(?=[^/]+$)/, '')

/** A principal as the flags that name it: `--user ada@acme.com`, `--project web --environment production,preview`. */
export function principalFlags(principal: PrincipalView): string {
  switch (principal.kind) {
    case 'user':
      return `--user ${principal.email ?? principal.userId}`
    case 'project':
      return `--project ${principal.name ?? principal.projectId} --environment ${principal.environments.join(',')}`
    case 'github':
      return [
        `--github ${principal.repository}`,
        ...(principal.workflow !== undefined ? [`--workflow ${workflowName(principal.workflow)}`] : []),
        ...(principal.branch !== undefined ? [`--git-branch ${principal.branch}`] : []),
        ...(principal.event !== undefined ? [`--event ${principal.event}`] : []),
      ].join(' ')
    case 'oidc':
      return [`--oidc ${principal.issuer}`, ...Object.entries(principal.claims).flatMap(([name, value]) => [value].flat().map((one) => `--claim ${name}=${one}`))].join(' ')
    case 'all-projects':
      return `--all-projects --environment ${principal.environments.join(',')}`
    case 'app':
      return `--app ${principal.name ?? principal.clientId}`
    default:
      return `--${principal.kind}`
  }
}

/**
 * What a grant lets do, as `--can` writes it, `security/=none ci/=read,post`, or in words for
 * `*` alone: `read post react label`, or `everything your role allows` for all of it where team
 * roles cap it.
 */
export function grantCan(can: GrantView['can'], capped: boolean): string {
  const patterns = Object.keys(can)
  const words = (grant: GrantView['can'][string]) => (grant === 'all' ? 'all' : grant.length === 0 ? 'none' : grant.join(','))
  if (patterns.length === 1 && patterns[0] === '*') {
    const all = can['*']!
    if (all === 'all' || all.includes('manage')) return capped ? 'everything your role allows' : 'everything'
    return all.length === 0 ? 'nothing' : all.join(' ')
  }
  return patterns.map((pattern) => `${pattern}=${words(can[pattern]!)}`).join(' ')
}

const grantCells = (grant: GrantView) => [grant.id, grant.principals.map(principalFlags).join(' '), grantCan(grant.can, grant.capped)]

/** Each grant on a row: its ID, who it names (as the flags that would), and what it lets them do. */
export function formatGrants(grants: GrantView[]): string {
  return table(grants.map(grantCells))
}

/** One grant as its row: `g3  --everyone  security/=none`. */
export const grantRow = (grant: GrantView) => grantCells(grant).join('  ')

/** `90m` → `1h30m`, `1d`: milliseconds as a duration flag would say them. */
export function span(ms: number): string {
  const parts: string[] = []
  let rest = Math.round(ms / 1000)
  for (const [unit, size] of [['d', 86_400], ['h', 3600], ['m', 60], ['s', 1]] as const) {
    if (rest >= size) parts.push(`${Math.floor(rest / size)}${unit}`)
    rest %= size
  }
  return parts.join('') || '0s'
}

/** `in 25m`, or `due` once it's past. */
const until = (iso: string, now: number) => {
  const ms = Date.parse(iso) - now
  if (ms <= 0) return 'due'
  return `in ${span(ms < 60_000 ? Math.ceil(ms / 1000) * 1000 : Math.ceil(ms / 60_000) * 60_000)}`
}

/** One schedule: what it sends, when, where, and how it stops. */
export function formatSchedule(schedule: ScheduleView, options: { pad?: string; now?: number } = {}): string {
  const now = options.now ?? Date.now()
  const pad = options.pad ?? ''
  const where = schedule.re === null ? `new thread in ${schedule.channel}` : `#${schedule.re}`
  const repeat = schedule.every === null ? 'once' : `every ${span(schedule.every)}`
  const stop =
    schedule.every === null
      ? ''
      : schedule.times !== null
        ? ` · ${schedule.times} times`
        : schedule.until !== null
          ? ` · until ${schedule.until}`
          : ' · until canceled'
  const when =
    schedule.state === 'pending'
      ? `next ${until(schedule.next!, now)} (${schedule.next})`
      : schedule.state === 'canceled'
        ? schedule.canceled?.reason === 'thread_deleted'
          ? 'ended: the thread was deleted'
          : schedule.canceled?.reason === 'dropped'
            ? 'ended: the board dropped it'
            : schedule.canceled?.reason === 'revoked'
              ? 'ended: its creator can no longer post it'
              : 'canceled'
        : 'done'
  const sent = schedule.sent > 0 ? ` · ${schedule.sent} sent` : ''
  const files = schedule.attachments.length ? ` · ${schedule.attachments.length} ${schedule.attachments.length === 1 ? 'file' : 'files'}` : ''
  const text = displayText(schedule.text, byVercelBot(schedule, null))
  return [
    `${pad}${schedule.id}  ${where} · ${repeat}${stop} · ${when}${sent}${files} · by ${authorName(schedule)}`,
    indent(text || '(no text)', `${pad}    `),
  ].join('\n')
}

/** One line per live event, for `tail` and `wait`. */
export function formatEvent(event: BoardEventView): string {
  const message = event.message
  if (!message) return `#${event.cursor}  ${event.type}`
  const where = message.re === null ? message.channel : `${message.channel} ↳ #${message.re}`
  const who = authorName(message)
  switch (event.type) {
    case 'message.posted': {
      const files = (message.attachments ?? []).map((a) => ` · file ${a.name}`).join('')
      return `#${message.id}  ${where}  ${who}: ${shownText(message)}${files}`
    }
    case 'message.edited':
      return `#${message.id}  ${where}  ${who} (edited): ${shownText(message)}`
    case 'message.deleted':
      return `#${message.id}  ${where}  (message removed)`
    case 'message.linked':
      return `#${message.id}  ${where}  ↪ links ${(message.links ?? []).map((link) => link.message !== null ? `#${link.message}` : link.url).join(', ') || 'nothing'}`
    case 'reaction.added':
    case 'reaction.removed':
      return `#${message.id}  ${where}  ${displayEmoji(event.payload.emoji)} ${
        event.type === 'reaction.added' ? 'added' : 'removed'
      } by ${event.actor?.name ?? event.payload.by.actor}`
    case 'labels.changed': {
      const set = Object.entries(event.payload.set).map(([k, v]) => `${k}=${v}`)
      const unset = event.payload.unset.map((k) => `-${k}`)
      return `#${message.id}  ${where}  labels ${[...set, ...unset].join(' ')}${event.actor ? ` by ${event.actor.name}` : ''}`
    }
    case 'message.sync_failed':
      return `#${message.id}  ${where}  ✗ didn't reach ${event.payload.target}: ${event.payload.error}`
    case 'task.created':
    case 'task.assigned':
    case 'task.needs_changed':
    case 'task.ready':
    case 'task.claimed':
    case 'task.renewed':
    case 'task.released':
    case 'task.expired':
    case 'task.completed':
    case 'task.failed':
    case 'task.blocked':
    case 'task.unblocked':
    case 'task.canceled':
    case 'task.reopened':
      return `#${message.id}  ${where}  task ${taskEvent(event)}`
    default:
      return `#${event.cursor}  ${event.type}`
  }
}

/** What happened to a task, after `task`: `claimed by claude via ada`, `completed by claude via ada · tests pass`. */
function taskEvent(event: Extract<BoardEventView, { type: `task.${string}` }>): string {
  const by = event.actor ? ` by ${actorName(event.actor)}` : ''
  const more = (...parts: (string | null | undefined)[]) => parts.filter((part): part is string => !!part).map((part) => ` · ${part}`).join('')
  switch (event.type) {
    case 'task.created':
      return `created${by}${more(event.payload.needs.length ? `needs ${event.payload.needs.map((id) => `#${id}`).join(' ')}` : null, event.payload.for !== null ? `for ${profileOf(event.payload.for)}` : null)}`
    case 'task.assigned':
      return event.payload.for !== null ? `assigned to ${profileOf(event.payload.for)}${by}` : `unassigned${by}`
    case 'task.needs_changed':
      // What it waits for now, in place of what it waited for.
      return `needs ${event.payload.needs.length ? event.payload.needs.map((id) => `#${id}`).join(' ') : 'nothing'}${by}`
    case 'task.ready':
      return 'ready'
    case 'task.expired':
      return 'lease ran out'
    case 'task.completed':
      return `completed${by}${more(event.payload.result === null ? null : noteLine(event.payload.result))}`
    case 'task.failed':
      return `failed${by}${more(noteLine(event.payload.reason))}`
    case 'task.blocked':
      return `blocked${by}${more(event.payload.kind, noteLine(event.payload.reason))}`
    case 'task.canceled':
      return `canceled${by}${more(noteLine(event.payload.reason))}`
    default:
      // Claimed, renewed, released, unblocked, reopened: what happened, and who did it.
      return `${event.type.slice('task.'.length)}${by}`
  }
}

/**
 * Where a thread is synced, for `vb sync <id>`: a row a target, its sync key and where it is, then
 * the link to the message's copy there, or why it didn't reach it.
 */
export function formatSynced(targets: SyncedView['targets']): string {
  const where = (row: SyncedView['targets'][number]) => row.target.slice(row.key.length + 1)
  const keys = Math.max(...targets.map((row) => row.key.length))
  const wheres = Math.max(...targets.map((row) => where(row).length))
  return targets
    .map((row) => {
      const copy = row.undelivered !== null ? `didn't reach it: ${row.undelivered}` : (row.url ?? (row.message !== null ? `message ${row.message}` : 'no copy yet'))
      return `${row.key.padEnd(keys)}  ${where(row).padEnd(wheres)}  ${terminalText(copy)}`
    })
    .join('\n')
}

/**
 * A channel or thread read with `vb sources <key> read`: a header, then each message under its ID,
 * with the target that reads its thread when it has replies.
 */
export function formatSourceRead(key: string, read: SourceRead, now = Date.now(), cli = 'vb'): string {
  const where = `${key}:${read.channel}${read.name ? ` (#${read.name})` : ''}${read.thread ? `, thread ${read.thread}` : ''}`
  if (read.messages.length === 0) return `${where}\nno messages`
  const blocks = read.messages.map((message) => {
    const reply = read.thread !== null && message.id !== read.thread
    const pad = reply ? '    ' : '      '
    const when = message.createdAt ? ` · ${ago(message.createdAt, now)}` : ''
    const replies = message.replies > 0 && read.thread === null ? `  (${message.replies} ${message.replies === 1 ? 'reply' : 'replies'}: ${cli} sources ${key} read ${message.thread})` : ''
    return [
      `${reply ? '  ↳ ' : ''}${message.id}  ${message.author}${when}${replies}`,
      indent(message.text || '(no text)', pad),
      ...message.files.map((file) => `${pad}file ${file.name}${file.url ? ` ${file.url}` : ''}`),
    ].join('\n')
  })
  const more = read.next
    ? [`(more not shown: ${cli} sources ${key} read ${read.thread ?? read.channel} --after ${read.next})`]
    : read.more ? [`(${read.thread ? 'later replies' : 'older messages'} not shown: raise --limit, up to 200)`] : []
  return [where, ...blocks, ...more].join('\n')
}

/**
 * A conformance report: each group a heading, its checks under it, and why for one that failed
 * or was skipped, then the counts.
 */
export function formatConformance(report: ConformanceReport): string {
  const blocks: string[] = []
  for (const group of [...new Set(report.checks.map((check) => check.group))]) {
    const lines: string[] = [group]
    for (const check of report.checks.filter((c) => c.group === group)) {
      lines.push(`  ${check.status.padEnd(7)}  ${check.name}`)
      if (check.detail) lines.push(`           ${check.detail}`)
    }
    blocks.push(lines.join('\n'))
  }
  const count = (status: CheckResult['status']) => report.checks.filter((check) => check.status === status).length
  const counts = [`${count('passed')} passed`, ...(count('skipped') ? [`${count('skipped')} skipped`] : []), ...(count('failed') ? [`${count('failed')} failed`] : [])]
  return `${blocks.join('\n\n')}\n\n${counts.join(', ')}`
}
