import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useToasts } from './chrome.ts'

// --- the scrolling list --------------------------------------------------------------

/**
 * Keeps to the bottom while you're there, holds still while you read history,
 * and keeps your place when older messages load above.
 */
export function Feed(props: {
  scope: string
  /** The first message shown: when it changes, older ones loaded above. */
  first: string
  /** The last thing shown, as a key: when it changes, something new came in below. */
  last: string
  older?: () => Promise<boolean>
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const restore = useRef<{ height: number; top: number } | null>(null)
  const loading = useRef(false)
  const done = useRef(false)
  const first = useRef(props.first)
  first.current = props.first
  const lastSeen = useRef(props.last)
  const [behind, setBehind] = useState(false)

  const toBottom = () => {
    const el = ref.current!
    el.scrollTop = el.scrollHeight
    pinned.current = true
    setBehind(false)
  }

  useLayoutEffect(() => {
    toBottom()
    lastSeen.current = props.last
    done.current = false
  }, [props.scope])

  useLayoutEffect(() => {
    const el = ref.current!
    if (restore.current) {
      el.scrollTop = el.scrollHeight - restore.current.height + restore.current.top
      restore.current = null
    } else if (pinned.current) el.scrollTop = el.scrollHeight
    else if (props.last !== lastSeen.current) setBehind(true)
    lastSeen.current = props.last
  }, [props.first, props.last])

  // Reactions, edits, and images change heights without changing the list.
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (pinned.current && !restore.current) ref.current!.scrollTop = ref.current!.scrollHeight
    })
    observer.observe(content.current!)
    // And the list itself: what sits above a thread comes and goes.
    observer.observe(ref.current!)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="feed-wrap">
      <div
        className="feed"
        ref={ref}
        onScroll={() => {
          const el = ref.current!
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
          if (pinned.current) setBehind(false)
          if (el.scrollTop < 240 && props.older && !loading.current && !done.current) {
            loading.current = true
            const before = first.current
            restore.current = { height: el.scrollHeight, top: el.scrollTop }
            void props.older().then((more) =>
              // After the render that shows them: if nothing came in above, there's no place to keep.
              requestAnimationFrame(() => {
                if (first.current === before) restore.current = null
                loading.current = false
                done.current = !more
              }),
            )
          }
        }}
      >
        <div ref={content}>{props.children}</div>
      </div>
      {behind && (
        <button className="jump" onClick={toBottom}>
          new messages ↓
        </button>
      )}
    </div>
  )
}

export function Toasts() {
  const toasts = useToasts()
  return (
    <div className="toasts" role="status">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          {t.text}
        </div>
      ))}
    </div>
  )
}
