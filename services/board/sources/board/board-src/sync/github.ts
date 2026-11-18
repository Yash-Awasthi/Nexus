import { ChatSyncProvider } from './chat-provider.ts'
import { slug, tagOf } from './tags.ts'
import type { Adapter, Message as ChatMessage } from 'chat'
import type { ExternalAuthor, ExternalEvent } from '../contract/external.ts'
import { markdownOf } from './chat.ts'
import { z } from 'zod'
import { envelope, eventSchema } from './events.ts'
import type { ReceivedEvent, ResolvedTarget, SyncContext } from './provider.ts'
import { createGitHubAdapter } from '@chat-adapter/github'
import { connectGitHubAdapter } from '@vercel/connect/chat'
import { into, withRoutes, type SyncFn, type SyncUnit } from './fn.ts'

/** `owner/repo:12` (and its review threads) → `owner/repo:pulls`; `owner/repo:issue:3` → `owner/repo:issues`. */
function channelOf(thread: string): string {
  const match = /^([^:]+):(issue:)?\d+/.exec(thread)
  return match ? `${match[1]}:${match[2] ? 'issues' : 'pulls'}` : thread
}

type User = { login?: string; id?: number; type?: string; avatar_url?: string }

const author = (user: User | undefined): ExternalAuthor => ({
  id: `github:user:${user?.id ?? 'unknown'}`,
  handle: user?.login ?? 'unknown',
  name: user?.login ?? 'unknown',
  avatar: user?.avatar_url ?? null,
  isBot: user?.type === 'Bot',
})

type Comment = { id: number; in_reply_to_id?: number; user?: User; body?: string }
type Repository = { name: string; owner: { login: string } }
type CommentPayload = {
  action?: string
  comment?: Comment
  issue?: { number?: number; pull_request?: unknown }
  pull_request?: { number?: number }
  repository?: Repository
}
/** The adapter's own parsing, so an edit lands on the same thread and message IDs as the comment it changes. */
type CommentParser = {
  encodeThreadId(id: { owner: string; repo: string; prNumber: number; type?: 'pr' | 'issue'; reviewCommentId?: number }): string
  parseIssueComment(comment: Comment, repository: Repository, number: number, threadId: string, type?: 'pr' | 'issue'): ChatMessage
  parseReviewComment(comment: Comment, repository: Repository, number: number, threadId: string): ChatMessage
}

type Label = { name?: string }
type Item = { labels?: Label[]; assignees?: User[] }
type GitHubItem = Item & {
  number: number
  title: string
  html_url: string
  user?: User
  state: string
  draft?: boolean
  merged?: boolean
}
type GitHubClient = {
  rest: {
    pulls: { get(args: { owner: string; repo: string; pull_number: number }): Promise<{ data: GitHubItem }> }
    issues: { get(args: { owner: string; repo: string; issue_number: number }): Promise<{ data: GitHubItem }> }
    reactions?: {
      createForIssue(args: { owner: string; repo: string; issue_number: number; content: string }): Promise<unknown>
      listForIssue(args: { owner: string; repo: string; issue_number: number; content?: string; per_page?: number }): Promise<{ data: { id: number; content: string; user: { id: number } | null }[] }>
      deleteForIssue(args: { owner: string; repo: string; issue_number: number; reaction_id: number }): Promise<unknown>
    }
  }
}

/** A PR's or issue's current labels and assignees, as board labels. */
function tagsOf(item: Item): Record<string, string> {
  const tags = [
    ...(item.labels ?? []).map((label) => tagOf('tag', label.name)),
    ...(item.assignees ?? []).map((user) => tagOf('assignee', user.login)),
  ]
  return Object.fromEntries(tags.filter((tag) => tag !== null))
}

/** Actions that change only labels and assignees, which every PR and issue event reconciles. */
const TAG_ACTIONS = ['labeled', 'unlabeled', 'assigned', 'unassigned']

