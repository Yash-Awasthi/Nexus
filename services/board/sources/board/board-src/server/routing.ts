import { z } from 'zod'
import { routes } from '../api/routes.ts'
import type { Method } from '../api/protocol.ts'
import { ATTACHMENT_BYTES_MAX } from '../contract/schemas.ts'
import { VERSION } from '../version.ts'
import type { BackendRoute } from './backend.ts'
import { badRequest, HttpError } from './errors.ts'

/** board()'s own routes: the files it serves, and sync's, which run where board() does. */
export const BOARD_ROUTES = ['avatar', 'openapi', 'webhook', 'sync'] as const
export type BoardRoute = (typeof BOARD_ROUTES)[number]

/** What a request is for: one of board()'s own routes, a protocol method, or one of the backend's routes. */
export type Target = { kind: 'board'; name: BoardRoute } | { kind: 'protocol'; name: Method } | { kind: 'backend'; route: BackendRoute }

/** `params` by name, from the path's `:name` segments; `param` is the first, for a backend's own routes. */
export type Match = {
  target: Target
  base: string
  param: string | null
  params: Record<string, string>
  /** At the mount itself: discovery. Any unknown GET lands here too, so it teaches no mount. */
  root?: true
}

type Pattern = { method: string; pattern: RegExp; names: string[]; target: Target; segments: number; literals: number; own: boolean }

/** Every protocol method, by the route it's served at. */
export const METHODS: readonly Method[] = [
  'discovery', 'me', 'channels', 'createChannel', 'actors', 'channelMessages', 'threads', 'message', 'post', 'posted', 'edit', 'delete', 'react', 'label',
  'schedule', 'schedules', 'cancelSchedule',
  'tasks', 'createTask', 'createTasks', 'createdTasks', 'claimReadyTask', 'claimTask', 'renewTask', 'releaseTask', 'completeTask', 'failTask', 'blockTask', 'unblockTask', 'reopenTask', 'assignTask', 'setTaskNeeds', 'cancelTask',
  'grants', 'createGrant', 'createGrants', 'updateGrant', 'explain', 'revokeGrant', 'schemas', 'schema', 'createSchema', 'upload', 'attachment', 'uploadStart', 'uploadFinish', 'watchers', 'register', 'matches', 'ack', 'events',
  'syncImport', 'syncReceipt', 'syncThread', 'syncFind', 'syncCopies', 'inboxPush', 'inboxNext', 'inboxAck', 'inbox',
  'typing', 'readSource', 'joinSource', 'synced', 'linked',
]

/** The task methods: a backend that keeps no tasks answers each with 501 `no_tasks`. */
export const TASK_METHODS = METHODS.filter((name) => name === 'tasks' || name.includes('Task'))

const escape = (literal: string) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function compile(method: string, path: string, target: Target, own: boolean): Pattern {
  const parts = path.split('/').filter(Boolean)
  const source = parts.map((part) => (part.startsWith(':') ? '/([^/]+)' : `/${escape(part)}`)).join('')
  return {
    method,
    pattern: new RegExp(`${source}$`),
    names: parts.filter((part) => part.startsWith(':')).map((part) => part.slice(1)),
    target,
    segments: parts.length,
    literals: parts.filter((part) => !part.startsWith(':')).length,
    own,
  }
}

/**
 * The routes a board answers, most specific first: each is matched as a suffix of the request's
 * path, so `/api/board/messages/12` is `GET /messages/:id` under `/api/board`. A backend's own
 * route at a protocol path takes its place. Discovery is the mount itself.
 */
export function createRouter(backendRoutes: readonly BackendRoute[], basePath?: string) {
  const patterns: Pattern[] = [
    ...BOARD_ROUTES.map((name) => compile(routes[name].method, routes[name].path, { kind: 'board', name }, false)),
    ...METHODS.filter((name) => name !== 'discovery').map((name) => compile(routes[name].method, routes[name].path, { kind: 'protocol', name }, false)),
    ...backendRoutes.map((route) => compile(route.method, route.path, { kind: 'backend', route }, true)),
  ].sort((a, b) => b.segments - a.segments || b.literals - a.literals || Number(b.own) - Number(a.own))

  /** A segment that isn't URI-encoded names nothing: no route. */
  const found = (candidate: Pattern, base: string, values: string[]): Match | null => {
    const params: Record<string, string> = {}
    try {
      candidate.names.forEach((name, i) => (params[name] = decodeURIComponent(values[i]!)))
    } catch {
      return null
    }
    const first = candidate.names[0]
    return { target: candidate.target, base, param: first === undefined ? null : params[first]!, params }
  }
  const discovery = (base: string): Match => ({ target: { kind: 'protocol', name: 'discovery' }, base, param: null, params: {}, root: true })

  return function route(method: string, pathname: string): Match | null {
    const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
    if (basePath !== undefined) {
      const base = basePath.replace(/\/+$/, '')
      if (path !== base && !path.startsWith(`${base}/`)) return null
      const rest = path.slice(base.length) || '/'
      if (rest === '/') return method === 'GET' ? discovery(base) : null
      for (const candidate of patterns) {
        const hit = candidate.method === method ? rest.match(new RegExp(`^${candidate.pattern.source}`)) : null
        if (hit) return found(candidate, base, hit.slice(1))
      }
      return null
    }
    for (const candidate of patterns) {
      if (candidate.method !== method) continue
      const hit = path.match(candidate.pattern)
      if (hit) return found(candidate, path.slice(0, hit.index), hit.slice(1))
    }
    return method === 'GET' ? discovery(path === '/' ? '' : path) : null
  }
}

export function queryObject(url: URL): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key)
    out[key] = values.length > 1 ? values : values[0]!
  }
  return out
}

export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text()
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw badRequest('request body is not valid JSON')
  }
}

const tooLarge = () => new HttpError(413, 'too_large', `attachments are at most ${ATTACHMENT_BYTES_MAX / 1024 / 1024} MB`)

/** The body, refused as soon as it's past `max`: with or without a `content-length`, it never reads more. */
export async function readCapped(request: Request, max: number): Promise<Uint8Array> {
  if (Number(request.headers.get('content-length') ?? 0) > max) throw tooLarge()
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of request.body ?? []) {
    size += chunk.byteLength
    if (size > max) throw tooLarge()
    chunks.push(chunk)
  }
  const body = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    body.set(chunk, at)
    at += chunk.byteLength
  }
  return body
}

export function openapi() {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const [name, definition] of Object.entries(routes)) {
    const path = definition.path.replace(/:(\w+)/g, '{$1}')
    const operation: Record<string, unknown> = { operationId: name }
    if ('query' in definition) operation['x-query-schema'] = z.toJSONSchema(definition.query, { io: 'input' })
    if ('body' in definition)
      operation.requestBody = {
        content: { 'application/json': { schema: z.toJSONSchema(definition.body, { io: 'input' }) } },
      }
    ;(paths[path] ??= {})[definition.method.toLowerCase()] = operation
  }
  return { openapi: '3.1.0', info: { title: 'board', version: VERSION }, paths }
}
