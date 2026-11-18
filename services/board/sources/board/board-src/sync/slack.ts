import { ChatSyncProvider, type ChatInput } from './chat-provider.ts'
import type { Adapter, Message as ChatMessage } from 'chat'
import { markdownOf } from './chat.ts'
import { z } from 'zod'
import { envelope, eventSchema } from './events.ts'
import { opensBlock, UnreadableError, type ResolvedTarget, type ProviderPost, type ProviderDelivery, type ProviderFile, type ProviderSender, type SyncContext, type ReceivedEvent, type FetchedLink } from './provider.ts'
import type { SourceJoin, SourceMessage, SourceRead } from '../api/routes.ts'
import { stringifyMarkdown } from 'chat'
import { LINKS_PER_MESSAGE_MAX, MENTIONED_PER_MESSAGE_MAX, type ExternalLink } from '../contract/external.ts'
import { extractMentions } from '../contract/mentions.ts'
import { MESSAGE_TEXT_MAX } from '../contract/schemas.ts'
import { createSlackAdapter } from '@chat-adapter/slack'
import { connectSlackAdapter } from '@vercel/connect/chat'
import type { SyncFn } from './fn.ts'
import { deploymentsLayout, type SlackBlock, type SlackText } from './slack-deployments.ts'
import type { VercelDeployment } from '../contract/bots.ts'

type SlackChannel = { id?: string; name?: string; is_member?: boolean; is_private?: boolean; is_im?: boolean; is_mpim?: boolean; is_ext_shared?: boolean }
export type SlackClient = {
  conversations: {
    list(args: Record<string, unknown>): Promise<{
      channels?: SlackChannel[]
      response_metadata?: { next_cursor?: string }
    }>
    info(args: { channel: string }): Promise<{ channel?: SlackChannel }>
    /** Reads a linked message or a thread; needs `channels:history` (`groups:history` for private channels). */
    replies?(args: { channel: string; ts: string; oldest?: string; latest?: string; inclusive?: boolean; limit: number }): Promise<{ messages?: SlackMessage[]; has_more?: boolean }>
    /** Reads a channel, newest first, for `vb sources <key> read`; needs `channels:history`. */
    history?(args: { channel: string; limit: number }): Promise<{ messages?: SlackMessage[]; has_more?: boolean }>
    /** Adds the app to a public channel, for `vb sources <key> join`; needs `channels:join`. */
    join?(args: { channel: string }): Promise<unknown>
  }
  users?: {
    info(args: { user: string }): Promise<{ user?: SlackUser }>
    lookupByEmail?(args: { email: string }): Promise<{ user?: SlackUser }>
  }
  files?: {
    delete(args: { file: string }): Promise<unknown>
    /** Uploads files and shares them in one message, with `initial_comment` as its text; needs `files:write`. */
    uploadV2?(args: { channel_id: string; initial_comment: string; file_uploads: { file: Buffer; filename: string }[] }): Promise<{ files?: { files?: { id?: string }[] }[] }>
    /** Where a file was shared (`shares`), to find the message an upload made; needs `files:read`. */
    info?(args: { file: string }): Promise<{ file?: { shares?: Partial<Record<'public' | 'private', Record<string, { ts?: string }[]>>> } }>
  }
  /** Posts an agent's message under its own name; needs `chat:write.customize` for `username` and `icon_url`. */
  chat?: {
    postMessage(args: SlackPost): Promise<{ ts?: string }>
    /** Replaces a message's text and layout, for one board laid out itself. */
    update?(args: { channel: string; ts: string; text: string; blocks: SlackBlock[] }): Promise<unknown>
    /** A message's link, with the workspace's own host and a reply's `thread_ts`. */
    getPermalink?(args: { channel: string; message_ts: string }): Promise<{ permalink?: string }>
  }
  /** Says which scopes the app has (`response_metadata.scopes`, from Slack's `x-oauth-scopes`). */
  /** Also whose a token is (`user_id`), for a person's own. */
  auth?: { test(args?: Record<string, unknown>): Promise<{ user_id?: string; user?: string; team_id?: string; response_metadata?: { scopes?: string[] } }> }
}

type SlackPost = {
  channel: string
  thread_ts?: string
  text?: string
  markdown_text?: string
  blocks?: SlackBlock[]
  username?: string
  icon_url?: string
  unfurl_links?: boolean
  unfurl_media?: boolean
}

/** What the Slack adapter does to a message before posting it, used when board posts one itself. */
type SlackInternals = Omit<Adapter, 'decodeThreadId'> & {
  decodeThreadId(threadId: string): { channel: string; threadTs: string }
  formatConverter?: {
    toSlackPayload?(message: { markdown: string }): { text: string } | { markdown_text: string }
    /** Markdown as Slack's older mrkdwn, the only text a file upload's comment takes. */
    toResponseUrlText?(message: { markdown: string }): string
  }
  /** The adapter's own lookup of a bare `@name` by display name, before it posts: off here, see `literalMentions`. */
  resolveMessageMentions?(message: { markdown: string }, threadId: string): Promise<{ markdown: string }>
  /** What the adapter writes in place of each user and channel a message it reads mentions: a user's is their ID here, see `literalMentions`. */
  lookupMentionNames?(users: Set<string>, channels: Set<string>): Promise<{ users: Map<string, string>; channels: Map<string, string> }>
  /** A Slack user as the adapter knows them, which it asks Slack for once and keeps: how it names a message's author too. */
  lookupUser?(user: string): Promise<{ displayName?: string; realName?: string; isBot?: boolean } | null>
}

/**
 * How a user a Slack message mentions stands in what the adapter reads of it: their ID between two
 * characters from Unicode's private use area, which nothing along the way escapes or rewrites.
 */
const MENTIONED = /@\uF8F0([A-Z0-9_]+)\uF8F1/g
const mentionedAs = (user: string) => `\uF8F0${user}\uF8F1`
/** A user's mention in Slack's own mrkdwn, with the name Slack may give it: `<@U0456>`, `<@U0456|ada>`. */
const SLACK_MENTION = /<@([A-Z0-9_]+)(?:\|[^<>]*)?>/g
/**
 * A Slack user's ID, as `<@U0456>` names one: `U…`, or `W…` on Enterprise Grid. A bot's own ID
 * (`B…`, the author of an app's messages) isn't one, and Slack shows `<@B0456>` as it's written.
 */
const SLACK_USER_ID = /^[UW][A-Z0-9_]+$/
/**
 * A Slack user as Slack mentions them, from their ID alone. Only a user's ID: anything else between
 * `<@` and `>` could close the mention and open Slack's own markup (`<!channel>`), and a bot's ID
 * shows as markup, so the mention stays text.
 */
function slackMention(id: string): string | null {
  const user = id.startsWith('slack:user:') ? id.slice('slack:user:'.length) : null
  return user !== null && SLACK_USER_ID.test(user) ? `<@${user}>` : null
}
/** What the adapter read of a Slack message, each user it mentions as board writes a mention: `@[slack:user:U0456]`. */
const mentionsById = (text: string): string => text.replace(MENTIONED, '@[slack:user:$1]')

/** Each `@` the adapter reads as a mention: one that opens a word, and isn't Slack's own `<@U0456>` or inside a word, as an email's is. */
const BARE_MENTION = /(?<![<A-Za-z0-9_])@(?=[A-Za-z0-9_])/g