/**
 * The label key prefixes the mirror owns on a GitHub root: keys under them that GitHub doesn't have are unset.
 * A prefix is owned only when the payload carries its array, so a trimmed payload doesn't unset every key.
 */
function ownedBy(item: Item): string[] {
  return [...(Array.isArray(item.labels) ? ['tag.'] : []), ...(Array.isArray(item.assignees) ? ['assignee.'] : [])]
}

type Lifecycle = Omit<Extract<ExternalEvent, { kind: 'lifecycle' }>, 'kind' | 'channel' | 'thread' | 'author'>

/** Maps a raw `pull_request`, `pull_request_review`, or `issues` webhook to a lifecycle event. */
function lifecycle(name: string, body: Record<string, unknown>): { lifecycle: Lifecycle; number: number; user: User } | null {
  const action = String(body.action ?? '')
  const sender = body.sender as User | undefined
  if (name === 'pull_request') {
    const pr = body.pull_request as { number: number; title: string; html_url: string; draft?: boolean; merged?: boolean; head?: { sha?: string } }
    // The commit the PR is at, so a watcher can tell which commit it judged and notice when that's no longer it.
    const sha = pr.head?.sha
    const head: Record<string, string> = sha ? { head: sha } : {}
    const pr_label = { pr: `${(body.repository as { full_name: string }).full_name}#${pr.number}`, ...head }
    const base = { title: `PR #${pr.number}: ${pr.title}`, url: pr.html_url, unset: [] as string[] }
    if (TAG_ACTIONS.includes(action))
      return { number: pr.number, user: sender ?? {}, lifecycle: { ...base, type: `pr.${action}`, labels: {}, reply: null, createRoot: false } }
    switch (action) {
      case 'opened':
        return {
          number: pr.number,
          user: sender ?? {},
          lifecycle: { ...base, type: 'pr.opened', labels: { ...pr_label, state: pr.draft ? 'draft' : 'open' }, reply: null, createRoot: true },
        }
      // A new title is the root's; an edit to only the description isn't on the board.
      case 'edited':
        if (!(body.changes as { title?: unknown } | undefined)?.title) return null
        return { number: pr.number, user: sender ?? {}, lifecycle: { ...base, type: 'pr.edited', labels: {}, reply: null, createRoot: false, retitled: true } }
      // New commits: only `head` changes, with no reply, since GitHub's own timeline already lists the pushes.
      case 'synchronize':
        if (!sha) return null
        // The last commit's CI results aren't this one's.
        return { number: pr.number, user: sender ?? {}, lifecycle: { ...base, type: 'pr.synchronized', labels: head, reply: null, createRoot: false, owns: [ciPrefix((body.repository as { id: number }).id, pr.number)] } }
      case 'ready_for_review':
        return { number: pr.number, user: sender ?? {}, lifecycle: { ...base, type: 'pr.ready', labels: { ...pr_label, state: 'open' }, reply: null, createRoot: true } }
      case 'converted_to_draft':
        return { number: pr.number, user: sender ?? {}, lifecycle: { ...base, type: 'pr.draft', labels: { state: 'draft' }, reply: null, createRoot: false } }
      case 'reopened':
        return {
          number: pr.number,
          user: sender ?? {},
          // A draft closed and reopened is still a draft.
          lifecycle: { ...base, type: 'pr.reopened', labels: { ...pr_label, state: pr.draft ? 'draft' : 'open' }, reply: `reopened by ${sender?.login ?? 'someone'}`, createRoot: true },
        }
      case 'closed':
        return {
          number: pr.number,
          user: sender ?? {},
          lifecycle: {
            ...base,
            type: 'pr.closed',
            labels: { state: pr.merged ? 'merged' : 'closed' },
            reply: `${pr.merged ? 'merged' : 'closed'} by ${sender?.login ?? 'someone'}`,
            createRoot: false,
          },
        }
      default:
        return null
    }
  }
  if (name === 'pull_request_review') {
    const pr = body.pull_request as { number: number; title: string; html_url: string }
    const review = body.review as { state?: string; body?: string | null }
    const base = { title: `PR #${pr.number}: ${pr.title}`, url: pr.html_url, createRoot: false }
    if (action === 'dismissed')
      return { number: pr.number, user: sender ?? {}, lifecycle: { ...base, type: 'review.dismissed', labels: {}, unset: ['review'], reply: null } }
    if (action !== 'submitted') return null
    const state = String(review.state ?? '').toLowerCase()
    const verdict = state === 'approved' ? 'approved' : state === 'changes_requested' ? 'changes requested' : null
    const text = [verdict ? `${verdict} by ${sender?.login ?? 'someone'}` : null, review.body || null].filter(Boolean).join('\n\n')
    if (!text) return null
    return {
      number: pr.number,
      user: sender ?? {},
      lifecycle: {
        ...base,
        type: 'review.submitted',
        labels: verdict ? { review: state } : {},
        unset: [],
        reply: text,
      },
    }
  }
  if (name === 'issues') {
    const issue = body.issue as { number: number; title: string; html_url: string }
    const label = { issue: `${(body.repository as { full_name: string }).full_name}#${issue.number}` }
    const base = { title: `Issue #${issue.number}: ${issue.title}`, url: issue.html_url, unset: [] as string[] }
    if (TAG_ACTIONS.includes(action))
      return { number: issue.number, user: sender ?? {}, lifecycle: { ...base, type: `issue.${action}`, labels: {}, reply: null, createRoot: false } }
    if (action === 'opened')
      return { number: issue.number, user: sender ?? {}, lifecycle: { ...base, type: 'issue.opened', labels: { ...label, state: 'open' }, reply: null, createRoot: true } }
    if (action === 'edited' && (body.changes as { title?: unknown } | undefined)?.title)
      return { number: issue.number, user: sender ?? {}, lifecycle: { ...base, type: 'issue.edited', labels: {}, reply: null, createRoot: false, retitled: true } }
    if (action === 'closed')
      return { number: issue.number, user: sender ?? {}, lifecycle: { ...base, type: 'issue.closed', labels: { state: 'closed' }, reply: `closed by ${sender?.login ?? 'someone'}`, createRoot: false } }
    if (action === 'reopened')
      return { number: issue.number, user: sender ?? {}, lifecycle: { ...base, type: 'issue.reopened', labels: { ...label, state: 'open' }, reply: `reopened by ${sender?.login ?? 'someone'}`, createRoot: true } }
  }
  return null
}

