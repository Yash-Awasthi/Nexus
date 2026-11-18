import { Check, ChevronsUpDown, Lock, PanelLeftClose, Plus, Settings } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ChannelView, Me } from '../../api/routes.ts'
import * as board from './board.ts'
import { toast } from './chrome.ts'
import { Avatar } from './message.tsx'
import { Link, navigate, type Route } from './nav.tsx'
import { openTasks, type State } from './store.ts'
import { ContextMenuArea, Menu, MenuItem, MenuSeparator } from './ui.tsx'
import { boardWords, shownName } from './words.ts'

// --- sidebar -------------------------------------------------------------------------

function useSeen(state: State, current: Route): Record<string, number> {
  const storage = `board.seen:${state.discovery?.url ?? location.host}`
  const [seen, setSeen] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem(storage) ?? 'null') ?? {}
    } catch {
      return {}
    }
  })
  const save = (next: Record<string, number>) => {
    setSeen(next)
    try {
      localStorage.setItem(storage, JSON.stringify(next))
    } catch {}
  }
  // The first visit marks everything read; after that, dots mean news.
  useEffect(() => {
    const channels = Object.values(state.channels)
    if (Object.keys(seen).length === 0 && channels.length > 0)
      save(Object.fromEntries(channels.map((channel) => [channel.path, channel.lastIndex ?? 0])))
  }, [state.channels])
  useEffect(() => {
    if (current.view !== 'channel') return
    const channel = state.channels[current.channel]
    if (channel?.lastIndex !== undefined && (seen[channel.path] ?? 0) < channel.lastIndex) save({ ...seen, [channel.path]: channel.lastIndex })
  }, [current, state.channels])
  return seen
}

export function Sidebar({ state, current, onCollapse }: { state: State; current: Route; onCollapse: () => void }) {
  const seen = useSeen(state, current)
  const groups = useMemo(() => {
    const out = new Map<string, ChannelView[]>()
    for (const channel of Object.values(state.channels).sort((a, b) => a.path.localeCompare(b.path))) {
      const at = channel.path.lastIndexOf('/')
      const group = at === -1 ? 'channels' : channel.path.slice(0, at)
      out.set(group, [...(out.get(group) ?? []), channel])
    }
    return [...out]
  }, [state.channels])
  const open = openTasks(state)
  const where = boardWords(state.discovery)
  const [adding, setAdding] = useState(false)
  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast(`copied ${text}`))
  return (
    <div className="sidebar-col">
      <div className="brand">
        <span className="which" title={state.discovery?.url}>
          <span className="name">{where.name}</span>
          {where.at && <span className="at">{where.at}</span>}
        </span>
        <button className="tool" title="hide the sidebar" onClick={onCollapse}>
          <PanelLeftClose size={15} strokeWidth={1.75} />
        </button>
      </div>
      <div className="sidebar-scroll">
        <Link to="/" className="item" current={current.view === 'activity'}>
          <span>activity</span>
        </Link>
        <Link to="/tasks" className="item" current={current.view === 'tasks'}>
          <span className="name">tasks</span>
          {open !== null && open > 0 && <span className="count">{open}</span>}
        </Link>
        <h2>
          channels
          <button className="tool" title="new channel" onClick={() => setAdding(true)}>
            <Plus size={12} />
          </button>
        </h2>
        {adding && <NewChannel onDone={() => setAdding(false)} />}
        {groups.map(([group, channels]) => (
          <section key={group}>
            {group !== 'channels' && <h2>{group}</h2>}
            {channels.map((channel) => {
              const active = current.view === 'channel' && current.channel === channel.path
              // Only where the board keeps a channel's last position: Vercel's API doesn't.
              const unread = !active && (channel.lastIndex ?? 0) > (seen[channel.path] ?? Number.POSITIVE_INFINITY)
              return (
                <ContextMenuArea
                  key={channel.path}
                  menu={
                    <>
                      <MenuItem onClick={() => copy(channel.path)}>copy name</MenuItem>
                      <MenuItem onClick={() => copy(`vb read ${channel.path}`)}>copy vb read command</MenuItem>
                    </>
                  }
                >
                  <Link to={`/c/${channel.path}`} className={`item${unread ? ' unread' : ''}`} current={active} title={channel.path}>
                    <span className="name">#{channel.path.slice(channel.path.lastIndexOf('/') + 1)}</span>
                    {unread ? <i className="dot" /> : channel.threads !== undefined ? <span className="count">{channel.threads}</span> : null}
                  </Link>
                </ContextMenuArea>
              )
            })}
          </section>
        ))}
      </div>
      <div className="sidebar-foot">
        <Link to="/settings/access" className="item settings" current={current.view === 'settings'}>
          <Settings size={14} strokeWidth={1.75} />
          <span>settings</span>
        </Link>
        <ProfileMenu me={state.me!} />
      </div>
    </div>
  )
}

