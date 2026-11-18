import { ChatSyncProvider, type ChatInput } from './chat-provider.ts'
import type { Adapter, Message as ChatMessage } from 'chat'
import type { ExternalAuthor } from '../contract/external.ts'
import { markdownOf } from './chat.ts'
import { z } from 'zod'
import { envelope, eventSchema } from './events.ts'
import { UnreadableError, type ProviderDelivery, type ProviderPost, type ReceivedEvent, type ResolvedTarget, type SyncContext } from './provider.ts'
import { createLinearAdapter } from '@chat-adapter/linear'
import { connectLinearAdapter } from '@vercel/connect/chat'
import { channels, type SyncFn, type SyncUnit } from './fn.ts'
import { slug, tagOf } from './tags.ts'
import type { SourceMessage, SourceRead } from '../api/routes.ts'

export const LinearEvent = eventSchema('linear', 'comment')
export type LinearEvent = z.infer<typeof LinearEvent>

export type LinearOptions = {
  /**
   * A Vercel Connect connector (`'linear/acme'`) holding a Linear app's token: board builds the
   * Chat SDK adapter from it. Or your own adapter from `createLinearAdapter`, in its default
   * `comments` mode, with the app's own token: the adapter skips what its token's user writes.
   */
  adapter: Adapter | string
}

/**
 * Syncs Linear with the board: `app` is a Vercel Connect connector (`'linear/acme'`) or the
 * options, and `sync` is what each event does, both ways, like `teams({ ENG: 'dev' })`. Each
 * issue is a thread: its comments are replies, and a board root in a mirrored team opens an issue.
 */
export function linear(app: string | LinearOptions, sync: SyncFn<LinearEvent>): LinearProvider {
  return new LinearProvider(typeof app === 'string' ? { adapter: app } : app, sync)
}

/**
 * Routes each event by its Linear team. Keys are team keys (`'ENG'`, the prefix of `ENG-123`);
 * values are a board channel to `mirror`, or a sync function.
 */
export const teams = (map: Record<string, SyncUnit<LinearEvent>>): SyncFn<LinearEvent> => channels(map)

type User = { id?: string; name?: string; displayName?: string; url?: string; avatarUrl?: string | null; type?: string }