/**
 * A PR's CI labels, `ci.<repo ID>-<number>.`: a board thread can join several PRs, even in other
 * repos, and each PR's results and pushes touch only its own. Two numbers keep it short and
 * unambiguous, where a repo's name can be long and hold the separators.
 */
const ciPrefix = (repo: number, number: number) => `ci.${repo}-${number}.`

/** Conclusions that mean a workflow failed. `cancelled` usually means a newer push superseded it. */
const FAILED = ['failure', 'timed_out', 'startup_failure']
/** Who CI results are posted as: GitHub Actions' bot, so they don't read as the person who pushed. */
const ACTIONS: User = { login: 'github-actions[bot]', id: 41898282, type: 'Bot' }

type WorkflowRun = {
  name?: string
  /** `.github/workflows/check.yml`: unique in its repo, where two workflows' names needn't be. */
  path?: string
  conclusion?: string | null
  head_sha?: string
  html_url?: string
  pull_requests?: { number: number; head?: { sha?: string } }[]
}

/**
 * Maps a completed `workflow_run` to a lifecycle event on each PR it ran for, at the commit the PR
 * is at: a failure replies and sets `ci.<repo ID>-<number>.<workflow file>=<conclusion>`, a pass unsets it. A fork's PRs
 * aren't in `pull_requests`, so their runs reach no thread.
 */