/** A character `text` doesn't have, from Unicode's private use area, or null if it has them all. */
function unusedIn(text: string): string | null {
  for (let code = 0xe000; code <= 0xf8ff; code++) if (!text.includes(String.fromCharCode(code))) return String.fromCharCode(code)
  return null
}

/**
 * A message as the adapter converts it, each bare `@` standing as a character its text doesn't have,
 * and `back`, which puts them in what the adapter made of it. Only a string, or a message's
 * `markdown` or `raw`, is text: anything else goes as it is.
 */
function withoutBareMentions<M>(message: M): { given: M; back: (text: string) => string } {
  const asIs = { given: message, back: (text: string) => text }
  const fields = message as Record<string, unknown> | null
  const field = typeof message === 'string' ? null : (['markdown', 'raw'] as const).find((name) => typeof fields?.[name] === 'string')
  const text = typeof message === 'string' ? message : field ? (fields![field] as string) : null
  const stand = text?.includes('@') ? unusedIn(text) : null
  if (text === null || stand === null) return asIs
  const hidden = text.replace(BARE_MENTION, stand)
  return { given: (field ? { ...fields, [field]: hidden } : hidden) as M, back: (made) => made.replaceAll(stand, '@') }
}

const literal = new WeakSet<object>()
/**
 * Turns off the adapter's own reading of mentions, once. Board resolves a message's mentions against
 * its own users before a provider posts it (the engine's `textFor`), each one it finds as Slack's
 * `<@U0456>`, and what it leaves is text: a handle no one here has, a package's name. The adapter
 * would look a bare `@name` up by display name, and write whatever is left as `<@name>`, which Slack
 * shows as is. So its lookup answers the message it was given, and its converter never sees a bare
 * `@`: it converts the text without them, and they go back in what it made.
 *
 * Coming in, the adapter writes each user a message mentions by display name, and their ID is gone
 * from what it read. Here it writes the ID, in a form `mentionsById` reads back, so a mention on
 * Slack is a mention of that user on the board.
 */
function literalMentions(adapter: SlackInternals): void {
  if (literal.has(adapter)) return
  literal.add(adapter)
  if (adapter.resolveMessageMentions) adapter.resolveMessageMentions = async (message) => message
  const names = adapter.lookupMentionNames
  if (names)
    adapter.lookupMentionNames = async (users, channels) => ({
      channels: (await names.call(adapter, new Set(), channels)).channels,
      users: new Map([...users].map((user) => [user, mentionedAs(user)])),
    })
  const converter = adapter.formatConverter
  if (!converter) return
  const { toSlackPayload, toResponseUrlText } = converter
  if (toSlackPayload)
    converter.toSlackPayload = (message) => {
      const { given, back } = withoutBareMentions(message)
      const payload = toSlackPayload.call(converter, given)
      return 'markdown_text' in payload ? { ...payload, markdown_text: back(payload.markdown_text) } : { ...payload, text: back(payload.text) }
    }
  if (toResponseUrlText)
    converter.toResponseUrlText = (message) => {
      const { given, back } = withoutBareMentions(message)
      return back(toResponseUrlText.call(converter, given))
    }
}

/** The most characters Slack shows of a message's username. */
const USERNAME_MAX = 80

/**
 * A sender's name as Slack shows it, at most 80 characters: a long name is cut, never whose word it
 * is. Null when that alone doesn't fit, for the message to go as the app with its label.
 */
export function slackUsername({ name, attribution = '' }: Pick<ProviderSender, 'name' | 'attribution'>): string | null {
  if (Array.from(name).length <= USERNAME_MAX) return name
  const room = USERNAME_MAX - Array.from(attribution).length - 1
  if (room < 1) return null
  // Cut on whole characters as people see them, so a flag or a family emoji isn't left half there.
  let cut = ''
  for (const { segment } of new Intl.Segmenter().segment(name.slice(0, name.length - attribution.length))) {
    if (Array.from(cut + segment).length > room) break
    cut += segment
  }
  return `${cut.trimEnd()}…${attribution}`
}

/**
 * Text as the adapter gives it to Slack, so the text around a table reads as it does in any
 * message (an emoji by its Slack name): markdown as the adapter posts
 * it, and its older mrkdwn, which a message's notification text is.
 */
const textOf = (adapter: SlackInternals): SlackText => ({
  markdown: (markdown) => {
    const payload = adapter.formatConverter?.toSlackPayload?.call(adapter.formatConverter, { markdown })
    return payload && 'markdown_text' in payload ? payload.markdown_text : markdown
  },
  mrkdwn: (markdown) => adapter.formatConverter?.toResponseUrlText?.call(adapter.formatConverter, { markdown }) ?? markdown,
})

/** Slack's answers that mean "not this layout", before anything is sent or changed: the message goes out as markdown instead. */
const LAYOUT_REFUSED = new Set(['invalid_blocks', 'invalid_blocks_format', 'msg_blocks_too_long', 'block_mismatch'])
const layoutRefused = (error: unknown) => LAYOUT_REFUSED.has((error as { data?: { error?: string } } | null)?.data?.error ?? '')

/** The `**name**: ` a message's text opens with (on a line of its own before a block), taken out when Slack shows the name as the sender. */
export function withoutLabel(markdown: string, name: string): string {
  const label = new RegExp(`^\\*\\*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*\\*:(?: |\n\n)`)
  return markdown.replace(label, '')
}