/** A channel, made before anything posts to it. Private closes it to everyone but you. */
function NewChannel({ onDone }: { onDone: () => void }) {
  const [closed, setClosed] = useState(false)
  return (
    <form
      className="new-channel"
      onSubmit={(event) => {
        event.preventDefault()
        const path = new FormData(event.currentTarget).get('path')?.toString().trim().replace(/^#/, '')
        if (!path) return onDone()
        void board.createChannel(path, closed ? { private: true } : {}).then((made) => made && navigate(`/c/${path}`))
        onDone()
      }}
      onKeyDown={(event) => event.key === 'Escape' && onDone()}
      onBlur={(event) => !event.currentTarget.contains(event.relatedTarget) && onDone()}
    >
      <input name="path" autoFocus placeholder="name, e.g. incidents" pattern="[a-z0-9][a-z0-9_\-]*(/[a-z0-9][a-z0-9_\-]*)*" title="lowercase letters, numbers, - and _, with / between parts" spellCheck={false} />
      <button
        type="button"
        className={`tool${closed ? ' on' : ''}`}
        aria-pressed={closed}
        title={closed ? 'private: only you get in' : 'make it private'}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setClosed(!closed)}
      >
        <Lock size={12} />
      </button>
    </form>
  )
}

const AGENTS = ['claude', 'codex', 'grok']

/** The profile `name`, with the avatar you last gave it. */
function remembered(name: string): board.Profile {
  const avatar = board.avatarOf(name)
  return avatar ? { name, avatar } : { name }
}

/** Who you post as: yourself, one of your agents' profiles, or any profile you name, with the avatar you give it. */
function ProfileMenu({ me }: { me: Me }) {
  // The profile you're naming or changing, as it starts out; null while the menu shows.
  const [editing, setEditing] = useState<board.Profile | null>(null)
  const person = me.via?.name ?? me.handle
  const choose = (name: string | null) => void board.setProfile(name === null ? null : remembered(name))
  if (editing)
    return (
      <form
        className="whoami naming"
        onSubmit={(event) => {
          event.preventDefault()
          const form = new FormData(event.currentTarget)
          const name = form.get('profile')?.toString().trim()
          const avatar = form.get('avatar')?.toString().trim()
          if (name) void board.setProfile({ name, ...(avatar ? { avatar } : {}) })
          setEditing(null)
        }}
        onKeyDown={(event) => event.key === 'Escape' && setEditing(null)}
        // Leaving the form puts it away; moving between its fields doesn't.
        onBlur={(event) => !event.currentTarget.contains(event.relatedTarget) && setEditing(null)}
      >
        <input
          name="profile"
          autoFocus
          defaultValue={editing.name}
          placeholder="profile name, e.g. reviewer"
          pattern="[A-Za-z][A-Za-z0-9\-]{0,31}"
          title="a letter, then up to 31 letters, numbers, and hyphens"
          required
        />
        <input
          name="avatar"
          type="url"
          defaultValue={editing.avatar ?? ''}
          placeholder="avatar URL, https://… (optional)"
          // What the board takes: https, or http on this machine.
          pattern="https://.+|http://(localhost|127\.0\.0\.1)([:\/].*)?"
          title="an https URL (http only on localhost)"
        />
        {/* Safari and Firefox don't focus a button you click: without this, the field's blur closes the form before the click. */}
        <button type="submit" className="send small" onMouseDown={(event) => event.preventDefault()}>
          post as this
        </button>
      </form>
    )
  const item = (label: string, profile: string | null) => (
    <MenuItem onClick={() => choose(profile)}>
      <span className="choice">
        {label}
        {me.profile === profile && <Check size={13} />}
      </span>
    </MenuItem>
  )
  return (
    <div className="whoami-wrap" title={me.actor}>
      <Menu
        className="whoami"
        title="post as"
        trigger={
          <>
            <Avatar name={shownName(me)} url={me.avatar} size={24} />
            <span className="as grow">as {shownName(me)}</span>
            <ChevronsUpDown size={13} />
          </>
        }
      >
        {!board.named && item(`${person} (you)`, null)}
        {AGENTS.map((agent) => item(agent, agent))}
        {me.profile !== null && !AGENTS.includes(me.profile) && item(me.profile, me.profile)}
        <MenuSeparator />
        {me.profile !== null && (
          <MenuItem onClick={() => setEditing(remembered(me.profile!))}>
            {me.profile}'s name and avatar…
          </MenuItem>
        )}
        <MenuItem onClick={() => setEditing({ name: '' })}>another profile…</MenuItem>
        {!board.named && board.getProfile() !== undefined && <MenuItem onClick={() => void board.setProfile(undefined)}>as inspect started</MenuItem>}
      </Menu>
    </div>
  )
}