function workflowRun(body: Record<string, unknown>): { lifecycle: Lifecycle; number: number; user: User }[] {
  if (body.action !== 'completed') return []
  const run = body.workflow_run as WorkflowRun | undefined
  const { full_name: repo, id } = (body.repository ?? {}) as { full_name?: string; id?: number }
  if (!run?.name || !run.path || !run.head_sha || !run.conclusion || !repo || typeof id !== 'number') return []
  const file = run.path.slice(run.path.lastIndexOf('/') + 1).replace(/\.ya?ml$/, '')
  if (!slug(file)) return []
  const failed = FAILED.includes(run.conclusion)
  if (!failed && run.conclusion !== 'success') return []
  return (run.pull_requests ?? [])
    .filter((pr) => pr.head?.sha === run.head_sha)
    .map((pr) => {
      const key = `${ciPrefix(id, pr.number)}${slug(file)}`.slice(0, 64)
      const verdict = run.conclusion === 'failure' ? 'failed' : run.conclusion!.replace('_', ' ')
      return {
        number: pr.number,
        user: ACTIONS,
        lifecycle: {
          type: failed ? 'ci.failed' : 'ci.passed',
          title: `PR #${pr.number}`,
          url: `https://github.com/${repo}/pull/${pr.number}`,
          labels: failed ? { [key]: run.conclusion! } : {},
          unset: failed ? [] : [key],
          reply: failed ? `${run.name} ${verdict} on ${repo.slice(repo.indexOf('/') + 1)}#${pr.number} at ${run.head_sha!.slice(0, 7)}${run.html_url ? `: ${run.html_url}` : ''}` : null,
          createRoot: false,
        },
      }
    })
}

const GitHubSubject = z.object({ type: z.enum(['pull_request', 'issue']), repo: z.string(), number: z.number().int().positive() })
const NativeItem = z.looseObject({
  number: z.number(), title: z.string(), html_url: z.string(),
  body: z.string().nullable().optional(), draft: z.boolean().optional(), state: z.string().optional(),
  base: z.looseObject({ ref: z.string() }).optional(), head: z.looseObject({ ref: z.string() }).optional(),
})
export const GitHubPayload = z.looseObject({ pull_request: NativeItem.optional(), issue: NativeItem.optional(), action: z.string().optional() })
const prTypes = ['pr.opened', 'pr.edited', 'pr.ready', 'pr.draft', 'pr.reopened', 'pr.synchronized', 'pr.closed', 'pr.labeled', 'pr.unlabeled', 'pr.assigned', 'pr.unassigned', 'review.submitted', 'review.dismissed'] as const
const ciTypes = ['ci.failed', 'ci.passed'] as const
const issueTypes = ['issue.opened', 'issue.edited', 'issue.closed', 'issue.reopened', 'issue.labeled', 'issue.unlabeled', 'issue.assigned', 'issue.unassigned'] as const
const [messageEvent, editedEvent, deletedEvent, reactionEvent, lifecycleEvent] = eventSchema('github', 'comment').options
const githubFields = { subject: GitHubSubject, raw: GitHubPayload }
const prLifecycle = <T extends string>(type: T) => lifecycleEvent.extend({
  type: z.literal(type), subject: GitHubSubject.extend({ type: z.literal('pull_request') }), raw: GitHubPayload.extend({ pull_request: NativeItem }),
})
const issueLifecycle = <T extends string>(type: T) => lifecycleEvent.extend({
  type: z.literal(type), subject: GitHubSubject.extend({ type: z.literal('issue') }), raw: GitHubPayload.extend({ issue: NativeItem }),
})
const ciLifecycle = <T extends string>(type: T) => lifecycleEvent.extend({
  type: z.literal(type), subject: GitHubSubject.extend({ type: z.literal('pull_request') }),
  raw: z.looseObject({ action: z.string().optional(), workflow_run: z.looseObject({ name: z.string(), path: z.string(), conclusion: z.string(), head_sha: z.string(), html_url: z.string().optional() }) }),
})
export const GitHubEvent = z.discriminatedUnion('type', [
  messageEvent.extend(githubFields), editedEvent.extend(githubFields), deletedEvent.extend(githubFields), reactionEvent.extend(githubFields),
  ...prTypes.map(prLifecycle), ...issueTypes.map(issueLifecycle), ...ciTypes.map(ciLifecycle),
])
export type GitHubEvent = z.infer<typeof GitHubEvent>

