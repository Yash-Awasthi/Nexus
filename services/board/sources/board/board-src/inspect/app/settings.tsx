import { RefreshCw } from 'lucide-react'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { InboxEntry } from '../../api/routes.ts'
import * as board from './board.ts'
import { Access } from './grants.tsx'
import { Ago, here, Link, SECTIONS, type Section, type Where } from './nav.tsx'
import { Schemas } from './schemas.tsx'
import { nameOf, type State, type Viewer } from './store.ts'
import { Header, nativeMenu, Unlisted } from './ui.tsx'
import { cadence, firstLine, shownName, until } from './words.ts'

// The board's configuration, apart from what's said on it: who gets in, what blocks can hold,
// what posts later, what watches, and what syncs. One view, a tab per section.

const ActionsSlot = createContext<HTMLElement | null>(null)

/** A section's own actions, at the end of the tabs' row. */
export function Actions({ children }: { children: ReactNode }) {
  const slot = useContext(ActionsSlot)
  return slot ? createPortal(children, slot) : null
}

export function Settings(props: { state: State; viewer: Viewer; now: number; lead: ReactNode; where: Where; section: Section; open: string | null }) {
  const { state, viewer, section } = props
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  return (
    <>
      <Header title="settings" lead={props.lead} flat />
      <nav className="tabs">
        {SECTIONS.map((name) => (
          <Link key={name} to={`/settings/${name}`} className="tab" current={name === section}>
            {name}
          </Link>
        ))}
        <span className="tab-actions" ref={setSlot} />
      </nav>
      <ActionsSlot.Provider value={slot}>
        <div className="page">
          {section === 'access' && <Access state={state} viewer={viewer} where={props.where} />}
          {section === 'schemas' && <Schemas state={state} viewer={viewer} selected={props.open} />}
          {section === 'schedules' && <Schedules state={state} viewer={viewer} now={props.now} all={props.where.params.get('show') === 'all'} />}
          {section === 'watchers' && <Watchers state={state} />}
          {section === 'sync' && <Sync state={state} entry={props.open} />}
        </div>
      </ActionsSlot.Provider>
    </>
  )
}

// --- schedules ---------------------------------------------------------------------------------

function Schedules({ state, viewer, now, all }: { state: State; viewer: Viewer; now: number; all: boolean }) {
  useEffect(() => {
    void board.loadSchedules(all)
  }, [all])
  const listed = state.schedules
  return (
    <>
      {listed.is === 'here' && <Actions>
        <Link to="/settings/schedules" className="tab" current={!all}>
          pending
        </Link>
        <Link to="/settings/schedules?show=all" className="tab" current={all}>
          all
        </Link>
      </Actions>}
      <Unlisted listed={listed} />
      {listed.is === 'here' && listed.items.length === 0 && <p className="empty">nothing scheduled</p>}
      {listed.is === 'here' &&
        listed.items.map((schedule) => (
          <div key={schedule.id} className="sched-row" {...nativeMenu}>
            <span className={schedule.state === 'pending' ? 'sched-when' : 'sched-when faint'} title={schedule.next ? new Date(schedule.next).toLocaleString() : undefined}>
              {schedule.state === 'pending' && schedule.next ? until(schedule.next, now) : schedule.state}
            </span>
            <span className="faint">{cadence(schedule)}</span>
            <span className="sched-text">{firstLine(schedule.text) || 'files only'}</span>
            {schedule.re === null ? (
              <Link to={`/c/${schedule.channel}`} className="text-link">
                #{schedule.channel}
              </Link>
            ) : (
              <Link to={here({ thread: schedule.re })} className="text-link">
                reply in #{schedule.channel}
              </Link>
            )}
            <span className="faint small">{shownName(schedule.author)}</span>
            {schedule.state === 'pending' && (schedule.by.principal === viewer.principal || viewer.may('manage', schedule.channel)) ? (
              <button className="act quiet" onClick={() => void board.cancelSchedule(schedule.id)}>
                cancel
              </button>
            ) : (
              <span />
            )}
          </div>
        ))}
    </>
  )
}

// --- watchers ----------------------------------------------------------------------------------

/** What boards elsewhere registered here, and what each tails. Read-only: a board registers its own. */
function Watchers({ state }: { state: State }) {
  useEffect(() => {
    void board.loadWatchers()
  }, [])
  const listed = state.watchers
  return (
    <>
      <Unlisted listed={listed} />
      {listed.is === 'here' && listed.items.length === 0 && <p className="empty">no watchers registered</p>}
      {listed.is === 'here' &&
        listed.items.map((registration) => (
          <section key={registration.owner} className="registration" {...nativeMenu}>
            <h3>
              <b>{nameOf(state, registration.owner)}</b>
              {registration.path ? ` · woken at ${registration.path}${registration.branch ? ` (${registration.branch})` : ''}` : registration.url ? ` · woken at ${registration.url}` : ' · pulls on its own'}
            </h3>
            {Object.entries(registration.watch).map(([id, watcher]) => (
              <div key={id} className="watch-row">
                <span className="watch-id">{id}</span>
                <code>{watcher.tail}</code>
              </div>
            ))}
            {registration.sync.map((entry) => (
              <div key={entry.key} className="watch-row">
                <span className="watch-id">{entry.key}</span>
                <span className="faint">syncs {entry.platform}</span>
              </div>
            ))}
          </section>
        ))}
    </>
  )
}

// --- sync --------------------------------------------------------------------------------------

/** The board's sync entries, and each one's raw inbox: what the platform sent, newest first. Not on the board's log, so not live. */
function Sync({ state, entry }: { state: State; entry: string | null }) {
  const entries = state.discovery?.sync ?? []
  const key = entry ?? entries[0]?.key ?? null
  const [events, setEvents] = useState<InboxEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () => {
    if (key === null) return
    setError(null)
    board.loadInbox(key).then(setEvents, (e: Error) => setError(e.message))
  }
  useEffect(() => {
    setEvents(null)
    load()
  }, [key])
  if (entries.length === 0 || key === null) return <p className="empty">this board syncs nothing</p>
  return (
    <>
      <Actions>
        <button className="tool" title="refresh" onClick={load}>
          <RefreshCw size={14} strokeWidth={1.75} />
        </button>
      </Actions>
      <nav className="tabs plain">
        {entries.map((one) => (
          <Link key={one.key} to={`/settings/sync/${one.key}`} className="tab" current={one.key === key}>
            {one.key}
            {one.platform !== one.key && <span className="faint"> {one.platform}</span>}
          </Link>
        ))}
      </nav>
      {error && <p className="empty error">{error}</p>}
      {!error && events === null && <p className="empty">loading…</p>}
      {events?.length === 0 && <p className="empty">no events yet</p>}
      {events?.map((row) => {
        const event = row.event as { kind: string; text?: string; type?: string; emoji?: string; author?: { handle?: string } }
        return (
          <div key={row.id} className="inbox-row">
            <Ago iso={row.createdAt} />
            <span>
              <span className="badge">{event.kind}</span>
            </span>
            <div>
              <div>
                <span className="author">{event.author?.handle ?? '—'}</span> {event.text ?? event.type ?? event.emoji ?? ''}
              </div>
              <pre>
                {row.channel} · {row.event.thread}
              </pre>
            </div>
          </div>
        )
      })}
    </>
  )
}
