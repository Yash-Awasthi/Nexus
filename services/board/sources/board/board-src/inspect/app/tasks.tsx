import { ListFilter, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { MessageView } from '../../api/routes.ts'
import * as board from './board.ts'
import { Composer } from './composer.tsx'
import { describe } from './filters.tsx'
import { Pendings } from './message.tsx'
import { Ago, here, Link, navigate, useTypeToFocus, type Where } from './nav.tsx'
import { isTask, nameOf, placesUnder, stateNow, tasks, type State, type TaskFilter, type TaskRoot } from './store.ts'
import { Lease, Needs, StateMark, useLapse } from './task.tsx'
import { Header, nativeMenu, Panel, Suggest, type KnownLabels } from './ui.tsx'
import { firstLine } from './words.ts'

// The board's tasks as a queue: open ones, oldest first, the order they're worked in. Each row is
// its thread, which is where a task is read and worked.

const STATES = ['open', 'waiting', 'ready', 'claimed', 'blocked', 'completed', 'failed', 'canceled', 'all'] as const

/** The view's filter, from its URL: `/tasks?state=ready&channel=work/&label=step=fix`. */
function readFilter(params: URLSearchParams): TaskFilter {
  const state = params.get('state') ?? 'open'
  const one = (name: 'channel' | 'owner' | 'for') => (params.get(name) ? { [name]: params.get(name)! } : {})
  return {
    state: (STATES as readonly string[]).includes(state) ? (state as TaskFilter['state']) : 'open',
    label: params.getAll('label').filter(Boolean),
    ...one('channel'),
    ...one('owner'),
    ...one('for'),
  }
}

const setFilter = (changes: Record<string, string | string[] | null>) => navigate(here({ params: changes }), true)

export function Tasks(props: { state: State; now: number; lead: ReactNode; where: Where; known: KnownLabels }) {
  const { state, where } = props
  useTypeToFocus('main')
  const query = where.params.toString()
  const filter = useMemo(() => readFilter(where.params), [query])
  const key = JSON.stringify(filter)
  // Where the board's list ended, for the filter it was asked with: the list stops there while the board has more.
  const [listed, setListed] = useState<{ key: string; cursor: string; last: MessageView | undefined; more: boolean } | null>(null)
  // What the board answered instead of the list, when it refused: `tooWide` when its tree holds more channels than one list reads.
  const [refused, setRefused] = useState<{ text: string; tooWide: boolean } | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let current = true
    setLoading(true)
    // A refusal was the last filter's: this one says its own once the board answers.
    setRefused(null)
    void board.loadTasks(filter).then((page) => {
      if (!current) return
      setLoading(false)
      setRefused('refused' in page ? { text: page.refused, tooWide: page.tooWide } : null)
      setListed('cursor' in page ? { key, ...page } : null)
    })
    return () => {
      current = false
    }
  }, [key])
  const end = listed?.key === key && listed.more ? listed.last : undefined
  const rows = useMemo(() => tasks(state, filter, props.now, end), [state.messages, state.ops, state.actors, key, props.now, end])

  // A task can wait for one this list doesn't hold (a completed one, say): its thread says its state.
  const missing = [...new Set(rows.flatMap((row) => row.task.needs))].filter((id) => !state.messages[id]).slice(0, 30)
  useEffect(() => {
    for (const id of missing) void board.loadThread(id)
  }, [missing.join(' ')])

  const owners = [...new Set(Object.values(state.messages).flatMap((m) => (isTask(m) ? [m.task.owner] : [])))]
  const assignees = [...new Set(Object.values(state.messages).flatMap((m) => (isTask(m) && m.task.for ? [m.task.for] : [])))]
  const chips: { key: string; text: string; drop: Record<string, string | string[] | null> }[] = [
    ...(filter.channel ? [{ key: 'channel', text: `in #${filter.channel}`, drop: { channel: null } }] : []),
    ...filter.label.map((label) => ({ key: `label:${label}`, text: describe(label), drop: { label: filter.label.filter((l) => l !== label) } })),
    ...(filter.owner ? [{ key: 'owner', text: `owner ${nameOf(state, filter.owner)}`, drop: { owner: null } }] : []),
    ...(filter.for ? [{ key: 'for', text: `for ${nameOf(state, filter.for)}`, drop: { for: null } }] : []),
  ]
  const more = listed?.key === key && listed.more
  // Tasks on their way, and any the board refused, with why.
  const pending = state.pending.filter((post) => post.task !== undefined && post.re === null)
  return (
    <>
      <Header title="tasks" meta="oldest first" live={state.live} lead={props.lead}>
        <TaskFilterButton filter={filter} channels={Object.keys(state.channels).sort()} owners={owners} assignees={assignees} state={state} known={props.known} count={chips.length} />
      </Header>
      <nav className="tabs plain">
        {STATES.map((name) => (
          <Link key={name} to={here({ params: { state: name === 'open' ? null : name } })} className="tab" current={filter.state === name}>
            {name}
          </Link>
        ))}
        {chips.map((chip) => (
          <span key={chip.key} className="label">
            {chip.text}
            <button title="remove" onClick={() => setFilter(chip.drop)}>
              <X size={11} />
            </button>
          </span>
        ))}
      </nav>
      <div className="page">
        {refused?.tooWide ? (
          <Places channels={Object.keys(state.channels)} under={filter.channel} />
        ) : refused !== null ? (
          <p className="empty error">{refused.text}</p>
        ) : rows.length === 0 && pending.length === 0 ? (
          <p className="empty">{loading ? 'loading…' : chips.length > 0 || filter.state !== 'open' ? 'no tasks match' : 'no open tasks'}</p>
        ) : (
          <div className="task-rows">
            {rows.map((row) => (
              <TaskRow key={row.id} root={row} state={state} open={where.thread === row.id} />
            ))}
          </div>
        )}
        <Pendings posts={pending} me={state.me!} />
        {more && (
          <button
            className="clear more"
            onClick={() => void board.loadTasks(filter, listed.cursor).then((page) => 'cursor' in page && setListed({ key, ...page }))}
          >
            load more
          </button>
        )}
      </div>
      <Composer
        scope="tasks"
        role="main"
        placeholder="start a task…"
        known={props.known}
        channels={Object.keys(state.channels).sort()}
        {...(filter.channel && !filter.channel.endsWith('/') ? { channel: filter.channel } : {})}
        tasks={{ state, always: true }}
        onSend={({ text, noSync, channel, labels, files, task }) => void board.send({ channel, re: null, text, noSync, labels, files, ...(task ? { task } : {}) })}
      />
    </>
  )
}

