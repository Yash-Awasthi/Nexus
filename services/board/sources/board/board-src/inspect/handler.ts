import type { BoardClient, ProfileOption } from '../client/client.ts'
import { InvalidProfileHeader, parseProfileHeader } from '../contract/profile-header.ts'
import { ATTACHMENT_BYTES_MAX } from '../contract/schemas.ts'
import { page as installed } from './page.ts'
import { CSP, relative, shell } from './shell.ts'

// `@vercel/board/inspect`: the inspector, served by your app. A route handler under `basePath`
// answers the page, its bundle, and its proxy to the board, which acts with the handle you give it:
// whoever reaches the route reads and writes as that handle, so put it behind what turns strangers
// away, such as Vercel's Deployment Protection.

/** Answers the inspector's requests under `basePath`: `GET`, `POST`, `PATCH`, `PUT`, and `DELETE` alike. */
export type InspectorHandler = (request: Request) => Promise<Response>

/**
 * The page's credential for its proxy. A server answers it on many instances, so it's the same for
 * every page: it's no secret, it's a header no other site's page can send without asking first.
 */
const TOKEN = 'page'

/** A JSON body the inspector reads whole: everything but an upload. */
const BODY_MAX = 1024 * 1024

/**
 * The inspector for `board`, served under `basePath` (`/board`: the page at `/board`, its bundle at
 * `/board/app.js`, its proxy at `/board/board/*`). The proxy answers only the page: a request names
 * its token, a browser's says it's from this origin (`Sec-Fetch-Site`), and a write carries this
 * origin. Each request acts as `board`, under the profile the page picks, the way any handle names
 * one (`x-board-profile`). A write that names none is refused: the handle is the deployment, not
 * whoever's visiting, so the page asks who's posting before it loads.
 */
export function inspector(options: { board: BoardClient; basePath: string }): InspectorHandler {
  const { board } = options
  const base = options.basePath.replace(/\/+$/, '')
  // The page and who it starts as, each read once per instance.
  const app = cached(installed)
  const started = cached(async () => profileOf(await board.me()))

  async function proxy(request: Request, path: string, search: string): Promise<Response> {
    const reading = request.method === 'GET' || request.method === 'HEAD'
    const site = request.headers.get('sec-fetch-site')
    if (request.headers.get('x-inspect-token') !== TOKEN || (site !== null && site !== 'same-origin') || (!reading && !sameOrigin(request)))
      return json(403, { error: { code: 'forbidden', message: "the board is reachable only from the inspector's own page" } })
    if (relative(path)) return json(400, { error: { code: 'bad_path', message: 'no relative paths' } })
    let as: ProfileOption = null
    const named = request.headers.get('x-board-profile')
    if (named !== null && named.trim() !== '') {
      try {
        const { name, avatar } = parseProfileHeader(named)
        as = avatar === null ? name : { name, avatar }
      } catch (error) {
        if (!(error instanceof InvalidProfileHeader)) throw error
        return json(400, { error: { code: 'invalid_profile', message: error.message } })
      }
    }
    // The handle is the deployment, which is no one visiting: a write names whose it is. Reads are the
    // same whoever asks, and the page's handle reads some (`/`, `/me`) as itself.
    if (!reading && (as === null || nameOf(as) === nameOf(await started().catch(() => null))))
      return json(401, { error: { code: 'profile_required', message: "name a profile to write as, other than the app's own: this page doesn't know who you are" } })
    let body: Uint8Array<ArrayBuffer> | undefined
    if (!reading) {
      const limit = path === '/attachments' ? ATTACHMENT_BYTES_MAX : BODY_MAX
      const read = await readUpTo(request, limit)
      if (read === null) return json(413, { error: { code: 'too_large', message: `a request to the inspector is at most ${limit} bytes` } })
      body = read
    }
    const forwarded: Record<string, string> = {}
    for (const header of ['content-type', 'accept', 'x-board-filename']) {
      const value = request.headers.get(header)
      if (value !== null) forwarded[header] = value
    }
    try {
      const upstream = await board.request(`${path}${search}`, {
        as,
        method: request.method,
        headers: forwarded,
        ...(body ? { body } : {}),
        signal: request.signal,
      })
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
      })
    } catch (error) {
      return json(502, { error: { code: 'unreachable', message: `the board didn't answer: ${(error as Error).message}` } })
    }
  }

  return async (request) => {
    const url = new URL(request.url)
    const at = url.pathname === base || url.pathname.startsWith(`${base}/`) ? url.pathname.slice(base.length) || '/' : null
    if (at === null) return text(404, 'not found')
    if (at === '/board' || at.startsWith('/board/')) return proxy(request, at.slice('/board'.length) || '/', url.search)
    if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'method not allowed')
    if (at === '/app.js') {
      const script = await app()
      if (script === null) return text(503, "the inspector's UI isn't installed with @vercel/board")
      // The page names it by board's version (`?v=`), so a browser keeps it until board is upgraded.
      return new Response(script, { headers: { ...HEADERS, 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'private, max-age=31536000, immutable' } })
    }
    // A board that won't say who the handle is still gets its page, which says why when it asks.
    const profile = await started().catch(() => null)
    return new Response(shell({ token: TOKEN, profile, base, named: true }), {
      headers: { ...HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP },
    })
  }
}

/**
 * A request's body, or null once it's more than `limit` bytes: a `Content-Length` over it is refused
 * before reading, and a body without one stops being read, and is canceled, as soon as it passes it.
 */
async function readUpTo(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(request.headers.get('content-length') ?? 0) > limit) return null
  if (request.body === null) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const body = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    body.set(chunk, at)
    at += chunk.byteLength
  }
  return body
}

/** `load`'s answer, asked for once: a failure is asked again next time. */
function cached<T>(load: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null
  return () =>
    (promise ??= load().catch((error: unknown) => {
      promise = null
      throw error
    }))
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }

/** The profile a handle acts as, as the page is told it. */
const profileOf = (me: { profile: string | null; avatar?: string | null }): ProfileOption =>
  me.profile === null ? null : me.avatar ? { name: me.profile, avatar: me.avatar } : me.profile

/** A profile's name as the board keys it: lowercased, so `Factory` is the same actor as `factory`. */
const nameOf = (profile: ProfileOption): string | null => {
  if (profile === null) return null
  return (typeof profile === 'string' ? profile : profile.name).toLowerCase()
}

/** A write's `Origin` is this server's, as the request reached it. */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (origin === null) return false
  const host = URL.parse(origin)?.host
  return host !== undefined && (host === new URL(request.url).host || host === request.headers.get('host'))
}

const text = (status: number, body: string) => new Response(body, { status, headers: { ...HEADERS, 'content-type': 'text/plain; charset=utf-8' } })

const json = (status: number, body: unknown) => Response.json(body, { status, headers: HEADERS })
