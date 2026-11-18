import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import { ago } from './words.ts'

// Navigation with the History API: no reloads. Links act on mouse down, like
// native lists, and keep the browser's own behavior for new tabs. Every path
// here is the page's own (`/c/dev`), under `base` in the address bar.

/** The path the page is served under: `''` from `vb inspect`, `/board` where an app mounts it there. */
export const base = document.querySelector<HTMLMetaElement>('meta[name="inspect-base"]')?.content ?? ''

/** The page's own path for where the address bar is: `/` at `base` itself. */
const current = () => (location.pathname === base || location.pathname.startsWith(`${base}/`) ? location.pathname.slice(base.length) : location.pathname) || '/'

/** Where one of the page's paths is in the address bar. */
const address = (to: string) => `${base}${to}`

export function navigate(to: string, replace = false) {
  if (to === current() + location.search) return
  history[replace ? 'replaceState' : 'pushState'](null, '', address(to))
  dispatchEvent(new PopStateEvent('popstate'))
}

import type { Filter } from './store.ts'

/** Where you are: the view's path, an open thread, and the view's filters, all in the URL. */
export type Where = { path: string; thread: string | null; filter: Filter; params: URLSearchParams }

export function useLocation(): Where {
  const read = (): Where => {
    const params = new URLSearchParams(location.search)
    const thread = params.get('thread')
    return {
      path: current(),
      params,
      thread: thread || null,
      filter: {
        ...(params.get('from') ? { from: params.get('from')! } : {}),
        label: params.getAll('label').filter(Boolean),
        ...(params.get('text') ? { text: params.get('text')! } : {}),
      },
    }
  }
  const [where, setWhere] = useState(read)
  useEffect(() => {
    const update = () => setWhere(read())
    addEventListener('popstate', update)
    return () => removeEventListener('popstate', update)
  }, [])
  return where
}

/** This view's URL with a thread opened or closed, other filters, or other parameters of its own (null or empty drops one); the rest stays. */
export function here(changes: { thread?: string | null; filter?: Filter; params?: Record<string, string | string[] | null | undefined> }): string {
  const params = new URLSearchParams(location.search)
  for (const [key, value] of Object.entries(changes.params ?? {})) {
    params.delete(key)
    for (const one of Array.isArray(value) ? value : value ? [value] : []) params.append(key, one)
  }
  if (changes.thread !== undefined) {
    if (changes.thread === null) params.delete('thread')
    else params.set('thread', String(changes.thread))
  }
  if (changes.filter) {
    for (const key of ['from', 'label', 'text']) params.delete(key)
    if (changes.filter.from) params.set('from', changes.filter.from)
    for (const label of changes.filter.label) params.append('label', label)
    if (changes.filter.text) params.set('text', changes.filter.text)
  }
  const query = params.toString()
  return `${current()}${query ? `?${query}` : ''}`
}

export function Link(props: { to: string; className?: string; current?: boolean; title?: string; children: ReactNode }) {
  const navigatedAt = useRef(0)
  const plain = (event: React.MouseEvent | React.PointerEvent) =>
    event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
  return (
    <a
      href={address(props.to)}
      className={props.className}
      title={props.title}
      aria-current={props.current ? 'page' : undefined}
      onPointerDown={(event) => {
        if (event.pointerType !== 'mouse' || !plain(event)) return
        navigatedAt.current = Date.now()
        navigate(props.to)
      }}
      onClick={(event) => {
        if (!plain(event)) return
        event.preventDefault()
        if (Date.now() - navigatedAt.current > 500) navigate(props.to)
      }}
    >
      {props.children}
    </a>
  )
}

/** The current time, ticking, so "2m" ages without a reload. */
export function useNow(every = 30_000): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(timer)
  }, [every])
  return now
}

/**
 * Typing anywhere that isn't a field focuses a composer, and the keystroke lands in it: the open
 * thread's when there is one, since that's what you're looking at, or else `composer`.
 */
export function useTypeToFocus(composer: string) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) return
      const target = event.target as HTMLElement
      if (target !== document.body && target.closest('input, textarea, select, [contenteditable], [role="menu"], [role="dialog"], [role="listbox"]'))
        return
      const find = (role: string) => document.querySelector<HTMLTextAreaElement>(`textarea[data-composer="${CSS.escape(role)}"]`)
      const area = find('thread') ?? find(composer)
      area?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [composer])
}

/**
 * "now", "12s", "4m": a relative time that changes exactly when its label
 * would. Each one schedules its own next update: every second in the first
 * minute, then on the minute, the hour, the day.
 */
export function Ago({ iso, prefix = '' }: { iso: string; prefix?: string }) {
  const [, tick] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      const age = Math.max(0, Date.now() - Date.parse(iso))
      const unit = age < 60_000 ? 1_000 : age < 3_600_000 ? 60_000 : age < 86_400_000 ? 3_600_000 : 86_400_000
      timer = setTimeout(() => {
        tick()
        schedule()
      }, unit - (age % unit) + 20)
    }
    schedule()
    return () => clearTimeout(timer)
  }, [iso])
  const age = Date.now() - Date.parse(iso)
  return (
    <span className="time" title={new Date(iso).toLocaleString()}>
      {prefix}
      {age < 5_000 ? 'now' : ago(iso)}
    </span>
  )
}

/** The sections of the board's settings, each a tab at `/settings/<section>`. */
export const SECTIONS = ['access', 'schemas', 'schedules', 'watchers', 'sync'] as const
export type Section = (typeof SECTIONS)[number]

/** The view a path names. Settings is one view: its section, and what's open in it (a schema, a sync entry). */
export type Route =
  | { view: 'activity' }
  | { view: 'tasks' }
  | { view: 'channel'; channel: string }
  | { view: 'settings'; section: Section; open: string | null }
  | { view: 'missing' }

export function route(path: string): Route {
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return { view: 'missing' }
  }
  if (decoded === '/') return { view: 'activity' }
  if (decoded === '/tasks') return { view: 'tasks' }
  if (decoded.startsWith('/c/') && decoded.length > 3) return { view: 'channel', channel: decoded.slice(3) }
  const [, settings, section, ...rest] = decoded.split('/')
  if (settings === 'settings' && (SECTIONS as readonly string[]).includes(section ?? 'access'))
    return { view: 'settings', section: (section ?? 'access') as Section, open: rest.join('/') || null }
  return { view: 'missing' }
}
