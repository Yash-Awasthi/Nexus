import type { Discovery, MessageView, PrincipalView, ScheduleView } from '../../api/routes.ts'
import type { ScheduleTiming } from '../../server/index.default.ts'

// How the page says things: names, times, and sizes. Each is a few lines any UI on a board writes
// for itself, so the page keeps its own rather than reaching into the package for the CLI's.

type Named = { name: string; via?: { name: string; environment: string | null } | undefined }

/** An actor as people see it: `claude via julian`, `Malte via www (preview)`, or just a name. */
export function shownName(actor: Named): string {
  if (!actor.via) return actor.name
  const { name, environment } = actor.via
  return `${actor.name} via ${name}${environment !== null && environment !== 'production' ? ` (${environment})` : ''}`
}

/** A message's author as people see them, or their ID when the board says nothing more. */
export const authorName = (message: Pick<MessageView, 'author' | 'by'>): string => (message.author ? shownName(message.author) : message.by.actor)

/** `12s`, `4m`, `3h`, `2d`: how long ago. */
export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

/** `120 KB`, `3.4 MB`: a file's size the way people read it. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** What went wrong, as the board or the handle said it. */
export const said = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** A message's first line, for a row that shows one. */
export const firstLine = (text: string): string => text.split('\n').find((line) => line.trim() !== '')?.trim() ?? ''

/** `58:12`, or `1h 02m` past an hour: how long is left. */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const two = (n: number) => String(n).padStart(2, '0')
  return hours > 0 ? `${hours}h ${two(minutes)}m` : `${minutes}:${two(seconds % 60)}`
}

const REFUSALS: Record<string, string> = {
  claim_lost: "this tab's claim is over: it was released, taken over, or its lease ran out. Claim the task again to go on.",
  task_claimed: 'someone holds this task now, until their lease ends',
  task_assigned: "it's assigned to someone else, and only they claim it",
  task_waiting: 'it still waits for the tasks it needs',
  task_blocked: "it's held for a person: unblock it first",
  task_finished: "it's finished already",
  task_not_owned: "this is someone else's task: its owner changes it, or anyone with manage in its channel",
  already_a_task: 'this thread is a task already',
  not_a_task: "this thread isn't a task",
  reserved_label: "labels under board. are the board's own: a task's actions change them",
}

/** What a refusal means, in the page's words, or the board's own where the page has none. */
export function refusal(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return (typeof code === 'string' && REFUSALS[code]) || said(error)
}

/** Who a grant names, the way people say it. */
export function principalName(principal: PrincipalView): string {
  switch (principal.kind) {
    case 'user':
      return principal.email ?? principal.userId
    case 'project':
      return `${principal.name ?? principal.projectId} (${principal.environments.join(', ')})`
    case 'github':
      return [principal.repository, principal.workflow, principal.branch, principal.event].filter(Boolean).join(' · ')
    case 'oidc':
      return `${principal.issuer} ${Object.entries(principal.claims).map(([name, value]) => `${name}=${[value].flat().join('|')}`).join(' ')}`.trim()
    case 'app':
      return principal.name ?? principal.clientId
    case 'all-users':
      return 'every user'
    case 'all-projects':
      return `every project (${principal.environments.join(', ')})`
    case 'all-apps':
      return 'every app'
    case 'everyone':
      return 'everyone'
  }
}

const SPANS: [string, number][] = [
  ['d', 86_400_000],
  ['h', 3_600_000],
  ['m', 60_000],
  ['s', 1000],
]

/** `in 21h`, `in 5m`, `now`: how long until a time, by its largest whole unit. */
export function until(iso: string, now = Date.now()): string {
  const left = Date.parse(iso) - now
  if (left < 1000) return 'now'
  const [unit, size] = SPANS.find(([, size]) => left >= size)!
  return `in ${Math.floor(left / size)}${unit}`
}

/** `1d`, `90m`, `36h`: a span of milliseconds in the largest unit that divides it. */
export function span(ms: number): string {
  const [unit, size] = SPANS.find(([, size]) => ms >= size && ms % size === 0) ?? ['s', 1000]
  return `${Math.round(ms / size)}${unit}`
}

/** How often a schedule sends, and how far along it is: `every 1d · 2 of 4 sent`. */
export function cadence(schedule: Pick<ScheduleView, 'every' | 'times' | 'sent' | 'until'>): string {
  const parts = [schedule.every === null ? 'once' : `every ${span(schedule.every)}`]
  if (schedule.times !== null) parts.push(`${schedule.sent} of ${schedule.times} sent`)
  else if (schedule.sent > 0) parts.push(`${schedule.sent} sent`)
  if (schedule.until !== null) parts.push(`until ${new Date(schedule.until).toLocaleDateString()}`)
  return parts.join(' · ')
}

/** A time as `<input type="datetime-local">` takes one: local, to the minute. Nothing, for what isn't a time. */
export function localInput(at: string | Date): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  const two = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`
}

/** A timing as the send-later form's fields start out, so reopening it to change one keeps the rest. */
export function laterFields(timing: ScheduleTiming | null): { after: string; at: string; every: string; times: string } {
  return {
    after: timing?.in ?? '',
    at: timing?.at !== undefined && timing.in === undefined ? localInput(timing.at) : '',
    every: timing?.every ?? '',
    times: timing?.times ? String(timing.times) : '',
  }
}

/** A timing in a few words: `in 2h`, `at Nov 12, 9:00 AM, every 1d`. */
export const timingWords = (later: ScheduleTiming): string =>
  [later.in ? `in ${later.in}` : later.at ? `at ${new Date(later.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : '', later.every ? `every ${later.every}` : '']
    .filter(Boolean)
    .join(', ')

/**
 * Which board a page is on, in two lines: its name and its host where it has a name (a team's
 * board in Vercel's API), else its host and where on it. Before its discovery answers, just `board`.
 */
export function boardWords(discovery: Pick<Discovery, 'url' | 'name'> | null): { name: string; at: string | null } {
  if (!discovery) return { name: 'board', at: null }
  let url: URL
  try {
    url = new URL(discovery.url)
  } catch {
    return { name: discovery.name ?? discovery.url, at: null }
  }
  if (discovery.name) return { name: discovery.name, at: url.host }
  const path = url.pathname.replace(/\/+$/, '')
  return { name: url.host, at: path || null }
}