/** HTML elements GitHub renders in comments; anything else in angle brackets (`<@U123>`, `<https://…>`, `a < b`) is left alone. */
const HTML_TAGS = new Set(
  'a abbr b bdi bdo blockquote br caption center cite code dd del details dfn div dl dt em figcaption figure font h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p picture pre q rp rt ruby s samp section small source span strike strong sub summary sup table tbody td tfoot th thead time tr tt u ul var video wbr'.split(' '),
)
const MARKS: Record<string, string> = { b: '**', strong: '**', i: '_', em: '_', code: '`', kbd: '`', s: '~~', del: '~~', strike: '~~' }
const BLOCKS = new Set(['p', 'div', 'details', 'table', 'tr', 'ul', 'ol', 'li', 'blockquote', 'pre', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const attribute = (attrs: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs)?.slice(1).find((v) => v !== undefined) ?? ''

/**
 * Slack's `<!channel>`, `<!here>`, `<!everyone>`, and `<!subteam^…>` notify a whole channel or user
 * group. Text from other platforms (a GitHub comment) isn't allowed to ping them, so a word joiner
 * breaks the markup; the text reads the same. A message written on the board isn't touched: its
 * author may mean to ping a group. Code isn't spared: what Slack takes for code isn't what a regex
 * here does (an escaped backtick, runs that don't match, a fence nobody closed), and guessing wrong
 * pings a channel, where a joiner in copied code is only in the way.
 */
export const withoutBroadcasts = (markdown: string): string => markdown.replace(/<!(?=[a-z^])/gi, '<\u2060!')

/** GitHub's markdown allows inline HTML, which Slack shows as raw tags: as markdown instead, outside code. */
export function withoutHtml(markdown: string): string {
  if (!/<\/?[a-z!]/i.test(markdown) || /[\uE000\uE001]/.test(markdown)) return markdown
  // Code keeps its HTML, byte for byte: it's what someone wanted shown. Read left to right, so a
  // code span's `<!--` stays code and a comment hides everything in it, backticks and all.
  const code: string[] = []
  let hidden = false
  const text = markdown.replace(
    /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|``[^\n]*?``|`[^`\n]+`)|<!--[\s\S]*?(?:-->|$)/g,
    (_, span: string | undefined) => (span === undefined ? ((hidden = true), '') : `\uE000${code.push(span) - 1}\uE001`),
  )
  const out = text
    .replace(/<img\b([^>]*)>/gi, (_, attrs: string) => attribute(attrs, 'alt'))
    .replace(/<source\b[^>]*>/gi, '')
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_, attrs: string, inner: string) => {
      const href = attribute(attrs, 'href')
      const label = inner.replace(/<[^>]*>/g, '').trim()
      return href ? (label ? `[${label}](${href})` : href) : label
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?([a-z][a-z0-9]*)\b(?:\s[^<>]*)?\/?>/gi, (tag, name: string) => {
      const lower = name.toLowerCase()
      if (!HTML_TAGS.has(lower)) return tag
      const closing = tag.startsWith('</')
      if (lower === 'summary') return closing ? '**\n\n' : '**'
      return MARKS[lower] ?? (BLOCKS.has(lower) && closing ? '\n' : '')
    })
  if (!hidden && out === text) return markdown
  // Tidied around the code, never inside it: each span is still one placeholder here.
  const tidy = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '')
  return tidy.replace(/\uE000(\d+)\uE001/g, (_, i: string) => code[Number(i)]!)
}

/**
 * A sender's picture as Slack's `icon_url`: an https image. The board's built-in agent
 * avatars are SVGs, which Slack won't show, so those keep the app's icon.
 */
export function slackIcon(avatar: string | null): string | null {
  if (!avatar) return null
  try {
    const url = new URL(avatar)
    return url.protocol === 'https:' && !/\/avatars\/[a-z0-9-]+$/.test(url.pathname) && !url.pathname.endsWith('.svg') ? avatar : null
  } catch {
    return null
  }
}

type SlackUser = {
  id?: string
  name?: string
  real_name?: string
  is_bot?: boolean
  /** A guest: one channel or several, never every public channel. */
  is_restricted?: boolean
  is_ultra_restricted?: boolean
  /** Someone from another organization, in a Slack Connect channel. */
  is_stranger?: boolean
  /** The workspace they belong to: the app's own for its people, another's for a Slack Connect member. */
  team_id?: string
  profile?: { display_name?: string; real_name?: string; image_72?: string; image_48?: string }
}

type SlackFile = { name?: string; title?: string; permalink?: string }
type SlackMessage = {
  ts?: string
  text?: string
  user?: string
  username?: string
  bot_profile?: { name?: string }
  files?: SlackFile[]
  thread_ts?: string
  reply_count?: number
  attachments?: SlackAttachment[]
}
/** What Slack attaches to a message that links another: `is_msg_unfurl` marks a message link's. */
type SlackAttachment = {
  is_msg_unfurl?: boolean
  /** A forward's shared message. */
  is_share?: boolean
  from_url?: string
  original_url?: string
  channel_id?: string
  ts?: string
  author_id?: string
  author_name?: string
  author_subname?: string
  text?: string
  files?: SlackFile[]
}

/**
 * Slack message permalinks in mrkdwn: `https://acme.slack.com/archives/C0123/p1727000000123456`,
 * with `?thread_ts=…` for a reply. Slack escapes `&` in text as `&amp;`.
 */
const PERMALINK = /https:\/\/[a-z0-9-]+(?:\.enterprise)?\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})((?:\?|&amp;|&)[^\s|>]*)?/g

/** `1727000000.123456` → its ISO time. */
const tsTime = (ts: string | undefined) => {
  const seconds = Number(ts)
  return ts && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null
}

const filesOf = (files: SlackFile[] | undefined) =>
  (files ?? []).slice(0, 20).map((file) => ({ name: (file.name || file.title || 'file').slice(0, 1000), url: file.permalink?.slice(0, 4000) ?? null }))

/** A permalink's channel, ts and thread, or null when `url` isn't a Slack message's. */
function permalinkOf(url: string) {
  const match = new RegExp(PERMALINK.source).exec(url)
  if (!match || match.index !== 0) return null
  const [, channel, seconds, micros, query] = match
  const ts = `${seconds}.${micros}`
  return { url: match[0].replaceAll('&amp;', '&'), channel: channel!, ts, thread: /[?&]thread_ts=(\d+\.\d+)/.exec(query?.replaceAll('&amp;', '&') ?? '')?.[1] ?? ts }
}

/** A Slack attachment as a link's snapshot. */
const snapshotOf = (att: SlackAttachment, ts: string, markdown: (mrkdwn: string) => string) => ({
  author: (att.author_subname || att.author_name || att.author_id || 'someone').slice(0, 256),
  text: markdown(att.text ?? '').slice(0, MESSAGE_TEXT_MAX),
  createdAt: tsTime(att.ts ?? ts),
  files: filesOf(att.files),
})

/**
 * Every Slack message a message's mrkdwn links to, in order, with the unfurls Slack attached for them,
 * then the messages it forwards: a forward's shared message is only in its `is_share` attachments.
 */
export function slackLinks(key: string, text: string, attachments: SlackAttachment[] = [], markdown: (mrkdwn: string) => string = (t) => t): ExternalLink[] {
  const links: ExternalLink[] = []
  // A message linked twice (its text and a forward's share) is one link, with whichever snapshot came.
  const add = (found: NonNullable<ReturnType<typeof permalinkOf>>, att: SlackAttachment | undefined) => {
    const known = links.find((link) => link.url === found.url || (link.thread === `${key}:${found.channel}:${found.thread}` && link.message === found.ts))
    if (known) {
      if (!known.snapshot && att) known.snapshot = snapshotOf(att, found.ts, markdown)
      return
    }
    if (found.url.length > 4000 || links.length === LINKS_PER_MESSAGE_MAX) return
    links.push({ url: found.url, thread: `${key}:${found.channel}:${found.thread}`, message: found.ts, snapshot: att ? snapshotOf(att, found.ts, markdown) : null })
  }
  for (const match of text.matchAll(PERMALINK)) {
    const found = permalinkOf(match[0])!
    add(found, attachments.find((att) => att.is_msg_unfurl && ((att.channel_id === found.channel && att.ts === found.ts) || att.from_url?.replaceAll('&amp;', '&') === found.url)))
  }
  for (const att of attachments) {
    const found = att.is_share ? permalinkOf(att.from_url ?? att.original_url ?? '') : null
    if (found) add(found, att)
  }
  return links
}

/**
 * What a forward with no text of its own says: the messages it shares, quoted,
 * so the board (and whoever watches it) reads what was forwarded, not "(no text)".
 */
export function forwardText(links: ExternalLink[]): string {
  return links.filter((link) => link.snapshot).map((link) => {
    const { author, text } = link.snapshot!
    const lines = text.trim() ? text.trim().split('\n') : ['']
    // A first line that opens a block (a fence, a list, a heading, a quote, a table) only works at a line's start.
    const head = opensBlock(lines[0]!) ? [`> **${author}**:`, `> ${lines[0]}`] : [`> **${author}**: ${lines[0]}`]
    return [...head, ...lines.slice(1).map((line) => `> ${line}`)].map((line) => line.trimEnd()).concat('', link.url).join('\n')
  }).join('\n\n')
}

/** Slack's answers that mean "no files from this app", not "try again". */
const REFUSED = new Set([
  'missing_scope',
  'not_allowed_token_type',
  'no_permission',
  'restricted_action',
  'file_uploads_disabled',
  'file_uploads_except_images_disabled',
  'file_upload_size_restricted',
])

/** A Slack API error's code (`missing_scope`), with the scope it needed. */
function slackError(error: unknown): string {
  const data = (error as { data?: { error?: string; needed?: string } }).data
  if (!data?.error) return (error as Error).message
  return data.needed ? `${data.error}, needs ${data.needed}` : data.error
}

/** Extensions Slack shows as text (a preview, not a download): it calls any other extension binary. */
const SLACK_TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'yaml', 'yml', 'xml', 'html', 'css', 'js', 'ts', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'sh', 'bash', 'sql', 'diff', 'patch'])
const TEXT_TYPES = /^(text\/|application\/(json|x-ndjson|xml|yaml|x-yaml|javascript|x-sh)\b)/

