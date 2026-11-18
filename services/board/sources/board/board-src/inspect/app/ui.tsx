import { Autocomplete } from '@base-ui/react/autocomplete'
import { ContextMenu } from '@base-ui/react/context-menu'
import { Menu as BaseMenu } from '@base-ui/react/menu'
import { Popover } from '@base-ui/react/popover'
import { X } from 'lucide-react'
import { useRef, useState, type ReactElement, type ReactNode } from 'react'
import { displayEmoji } from '../../contract/emoji.ts'
import type { Listed } from './store.ts'
import { EMOJI_TABLE } from '../../contract/emoji-table.ts'

// Base UI primitives, dressed like Just Chat: square, one hairline, and an
// offset dot shadow instead of a blur.

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="frame">
      {children}
      <i className="dots" aria-hidden />
    </div>
  )
}

export function Menu(props: { trigger: ReactNode; title: string; className?: string; onOpenChange?: (open: boolean) => void; children: ReactNode }) {
  return (
    <BaseMenu.Root {...(props.onOpenChange ? { onOpenChange: props.onOpenChange } : {})}>
      <BaseMenu.Trigger className={props.className ?? 'tool'} aria-label={props.title} title={props.title}>
        {props.trigger}
      </BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner className="positioner" align="end" sideOffset={4}>
          <Frame>
            <BaseMenu.Popup className="menu">{props.children}</BaseMenu.Popup>
          </Frame>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  )
}