export type GitHubRepo = SyncUnit<GitHubEvent> | { pulls?: SyncUnit<GitHubEvent>; issues?: SyncUnit<GitHubEvent> }
export type GitHubOptions = {
  /**
   * A Vercel Connect connector (`'github/acme'`): board builds the GitHub adapter.
   * Or your own Chat SDK adapter.
   */
  adapter: Adapter | string
  /**
   * The app's bot user ID, so its own comments never echo back. With a connector,
   * board looks it up from the installation token; set it to skip that call.
   */
  botUserId?: number
}

/**
 * Syncs GitHub with the board: `app` is a Vercel Connect connector
 * (`'github/acme'`) or the options, and `sync` is what each event does, both
 * ways, like `repos({ 'acme/www': 'prs' })`. A board thread never opens an
 * issue: GitHub threads start on GitHub.
 */
export function github(app: string | GitHubOptions, sync: SyncFn<GitHubEvent>): GitHubProvider {
  return new GitHubProvider(typeof app === 'string' ? { adapter: app } : app, sync)
}

/**
 * Routes each event by its repo. Keys are repos (`'owner/repo'`); values are a board channel
 * that PRs and issues are imported `into`, a sync function, or `{ pulls, issues }` to route
 * each its own way. A string imports and sends nothing back: what's said on the board stays
 * there unless a function delivers it. A thread the board syncs in another repo keeps
 * importing.
 */
export function repos(map: Record<string, GitHubRepo>): SyncFn<GitHubEvent> {
  const unit = (value: SyncUnit<GitHubEvent> | undefined) => (typeof value === 'string' ? into(value) : value)
  const routes = new Map<string, SyncFn<GitHubEvent>>()
  for (const [repo, value] of Object.entries(map)) {
    const { pulls, issues } = typeof value === 'object' ? value : { pulls: value, issues: value }
    const [forPulls, forIssues] = [unit(pulls), unit(issues)]
    if (forPulls) routes.set(`${repo}:pulls`, forPulls)
    if (forIssues) routes.set(`${repo}:issues`, forIssues)
  }
  const fn: SyncFn<GitHubEvent> = async (sync) => {
    const route = sync.channel === null ? undefined : routes.get(sync.channel)
    if (route) await route(sync)
    else if (sync.direction === 'in') await sync.import()
  }
  return withRoutes(fn, async (channel) => routes.has(channel))
}

type Detecting = {
  _botUserId: number | null
  logger?: { info(message: string, data?: unknown): void; warn(message: string, data?: unknown): void }
  detectBotUserId(octokit: { graphql?(query: string): Promise<unknown> }): Promise<void>
}

/**
 * A connector's GitHub adapter, finding its own bot user ID. Chat SDK skips detection
 * with Connect's installation token, since REST's `/user` refuses it, and only learns
 * the ID from the first comment it posts, per instance. GraphQL's `viewer` answers with
 * the app's bot user for the same token.
 */