/**
 * The name a file goes to Slack under. Slack picks a file's type from its
 * extension, so a text file named `run.log` arrives as a binary download;
 * `run.log.txt` arrives as text it previews. The board keeps the file's own name.
 */
export function slackFileName(filename: string, mimeType?: string): string {
  if (!mimeType || !TEXT_TYPES.test(mimeType)) return filename
  const extension = /\.([^./]+)$/.exec(filename)?.[1]?.toLowerCase()
  return extension && SLACK_TEXT_EXTENSIONS.has(extension) ? filename : `${filename}.txt`
}

export const SlackEvent = eventSchema('slack', 'message')
export type SlackEvent = z.infer<typeof SlackEvent>

export type SlackOptions = {
  /**
   * A Vercel Connect connector (`'slack/acme'`): board builds the Slack adapter
   * and its Web API client. Or your own Chat SDK adapter.
   */
  adapter: Adapter | string
  /** Not needed with a connector. */
  client?: () => Promise<SlackClient>
  /**
   * Lets `vb sources <key> join` add the app to a public channel, so it can be read on demand
   * without syncing it. Off by default; the app needs `channels:join`.
   */
  join?: boolean
}

/**
 * Syncs a Slack workspace with the board: `app` is a Vercel Connect connector
 * (`'slack/acme'`) or the options, and `sync` is what each event does, both ways,
 * like `channels({ '#prs': 'prs' })`. Invite the app to each channel it syncs:
 * it never joins one on its own.
 */
export function slack(app: string | SlackOptions, sync: SyncFn<SlackEvent>): SlackProvider {
  return new SlackProvider(typeof app === 'string' ? { adapter: app } : app, sync)
}

/** How many times to look for the message an upload made, about 15 seconds in all. */
const SHARE_POLLS = 10

type SlackWithTokens = Adapter & { webClient?: SlackClient; withBotToken?<T>(token: string, fn: () => T): T }

/**
 * Slack's client retries 10 times over about 30 minutes by default, which outlives any function:
 * here a call gets 3 more tries. Each still waits out Slack's `Retry-After` (about a minute at
 * most), and `timeout` caps only the request itself, at 30 seconds.
 */
const SLACK_CLIENT = { retryConfig: { retries: 3, factor: 2, minTimeout: 500, randomize: true }, timeout: 30_000 }

/** A Slack adapter and its client, from one Vercel Connect connector. */
function fromConnector(connector: string) {
  const credentials = connectSlackAdapter(connector)
  const adapter = createSlackAdapter({ ...credentials, webClientOptions: SLACK_CLIENT }) as unknown as SlackWithTokens
  const botToken = credentials.botToken
  const client = async () => adapter.withBotToken!(typeof botToken === 'function' ? await botToken() : botToken, () => adapter.webClient!)
  return { adapter: adapter as Adapter, client }
}

export class SlackProvider extends ChatSyncProvider<SlackEvent> {
  private readonly web: () => Promise<SlackClient | undefined>
  private scopes: Promise<string[]> | undefined

