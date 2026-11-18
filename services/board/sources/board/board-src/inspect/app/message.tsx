import { Clock, Ellipsis, FileText, MessageSquare, SmilePlus, Tag } from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { LOGOS } from '../../contract/logos.ts'
import type { MessageView, SchemaView } from '../../api/routes.ts'
import { displayEmoji } from '../../contract/emoji.ts'
import type { Attachment } from '../../server/index.default.ts'
import { BlockCard } from './blocks.tsx'
import * as board from './board.ts'
import { setEditing, toast, useEditing } from './chrome.ts'
import { Ago } from './nav.tsx'
import { bodyParts, continues, isTask, schemaOf, sourcePlatform, type Groupable, type Pending, type ReplySummary, type State } from './store.ts'
import { TaskLine } from './task.tsx'
import { authorName, fileSize, shownName, timingWords } from './words.ts'
import { ContextMenuArea, EmojiPicker, fieldMenu, LabelEditor, Panel, Menu, MenuEmojiRow, MenuItem, MenuSeparator, nativeMenu, type KnownLabels } from './ui.tsx'

const MENU_EMOJI = ['thumbs_up', 'heart', 'laugh', 'party', 'eyes', 'check']

export type RowOptions = {
  me: string
  now: number
  known: KnownLabels
  /** Opens a message's thread; unset inside the thread itself. */
  openThread?: (id: string) => void
  /** Shown after the author, e.g. "in #prs" in the activity view. */
  context?: (m: MessageView) => ReactNode
  /** A root's replies, summarized under it. */
  summary?: (m: MessageView) => ReplySummary | undefined
  /** Sync key → platform, for each message's source mark. */
  platforms?: Record<string, string>
  /** The page's state, where a root that's a task shows it in a line; unset in a thread, whose pane shows it in full. */
  board?: State
  /** The board's schema registry, once read: what each block's fields mean. */
  schemas?: SchemaView[] | null
  /** Each actor the page knows, by ID, as they show: who a mention reads as. */
  names?: Record<string, string>
}

// A mention is `@[actor-id]` or `@[email]`, as the board stores one: any other `@word` is text.
const MENTIONS = /((?<![\w@.-])@\[[^\]\s]+\])/g
const MENTION = /^@\[([^\]\s]+)\]$/

type MdNode = { type: string; value?: string; children?: MdNode[]; data?: unknown }

/** Picks out the mentions in text, but not inside code or links: each reads as who it mentions, by `names`, or as it's written. */
const remarkMentions = (names: Record<string, string>) => () => {
  const walk = (node: MdNode) => {
    if (!node.children || node.type === 'link' || node.type === 'inlineCode' || node.type === 'code') return
    node.children = node.children.flatMap((child): MdNode[] => {
      if (child.type !== 'text') {
        walk(child)
        return [child]
      }
      return (child.value ?? '')
        .split(MENTIONS)
        .filter(Boolean)
        .map((part) => {
          const named = MENTION.exec(part)?.[1]
          if (named === undefined) return { type: 'text', value: part }
          const shown = `@${names[named] ?? named}`
          return { type: 'mention', value: shown, data: { hName: 'span', hProperties: { className: ['mention'], title: named }, hChildren: [{ type: 'text', value: shown }] } }
        })
    })
  }
  return (tree: MdNode) => walk(tree)
}

const NO_NAMES: Record<string, string> = {}
const COMPONENTS = {
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
}

/**
 * Markdown, as GitHub and Slack (through Chat SDK) write it: tables, lists,
 * code, links. Raw HTML is dropped. Right-clicking it gives the browser's menu.
 */
export const Text = memo(function Text({ text, edited = false, names = NO_NAMES }: { text: string; edited?: boolean; names?: Record<string, string> }) {
  const plugins = useMemo(() => [remarkGfm, remarkBreaks, remarkMentions(names)], [names])
  return (
    <div className="text" {...nativeMenu}>
      <Markdown remarkPlugins={plugins} components={COMPONENTS} skipHtml>
        {text}
      </Markdown>
      {edited && <span className="edited"> (edited)</span>}
    </div>
  )
})