/**
 * Where to look, when the board lists tasks a tree at a time: Vercel's does for a caller who doesn't
 * read every channel. Each place filters the list to it, and one that's still too big shows its own.
 */
function Places({ channels, under }: { channels: string[]; under: string | undefined }) {
  const places = placesUnder(channels, under)
  return (
    <>
      <p className="empty">
        {under ? `#${under} has` : 'this board has'} too many channels to list tasks from at once, since you don't read every channel here. pick where to look:
      </p>
      <div className="task-places">
        {places.map(({ place, channels: count }) => (
          <Link key={place} to={here({ params: { channel: place } })} className="task-place">
            <span className="name">#{place}</span>
            {place.endsWith('/') && <span className="count">{count === 1 ? '1 channel' : `${count} channels`}</span>}
          </Link>
        ))}
      </div>
    </>
  )
}

/** One task: its state, what it says, and the one thing about it that matters now. Opens its thread. */
function TaskRow({ root, state, open }: { root: TaskRoot; state: State; open: boolean }) {
  const { task } = root
  const now = useLapse(task.claim?.until)
  const current = stateNow(task, now)
  const labels = Object.entries(root.labels).filter(([key]) => !key.startsWith('board.'))
  return (
    <div
      className="task-row"
      role="link"
      tabIndex={0}
      aria-current={open ? 'true' : undefined}
      onClick={(event) => {
        // A link inside the row (what it needs) goes where it says.
        if (!(event.target as HTMLElement).closest('a')) navigate(here({ thread: root.id }))
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') navigate(here({ thread: root.id }))
      }}
    >
      <StateMark state={current} />
      <span className="task-title" {...nativeMenu}>
        {/* A task can be its files alone. */}
        <span className="faint">#{root.id}</span> {firstLine(root.text) || (root.attachments ?? []).map((file) => file.name).join(', ') || 'message removed'}
        {labels.map(([key, value]) => (
          <span key={key} className="label">
            {key}={value}
          </span>
        ))}
      </span>
      <span className="task-now">
        {current === 'claimed' && task.claim && (
          <>
            {nameOf(state, task.claim.actor)} · <Lease until={task.claim.until} />
          </>
        )}
        {current === 'ready' && (task.state === 'claimed' ? 'lease ran out' : task.for ? `for ${nameOf(state, task.for)}` : '')}
        {current === 'waiting' && (
          <>
            needs <Needs ids={task.needs} state={state} />
          </>
        )}
        {current === 'blocked' && (task.blocked?.kind ?? task.blocked?.reason)}
        {current === 'completed' && task.result}
        {(current === 'failed' || current === 'canceled') && task.reason}
      </span>
      <span className="task-where">#{root.channel}</span>
      <Ago iso={root.createdAt} />
    </div>
  )
}