  constructor(given: SlackOptions, sync: SyncFn<SlackEvent>) {
    const connected = typeof given.adapter === 'string' ? fromConnector(given.adapter) : null
    const options = connected ? { ...given, adapter: connected.adapter, client: given.client ?? connected.client } : { ...given, adapter: given.adapter as Adapter }
    let directClient: SlackClient | undefined
    if (!options.client) {
      try {
        directClient = (options.adapter as Adapter & { webClient?: SlackClient }).webClient
      } catch {
        throw new Error('slack requires a public client resolver when the adapter uses async tokens')
      }
    }
    async function client(): Promise<SlackClient | undefined> {
      return options.client ? options.client() : directClient
    }

    // One listing resolves every name. A miss lists again, since the channel may be
    // new (the sync engine throttles retries). Without `groups:read`, Slack refuses
    // to list private channels at all, so the listing falls back to public ones.
    let listing: Promise<SlackChannel[]> | undefined
    let publicOnly = false
    async function list(client: SlackClient, types: string): Promise<SlackChannel[]> {
      const channels: SlackChannel[] = []
      let cursor: string | undefined
      do {
        const page = await client.conversations.list({
          types,
          exclude_archived: true,
          limit: 1000,
          ...(cursor ? { cursor } : {}),
        })
        channels.push(...(page.channels ?? []))
        cursor = page.response_metadata?.next_cursor || undefined
      } while (cursor)
      return channels
    }
    async function listAll(client: SlackClient): Promise<SlackChannel[]> {
      if (!publicOnly)
        try {
          return await list(client, 'public_channel,private_channel')
        } catch (error) {
          if (!slackError(error).startsWith('missing_scope')) throw error
          publicOnly = true
        }
      return list(client, 'public_channel')
    }
    function channels(client: SlackClient, fresh: boolean) {
      if (fresh || !listing) {
        const promise = listAll(client)
        promise.catch(() => {
          if (listing === promise) listing = undefined
        })
        listing = promise
      }
      return listing
    }

    async function find(client: SlackClient, name: string): Promise<SlackChannel & { id: string }> {
      const match = (all: SlackChannel[]) =>
        all.find((channel): channel is SlackChannel & { id: string } => channel.name === name && !!channel.id)
      let found
      try {
        found = match(await channels(client, false)) ?? match(await channels(client, true))
      } catch (error) {
        throw new UnreadableError('list_failed', `can't list Slack channels to find #${name} (${slackError(error)}); use its ID instead`)
      }
      // Without groups:read, a private channel's name never lists, whatever happens next: it's
      // skipped like a channel that doesn't exist, and its ID still maps it.
      if (!found)
        throw new UnreadableError(
          'channel_not_found',
          publicOnly
            ? `no public Slack channel named #${name} (the app lacks groups:read, so a private channel needs its ID)`
            : `no Slack channel named #${name} (a private channel shows up once the app is invited)`,
        )
      return found
    }

    // A channel (`#name` or its ID), a thread (`C0123:1727000000.123456`), or a message permalink (its thread).
    async function targetOf(web: SlackClient, target: string): Promise<{ channel: string; thread: string | null }> {
      const link = new RegExp(PERMALINK.source).exec(target)
      if (link) {
        const [, id, seconds, micros, query] = link
        return { channel: id!, thread: /[?&]thread_ts=(\d+\.\d+)/.exec(query?.replaceAll('&amp;', '&') ?? '')?.[1] ?? `${seconds}.${micros}` }
      }
      if (target.startsWith('#')) return { channel: (await find(web, target.slice(1))).id, thread: null }
      const parsed = /^([A-Z0-9]+)(?::(\d+\.\d+))?$/.exec(target)
      if (!parsed) throw new UnreadableError('invalid_target', `not a Slack channel, thread, or message link: ${target} (try #name, C0123, C0123:1727000000.123456, or a permalink)`)
      return { channel: parsed[1]!, thread: parsed[2] ?? null }
    }

    // Slack's events carry user IDs only; their pictures come from users.info, once each.
    const avatars = new Map<string, Promise<string | null>>()
    function avatarOf(user: string): Promise<string | null> {
      let promise = avatars.get(user)
      if (!promise) {
        promise = client()
          .then(async (web) => {
            const profile = (await web?.users?.info({ user }))?.user?.profile
            return profile?.image_72 ?? profile?.image_48 ?? null
          })
          .catch(() => null)
        avatars.set(user, promise)
      }
      return promise
    }

    // Slack's own mrkdwn → markdown, the way Chat SDK reads every Slack message.
    const converter = (options.adapter as { formatConverter?: { toAst(text: string): Parameters<typeof stringifyMarkdown>[0] } }).formatConverter
    const mrkdwn = (text: string) => {
      try {
        return converter ? stringifyMarkdown(converter.toAst(text)).trim() : text
      } catch {
        return text
      }
    }
    // What a source read shows: each user a message mentions by their ID, as an import brings one in.
    const mrkdwnById = (text: string) => {
      const asIs = () => text.replace(SLACK_MENTION, '@[slack:user:$1]')
      if (!converter) return asIs()
      try {
        return mentionsById(stringifyMarkdown(converter.toAst(text.replace(SLACK_MENTION, (_, user: string) => `<@${user}|${mentionedAs(user)}>`))).trim())
      } catch {
        return asIs()
      }
    }
    const names = new Map<string, Promise<string>>()
    function nameOf(user: string): Promise<string> {
      let promise = names.get(user)
      if (!promise) {
        promise = client()
          .then(async (web) => {
            const found = (await web?.users?.info({ user }))?.user
            return found?.profile?.real_name || found?.real_name || found?.profile?.display_name || found?.name || user
          })
          .catch(() => user)
        names.set(user, promise)
      }
      return promise
    }

    const fileIds = (raw: unknown) => ((raw as { uploadedFileIds?: string[] } | null)?.uploadedFileIds ?? []).filter(Boolean)
    // Slack tags each file with its event's team, and the adapter fetches a tagged
    // file with that team's installed token, which a single-workspace app (one bot
    // token, as Vercel Connect gives it) never stores: "Installation not found".
    // Without the tag, the adapter uses its bot token.
    // An app that can also install through OAuth (a client ID) keeps the tag, so
    // each team's files use that team's token.
    const internals = options.adapter as Adapter & { defaultBotTokenProvider?: unknown; installationProvider?: unknown; clientId?: unknown }
    const singleWorkspace = !!internals.defaultBotTokenProvider && !internals.installationProvider && !internals.clientId
    super({
      fileIds,
      fileToFetch(file) {
        if (!singleWorkspace || !file.fetchMetadata) return file
        const { teamId: _team, enterpriseId: _enterprise, isEnterpriseInstall: _install, ...rest } = file.fetchMetadata
        return { ...file, fetchMetadata: rest }
      },
      platform: 'slack',
      adapter: options.adapter,
      canStartThreads: true,
      startsThreadsWithFiles: true,
      // The adapter uploads files given without text as their own message: here, right after the text.
      async uploadFiles(thread, files) {
        const sent = await options.adapter.postMessage(thread, { markdown: '', files })
        return { message: sent.id, files: fileIds(sent.raw) }
      },
      uploadName: (file) => slackFileName(file.filename, file.mimeType),
      refusesFiles: (error) => REFUSED.has((error as { data?: { error?: string } } | null)?.data?.error ?? ''),
      async deleteFiles(ids) {
        const web = await client()
        for (const file of ids)
          await web?.files?.delete({ file }).catch((error: unknown) => console.warn(`[board] slack: couldn't delete file ${file} (${slackError(error)})`))
      },
      async findByEmail(email) {
        const web = await client()
        const user = (await web?.users?.lookupByEmail?.({ email }).catch(() => undefined))?.user
        if (!user?.id) return null
        const handle = user.profile?.display_name || user.name || user.id
        return {
          id: `slack:user:${user.id}`, handle,
          name: user.profile?.real_name || user.real_name || handle,
          avatar: user.profile?.image_72 ?? user.profile?.image_48 ?? null,
          isBot: user.is_bot === true,
        }
      },
      mention: (actor) => slackMention(actor.id),
      mentionById: slackMention,
      // `#name` is looked up by name; anything else is a channel ID.
      async resolveChannel(key) {
        if (!key.startsWith('#')) return key
        const web = await client()
        if (!web) throw new Error(`can't look up Slack channel ${key}: use its ID instead`)
        const channel = await find(web, key.slice(1))
        if (!channel.is_member) console.warn(`[board] slack: invite the app to ${key}; its events don't arrive until it's in`)
        return channel.id
      },
      // A forward has no text of its own: it says what it shares.
      markdown(message) {
        const text = mentionsById(markdownOf(message))
        if (text.trim()) return text
        const raw = message.raw as { attachments?: SlackAttachment[] } | null
        const shared = Array.isArray(raw?.attachments) ? raw.attachments.filter((att) => att.is_share) : []
        return shared.length ? forwardText(slackLinks('', '', shared, mrkdwn)) : text
      },
      // Who the text mentions, as each would be named had they written: the adapter's own record of them.
      async mentioned(text) {
        const users = [...new Set(extractMentions(text).flatMap((token) => (token.kind === 'actor' && token.actor.startsWith('slack:user:') ? [token.actor.slice('slack:user:'.length)] : [])))]
        return Promise.all(
          users.slice(0, MENTIONED_PER_MESSAGE_MAX).map(async (user) => {
            const adapter = options.adapter as SlackInternals
            const [known, avatar] = await Promise.all([adapter.lookupUser ? adapter.lookupUser(user).catch(() => null) : null, avatarOf(user)])
            const handle = known?.displayName || user
            return { id: `slack:user:${user}`, handle, name: known?.realName || handle, avatar, isBot: known?.isBot === true }
          }),
        )
      },
      links(key, message) {
        const raw = message.raw as { text?: unknown; attachments?: SlackAttachment[] } | null
        return slackLinks(key, typeof raw?.text === 'string' ? raw.text : message.text, Array.isArray(raw?.attachments) ? raw.attachments : [], mrkdwn)
      },
      // A permalink names its channel and ts, and a reply's thread in `thread_ts`.
      locate(url) {
        const found = permalinkOf(url.trim())
        return found ? { thread: `${found.channel}:${found.thread}`, message: found.ts } : null
      },
      // Slack's own link, with the workspace's host and a reply's `thread_ts`.
      async url(thread, message) {
        const [channel] = thread.split(':')
        const web = await client()
        if (!web?.chat?.getPermalink || !channel) return null
        try {
          return (await web.chat.getPermalink({ channel, message_ts: message })).permalink ?? null
        } catch {
          return null
        }
      },
      // A link Slack didn't unfurl, read with the app's token, but only from a public channel
      // the app is already in. The token reads what the app can, not what the person who
      // posted the link can, and every board reader would see the snapshot: private
      // channels and DMs are left to Slack's unfurl, which checks the poster, and so is a
      // channel shared with another organization. A guest or someone from another
      // organization who posted the link may not see that channel, so nothing is read for
      // them. Nor does it join a channel someone linked, which would announce the app there.
      async fetchLink(link, linker): Promise<FetchedLink> {
        const [, channel, thread] = link.thread.split(':')
        const web = await client()
        const replies = web?.conversations.replies
        if (!web || !replies || !channel || !thread) return { snapshot: null, unavailable: 'no Slack client to read it with' }
        const one = async (channel: string, thread: string, ts: string) =>
          (await replies({ channel, ts: thread, oldest: ts, latest: ts, inclusive: true, limit: 1 })).messages?.find((m) => m.ts === ts)
        const [, at, root] = linker.thread.split(':')
        const linkingMessage = at && root ? one(at, root, linker.message).catch(() => undefined) : Promise.resolve(undefined)
        // Whoever posted the link, as Slack knows them: an app or the board's own message passes, a
        // person who is a guest or from another workspace, or one Slack won't say, doesn't.
        const posterMayRead = async () => {
          const poster = (await linkingMessage)?.user
          if (!poster) return (await linkingMessage) !== undefined
          const user = (await web.users?.info({ user: poster }).catch(() => undefined))?.user
          if (!user) return false
          if (user.is_bot) return true
          if (user.is_restricted || user.is_ultra_restricted || user.is_stranger) return false
          // A Slack Connect member of a shared channel belongs to another workspace, whatever else Slack flags.
          const team = (await web.auth?.test().catch(() => undefined))?.team_id
          return !!team && user.team_id === team
        }
        let found: SlackMessage | undefined
        let unavailable = 'message_not_found'
        try {
          const info = (await web.conversations.info({ channel })).channel
          if (!info) unavailable = 'channel_not_found'
          else if (info.is_private || info.is_im || info.is_mpim) unavailable = 'private_channel'
          else if (info.is_ext_shared) unavailable = 'shared_channel'
          else if (!info.is_member) unavailable = 'not_in_channel'
          else if (!(await posterMayRead())) unavailable = 'poster_cannot_read'
          else found = await one(channel, thread, link.message)
        } catch (error) {
          unavailable = slackError(error)
        }
        if (!found) {
          // Slack's unfurl skips Chat SDK, so it can come in before its message, when there's
          // nothing yet to edit. By now it's on the message that links it, which the app can
          // read: that message came from a channel the app is in.
          const linking = await linkingMessage
          const unfurled = linking ? slackLinks('', linking.text ?? '', linking.attachments, mrkdwn).find((known) => known.url === link.url)?.snapshot : null
          return unfurled ? { snapshot: unfurled, unavailable: null } : { snapshot: null, unavailable }
        }
        const author = found.user ? await nameOf(found.user) : found.username || found.bot_profile?.name || 'someone'
        return { unavailable: null, snapshot: {
          author: author.slice(0, 256), text: mrkdwn(found.text ?? '').slice(0, MESSAGE_TEXT_MAX),
          createdAt: tsTime(found.ts), files: filesOf(found.files),
        } }
      },
      // A channel or thread read on demand (`vb sources <key> read`), with the same limits as a link:
      // public channels the app is already in. It never joins (that would announce the
      // app, and Slack would start sending the channel's events), and nothing it reads
      // is stored; the board still only listens to the channels it's configured with.
      async read(target, { limit }): Promise<SourceRead> {
        const web = await client()
        if (!web) throw new UnreadableError('no_client', 'no Slack client to read it with')
        const parsed = await targetOf(web, target)
        const channel = parsed.channel
        let thread = parsed.thread
        let found: SlackMessage[]
        let more = false
        let name: string | null = null
        try {
          const info = (await web.conversations.info({ channel })).channel
          if (!info) throw new UnreadableError('channel_not_found', `no Slack channel ${channel}`)
          name = info.name ?? null
          const label = name ? `#${name}` : channel
          if (info.is_private || info.is_im || info.is_mpim)
            throw new UnreadableError('private_channel', `${label} is private: the board only reads public channels on demand`)
          // Slack Connect: another organization's people write here, so it isn't ours to read on demand.
          if (info.is_ext_shared)
            throw new UnreadableError('shared_channel', `${label} is shared with another organization: the board doesn't read those on demand`)
          if (!info.is_member)
            throw new UnreadableError('not_in_channel', options.join
              ? `the app isn't in ${label}: join it first with \`vb sources <key> join ${label}\`, which adds the app there`
              : `the app isn't in ${label}: someone needs to add it (it won't join on its own)`)
          if (thread) {
            const replies = web.conversations.replies
            if (!replies) throw new UnreadableError('no_client', "this Slack client can't read threads")
            let page = await replies({ channel, ts: thread, limit })
            // A reply's ts reads only that reply: read the thread it's in instead.
            const root = page.messages?.[0]?.thread_ts
            if (root && root !== thread) {
              thread = root
              page = await replies({ channel, ts: root, limit })
            }
            found = page.messages ?? []
            more = page.has_more ?? false
          } else {
            if (!web.conversations.history) throw new UnreadableError('no_client', "this Slack client can't read channels")
            const page = await web.conversations.history({ channel, limit })
            found = (page.messages ?? []).reverse()
            more = page.has_more ?? false
          }
        } catch (error) {
          if (error instanceof UnreadableError) throw error
          throw new UnreadableError(slackError(error).split(',')[0]!, `Slack refused to read ${target}: ${slackError(error)}`)
        }
        const messages = await Promise.all(found.slice(0, limit).filter((m) => m.ts).map(async (m): Promise<SourceMessage> => ({
          id: m.ts!,
          thread: `${channel}:${m.thread_ts ?? m.ts}`,
          author: (m.user ? await nameOf(m.user) : m.username || m.bot_profile?.name || 'someone').slice(0, 256),
          text: mrkdwnById(m.text ?? '').slice(0, MESSAGE_TEXT_MAX),
          createdAt: tsTime(m.ts),
          replies: m.reply_count ?? 0,
          files: filesOf(m.files),
        })))
        return { channel, name, thread, messages, more: more || found.length > limit }
      },
      // Joins a public channel so it can be read, only when the board opted in (`join: true`). Slack
      // announces the app there and starts sending the channel's events, but sync still only
      // imports the channels it maps. Private and Slack Connect channels stay out, as for reads.
      async join(target): Promise<SourceJoin> {
        if (!options.join) throw new UnreadableError('join_disabled', "this board doesn't join Slack channels: it needs `join: true` on slack()")
        const web = await client()
        if (!web) throw new UnreadableError('no_client', 'no Slack client to join with')
        const { channel } = await targetOf(web, target)
        try {
          const info = (await web.conversations.info({ channel })).channel
          if (!info) throw new UnreadableError('channel_not_found', `no Slack channel ${channel}`)
          const name = info.name ?? null
          const label = name ? `#${name}` : channel
          if (info.is_private || info.is_im || info.is_mpim)
            throw new UnreadableError('private_channel', `${label} is private: the app can only be invited there`)
          if (info.is_ext_shared)
            throw new UnreadableError('shared_channel', `${label} is shared with another organization: the board doesn't join those`)
          if (info.is_member) return { channel, name, joined: false }
          if (!web.conversations.join) throw new UnreadableError('no_client', "this Slack client can't join channels")
          await web.conversations.join({ channel })
          return { channel, name, joined: true }
        } catch (error) {
          if (error instanceof UnreadableError) throw error
          const code = slackError(error).split(',')[0]!
          if (code === 'missing_scope') throw new UnreadableError(code, "the Slack app can't join channels: it needs the channels:join scope")
          throw new UnreadableError(code, `Slack refused to join ${target}: ${slackError(error)}`)
        }
      },
      // Slack unfurls a message link a moment later, as a `message_changed` that keeps the text.
      // Chat SDK drops those (nothing it shows changed), so they come here.
      intercept(key, _headers, body): ReceivedEvent[] {
        let event: { type?: string; subtype?: string; channel?: string; message?: SlackMessage & { thread_ts?: string; attachments?: SlackAttachment[] }; previous_message?: { text?: string } } | undefined
        try {
          event = (JSON.parse(body) as { event?: typeof event }).event
        } catch {
          return []
        }
        const inner = event?.message
        if (event?.type !== 'message' || event.subtype !== 'message_changed' || !event.channel || !inner?.ts) return []
        if (!inner.attachments?.some((att) => att.is_msg_unfurl) || inner.text !== event.previous_message?.text) return []
        // Every link, unfurled or not: the event replaces the message's links, and the board
        // keeps what it already knew about the ones Slack didn't unfurl.
        const links = slackLinks(key, inner.text ?? '', inner.attachments, mrkdwn)
        const unfurled = links.filter((link) => link.snapshot)
        if (unfurled.length === 0) return []
        const thread = `${key}:${event.channel}:${inner.thread_ts ?? inner.ts}`
        return [{
          dedupe: `unfurl:${thread}|${inner.ts}|${unfurled.map((link) => link.message).join(',')}`,
          raw: event,
          event: {
            kind: 'edited', channel: `${key}:${event.channel}`, thread, subthread: null, message: inner.ts,
            text: inner.text ?? '', linksOnly: true, links,
            author: { id: 'slack:system', handle: 'slack', name: 'Slack', avatar: null, isBot: true },
          },
        }]
      },
      avatar: (message: ChatMessage) => (message.author.userId ? avatarOf(message.author.userId) : Promise.resolve(null)),
      groupThread: (thread) => thread,
      // A Slack thread is named by its root message's ts.
      isRoot: (thread, messageId) => thread.slice(thread.lastIndexOf(':') + 1) === messageId,
      context: () => null,
      async resolveTarget(target): Promise<ResolvedTarget> {
        const at = target.indexOf(':')
        const channel = await this.resolveChannel(at === -1 ? target : target.slice(0, at))
        return { target: at === -1 ? channel : `${channel}:${target.slice(at + 1)}`, channel, kind: at === -1 ? 'channel' : 'thread' }
      },
    }, sync)
    this.web = client
    // The adapter leaves a message's mentions to board, going out and coming in: a webhook reaches it without `ready()`.
    literalMentions(options.adapter as SlackInternals)
  }