/** A message's body: its prose as markdown, and each block it carries as a card, where its fence was. */
function Body({ m, schemas, names }: { m: MessageView; schemas: SchemaView[] | null | undefined; names: Record<string, string> | undefined }) {
  const parts = useMemo(() => bodyParts(m.text, m.blocks ?? []), [m.text, m.blocks])
  const edited = m.editedAt !== null
  const lastText = parts.findLastIndex((part) => 'text' in part)
  return (
    <>
      {parts.map((part, i) =>
        'text' in part ? (
          <Text key={i} text={part.text} edited={edited && i === lastText} {...(names ? { names } : {})} />
        ) : (
          <BlockCard
            key={i}
            block={part.block}
            schema={schemaOf({ schemas: schemas ?? null }, part.block.schema, part.block.version)}
            registry={schemas !== null && schemas !== undefined}
          />
        ),
      )}
      {edited && lastText === -1 && <span className="edited">(edited)</span>}
    </>
  )
}

/**
 * The platform messages a message links to (Slack permalinks), quoted under it:
 * what each said when the link arrived, or why the board couldn't read it.
 */
export function Links({ items }: { items: MessageView['links'] }) {
  if (!items?.length) return null
  return (
    <div className="links">
      {items.map((link) => (
        <div key={link.url} className="link-embed">
          <div className="link-meta" {...nativeMenu}>
            {link.snapshot && <span className="author">{link.snapshot.author}</span>}
            {link.message !== null && <span className="faint">#{link.message}</span>}
            <a href={link.url} target="_blank" rel="noreferrer">{link.snapshot ? 'open' : link.url}</a>
            {!link.snapshot && <span className="faint">couldn't read it: {link.unavailable ?? 'unknown'}</span>}
          </div>
          {link.snapshot?.text && <Text text={link.snapshot.text} />}
          {link.snapshot?.files.map((file, i) => (
            <div key={i} className="link-file">
              <FileText size={12} strokeWidth={1.75} />
              {file.url ? <a href={file.url} target="_blank" rel="noreferrer">{file.name}</a> : <span>{file.name}</span>}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

const IMAGE = /^image\/(png|jpeg|gif|webp|avif)$/
const VIDEO = /^video\/(mp4|webm)$/

/**
 * A message's files: images and videos in a fixed-size frame, so one loading
 * never moves what you're reading; anything else as a chip that saves it.
 */
export function Attachments({ items }: { items: Attachment[] }) {
  if (items.length === 0) return null
  return (
    <div className="attachments">
      {items.map((attachment) => (
        <AttachmentView key={attachment.id} attachment={attachment} />
      ))}
    </div>
  )
}

function AttachmentView({ attachment }: { attachment: Attachment }) {
  const media = IMAGE.test(attachment.type) ? 'image' : VIDEO.test(attachment.type) ? 'video' : null
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!media) return
    let live = true
    board.attachmentUrl(attachment.id).then(
      (next) => live && setUrl(next),
      () => {},
    )
    return () => {
      live = false
    }
  }, [attachment.id, media])
  const title = `${attachment.name} · ${fileSize(attachment.size)}`
  if (media === 'image')
    return (
      <button className="attachment-media" title={`${title} · click to open`} onClick={() => url && window.open(url, '_blank', 'noopener')}>
        {url && <img src={url} alt={attachment.name} />}
      </button>
    )
  if (media === 'video')
    return <span className="attachment-media" title={title}>{url && <video src={url} controls preload="metadata" />}</span>
  return (
    <button className="file" title={`download ${attachment.name}`} onClick={() => void board.saveAttachment(attachment)}>
      <FileText size={14} strokeWidth={1.75} />
      <span className="file-name">{attachment.name}</span>
      <span className="faint">{fileSize(attachment.size)}</span>
    </button>
  )
}

// Slack's mark is four dot-and-bar pairs, one color each: bottom-left, top-left,
// top-right, bottom-right, in the order Simple Icons draws them.
const SLACK_COLORS = ['#E01E5A', '#36C5F0', '#2EB67D', '#ECB22E']
const slackParts = (LOGOS.slack.match(/M[^M]+/g) ?? []).map((d, i) => ({ d, fill: SLACK_COLORS[Math.floor(i / 2)]! }))

const SOURCES: Record<string, { name: string; paths: { d: string; fill: string }[] }> = {
  slack: { name: 'Slack', paths: slackParts },
  github: { name: 'GitHub', paths: [{ d: LOGOS.github, fill: 'currentColor' }] },
  whatsapp: { name: 'WhatsApp', paths: [{ d: LOGOS.whatsapp, fill: '#25D366' }] },
}

/** Where a message came from, as that platform's mark. */
export function SourceLogo({ platform }: { platform: string }) {
  const source = SOURCES[platform]
  if (!source) return <span className="source text">{platform.slice(0, 1)}</span>
  return (
    <span className="source" title={`from ${source.name}`}>
      <svg viewBox="0 0 24 24" aria-label={source.name}>
        {source.paths.map((path, i) => (
          <path key={i} d={path.d} fill={path.fill} />
        ))}
      </svg>
    </span>
  )
}

export function Avatar({ name, url, size = 28 }: { name: string; url: string | null | undefined; size?: number }) {
  const [broken, setBroken] = useState(false)
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.43 }}>
      {url && !broken ? <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} /> : name.slice(0, 1).toUpperCase()}
    </span>
  )
}

const day = (iso: string) => new Date(iso).toDateString()

function dayLabel(iso: string, now: number): string {
  const date = new Date(iso)
  const today = new Date(now)
  if (date.toDateString() === today.toDateString()) return 'today'
  if (date.toDateString() === new Date(now - 86_400_000).toDateString()) return 'yesterday'
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function DayDivider({ iso, now }: { iso: string; now: number }) {
  return <div className="divider">{dayLabel(iso, now)}</div>
}

/**
 * A list of messages with day dividers and author grouping. `after` is what
 * came just before the list (a thread's root), so its day isn't repeated.
 * `at` is the time a message is listed by, when it isn't when it was written.
 */
export function Messages(props: { messages: MessageView[]; options: RowOptions; now: number; after?: MessageView; at?: (m: MessageView) => string }) {
  const at = props.at ?? ((m: MessageView) => m.createdAt)
  const rows: ReactNode[] = []
  props.messages.forEach((m, i) => {
    const previous = props.messages[i - 1]
    const before = previous ?? props.after
    if (!before || day(at(before)) !== day(at(m))) rows.push(<DayDivider key={`d${m.id}`} iso={at(m)} now={props.now} />)
    const grouped = continues(previous, m, previous ? (props.options.summary?.(previous)?.count ?? 0) > 0 : false)
    rows.push(<MessageRow key={m.id} m={m} options={props.options} continued={grouped} />)
  })
  return <>{rows}</>
}

function Editor({ m }: { m: MessageView }) {
  const [value, setValue] = useState(m.text)
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current!
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])
  useLayoutEffect(() => {
    const el = ref.current!
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [value])
  const save = () => {
    setEditing(null)
    if (value.trim() && value.trim() !== m.text) void board.edit(m.id, value.trim())
  }
  return (
    <div className="editor" {...fieldMenu}>
      <textarea
        ref={ref}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            setEditing(null)
          }
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            save()
          }
        }}
      />
      <span className="hint">enter to save · esc to cancel</span>
    </div>
  )
}

