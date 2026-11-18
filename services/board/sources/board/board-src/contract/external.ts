// Platform-side shapes: where a message came from, what it links to, and events as sync
// normalizes them. Plain zod, so a handle on any backend can use them without loading A2.
import { z } from 'zod'
import { MessageId, MESSAGE_TEXT_MAX } from './schemas.ts'


/**
 * An external thread or channel, prefixed with its sync key:
 * `slack:C0123ABC` (a channel), `slack:C0123ABC:1727.1234` (a thread),
 * `github:acme/web:12` (a PR thread).
 */
export const ExternalTarget = z.string().min(3).max(300)

/** Where a message came from on a platform. `thread` is grouped (GitHub review threads fold into their PR). */
export const Origin = z.object({
  channel: ExternalTarget.optional(),
  thread: ExternalTarget,
  /** The exact platform thread, when it differs from `thread`. */
  subthread: ExternalTarget.nullable(),
  message: z.string().min(1).max(300),
  context: z.string().max(300).nullable(),
})

/** What a linked message said, as the board saw it when the link arrived. */
export const LinkSnapshot = z.object({
  author: z.string().min(1).max(256),
  text: z.string().max(MESSAGE_TEXT_MAX),
  /** When it was written, if the platform said. */
  createdAt: z.string().max(64).nullable(),
  /** Its files, linked rather than copied. */
  files: z.array(z.object({ name: z.string().min(1).max(1000), url: z.string().max(4000).nullable() })).max(20),
})

/**
 * A platform message linked from a message (a Slack permalink): the board message
 * it was synced to, if any, and a snapshot of it, or why the board couldn't read it.
 */
export const Link = z.object({
  url: z.string().min(1).max(4000),
  message: MessageId.nullable(),
  snapshot: LinkSnapshot.nullable(),
  /** Why there's no snapshot: `not_in_channel`, `channel_not_found`. */
  unavailable: z.string().max(300).nullable(),
})
export type Link = z.infer<typeof Link>
export const LINKS_PER_MESSAGE_MAX = 10
/** The most platform users one message introduces to the board by mentioning them. */
export const MENTIONED_PER_MESSAGE_MAX = 50

export type Origin = z.infer<typeof Origin>

export const ExternalAuthor = z.object({
  /** The platform principal, e.g. `slack:user:U0456`. */
  id: z.string().min(1),
  handle: z.string().min(1),
  name: z.string().min(1),
  avatar: z.string().nullable(),
  isBot: z.boolean(),
})

/**
 * A file on a platform message, as Chat SDK describes it: enough for the
 * platform's adapter to fetch it later (`rehydrateAttachment`), never the bytes.
 */
export const ExternalFile = z.object({
  type: z.enum(['image', 'file', 'video', 'audio']),
  name: z.string().max(1000).optional(),
  mimeType: z.string().max(255).optional(),
  size: z.number().int().nonnegative().optional(),
  url: z.string().max(4000).optional(),
  fetchMetadata: z.record(z.string(), z.string().max(4000)).optional(),
})
export type ExternalFile = z.infer<typeof ExternalFile>

/**
 * A platform message a platform message links to, at intake: where it lives
 * (`thread`, with the sync key prefix, and `message`), and what it said when the
 * platform sent that along (Slack's unfurl).
 */
export const ExternalLink = z.object({
  url: z.string().min(1).max(4000),
  thread: ExternalTarget,
  message: z.string().min(1).max(300),
  snapshot: LinkSnapshot.nullable(),
})
export type ExternalLink = z.infer<typeof ExternalLink>

export const ExternalLocation = z.object({ channel: ExternalTarget, thread: ExternalTarget, subthread: ExternalTarget.nullable() })

/** A platform event, normalized at intake. Thread IDs are external IDs with the sync key prefix. */
export const ExternalEvent = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'),
    ...ExternalLocation.shape,
    message: z.string(),
    isRoot: z.boolean(),
    text: z.string(),
    context: z.string().nullable(),
    author: ExternalAuthor,
    /** Files on the message, fetched when it lands on the board. Older events have none. */
    files: z.array(ExternalFile).max(20).optional(),
    /** Platform messages it links to. Older events have none. */
    links: z.array(ExternalLink).max(LINKS_PER_MESSAGE_MAX).optional(),
    /** The platform's users its text mentions, each written there as `@[<their id>]`. Older events have none. */
    mentioned: z.array(ExternalAuthor).max(MENTIONED_PER_MESSAGE_MAX).optional(),
  }),
  z.object({
    kind: z.literal('edited'),
    ...ExternalLocation.shape,
    message: z.string(),
    text: z.string(),
    author: ExternalAuthor,
    links: z.array(ExternalLink).max(LINKS_PER_MESSAGE_MAX).optional(),
    /** Only the links changed (the platform sent what they say), so `text` isn't news. */
    linksOnly: z.boolean().optional(),
    /** As a message's: who its text now mentions. */
    mentioned: z.array(ExternalAuthor).max(MENTIONED_PER_MESSAGE_MAX).optional(),
  }),
  z.object({
    kind: z.literal('deleted'),
    ...ExternalLocation.shape,
    message: z.string(),
  }),
  z.object({
    kind: z.literal('reaction'),
    ...ExternalLocation.shape,
    message: z.string(),
    emoji: z.string(),
    added: z.boolean(),
    author: ExternalAuthor,
  }),
  z.object({
    /** A platform lifecycle event: a PR opening, closing, being reviewed. */
    kind: z.literal('lifecycle'),
    ...ExternalLocation.omit({ subthread: true }).shape,
    type: z.string(),
    title: z.string(),
    url: z.string().nullable(),
    /** What the PR or issue says, under its title and link on a root it opens or retitles. */
    body: z.string().nullable().optional(),
    labels: z.record(z.string(), z.string()),
    unset: z.array(z.string()),
    /** Key prefixes the platform owns on the root, e.g. `tag.`: keys under them that aren't in `labels` are unset. */
    owns: z.array(z.string()).optional(),
    /** A reply to add to the thread, e.g. "merged by julian". */
    reply: z.string().nullable(),
    /** Create the root if the board hasn't seen this thread. */
    createRoot: z.boolean(),
    /** The thread's title or body changed on the platform: a root that came from it says the new one. */
    retitled: z.boolean().optional(),
    author: ExternalAuthor,
  }),
])

export type ExternalEvent = z.infer<typeof ExternalEvent>
export type ExternalAuthor = z.infer<typeof ExternalAuthor>

/** `slack:C0123ABC:1727.1234` is a thread; `slack:C0123ABC` and `github:owner/repo` are channels. */
export const isThreadTarget = (target: string) => target.slice(target.indexOf(':') + 1).includes(':')

/** `slack:C0123ABC:1727.1` → `slack:C0123ABC`; `github:o/r:12` → `github:o/r`. */
export const channelOf = (externalThread: string) => {
  const at = externalThread.indexOf(':')
  const rest = externalThread.slice(at + 1)
  const colon = rest.indexOf(':')
  return colon === -1 ? externalThread : externalThread.slice(0, at + 1 + colon)
}

/**
 * One key for a platform message in a platform thread. The thread's own `|` and `\` are escaped, so
 * its end is the first bare `|`: (`a`, `b|c`) and (`a|b`, `c`) are two keys.
 */
export const externalMessageKey = (thread: string, message: string) => `${thread.replace(/[\\|]/g, '\\$&')}|${message}`