  /**
   * A message goes out under its author's name (`Ada Lovelace`, `clever-lemur via acme-agents`,
   * `Malte via support (slack)`), and their picture when it has one Slack can show, instead of the
   * app's, with the text's `**name**: ` label dropped. Without `chat:write.customize` it posts as
   * the app, label and all.
   */
  override async post(target: string, kind: ResolvedTarget['kind'], body: ProviderPost): Promise<ProviderDelivery> {
    const { as, deployments, external, ...given } = body
    const html = withoutHtml(given.markdown)
    const post = { ...given, markdown: external ? withoutBroadcasts(html) : html }
    if (deployments && !post.files?.length) {
      const laidOut = await this.postDeployments(target, as, post.markdown, deployments)
      if (laidOut) return laidOut
    }
    if (kind === 'channel' && post.files?.length && post.markdown.trim()) {
      const sent = await this.postWithFiles(target, post.markdown, post.files)
      if (sent) return sent
      // Text alone, as a reply's goes: without `files`, the engine uploads them under it.
      const { files: _files, ...text } = post
      return (as ? await this.postNamed(target, as, text.markdown) : null) ?? super.post(target, kind, text)
    }
    return (as && !post.files?.length ? await this.postNamed(target, as, post.markdown) : null) ?? super.post(target, kind, post)
  }