function fromConnector(connector: string, botUserId: number | undefined): Adapter {
  const adapter = createGitHubAdapter({ ...connectGitHubAdapter(connector), ...(botUserId !== undefined ? { botUserId } : {}) })
  const detecting = adapter as unknown as Detecting
  detecting.detectBotUserId = async (octokit) => {
    if (detecting._botUserId !== null || !octokit.graphql) return
    try {
      const { viewer } = (await octokit.graphql('query { viewer { databaseId login } }')) as { viewer?: { databaseId?: number; login?: string } }
      if (typeof viewer?.databaseId !== 'number') return
      detecting._botUserId = viewer.databaseId
      detecting.logger?.info('GitHub bot user ID detected from the GraphQL viewer', { botUserId: viewer.databaseId, login: viewer.login })
    } catch (error) {
      // The adapter still learns it from the first comment it posts.
      detecting.logger?.warn('Could not detect the GitHub bot user ID', { error })
    }
  }
  return adapter as unknown as Adapter
}

export class GitHubProvider extends ChatSyncProvider<GitHubEvent> {

  constructor(given: GitHubOptions, sync: SyncFn<GitHubEvent>) {
    const options = {
      ...given,
      adapter: typeof given.adapter === 'string'
        ? fromConnector(given.adapter, given.botUserId)
        : given.adapter,
    }
    super({
      platform: 'github',
      adapter: options.adapter,
      canStartThreads: false,
      // By their login, which an import keeps as their name. Their handle isn't it everywhere: a sync
      // elsewhere's user goes by `<project>/<login>` on the board, which GitHub would read as a team.
      mention: (actor) => actor.id.startsWith('github:user:') ? `@${actor.name}` : null,
      resolveChannel: (key) => Promise.resolve(key),
      // Inline review threads (`owner/repo:12:rc:345`) belong to their PR (`owner/repo:12`).
      groupThread: (thread) => thread.replace(/:rc:[^:]+$/, ''),
      channelOf,
      isRoot: () => false,
      // A PR's or issue's page is its thread; `#issuecomment-…` is a comment in it, and `#discussion_r…`
      // a review comment, which names its review thread only when it's the thread's first: so it's read
      // as a comment in the PR's thread, which knows every comment in its review threads.
      locate(url) {
        const match = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(pull|issues)\/(\d+)[^#\s]*(?:#(issuecomment-|discussion_r)(\d+))?$/.exec(url.trim())
        if (!match) return null
        const [, owner, repo, kind, number, anchor, id] = match
        const thread = `${owner}/${repo}:${kind === 'issues' ? 'issue:' : ''}${number}`
        if (anchor === 'discussion_r' && kind !== 'pull') return null
        return { thread, message: anchor ? id! : null }
      },
      // A root's copy is the PR or issue itself: its ID isn't a comment's.
      async url(thread, message) {
        const match = /^([^/]+)\/([^:]+):(issue:)?(\d+)(:rc:\d+)?$/.exec(thread)
        if (!match) return null
        const [, owner, repo, issue, number, review] = match
        const page = `https://github.com/${owner}/${repo}/${issue ? 'issues' : 'pull'}/${number}`
        if (!/^\d+$/.test(message)) return page
        return `${page}#${review ? 'discussion_r' : 'issuecomment-'}${message}`
      },
      async fetchRoot(thread) {
        const match = /^([^/]+)\/([^:]+):(issue:)?(\d+)$/.exec(thread)
        if (!match) throw new Error(`invalid GitHub thread: ${thread}`)
        const [, owner, repo, issue, number] = match
        const client = (options.adapter as Adapter & { octokit: GitHubClient }).octokit.rest
        const { data } = issue
          ? await client.issues.get({ owner: owner!, repo: repo!, issue_number: Number(number) })
          : await client.pulls.get({ owner: owner!, repo: repo!, pull_number: Number(number) })
        return {
          text: `${issue ? 'Issue' : 'PR'} #${data.number}: ${data.title}\n${data.html_url}`,
          raw: issue ? { issue: data } : { pull_request: data },
          author: author(data.user),
          labels: {
            ...tagsOf(data),
            [issue ? 'issue' : 'pr']: `${owner}/${repo}#${data.number}`,
            state: issue ? data.state : data.merged ? 'merged' : data.state === 'closed' ? 'closed' : data.draft ? 'draft' : 'open',
          },
        }
      },
      // GitHub's own markdown, tables and all; Chat SDK's text flattens it.
      markdown(message: ChatMessage) {
        const raw = message.raw as { body?: unknown; comment?: { body?: unknown } } | null
        const body = raw?.comment?.body ?? raw?.body
        return typeof body === 'string' && body.trim() ? body.trim() : markdownOf(message)
      },
      async avatar(message: ChatMessage) {
        const raw = message.raw as { user?: { avatar_url?: unknown }; comment?: { user?: { avatar_url?: unknown } } } | null
        const url = raw?.comment?.user?.avatar_url ?? raw?.user?.avatar_url
        return typeof url === 'string' ? url : null
      },
      context(message: ChatMessage) {
        const raw = message.raw as { path?: string; line?: number; comment?: { path?: string; line?: number } } | null
        const path = raw?.path ?? raw?.comment?.path
        const line = raw?.line ?? raw?.comment?.line
        return path ? (line ? `${path}:${line}` : path) : null
      },
      // Chat SDK's GitHub adapter only handles new comments; edits (Vercel updating its deployment comment) and deletes come through here.
      missed(headers, body) {
        const name = headers.get('x-github-event') ?? ''
        if (name !== 'issue_comment' && name !== 'pull_request_review_comment') return []
        let payload: CommentPayload
        try {
          payload = JSON.parse(body) as CommentPayload
        } catch {
          return []
        }
        if ((payload.action !== 'edited' && payload.action !== 'deleted') || !payload.comment?.id || !payload.repository) return []
        const { comment, repository } = payload
        const adapter = options.adapter as Adapter & CommentParser
        const review = name === 'pull_request_review_comment'
        const number = review ? payload.pull_request?.number : payload.issue?.number
        if (!number) return []
        const type = review ? undefined : payload.issue?.pull_request ? 'pr' : 'issue'
        const threadId = adapter.encodeThreadId({
          owner: repository.owner.login, repo: repository.name, prNumber: number,
          ...(review ? { reviewCommentId: comment.in_reply_to_id ?? comment.id } : { type }),
        })
        const message = review
          ? adapter.parseReviewComment(comment, repository, number, threadId)
          : adapter.parseIssueComment(comment, repository, number, threadId, type)
        // The board's own comments: it made the change, so it already has it.
        if (message.author.isMe) return []
        return payload.action === 'edited'
          ? [{ kind: 'edited', message }]
          : [{ kind: 'deleted', thread: threadId, message: message.id, raw: payload }]
      },
      intercept(key, headers, body): ReceivedEvent[] {
        const name = headers.get('x-github-event') ?? ''
        if (!['pull_request', 'pull_request_review', 'issues', 'workflow_run'].includes(name)) return []
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(body) as Record<string, unknown>
        } catch {
          return []
        }
        const repo = (parsed.repository as { full_name: string }).full_name
        if (name === 'workflow_run') {
          const delivery = headers.get('x-github-delivery') ?? `${name}:${(parsed.workflow_run as { id?: number } | undefined)?.id}`
          return workflowRun(parsed).map((found) => ({
            event: { kind: 'lifecycle', channel: `${key}:${repo}:pulls`, thread: `${key}:${repo}:${found.number}`, author: author(found.user), ...found.lifecycle },
            raw: parsed,
            dedupe: `lifecycle:${delivery}:${found.number}`,
          }))
        }
        const found = lifecycle(name, parsed)
        if (!found) return []
        // Every PR and issue event carries all of its labels and assignees, so each one reconciles whichever it has.
        const item = (parsed.pull_request ?? parsed.issue) as Item | undefined
        if (item) Object.assign(found.lifecycle, { labels: { ...tagsOf(item), ...found.lifecycle.labels }, owns: [...ownedBy(item), ...(found.lifecycle.owns ?? [])] })
        const thread = name === 'issues' ? `${key}:${repo}:issue:${found.number}` : `${key}:${repo}:${found.number}`
        const delivery = headers.get('x-github-delivery') ?? `${name}:${found.lifecycle.type}:${found.number}`
        return [
          {
            event: { kind: 'lifecycle', channel: `${key}:${repo}:${name === 'issues' ? 'issues' : 'pulls'}`, thread, author: author(found.user), ...found.lifecycle },
            raw: parsed,
            dedupe: `lifecycle:${delivery}`,
          },
        ]
      },
      async resolveTarget(target): Promise<ResolvedTarget> {
        // A review thread's comments come in under its PR, so a board thread joins the PR: its replies
        // to review comments still go into their review threads.
        const review = /^([^/]+\/[^:]+:\d+):rc:[^:]+$/.exec(target)
        if (review) throw new Error(`a review thread can't be a target; sync its PR, ${review[1]}`)
        if (!/^[^/]+\/[^:]+(?::(?:issue:)?\d+)?$/.test(target)) throw new Error(`invalid GitHub target: ${target}`)
        const at = target.indexOf(':')
        return { target, channel: at === -1 ? target : channelOf(target), kind: at === -1 ? 'channel' : 'thread' }
      },
    }, sync)
  }