function TaskFilterButton(props: { filter: TaskFilter; channels: string[]; owners: string[]; assignees: string[]; state: State; known: KnownLabels; count: number }) {
  const { filter, state } = props
  const [open, setOpen] = useState(false)
  const [channel, setChannel] = useState(filter.channel ?? '')
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const valueRef = useRef<HTMLDivElement>(null)
  useEffect(() => setChannel(filter.channel ?? ''), [filter.channel])
  // A channel, or with a trailing slash it and everything under it.
  const places = [...new Set(props.channels.flatMap((path) => [path, ...(path.includes('/') ? [`${path.slice(0, path.indexOf('/'))}/`] : [])]))].sort()
  const addLabel = () => {
    const k = key.trim()
    if (!k) return
    const label = value.trim() ? `${k}=${value.trim()}` : k
    if (!filter.label.includes(label)) setFilter({ label: [...filter.label, label] })
    setKey('')
    setValue('')
  }
  const who = (name: 'owner' | 'for', ids: string[]) => (
    <div className="segments">
      {['', ...ids].map((id) => (
        <button key={id || 'any'} className={`segment${(filter[name] ?? '') === id ? ' on' : ''}`} title={id} onClick={() => setFilter({ [name]: id || null })}>
          {id ? nameOf(state, id) : 'anyone'}
        </button>
      ))}
    </div>
  )
  return (
    <Panel
      title="filter tasks"
      trigger={
        <>
          <ListFilter size={15} strokeWidth={1.75} />
          {props.count > 0 && <span className="count">{props.count}</span>}
        </>
      }
      open={open}
      onOpenChange={setOpen}
    >
      <div className="filter-form">
        <div className="filter-row">
          <span className="filter-name">channel</span>
          <Suggest
            prefix="#"
            value={channel}
            onChange={(next) => {
              setChannel(next)
              // Picking one from the list filters at once; typing waits for Enter.
              if (places.includes(next) || next === '') setFilter({ channel: next || null })
            }}
            items={places}
            placeholder="any (work/ for all under it)"
            onEnter={() => setFilter({ channel: channel.trim().replace(/^#/, '') || null })}
          />
        </div>
        <div className="filter-row">
          <span className="filter-name">labels</span>
          <div className="label-add">
            <Suggest value={key} onChange={setKey} items={[...props.known.keys()].filter((k) => !k.startsWith('board.'))} placeholder="key" onEnter={() => (value ? addLabel() : valueRef.current?.querySelector('input')?.focus())} />
            <span className="faint">=</span>
            <div ref={valueRef} className="grow">
              <Suggest value={value} onChange={setValue} items={[...(props.known.get(key.trim()) ?? [])]} placeholder="any (or a|b)" onEnter={addLabel} />
            </div>
            <button className="send small" disabled={!key.trim()} onClick={addLabel}>
              add
            </button>
          </div>
        </div>
        <div className="filter-row">
          <span className="filter-name">owner</span>
          {who('owner', props.owners)}
        </div>
        <div className="filter-row">
          <span className="filter-name">for</span>
          {who('for', props.assignees)}
        </div>
      </div>
    </Panel>
  )
}