  /**
   * A new thread whose root shows its files under its text, as one message: Slack makes
   * that message from an upload's `initial_comment`, and names it only on the file, a
   * moment later. A file upload can't set a username, so it goes out as the app, label and all.
   * Null, before anything is sent, where the client can't, or the app can't read files
   * (`files:read`) to find that message.
   */
  private async postWithFiles(target: string, markdown: string, files: ProviderFile[]): Promise<ProviderDelivery | null> {
    const adapter = (await this.ready()) as SlackInternals
    const web = await this.web()
    const toMrkdwn = adapter.formatConverter?.toResponseUrlText
    if (!web?.files?.uploadV2 || !web.files.info || !toMrkdwn || !(await this.hasScope(web, 'files:read'))) return null
    const threadId = this.toChat(target)
    const { channel } = adapter.decodeThreadId(threadId)
    const uploaded = await web.files.uploadV2({
      channel_id: channel,
      initial_comment: toMrkdwn.call(adapter.formatConverter, { markdown }),
      file_uploads: files.map((file) => ({ file: Buffer.from(file.data), filename: slackFileName(file.filename, file.mimeType) })),
    })
    const ids = (uploaded.files?.[0]?.files ?? []).map((file) => file.id).filter((id): id is string => !!id)
    // From here on the message is in Slack, so no error may read as a refusal, which would post the text again,
    // and a passing one is waited out: a throw retries the delivery, and that uploads it all again.
    const found = async () => {
      let failure: unknown = new Error('never shared')
      for (let attempt = 0; attempt < SHARE_POLLS; attempt++) {
        try {
          const shares = (await web.files!.info!({ file: ids[0]! })).file?.shares
          const ts = shares?.public?.[channel]?.[0]?.ts ?? shares?.private?.[channel]?.[0]?.ts
          if (ts) return ts
        } catch (error) {
          if (REFUSED.has((error as { data?: { error?: string } } | null)?.data?.error ?? '')) throw error
          failure = error
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempt, 2000)))
      }
      throw failure
    }
    if (!ids[0]) throw new Error('slack: files.uploadV2 returned no file IDs')
    let ts: string
    try {
      ts = await found()
    } catch (error) {
      throw new Error(`slack: couldn't find the message uploading ${ids[0]} made in ${channel} (${slackError(error)})`)
    }
    return { thread: this.toNative(`${adapter.name}:${channel}:${ts}`), message: ts, files: ids }
  }

  /** An edit keeps the label out only where the message went out under its author's name. */
  override async edit(thread: string, message: string, body: ProviderPost) {
    const { as, deployments, external, ...given } = body
    const html = withoutHtml(given.markdown)
    const post = { ...given, markdown: external ? withoutBroadcasts(html) : html }
    // Only an app that may name a message's sender ever sent one under a name.
    const named = as && (await this.web().then((web) => !!web && this.canCustomize(web), () => false)) ? await this.sentAs(thread, message, as) : false
    const edited = named && as ? { ...post, markdown: withoutLabel(post.markdown, as.name) } : post
    if (deployments && !edited.files && (await this.editDeployments(thread, message, edited.markdown, deployments))) return
    await super.edit(thread, message, edited)
  }

  /**
   * Vercel's deployment comment goes out with its deployments as the table Vercel posts on a
   * pull request, the text around them as markdown, under its author's name where the app may
   * set one. Null, with nothing sent, when board has no client to post with, the markdown isn't
   * one board can lay out, or Slack won't take the layout: it goes out as markdown, a line each.
   */
  private async postDeployments(target: string, as: ProviderSender | undefined, markdown: string, deployments: VercelDeployment[]): Promise<ProviderDelivery | null> {
    if (!deploymentsLayout(markdown, deployments)) return null
    const adapter = (await this.ready()) as SlackInternals
    const web = await this.web().catch(() => undefined)
    if (!web?.chat) return null
    const username = as ? slackUsername(as) : null
    const named = as && username !== null && (await this.canCustomize(web)) ? { username, icon: slackIcon(as.avatar), name: as.name } : null
    const threadId = this.toChat(target)
    const { channel, threadTs } = adapter.decodeThreadId(threadId)
    const message = { markdown: named ? withoutLabel(markdown, named.name) : markdown }
    const layout = deploymentsLayout(message.markdown, deployments, textOf(adapter))
    if (!layout) return null
    const sent = await web.chat
      .postMessage({
        channel,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        ...layout,
        unfurl_links: false,
        unfurl_media: false,
        ...(named ? { username: named.username, ...(named.icon ? { icon_url: named.icon } : {}) } : {}),
      })
      .catch((error: unknown) => {
        if (layoutRefused(error)) return null
        throw error
      })
    if (!sent) return null
    if (!sent.ts) throw new Error('slack: chat.postMessage returned no ts')
    return { thread: this.toNative(`${adapter.name}:${channel}:${threadTs || sent.ts}`), message: sent.ts }
  }

  /** An edit to that comment: its text and table, replaced. False, with nothing changed, where a post would be null, or board's client can't edit. */
  private async editDeployments(thread: string, message: string, markdown: string, deployments: VercelDeployment[]): Promise<boolean> {
    if (!deploymentsLayout(markdown, deployments)) return false
    const adapter = (await this.ready()) as SlackInternals
    const web = await this.web().catch(() => undefined)
    if (!web?.chat?.update) return false
    const threadId = this.toChat(thread)
    const layout = deploymentsLayout(markdown, deployments, textOf(adapter))
    if (!layout) return false
    try {
      await web.chat.update({ channel: adapter.decodeThreadId(threadId).channel, ts: message, ...layout })
    } catch (error) {
      if (layoutRefused(error)) return false
      throw error
    }
    return true
  }

  private async postNamed(target: string, as: ProviderSender, markdown: string): Promise<ProviderDelivery | null> {
    const adapter = (await this.ready()) as SlackInternals
    const web = await this.web()
    const username = slackUsername(as)
    if (!web?.chat || !adapter.formatConverter?.toSlackPayload || username === null || !(await this.canCustomize(web))) return null
    const threadId = this.toChat(target)
    const { channel, threadTs } = adapter.decodeThreadId(threadId)
    const icon = slackIcon(as.avatar)
    const sent = await web.chat.postMessage({
      channel,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...adapter.formatConverter.toSlackPayload({ markdown: withoutLabel(markdown, as.name) }),
      unfurl_links: false,
      unfurl_media: false,
      username,
      ...(icon ? { icon_url: icon } : {}),
    })
    if (!sent.ts) throw new Error('slack: chat.postMessage returned no ts')
    return { thread: this.toNative(`${adapter.name}:${channel}:${threadTs || sent.ts}`), message: sent.ts }
  }

  /** Whether the app may set a message's username and icon (`chat:write.customize`). */
  private canCustomize(web: SlackClient): Promise<boolean> {
    return this.hasScope(web, 'chat:write.customize')
  }

  /** Whether the app has a scope, from its scopes, asked once. */
  private async hasScope(web: SlackClient, scope: string): Promise<boolean> {
    this.scopes ??= (async () => (await web.auth?.test())?.response_metadata?.scopes ?? [])().catch((error: unknown) => {
      this.scopes = undefined
      console.warn(`[board] slack: couldn't check the app's scopes (${slackError(error)}); posting as the app`)
      return []
    })
    return (await this.scopes).includes(scope)
  }

  /** Whether a message Slack has went out under the sender's name. */
  private async sentAs(thread: string, message: string, as: ProviderSender): Promise<boolean> {
    const username = slackUsername(as)
    if (username === null) return false
    const web = await this.web().catch(() => undefined)
    const channel = thread.slice(0, thread.indexOf(':'))
    if (!web?.conversations.replies || !channel) return false
    const found = await web.conversations
      .replies({ channel, ts: message, oldest: message, latest: message, inclusive: true, limit: 1 })
      .then((page) => page.messages?.find((m) => m.ts === message), () => undefined)
    return found?.username === username
  }

  /**
   * Slack's link to the event's message, from `chat.getPermalink`, so it has the workspace's
   * own host (Enterprise Grid included) and a reply's `thread_ts`. Null for an event without
   * one message to link (a lifecycle event, or a deleted message Slack no longer has); throws
   * when Slack won't say. It reads only the URL: nothing is synced or joined.
   */
  override async permalink(event: SlackEvent): Promise<string | null> {
    if (event.kind === 'lifecycle' || event.kind === 'deleted') return null
    const channel = event.channel.slice(event.key.length + 1)
    const web = await this.web()
    if (!web?.chat?.getPermalink) throw new Error('slack: no client with chat.getPermalink to link the message with')
    let found: string | undefined
    try {
      found = (await web.chat.getPermalink({ channel, message_ts: event.message })).permalink
    } catch (error) {
      throw new Error(`slack: couldn't get the permalink for ${channel} ${event.message} (${slackError(error)})`)
    }
    if (!found) throw new Error('slack: chat.getPermalink returned no permalink')
    return found
  }

  override eventId(key: string, input: ChatInput): string {
    if (input.kind !== 'reaction') return super.eventId(key, input)
    const reaction = input.reaction
    const stamp = z.looseObject({ event_ts: z.string().min(1) }).parse(reaction.raw).event_ts
    return `reaction:${key}:${this.toNative(reaction.threadId)}|${reaction.messageId}|${reaction.rawEmoji}|${reaction.user.userId}|${reaction.added}|${stamp}`
  }

  override event(context: SyncContext): SlackEvent {
    return SlackEvent.parse(envelope(this.platform, context.key, context.event, context.raw, context.id))
  }
}
export { channels } from './fn.ts'