const copy = (text: string, what: string) =>
  navigator.clipboard.writeText(text).then(
    () => toast(`copied ${what}`),
    () => toast(`couldn't copy ${what}`),
  )

export function MessageRow({ m, options, continued = false }: { m: MessageView; options: RowOptions; continued?: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [labelsOpen, setLabelsOpen] = useState(false)
  const row = useRef<HTMLDivElement>(null)
  const editing = useEditing() === m.id
  const name = authorName(m)
  const mine = m.by.actor === options.me
  const reacted = (emoji: string) => (m.reactions[emoji] ?? []).includes(options.me)
  const toggle = (emoji: string) => void board.react(m.id, emoji, reacted(emoji))
  const replies = m.re === null ? options.summary?.(m) : undefined
  const thread = m.re ?? m.id
  // A task's state is its `board.task` label too, which its line already says.
  const labels = Object.entries(m.labels).filter(([key]) => !(key.startsWith('board.') && m.task))

  const items = (
    <>
      <MenuEmojiRow emojis={MENU_EMOJI} onPick={toggle} />
      <MenuSeparator />
      {options.openThread && <MenuItem onClick={() => options.openThread!(thread)}>{m.re === null ? 'reply in thread' : 'open thread'}</MenuItem>}
      <MenuItem onClick={() => setLabelsOpen(true)}>labels…</MenuItem>
      {m.text && <MenuItem onClick={() => void copy(m.text, 'text')}>copy text</MenuItem>}
      <MenuItem onClick={() => void copy(String(m.id), `#${m.id}`)} hint={`#${m.id}`}>
        copy id
      </MenuItem>
      {mine && (
        <>
          <MenuSeparator />
          <MenuItem onClick={() => setEditing(m.id)}>edit message</MenuItem>
          <MenuItem danger onClick={() => confirm(`Delete #${m.id}? It's removed on Slack and GitHub too.`) && void board.remove(m.id)}>
            delete message
          </MenuItem>
        </>
      )}
    </>
  )

  const active = (hovered || menuOpen || labelsOpen) && !editing
  const element = (
      <div
        ref={row}
        id={`m${m.id}`}
        className={`message${continued ? ' continued' : ''}${active ? ' active' : ''}`}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div className="gutter">
          {continued ? (
            <span className="gutter-time" {...nativeMenu}>
              {new Date(m.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '')}
            </span>
          ) : (
            <span className="avatar-wrap">
              <Avatar name={name} url={m.author?.avatar} />
              {m.from && <SourceLogo platform={sourcePlatform(m, options.platforms) ?? m.from} />}
            </span>
          )}
        </div>
        <div className="body">
          {!continued && (
            <div className="meta-line">
              <span className="author" {...nativeMenu}>
                {name}
              </span>
              {options.context?.(m)}
              <Ago iso={m.createdAt} />
              {m.noSync && <span className="badge">board only</span>}
              {m.schedule && (
                <span className="badge" title={`sent by schedule ${m.schedule.id}: send ${m.schedule.n + 1}`}>
                  <Clock size={10} /> scheduled
                </span>
              )}
            </div>
          )}
          {m.deleted ? (
            <div className="removed" {...nativeMenu}>
              message removed
            </div>
          ) : editing ? (
            <Editor m={m} />
          ) : (
            <>
              <Body m={m} schemas={options.schemas} names={options.names} />
              <Attachments items={m.attachments ?? []} />
              <Links items={m.links} />
            </>
          )}
          {options.board && isTask(m) && !m.deleted && <TaskLine root={m} state={options.board} />}
          {(labels.length > 0 || Object.keys(m.reactions).length > 0) && (
            <div className="chips">
              {labels.map(([key, value]) => (
                <button key={key} className="label" title="edit labels" onClick={() => setLabelsOpen(true)}>
                  {key}={value}
                </button>
              ))}
              {Object.entries(m.reactions).map(([emoji, actors]) => (
                <button key={emoji} className={`chip${reacted(emoji) ? ' mine' : ''}`} title={`:${emoji}: ${actors.join(', ')}`} onClick={() => toggle(emoji)}>
                  {displayEmoji(emoji)} {actors.length}
                </button>
              ))}
            </div>
          )}
          {Object.entries(m.undelivered ?? {}).map(([target, error]) => (
            <div key={target} className="undelivered">
              ✗ didn't reach {target}: {error}
            </div>
          ))}
          {replies && replies.count > 0 && options.openThread && (
            <button className="replies" onClick={() => options.openThread!(m.id)}>
              <span className="faces">
                {replies.faces.map((r) => (
                  <Avatar key={r.by.actor} name={authorName(r)} url={r.author?.avatar} size={16} />
                ))}
              </span>
              {replies.count} {replies.count === 1 ? 'reply' : 'replies'}
              {replies.last && <Ago iso={replies.last.createdAt} prefix=" · last " />}
            </button>
          )}
        </div>
        {active && !m.deleted && (
          <div className="actions">
            <button className="tool" title={`${reacted('thumbs_up') ? 'remove' : 'react'} 👍`} onClick={() => toggle('thumbs_up')}>
              👍
            </button>
            <EmojiPicker trigger={<SmilePlus size={15} strokeWidth={1.75} />} onPick={toggle} onOpenChange={setMenuOpen} />
            {options.openThread && (
              <button className="tool" title={m.re === null ? 'reply in thread' : 'open thread'} onClick={() => options.openThread!(thread)}>
                <MessageSquare size={15} strokeWidth={1.75} />
              </button>
            )}
            <button className="tool" title="labels" onClick={() => setLabelsOpen(true)}>
              <Tag size={15} strokeWidth={1.75} />
            </button>
            <Menu trigger={<Ellipsis size={15} strokeWidth={1.75} />} title="more" onOpenChange={setMenuOpen}>
              {items}
            </Menu>
          </div>
        )}
        <Panel title="labels" open={labelsOpen} onOpenChange={setLabelsOpen} anchor={row}>
          <LabelEditor
            labels={m.labels}
            known={options.known}
            onSet={(key, value) => void board.label(m.id, { [key]: value }, [])}
            onUnset={(key) => void board.label(m.id, {}, [key])}
          />
        </Panel>
      </div>
  )
  if (m.deleted) return element
  return (
    <ContextMenuArea menu={items} onOpenChange={setMenuOpen}>
      {element}
    </ContextMenuArea>
  )
}

type Me = { actor: string; name: string; handle: string; profile: string | null; avatar: string | null }

/**
 * Posts on their way, after `after` (the last message shown). Each is grouped
 * exactly as its message will be, so nothing moves when the board confirms it.
 */
export function Pendings(props: { posts: Pending[]; me: Me; after?: MessageView; afterHasReplies?: boolean }) {
  const seen = (post: Pending): Groupable => ({ by: { actor: props.me.actor } as MessageView['by'], createdAt: post.createdAt, deleted: false, channel: post.channel, re: post.re })
  return (
    <>
      {props.posts.map((post, i) => {
        const previous = i === 0 ? props.after : seen(props.posts[i - 1]!)
        // One to send later says when under its own header, so it never runs on from the row above.
        const continued = post.later === undefined && continues(previous, seen(post), i === 0 ? (props.afterHasReplies ?? false) : false)
        return <PendingRow key={post.key} post={post} me={props.me} continued={continued} />
      })}
    </>
  )
}

/** A post on its way, or one that didn't make it. */
export function PendingRow({ post, me, continued = false }: { post: Pending; me: Me; continued?: boolean }) {
  const status = post.later ? (post.error ? "didn't schedule" : 'scheduling…') : post.error ? "didn't send" : 'sending…'
  return (
    <div className={`message pending${continued ? ' continued' : ''}${post.error ? ' failed' : ''}`}>
      <div className="gutter">
        {continued ? (
          <span className="gutter-time shown" title={status}>
            …
          </span>
        ) : (
          <Avatar name={shownName(me)} url={me.avatar} />
        )}
      </div>
      <div className="body">
        {!continued && (
          <div className="meta-line">
            <span className="author">{shownName(me)}</span>
            <span className="time">{status}</span>
            {post.later && (
              <span className="badge">
                <Clock size={10} /> {timingWords(post.later)}
              </span>
            )}
          </div>
        )}
        {post.text && <Text text={post.text} />}
        {post.files && (
          <div className="attachments">
            {post.files.map((file, i) => (
              <span key={i} className="file">
                <FileText size={14} strokeWidth={1.75} />
                <span className="file-name">{file.name}</span>
                <span className="faint">{fileSize(file.size)}</span>
              </span>
            ))}
          </div>
        )}
        {post.error && (
          <div className="undelivered">
            ✗ {post.error} · <button onClick={() => void board.retry(post)}>retry</button> · <button onClick={() => board.discard(post.key)}>discard</button>
          </div>
        )}
      </div>
    </div>
  )
}