  /**
   * A thread's root is the PR or issue itself, not a comment: its copy has no comment ID
   * (`root:<event>` or `lifecycle:<event>`), so its reactions go on the PR or issue.
   */
  override async react(thread: string, message: string, emoji: string, added: boolean) {
    if (/^\d+$/.test(message)) return super.react(thread, message, emoji, added)
    const match = /^([^/]+)\/([^:]+):(?:issue:)?(\d+)$/.exec(thread)
    if (!match) throw new Error(`invalid GitHub thread: ${thread}`)
    const adapter = (await this.ready()) as Adapter & {
      octokit: GitHubClient
      getOctokitForThread?(owner: string, repo: string): Promise<GitHubClient>
      botUserId?: string
      emojiToGitHubReaction?(emoji: string): string
    }
    // GitHub has eight reactions, and the adapter turns any other emoji into +1. On the PR itself
    // that reads as the bot approving (a review's looking-bunny, a person's shipit), so skip those.
    const content = adapter.emojiToGitHubReaction?.(emoji)
    if (!content || (content === '+1' && emoji !== 'thumbs_up' && emoji !== '+1')) return
    const [, owner, repo, number] = match as unknown as [string, string, string, string]
    // The adapter's own reactions use the thread's installation, which holds outside a webhook request too.
    const client = (await adapter.getOctokitForThread?.(owner, repo)) ?? adapter.octokit
    const reactions = client.rest.reactions
    if (!reactions) throw new Error('GitHub client has no reactions API')
    const where = { owner, repo, issue_number: Number(number) }
    if (added) return void (await reactions.createForIssue({ ...where, content }))
    if (adapter.botUserId === undefined) return
    const { data } = await reactions.listForIssue({ ...where, content, per_page: 100 })
    const own = data.find((reaction) => reaction.content === content && String(reaction.user?.id) === adapter.botUserId)
    if (own) await reactions.deleteForIssue({ ...where, reaction_id: own.id })
  }

  override event(context: SyncContext): GitHubEvent {
    const match = /^([^:]+):(issue:)?(\d+)/.exec(context.event.thread.slice(context.key.length + 1))
    if (!match) throw new Error(`invalid GitHub thread: ${context.event.thread}`)
    const base = envelope(this.platform, context.key, context.event, context.raw ?? {}, context.id)
    return GitHubEvent.parse({
      ...base,
      type: context.event.kind === 'message' ? 'comment' : base.type,
      subject: { type: match[2] ? 'issue' : 'pull_request', repo: match[1], number: Number(match[3]) },
    })
  }
}