/** Right-click anywhere in `children` but on text (which keeps the browser's menu) opens `menu`. */
export function ContextMenuArea(props: { menu: ReactNode; onOpenChange?: (open: boolean) => void; children: ReactElement }) {
  return (
    <ContextMenu.Root {...(props.onOpenChange ? { onOpenChange: props.onOpenChange } : {})}>
      <ContextMenu.Trigger render={props.children} />
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="positioner">
          <Frame>
            <ContextMenu.Popup className="menu">{props.menu}</ContextMenu.Popup>
          </Frame>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

/**
 * Whether (x, y) is on a character, not the blank space a block leaves beside a short line or under
 * its last one: the caret's nearest text node, and whether the point is inside one of its lines.
 */
function onText(x: number, y: number): boolean {
  const node = document.caretPositionFromPoint?.(x, y)?.offsetNode ?? document.caretRangeFromPoint?.(x, y)?.startContainer
  if (node?.nodeType !== Node.TEXT_NODE) return false
  const range = document.createRange()
  range.selectNodeContents(node)
  return [...range.getClientRects()].some((line) => x >= line.left && x <= line.right && y >= line.top && y <= line.bottom)
}

/** Whether a right-click there keeps the browser's menu: on text, a link, or an image. */
const keepsBrowserMenu = (event: React.MouseEvent) => !!(event.target as Element).closest('a, img, video') || onText(event.clientX, event.clientY)

/**
 * Stops a right-click on text, a link, or an image from reaching the custom menu: you get copy and
 * look-up. The space around them is the row's, where its menu opens, and where the cursor is the
 * default one, not text's.
 */
export const nativeMenu = {
  onContextMenuCapture: (event: React.MouseEvent) => {
    if (keepsBrowserMenu(event)) event.stopPropagation()
  },
  // Not while a button is down: a selection being dragged keeps its cursor.
  onMouseMove: (event: React.MouseEvent<HTMLElement>) => {
    if (event.buttons === 0) event.currentTarget.style.cursor = keepsBrowserMenu(event) ? '' : 'default'
  },
}

/** Keeps the browser's menu everywhere in something you type in. */
export const fieldMenu = { onContextMenuCapture: (event: React.MouseEvent) => event.stopPropagation() }

export function MenuItem(props: { onClick: () => void; danger?: boolean; hint?: string; children: ReactNode }) {
  return (
    <BaseMenu.Item className={`item${props.danger ? ' danger' : ''}`} onClick={props.onClick}>
      <span className="grow">{props.children}</span>
      {props.hint && <span className="hint">{props.hint}</span>}
    </BaseMenu.Item>
  )
}

export const MenuSeparator = () => <BaseMenu.Separator className="separator" />

export function MenuEmojiRow({ emojis, onPick }: { emojis: string[]; onPick: (name: string) => void }) {
  return (
    <div className="emoji-row">
      {emojis.map((name) => (
        <BaseMenu.Item key={name} className="item emoji" title={`:${name}:`} onClick={() => onPick(name)}>
          {displayEmoji(name)}
        </BaseMenu.Item>
      ))}
    </div>
  )
}

const ALL_EMOJI = Object.keys(EMOJI_TABLE)

/** Every reaction, in a popover anchored to its trigger. */
export function EmojiPicker(props: { trigger: ReactNode; onPick: (name: string) => void; onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const change = (next: boolean) => {
    setOpen(next)
    props.onOpenChange?.(next)
  }
  return (
    <Popover.Root open={open} onOpenChange={change}>
      <Popover.Trigger className="tool" aria-label="add a reaction" title="add a reaction">
        {props.trigger}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="positioner" align="end" sideOffset={4}>
          <Frame>
            <Popover.Popup className="menu emoji-grid">
              {ALL_EMOJI.map((name) => (
                <button
                  key={name}
                  className="emoji"
                  title={`:${name}:`}
                  onClick={() => {
                    props.onPick(name)
                    change(false)
                  }}
                >
                  {displayEmoji(name)}
                </button>
              ))}
            </Popover.Popup>
          </Frame>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** A text field that suggests values but takes anything you type. */
export function Suggest(props: {
  value: string
  onChange: (value: string) => void
  items: string[]
  placeholder: string
  prefix?: string
  label?: (item: string) => ReactNode
  onEnter?: () => void
  className?: string
  autoFocus?: boolean
}) {
  return (
    <Autocomplete.Root items={props.items} value={props.value} onValueChange={props.onChange} openOnInputClick autoHighlight={false}>
      <label className={`suggest ${props.className ?? ''}`}>
        {props.prefix && <span className="prefix">{props.prefix}</span>}
        <Autocomplete.Input
          placeholder={props.placeholder}
          autoFocus={props.autoFocus}
          spellCheck={false}
          onKeyDown={(event) => {
            // Enter with nothing highlighted takes what you typed.
            if (event.key === 'Enter' && !event.currentTarget.getAttribute('aria-activedescendant') && props.onEnter) {
              event.preventDefault()
              props.onEnter()
            }
          }}
        />
      </label>
      <Autocomplete.Portal>
        <Autocomplete.Positioner className="positioner" align="start" sideOffset={4}>
          <Frame>
            <Autocomplete.Popup className="menu list">
              <Autocomplete.Empty className="empty-item">nothing yet: type a new one</Autocomplete.Empty>
              <Autocomplete.List>
                {(item: string) => (
                  <Autocomplete.Item key={item} value={item} className="item">
                    {props.label ? props.label(item) : item}
                  </Autocomplete.Item>
                )}
              </Autocomplete.List>
            </Autocomplete.Popup>
          </Frame>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
    </Autocomplete.Root>
  )
}

export type KnownLabels = Map<string, Set<string>>

/**
 * Labels as key=value rows: remove one, or add one with suggestions from the
 * labels already on the board.
 */
export function LabelEditor(props: {
  labels: Record<string, string>
  known: KnownLabels
  onSet: (key: string, value: string) => void
  onUnset: (key: string) => void
}) {
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const valueRef = useRef<HTMLDivElement>(null)
  const add = () => {
    const k = key.trim()
    if (!k) return
    props.onSet(k, value.trim())
    setKey('')
    setValue('')
  }
  // Labels under `board.` are the board's own: it writes them, and no one else can.
  const entries = Object.entries(props.labels).filter(([k]) => !k.startsWith('board.'))
  return (
    <div className="labels-editor">
      {entries.length === 0 ? (
        <p className="hint">no labels</p>
      ) : (
        <div className="label-rows">
          {entries.map(([k, v]) => (
            <div key={k} className="label-row">
              <span className="label-key">{k}</span>
              <span className="label-value">{v || '—'}</span>
              <button className="tool" title={`remove ${k}`} onClick={() => props.onUnset(k)}>
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="label-add">
        <Suggest
          value={key}
          onChange={setKey}
          items={[...props.known.keys()].filter((k) => !(k in props.labels) && !k.startsWith('board.'))}
          placeholder="key"
          autoFocus
          onEnter={() => valueRef.current?.querySelector('input')?.focus()}
        />
        <span className="faint">=</span>
        <div ref={valueRef} className="grow">
          <Suggest value={value} onChange={setValue} items={[...(props.known.get(key.trim()) ?? [])]} placeholder="value" onEnter={add} />
        </div>
        <button className="send small" disabled={!key.trim()} onClick={add}>
          set
        </button>
      </div>
    </div>
  )
}

/** A titled popover, opened from its trigger or held open by its owner (anchored elsewhere). */
export function Panel(props: {
  title: string
  trigger?: ReactNode
  triggerTitle?: string
  /** The trigger's class: a toolbar's icon button unless it says otherwise. */
  triggerClass?: string
  /** Which edge of its trigger it lines up with: the end unless the trigger sits at the start of its row. */
  align?: 'start' | 'end'
  open: boolean
  onOpenChange: (open: boolean) => void
  anchor?: React.RefObject<Element | null>
  children: ReactNode
}) {
  return (
    <Popover.Root open={props.open} onOpenChange={props.onOpenChange}>
      {props.trigger && (
        <Popover.Trigger className={props.triggerClass ?? 'tool'} aria-label={props.triggerTitle ?? props.title} title={props.triggerTitle ?? props.title}>
          {props.trigger}
        </Popover.Trigger>
      )}
      <Popover.Portal>
        <Popover.Positioner className="positioner" align={props.align ?? 'end'} sideOffset={6} {...(props.anchor ? { anchor: props.anchor } : {})}>
          <Frame>
            <Popover.Popup className="menu popover">
              <Popover.Title className="popover-title">{props.title}</Popover.Title>
              {props.children}
            </Popover.Popup>
          </Frame>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** Drag to resize; arrow keys too. Reports the pointer's x while dragging. */
export function ResizeHandle(props: {
  side: 'left' | 'right'
  label: string
  onDrag: (clientX: number) => void
  onDone: () => void
  onStep: (delta: number) => void
}) {
  const [dragging, setDragging] = useState(false)
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      tabIndex={0}
      className={`resize ${props.side}${dragging ? ' dragging' : ''}`}
      onPointerDown={(event) => {
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(true)
      }}
      onPointerMove={(event) => dragging && props.onDrag(event.clientX)}
      onPointerUp={() => {
        setDragging(false)
        props.onDone()
      }}
      onPointerCancel={() => {
        setDragging(false)
        props.onDone()
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') props.onStep(-16)
        if (event.key === 'ArrowRight') props.onStep(16)
      }}
    >
      <i />
    </div>
  )
}

/** A view's header: its title, a quiet line beside it, its controls, and whether the feed is live. */
export function Header(props: { title: string; meta?: string | undefined; live?: 'connecting' | 'live' | 'reconnecting'; lead?: ReactNode; flat?: boolean; children?: ReactNode }) {
  return (
    <header className={`header${props.flat ? ' flat' : ''}`}>
      {props.lead}
      <span className="title">{props.title}</span>
      {props.meta && <span className="meta">{props.meta}</span>}
      <span className="spacer" />
      {props.children}
      {props.live && (
        <span className={`live ${props.live}`} title={props.live === 'live' ? 'receiving board events' : 'the feed reconnects on its own'}>
          <i />
          {props.live === 'live' ? 'live' : props.live}
        </span>
      )}
    </header>
  )
}

/** One thing a form asks for: a line, a longer note, or a line with suggestions. */
export type AskField = { name: string; placeholder: string; required?: boolean; items?: string[]; long?: boolean; value?: string }

/** What a small form asks for, and what it does with the answers. */
export type AskProps = {
  fields: AskField[]
  submit: string
  note?: string | undefined
  disabled?: boolean
  onSubmit: (values: Record<string, string>) => unknown
}

/** A small form: a field per thing it asks, sent with Enter (⌘Enter from a note). `onDone` hears that it was sent. */
export function AskForm(props: AskProps & { onDone?: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(props.fields.map((field) => [field.name, field.value ?? ''])))
  const value = (name: string) => values[name] ?? ''
  const put = (name: string, next: string) => setValues((current) => ({ ...current, [name]: next }))
  const ready = !props.disabled && props.fields.every((field) => !field.required || value(field.name).trim() !== '')
  const send = () => {
    if (!ready) return
    props.onDone?.()
    props.onSubmit(Object.fromEntries(props.fields.map((field) => [field.name, value(field.name).trim()])))
  }
  return (
    <form
      className="ask"
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
      {...fieldMenu}
    >
      {props.fields.map((field, i) =>
        field.items ? (
          <Suggest key={field.name} value={value(field.name)} onChange={(next) => put(field.name, next)} items={field.items} placeholder={field.placeholder} autoFocus={i === 0} onEnter={send} />
        ) : field.long ? (
          <textarea
            key={field.name}
            rows={3}
            autoFocus={i === 0}
            value={value(field.name)}
            placeholder={field.placeholder}
            onChange={(event) => put(field.name, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send()
            }}
          />
        ) : (
          <label key={field.name} className="suggest">
            <input autoFocus={i === 0} value={value(field.name)} placeholder={field.placeholder} spellCheck={false} onChange={(event) => put(field.name, event.target.value)} />
          </label>
        ),
      )}
      {props.note && <p className="hint">{props.note}</p>}
      <button type="submit" className="send small" disabled={!ready}>
        {props.submit}
      </button>
    </form>
  )
}

/** A button that asks before it acts: its form in a popover, closed once it's sent. */
export function Ask(props: AskProps & { label: ReactNode; title: string; triggerTitle?: string; className?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Panel title={props.title} trigger={props.label} triggerTitle={props.triggerTitle ?? props.title} triggerClass={props.className ?? 'act'} open={open} onOpenChange={setOpen}>
      <AskForm fields={props.fields} submit={props.submit} note={props.note} {...(props.disabled !== undefined ? { disabled: props.disabled } : {})} onSubmit={props.onSubmit} onDone={() => setOpen(false)} />
    </Panel>
  )
}

/** What shows in place of a list the board hasn't given: it's on its way, or what the board answered instead. */
export function Unlisted({ listed }: { listed: Listed<unknown> }) {
  if (listed.is === 'here') return null
  if (listed.is === 'failed') return <p className="empty error">{listed.why}</p>
  return <p className="empty">loading…</p>
}
