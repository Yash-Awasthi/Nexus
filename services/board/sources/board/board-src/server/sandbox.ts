// A Vercel Sandbox network policy that hands one board, and nothing else, to a sandboxed agent: the
// sandbox's proxy adds the credential and who the agent is to its requests for the board, so neither
// enters the sandbox. The types are the parts of `@vercel/sandbox`'s `NetworkPolicy` it uses, so board
// doesn't depend on the SDK: what it returns is one, and `Sandbox.create({ networkPolicy })` takes it.

import { routes } from '../api/routes.ts'
import { canText, compileAccess, parseCan, type Can } from './access.ts'
import { DEFAULT_CAN } from './auth.ts'
import { HttpError } from './errors.ts'

/** How a rule matches a value: a regular expression (RE2), or the value exactly. */
export type SandboxMatcher = { regex: string } | { exact: string }

/** The requests a rule handles: every dimension it names must match. */
export type SandboxMatch = {
  path?: SandboxMatcher
  method?: string[]
  queryString?: { key: SandboxMatcher; value?: SandboxMatcher }[]
  headers?: { key: SandboxMatcher; value?: SandboxMatcher }[]
}

/** A rule for one host's requests, as Vercel Sandbox runs them: in order, and the first that matches handles a request. */
export type SandboxRule =
  | { match?: SandboxMatch; transform: { headers: Record<string, string> }[] }
  | { match?: SandboxMatch; response: { statusCode: number; body?: string; contentType?: string } }

/**
 * What a sandbox needs to reach the board: `allow`, its network policy's hosts as `@vercel/sandbox`'s
 * `NetworkPolicy` has them, each with its rules, and `env`, the environment `vb` in it runs with. A
 * host `allow` doesn't name is blocked, so a caller adds its own beside the board's:
 * `Sandbox.create({ networkPolicy: { allow: { ...allow, 'registry.npmjs.org': [] } }, env })`.
 */
export type SandboxPolicy = {
  allow: Record<string, SandboxRule[]>
  /**
   * `BOARD_URL`, the board's URL, and `BOARD_TOKEN`, a placeholder: `vb` sends a credential, and the
   * policy replaces it with the real one on the way out, so none enters the sandbox.
   */
  env: { BOARD_URL: string; BOARD_TOKEN: string }
}

/** What `vb` in a sandbox sends as its credential, for the policy's proxy to replace. */
export const SANDBOX_TOKEN = 'set-by-the-network-policy'

/** What `sandboxPolicy()` takes: who the agent writes as, what it may do, and the credential, all left in the policy. */
export type SandboxPolicyOptions = {
  /**
   * The profile its writes are by, with its avatar: `{ name: 'fixer', avatar: 'https://…' }`. Without one,
   * the handle's own, from `as()`. It needs one: a policy that set none would let the sandbox send its
   * own, and write as any profile of this deployment, its watchers' included.
   */
  profile?: { name: string; avatar?: string }
  /**
   * What it may do at most, as `x-board-can` narrows it: a `can` (`{ 'dev/': ['read', 'post'] }`) or its
   * header form (`dev/=read,post`). Without one, read, post, react, and label everywhere.
   */
  can?: Can | string
  /**
   * The credential its requests carry. Without one, this deployment's own Vercel OIDC token, for the
   * board's URL, which dies with the function's own: hand the sandbox a new policy before it does.
   */
  token?: string
}

/** A route a sandbox reaches: its method, and its path after the board's URL's, `:name` standing for a segment (`/messages/:id`). */
export type SandboxRoute = { method: string; path: string }

/**
 * How a sandbox reaches a board, from a backend: its URL, the headers its requests carry, the routes
 * under the board's path that carry them, every one by method and shape (the protocol's, or another
 * API's), and what else they ask: `GET`s outside the board's path (`reads`), and routes the same
 * board has under another path of its host (`under`), as an API that versions some of its routes does.
 */
export type SandboxReach = {
  url: string
  headers: Record<string, string>
  routes: readonly SandboxRoute[]
  reads?: readonly string[]
  under?: readonly { path: string; routes: readonly SandboxRoute[] }[]
}

/** What a backend gets to say how a sandbox reaches its board. */
export type SandboxInput = { profile: { name: string; avatar?: string }; can: string; token: string | undefined }

/** Outside Node there's no deployment credential to find: a sandbox's policy needs the one it's given. */
export const withoutToken = (url: string): never => {
  throw new HttpError(400, 'no_token', `There's no credential here to hand a sandbox for ${url}: pass one, sandboxPolicy({ token }).`, { origin: 'handle' })
}

/**
 * `x-board-can` for `can`, read here as the board reads it, so a bad one fails before the sandbox
 * does: any `Can` (`'all'`, a list for every channel, a map from pattern to grant, a grant's `'none'`
 * included), or a header's own text (`dev/=read,post`).
 */