/** A person's handle, the end of their profile URL (`…/profiles/ada`), as the adapter reads it. */
const handleOf = (user: User | undefined) => /\/profiles\/([^/?#]+)/.exec(user?.url ?? '')?.[1] ?? user?.displayName ?? user?.name

const author = (user: User | undefined, isBot: boolean): ExternalAuthor => ({
  id: `linear:user:${user?.id ?? 'unknown'}`,
  handle: handleOf(user) ?? 'unknown',
  name: user?.name ?? user?.displayName ?? 'unknown',
  avatar: user?.avatarUrl ?? null,
  // A webhook's actor is a person (`user`) or an app (`OauthClient`, `Integration`).
  isBot: isBot || (user?.type !== undefined && user.type !== 'user'),
})

/** `ENG` from `ENG-123`, or from a Linear URL that names an issue (`…/issue/ENG-123/…`). */
const teamOf = (identifierOrUrl: string | undefined | null) => /(?:^|\/issue\/)([A-Z0-9_]+)-\d+/i.exec(identifierOrUrl ?? '')?.[1]?.toUpperCase() ?? null

type CommentData = { id: string; body?: string; issueId?: string; parentId?: string | null; user?: User; issue?: { id?: string; identifier?: string } }
type CommentPayload = { type: 'Comment'; action: string; url?: string; data: CommentData; organizationId: string }
type IssueData = {
  id: string; identifier: string; title: string; url?: string; description?: string | null
  team?: { key?: string }; state?: { name?: string; type?: string }
  creatorId?: string | null; archivedAt?: string | null
  priority?: number; priorityLabel?: string
  assigneeId?: string | null; assignee?: User | null
  labels?: { name?: string }[]
  projectId?: string | null; project?: { name?: string } | null
}
type IssuePayload = {
  type: 'Issue'; action: string; url?: string; data: IssueData
  updatedFrom?: { stateId?: unknown; title?: unknown; description?: unknown }; actor?: User; webhookId?: string; webhookTimestamp?: number
}

/** An issue's description, or null when it has none. */
const bodyOf = (description: string | null | undefined) => description?.trim() || null

/**
 * An issue's properties as board labels: `priority=high`, `project=v0-accessibility`, a label per
 * Linear label (`tag.bug`), and its assignee (`assignee.ada`). Only what the payload says: a
 * property it carries empty is unset, and one it names without its details is left as it was.
 * Linear leaves an empty assignee or project out of the payload rather than sending `null`, so
 * either one missing, with no ID either, is empty.
 * `priority` and `project` are single keys, so they're unset by name; `tag.` and `assignee.` are
 * prefixes the mirror owns, so a key under them that Linear doesn't have goes.
 */
function propertiesOf(data: IssueData): { labels: Record<string, string>; unset: string[]; owns: string[] } {
  const labels: Record<string, string> = {}
  const unset: string[] = []
  const owns: string[] = []
  if (data.priority === 0 || data.priorityLabel === 'No priority') unset.push('priority')
  else if (data.priorityLabel && slug(data.priorityLabel)) labels.priority = slug(data.priorityLabel).slice(0, 256)
  if (data.project?.name && slug(data.project.name)) labels.project = slug(data.project.name).slice(0, 256)
  else if (!data.project && !data.projectId) unset.push('project')
  if (Array.isArray(data.labels)) {
    owns.push('tag.')
    for (const label of data.labels) {
      const tag = tagOf('tag', label.name)
      if (tag) labels[tag[0]] = tag[1]
    }
  }
  if (data.assignee) {
    owns.push('assignee.')
    const tag = tagOf('assignee', handleOf(data.assignee))
    if (tag) labels[tag[0]] = tag[1]
  } else if (!data.assigneeId) owns.push('assignee.')
  return { labels, unset, owns }
}
type LinearRaw = { kind?: string; comment?: { url?: string; issueId?: string; parentId?: string; id?: string; body?: string; user?: { avatarUrl?: string } } }

/** The adapter's own parsing, and its client for a Connect token outside a webhook. */
type LinearAdapter = Adapter & {
  linearClient: LinearClient
  defaultBotUserId: string | null
  isConnectMode(): boolean
  withConnectClient<T>(organizationId: string | undefined, fn: () => Promise<T>): Promise<T>
  parseMessage(raw: { kind: 'comment'; comment: Record<string, unknown>; organizationId: string }): ChatMessage
}

type Issue = {
  id: string; identifier: string; title: string; url: string; description?: string | null
  state?: Promise<{ name?: string; type?: string } | undefined>
  team?: Promise<{ key?: string } | undefined>
  creator?: Promise<User | undefined>
  priority?: number; priorityLabel?: string
  project?: Promise<{ name?: string } | undefined>
  assignee?: Promise<User | undefined>
  labels?: () => Promise<{ nodes: { name?: string }[] }>
}
type LinearClient = {
  teams(args: { filter: { key: { eq: string } } }): Promise<{ nodes: { id: string; key: string }[] }>
  issue(id: string): Promise<Issue>
  createIssue(input: { teamId: string; title: string; description: string }): Promise<{ issueId?: string }>
  updateIssue(id: string, input: { description: string }): Promise<unknown>
}

/** The copy of an issue the board opened: the issue itself, not a comment. */
const OPENED = 'issue'
/** A root's copy: one the board opened, or imported (`lifecycle:<event>`, `root:<event>`). Comment IDs are UUIDs. */
const isIssue = (message: string) => message === OPENED || message.includes(':')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `ENG:<issueId>`, or `ENG:<issueId>:c:<commentId>` (a comment thread): the team, and the issue's UUID. */
function parseThread(thread: string) {
  const match = /^([A-Z0-9_]+):([^:]+)(?::c:([^:]+))?$/i.exec(thread)
  if (!match) throw new Error(`invalid Linear thread: ${thread}`)
  return { team: match[1]!.toUpperCase(), issue: match[2]!, comment: match[3] ?? null }
}

/** A board message's first line, as an issue title: Linear titles are plain text. */
function titleOf(markdown: string) {
  // Without the label `render` opens a message with (`**ada**: `, on a line of its own before a block): the description keeps it.
  const line = markdown.replace(/^\*\*[^*\n]+\*\*:\s*/, '').split('\n').map((text) => text.trim()).find(Boolean) ?? ''
  return line.replace(/\*\*|__|`/g, '').replace(/^[#>\s]+/, '').replace(/\s+/g, ' ').trim().slice(0, 255) || 'Untitled'
}

function stateOf(state: { name?: string; type?: string } | undefined) {
  return state?.type ?? state?.name?.toLowerCase() ?? null
}

type ReadIssue = {
  id: string; identifier: string; title: string; description?: string | null; url: string; createdAt: string
  priority?: number; priorityLabel?: string
  state?: { name?: string } | null; assignee?: User | null; creator?: User | null; project?: { name?: string } | null
  labels?: { nodes: { name?: string }[] }
  comments?: { nodes: ReadComment[]; pageInfo?: Page }
}
type ReadComment = { id: string; body?: string; createdAt: string; user?: User | null }
type Page = { hasNextPage: boolean; endCursor?: string | null }
type GraphQL = { client: { rawRequest<T>(query: string, variables: Record<string, unknown>): Promise<{ data?: T }> } }

const ISSUE_FIELDS = `id identifier title description url createdAt priority priorityLabel
  state { name } assignee { name displayName url } creator { name displayName url } project { name }
  labels(first: 10) { nodes { name } }`
// Linear caps a query's complexity, so a page of issues is smaller than the 200 a read can ask for.
const ISSUES_PER_PAGE = 100
const DESCRIPTION_IN_LIST = 1500
const MAX_COMMENTS = 1000

/** What a read names: a project (by its link), a team (by its key), or an issue (by its ID or link). */
function readTargetOf(target: string): { kind: 'project'; slugId: string } | { kind: 'team'; key: string } | { kind: 'issue'; id: string } {
  const project = /\/project\/(?:[^/?#]*-)?([0-9a-f]{8,})(?:[/?#]|$)/i.exec(target)
  if (project) return { kind: 'project', slugId: project[1]! }
  const issue = /(?:^|\/issue\/)([A-Z0-9_]+-\d+)(?:[/?#]|$)/i.exec(target.trim())
  if (issue) return { kind: 'issue', id: issue[1]!.toUpperCase() }
  if (/^[A-Z0-9_]+$/i.test(target.trim())) return { kind: 'team', key: target.trim().toUpperCase() }
  throw new UnreadableError('invalid_target', `can't read ${target} from Linear: name a project by its link, a team by its key (ENG), or an issue (ENG-123)`)
}

/** An issue as a read shows it: its title, its properties on one line, its link, and what it says. */
function issueMessage(issue: ReadIssue, descriptionMax: number | null): SourceMessage {
  const properties = [
    issue.state?.name,
    issue.priority ? issue.priorityLabel : undefined,
    issue.assignee ? `assigned to ${handleOf(issue.assignee)}` : 'unassigned',
    issue.project?.name,
    ...(issue.labels?.nodes ?? []).map((label) => label.name),
  ].filter(Boolean)
  const description = bodyOf(issue.description)
  const shown = description && descriptionMax !== null && description.length > descriptionMax ? `${description.slice(0, descriptionMax)}…` : description
  return {
    id: issue.identifier,
    thread: issue.identifier,
    author: handleOf(issue.creator ?? undefined) ?? 'unknown',
    text: [`${issue.identifier}: ${issue.title}\n${properties.join(' · ')}\n${issue.url}`, shown].filter(Boolean).join('\n\n'),
    createdAt: issue.createdAt,
    replies: issue.comments?.nodes.length ?? 0,
    files: [],
  }
}

export class LinearProvider extends ChatSyncProvider<LinearEvent> {
  private readonly linear: LinearAdapter
  private readonly teamIds = new Map<string, string>()

  constructor(given: LinearOptions, sync: SyncFn<LinearEvent>) {
    const adapter = (typeof given.adapter === 'string'
      ? createLinearAdapter({ ...connectLinearAdapter(given.adapter), mode: 'comments' })
      : given.adapter) as unknown as LinearAdapter
    super({
      platform: 'linear',
      adapter,
      canStartThreads: true,
      // Checked against Linear by the class's own `resolveChannel` and `resolveTarget`, which reach its API.
      resolveChannel: (key) => Promise.resolve(key.toUpperCase()),
      resolveTarget: (target) => Promise.resolve({ target, channel: target, kind: 'channel' }),
      // A comment thread (`ENG:<issue>:c:<comment>`) belongs to its issue (`ENG:<issue>`).
      groupThread: (thread) => thread.replace(/:c:[^:]+$/, ''),
      channelOf: (thread) => thread.slice(0, thread.indexOf(':')),
      // The board's IDs carry the team, which Chat SDK's don't: `ENG:<issue>` is `<issue>` there.
      toChatId: (id) => id.slice(id.indexOf(':') + 1),
      isRoot: () => false,
      context: () => null,
      // Linear's own markdown; Chat SDK's text flattens it.
      markdown(message: ChatMessage) {
        const body = (message.raw as LinearRaw | null)?.comment?.body
        return typeof body === 'string' && body.trim() ? body.trim() : markdownOf(message)
      },
      async avatar(message: ChatMessage) {
        return (message.raw as LinearRaw | null)?.comment?.user?.avatarUrl ?? null
      },
      // The adapter only emits new comments: edits and deletes come through here.
      missed(_headers, body) {
        let payload: CommentPayload
        try {
          payload = JSON.parse(body) as CommentPayload
        } catch {
          return []
        }
        if (payload.type !== 'Comment' || (payload.action !== 'update' && payload.action !== 'remove')) return []
        const { data } = payload
        const issueId = data.issueId ?? data.issue?.id
        if (!issueId || !data.user) return []
        const message = adapter.parseMessage({
          kind: 'comment',
          organizationId: payload.organizationId,
          comment: {
            ...data, issueId, parentId: data.parentId ?? undefined, url: payload.url,
            user: { type: 'user', id: data.user.id, displayName: handleOf(data.user) ?? 'unknown', fullName: data.user.name ?? 'unknown', email: undefined, avatarUrl: data.user.avatarUrl ?? undefined },
          },
        })
        // The board's own comments: it made the change, so it already has it.
        if (message.author.isMe) return []
        return payload.action === 'update'
          ? [{ kind: 'edited', message }]
          : [{ kind: 'deleted', thread: message.threadId, message: message.id, raw: payload }]
      },
      intercept(key, headers, body): ReceivedEvent[] {
        let payload: IssuePayload
        try {
          payload = JSON.parse(body) as IssuePayload
        } catch {
          return []
        }
        if (payload.type !== 'Issue' || !payload.data?.identifier) return []
        const { data } = payload
        const created = payload.action === 'create'
        if (!created && payload.action !== 'update') return []
        const retitled = payload.action === 'update' && (payload.updatedFrom?.title !== undefined || payload.updatedFrom?.description !== undefined)
        const team = data.team?.key ?? teamOf(data.identifier)!
        const state = stateOf(data.state)
        // An issue the board opened: its root is the board's, recorded when the post returns,
        // so this event only labels it, and never opens a second root for the same issue.
        const bot = adapter.defaultBotUserId
        const own = payload.actor?.id !== undefined && payload.actor.id === bot
        // An edit opens the thread of an issue the board hasn't seen, so issues that predate the
        // mirror, or moved into a mirrored team, come in when someone next touches them. Not an
        // issue the board created (its root is recorded when the post returns, and an edit in
        // that window would open a second one), and not Linear's own automations or an archive,
        // which sweep through old issues in bulk.
        const opens = created
          ? !own
          : !own && (bot === null || data.creatorId !== bot) && payload.actor?.type === 'user' && !data.archivedAt
        const delivery = headers.get('linear-delivery') ?? `${payload.webhookId}:${payload.webhookTimestamp}`
        const properties = propertiesOf(data)
        return [{
          event: {
            kind: 'lifecycle',
            channel: `${key}:${team}`,
            thread: `${key}:${team}:${data.id}`,
            type: created ? 'issue.created' : 'issue.updated',
            title: `${data.identifier}: ${data.title}`,
            url: data.url ?? payload.url ?? null,
            body: bodyOf(data.description),
            labels: { issue: data.identifier, ...(state ? { state } : {}), ...properties.labels },
            unset: properties.unset,
            owns: properties.owns,
            reply: null,
            createRoot: opens,
            ...(retitled ? { retitled: true } : {}),
            author: author(payload.actor, own),
          },
          raw: payload,
          dedupe: `lifecycle:${delivery}`,
        }]
      },
    }, sync)
    this.linear = adapter
  }

  /**
   * Runs a Linear API call. A Connect token lives in the adapter's request context, which only a
   * webhook sets up: anything else (a delivery, a root fetched on a later pull) asks for one here.
   */
  private async api<T>(fn: () => Promise<T>): Promise<T> {
    await this.ready()
    return this.linear.isConnectMode() ? this.linear.withConnectClient(undefined, fn) : fn()
  }

  /**
   * A project's or team's issues, newest first, or one issue and its comments, read on demand:
   * nothing is synced or stored. `next` pages past a read's `limit`.
   */
  override async read(target: string, { limit, after }: { limit: number; after: string | null }): Promise<SourceRead> {
    const wanted = readTargetOf(target)
    const query = <T>(text: string, variables: Record<string, unknown>) =>
      this.api(async () => (await (this.client() as unknown as GraphQL).client.rawRequest<T>(text, variables)).data)
    if (wanted.kind === 'issue') {
      // Linear pages comments by its own order, so read them all and page oldest first here.
      let issue: ReadIssue | null = null
      const comments: ReadComment[] = []
      let cursor: string | null = null
      do {
        const data: { issue: ReadIssue | null } | undefined = await query<{ issue: ReadIssue | null }>(
          `query BoardReadIssue($id: String!, $first: Int!, $after: String) { issue(id: $id) { ${ISSUE_FIELDS}
            comments(first: $first, after: $after) { nodes { id body createdAt user { name displayName url } } pageInfo { hasNextPage endCursor } } } }`,
          { id: wanted.id, first: ISSUES_PER_PAGE, after: cursor },
        )
        if (!data?.issue) throw new UnreadableError('channel_not_found', `no Linear issue ${wanted.id}`)
        issue = data.issue
        comments.push(...(issue.comments?.nodes ?? []))
        const page: Page | undefined = issue.comments?.pageInfo
        cursor = page?.hasNextPage ? page.endCursor ?? null : null
      } while (cursor !== null && comments.length < MAX_COMMENTS)
      comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      const from = after === null ? 0 : Math.max(0, Number.parseInt(after, 10) || 0)
      const shown = comments.slice(from, from + Math.min(limit, ISSUES_PER_PAGE))
      const to = from + shown.length
      return {
        channel: teamOf(issue.identifier) ?? wanted.id,
        name: null,
        thread: issue.identifier,
        messages: [
          ...(from === 0 ? [{ ...issueMessage(issue, null), replies: comments.length }] : []),
          ...shown.map((comment) => ({
            id: comment.id, thread: issue.identifier, author: handleOf(comment.user ?? undefined) ?? 'unknown',
            text: comment.body ?? '', createdAt: comment.createdAt, replies: 0, files: [],
          })),
        ],
        more: to < comments.length,
        next: to < comments.length ? String(to) : null,
      }
    }
    let filter: Record<string, unknown>
    let channel: string
    let name: string | null
    if (wanted.kind === 'project') {
      const data = await query<{ projects: { nodes: { id: string; name: string; url: string }[] } }>(
        'query BoardReadProject($slugId: String!) { projects(filter: { slugId: { eq: $slugId } }, first: 1) { nodes { id name url } } }',
        { slugId: wanted.slugId },
      )
      const project = data?.projects.nodes[0]
      if (!project) throw new UnreadableError('channel_not_found', `no Linear project ${target}`)
      filter = { project: { id: { eq: project.id } } }
      channel = project.url
      name = project.name
    } else {
      await this.team(wanted.key)
      filter = { team: { key: { eq: wanted.key } } }
      channel = wanted.key
      name = null
    }
    const data = await query<{ issues: { nodes: ReadIssue[]; pageInfo: Page } }>(
      `query BoardReadIssues($filter: IssueFilter, $first: Int!, $after: String) {
        issues(filter: $filter, first: $first, after: $after) { nodes { ${ISSUE_FIELDS} comments(first: 20) { nodes { id createdAt } } } pageInfo { hasNextPage endCursor } } }`,
      { filter, first: Math.min(limit, ISSUES_PER_PAGE), after },
    )
    const issues = data?.issues
    return {
      channel,
      name,
      thread: null,
      messages: (issues?.nodes ?? []).map((issue) => issueMessage(issue, DESCRIPTION_IN_LIST)),
      more: issues?.pageInfo.hasNextPage ?? false,
      next: issues?.pageInfo.hasNextPage ? issues.pageInfo.endCursor ?? null : null,
    }
  }

  override async resolveChannel(key: string) {
    await this.team(key)
    return key.toUpperCase()
  }

  /**
   * `ENG` is a team; `ENG:<uuid>`, a bare UUID, or `ENG-12` is an issue, by its team and UUID:
   * comments come in under the UUID, which stays when the issue is renamed.
   */
  override async resolveTarget(target: string): Promise<ResolvedTarget> {
    if (/:c:[^:]+$/.test(target)) throw new Error(`a comment thread can't be a target; sync its issue, ${target.replace(/:c:[^:]+$/, '')}`)
    if (/^[A-Z0-9_]+$/i.test(target)) return { target: target.toUpperCase(), channel: target.toUpperCase(), kind: 'channel' }
    const scoped = /^([A-Z0-9_]+):([^:]+)$/i.exec(target)
    if (scoped && UUID.test(scoped[2]!)) return { target: `${scoped[1]!.toUpperCase()}:${scoped[2]}`, channel: scoped[1]!.toUpperCase(), kind: 'thread' }
    if (!UUID.test(target) && !/^[A-Z0-9_]+-\d+$/i.test(target)) throw new Error(`invalid Linear target: ${target}`)
    const issue = await this.api(() => this.client().issue(target))
    const team = teamOf(issue.identifier) ?? (await this.api(async () => (await issue.team)?.key))
    if (!team) throw new Error(`Linear didn't say which team ${target} is in`)
    return { target: `${team.toUpperCase()}:${issue.id}`, channel: team.toUpperCase(), kind: 'thread' }
  }

  override async fetchRoot(thread: string) {
    return this.api(async () => {
      const issue = await this.client().issue(parseThread(thread).issue)
      const [state, creator, project, assignee, tags] = await Promise.all([issue.state, issue.creator, issue.project, issue.assignee, issue.labels?.()])
      const found = stateOf(state)
      const properties = propertiesOf({
        id: issue.id, identifier: issue.identifier, title: issue.title,
        priority: issue.priority, priorityLabel: issue.priorityLabel, project, assignee, labels: tags?.nodes,
      })
      return {
        text: [`${issue.identifier}: ${issue.title}\n${issue.url}`, bodyOf(issue.description)].filter(Boolean).join('\n\n'),
        raw: { issue: { id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url } },
        author: author(creator, false),
        labels: { issue: issue.identifier, ...(found ? { state: found } : {}), ...properties.labels },
      }
    })
  }

  private client() {
    return this.linear.linearClient
  }

  /** A team's ID from its key, which Linear's API asks for to open an issue. */
  private async team(key: string): Promise<string> {
    const wanted = key.toUpperCase()
    const known = this.teamIds.get(wanted)
    if (known) return known
    const { nodes } = await this.api(() => this.client().teams({ filter: { key: { eq: wanted } } }))
    const team = nodes.find((node) => node.key.toUpperCase() === wanted)
    if (!team) throw new UnreadableError('channel_not_found', `no Linear team ${wanted}`)
    this.teamIds.set(wanted, team.id)
    return team.id
  }

  // The channel is the comment's team, from its URL, or Linear's API when the URL doesn't say.
  protected override async normalize(key: string, input: ChatInput): Promise<ReceivedEvent> {
    const received = await super.normalize(key, input)
    if (input.kind === 'reaction') return received
    const raw = (input.kind === 'deleted' ? input.raw : input.message.raw) as (LinearRaw & CommentPayload) | null
    const comment = raw?.comment ?? raw?.data
    const issue = comment?.issueId ?? raw?.data?.issue?.id
    const root = (comment as { parentId?: string } | undefined)?.parentId || comment?.id
    if (!issue || !root) return received
    const team = teamOf(raw?.comment?.url ?? raw?.url) ?? teamOf(raw?.data?.issue?.identifier) ?? await this.teamOfIssue(issue)
    const thread = `${key}:${team}:${issue}`
    const event = { ...received.event, channel: `${key}:${team}`, thread, subthread: `${thread}:c:${root}` }
    return { ...received, event } as ReceivedEvent
  }

  private async teamOfIssue(id: string) {
    return this.api(async () => {
      const issue = await this.client().issue(id)
      const team = teamOf(issue.identifier) ?? (await issue.team)?.key
      if (!team) throw new Error(`Linear didn't say which team issue ${id} is in`)
      return team.toUpperCase()
    })
  }

  override inboxChannel(key: string, thread: string): string {
    return `${key}:${parseThread(thread.slice(key.length + 1)).team}`
  }

  /** A root in a mirrored team opens an issue, titled with its first line; a reply is a comment. */
  override async post(target: string, kind: ResolvedTarget['kind'], post: ProviderPost): Promise<ProviderDelivery> {
    if (kind === 'thread') {
      const sent = await this.api(() => super.post(target, kind, post))
      return { ...sent, thread: target }
    }
    const teamId = await this.team(target)
    const created = await this.api(() => this.client().createIssue({ teamId, title: titleOf(post.markdown), description: post.markdown }))
    if (!created.issueId) throw new Error(`Linear didn't return the issue it opened in ${target}`)
    return { thread: `${target.toUpperCase()}:${created.issueId}`, message: OPENED }
  }

  // Only an issue the board opened takes the root's text: one opened on Linear keeps its own description.
  override async edit(thread: string, message: string, post: ProviderPost) {
    if (message === OPENED) return void (await this.api(() => this.client().updateIssue(parseThread(thread).issue, { description: post.markdown })))
    if (!isIssue(message)) await this.api(() => super.edit(thread, message, post))
  }

  // An issue stays when its root is deleted on the board: closing it is a person's call.
  override async delete(thread: string, message: string) {
    if (!isIssue(message)) await this.api(() => super.delete(thread, message))
  }

  // Linear reacts to comments, not to issues, and the adapter can't take a reaction back.
  override async react(thread: string, message: string, emoji: string, added: boolean) {
    if (added && !isIssue(message)) await this.api(() => super.react(thread, message, emoji, added))
  }

  // Linear has no typing indicator for comments.
  override async startTyping() {}

  override event(context: SyncContext): LinearEvent {
    const base = envelope(this.platform, context.key, context.event, context.raw ?? {}, context.id)
    return LinearEvent.parse({ ...base, type: context.event.kind === 'message' ? 'comment' : base.type })
  }
}