export function canHeader(can: Can | string | undefined): string {
  if (typeof can === 'string' && can !== 'all') {
    parseCan(can)
    return can
  }
  const given: Can =
    can === undefined
      ? DEFAULT_CAN
      : can === 'all' || Array.isArray(can)
        ? can
        : (Object.fromEntries(Object.entries(can as Record<string, unknown>).map(([pattern, grant]) => [pattern, grant === 'none' ? [] : grant])) as Can)
  return canText(compileAccess(given))
}

/**
 * Routes under a board that the policy never adds the credential to: what hands out what outreaches
 * the policy (a grant, a watcher's registration, sync's records and a platform's events), and what a
 * platform or the board's own deployments call (webhooks, wake-ups), where the credential could speak
 * for them.
 */
const WITHHELD = ['grants', 'watchers', 'wake', 'webhooks', 'sync', 'inbox', 'sources']

const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `value` in any case, as a router that ignores case reads it: a regular expression without flags, as RE2 and JavaScript both take it. */
const caseless = (value: string) => [...value].map((char) => (/[a-z]/i.test(char) ? `[${char.toLowerCase()}${char.toUpperCase()}]` : escaped(char))).join('')

/** A path segment, percent-encoded as clients write them; the first rule refuses a dot segment and an encoded slash or dot. */
const SEGMENT = "(?:[A-Za-z0-9_.@~:+=,!$&'*-]|%[0-9A-Fa-f]{2})+"

/**
 * The protocol's routes a sandbox reaches: every route but those under a withheld segment. Each is
 * named whole, because a board mounted without a `basePath` matches a route as the end of a path, and
 * `/api/board/x/grants` would be its `/grants` under `/api/board/x`.
 */
export const PROTOCOL_ROUTES: readonly SandboxRoute[] = (Object.values(routes) as SandboxRoute[])
  .filter(({ path }) => !WITHHELD.includes(path.split('/').filter(Boolean)[0] ?? ''))
  .map(({ method, path }) => ({ method, path: path === '/' ? '' : path }))

/** `routes`' rules: one a method, its paths' shapes in one expression after `prefix`. */
function routeRules(prefix: string, routes: readonly SandboxRoute[], scoped: (match: SandboxMatch) => SandboxMatch, transform: { headers: Record<string, string> }[]): SandboxRule[] {
  const byMethod = new Map<string, string[]>()
  for (const { method, path } of routes) {
    const shape = path.split('/').filter(Boolean).map((part) => (part.startsWith(':') ? `/${SEGMENT}` : `/${escaped(part)}`)).join('')
    byMethod.set(method, [...(byMethod.get(method) ?? []), shape])
  }
  return [...byMethod].map(([method, shapes]) => ({ match: scoped({ method: [method], path: { regex: `^${prefix}(?:${shapes.join('|')})/?$` } }), transform }))
}

const refused = (why: string) => ({ response: { statusCode: 403, body: JSON.stringify({ error: { code: 'forbidden', message: why } }), contentType: 'application/json' } })

/**
 * The policy that hands the board `reach` names to a sandbox: its host, and on it only the board's
 * own routes, under its URL's path and with its query (`teamId`), each request carrying `reach`'s
 * headers. Anything else on the host is refused there; any other host, the sandbox doesn't reach.
 * Its `env` points `vb` in the sandbox at the board.
 */
export function boardPolicy(reach: SandboxReach): SandboxPolicy {
  const url = new URL(reach.url)
  const prefix = escaped(url.pathname.replace(/\/+$/, ''))
  const query = [...url.searchParams].map(([key, value]) => ({ key: { exact: key }, value: { exact: value } }))
  const scoped = (match: SandboxMatch): SandboxMatch => (query.length > 0 ? { ...match, queryString: query } : match)
  const transform = [{ headers: { ...reach.headers } }]
  return {
    allow: {
      [url.host]: [
        // A path a server could read as another, which no route of the board's is: a dot segment, an encoded slash or dot, a backslash.
        { match: { path: { regex: '(?:^|/)\\.\\.?(?:/|$)|%2[eEfF]|%5[cC]|\\\\' } }, ...refused('not a board route') },
        // Deployment Protection's own: a cookie that lets anyone past it, which the sandbox could carry off.
        { match: { queryString: [{ key: { regex: `^${caseless('x-vercel-set-bypass-cookie')}$` } }] }, ...refused('not a board route') },
        { match: { headers: [{ key: { exact: 'x-vercel-set-bypass-cookie' } }] }, ...refused('not a board route') },
        ...routeRules(prefix, reach.routes, scoped, transform),
        ...(reach.under ?? []).flatMap(({ path, routes }) => routeRules(escaped(path.replace(/\/+$/, '')), routes, scoped, transform)),
        ...(reach.reads ?? []).map((path) => ({ match: scoped({ path: { exact: path }, method: ['GET'] }), transform })),
        // Named apart for its answer, in any case, as a router that ignores case would read one.
        { match: { path: { regex: `^${prefix}/(?:${WITHHELD.map(caseless).join('|')})(?:/|$)` } }, ...refused("not a route this sandbox's policy hands it") },
        refused("not this board's"),
      ],
    },
    env: { BOARD_URL: reach.url, BOARD_TOKEN: SANDBOX_TOKEN },
  }
}
