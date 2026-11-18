import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { decodeJwt } from 'jose'
import { exchangeVercelOidcToken, getVercelOidcToken, getVercelToken } from '@vercel/oidc'
import type { Discovery } from '../api/routes.ts'
import { BoardError, type ProfileOption, type Resolvable } from './client.ts'

export const configDir = () =>
  join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'board')

/**
 * A Git checkout's root: `.git` is a directory with a `HEAD`, or a worktree's
 * `gitdir:` file. A stray empty `.git` (say, in `~` or `/tmp`) isn't one.
 */
function isCheckout(directory: string): boolean {
  const git = join(directory, '.git')
  try {
    if (statSync(git).isDirectory()) return existsSync(join(git, 'HEAD'))
    return readFileSync(git, 'utf8').startsWith('gitdir:')
  } catch {
    return false
  }
}

/** The project `cwd` is in: its Git checkout's root, or `cwd` outside one. */
export function projectDir(cwd = process.cwd()): string {
  let directory = resolve(cwd)
  while (true) {
    if (isCheckout(directory)) return directory
    const parent = dirname(directory)
    if (parent === directory) return resolve(cwd)
    directory = parent
  }
}

/**
 * The nearest Vercel project link (`.vercel/project.json`), searching up from the current
 * directory to a Git checkout's root. Null when there's none.
 */
export function vercelProjectFile(cwd = process.cwd()): string | null {
  let directory = resolve(cwd)
  while (true) {
    const file = join(directory, '.vercel', 'project.json')
    if (existsSync(file)) return file
    const parent = dirname(directory)
    if (isCheckout(directory) || parent === directory) return null
    directory = parent
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

const PROJECT_ID = /^prj_[A-Za-z0-9]{1,64}$/
/** A team's ID, or a personal account's, which owns a project too. */
const OWNER_ID = /^(?:team_)?[A-Za-z0-9]{1,64}$/
// An origin and a plain path, nothing a shell reads as anything else: `$(…)` and `;` can't be in one.
const URL_SHAPE = /^https?:\/\/[A-Za-z0-9.-]{1,253}(:\d{1,5})?(\/[A-Za-z0-9._~%/-]{0,2000})?$/

/**
 * A value a board said, as a message can show it: only when it's what it should be (a project
 * ID, a URL), since the handle's messages are trusted where a board's words aren't.
 */
const shown = (value: unknown, shape: RegExp): string | undefined => (typeof value === 'string' && shape.test(value) ? value : undefined)

/** Where `vb serve` leaves the token for the board it runs at `url`: only this user can read it. */
export function localTokenFile(url: string): string {
  const normalized = url.replace(/\/+$/, '')
  return join(configDir(), 'local', `${createHash('sha256').update(normalized).digest('hex').slice(0, 32)}.json`)
}

/** The token a local board on this machine left for you, if `url` is one. */
function localToken(url: string): { token: string } | null {
  try {
    if (!LOOPBACK.has(new URL(url).hostname)) return null
    const saved = JSON.parse(readFileSync(localTokenFile(url), 'utf8')) as { url?: string; token?: string }
    if (saved.url !== url.replace(/\/+$/, '') || typeof saved.token !== 'string') return null
    return { token: saved.token }
  } catch {
    return null
  }
}

/** When `token` expires, in milliseconds: its `exp`, or five minutes from now for one that says none. */
export const expiry = (token: string): number => {
  try {
    const { exp } = decodeJwt(token)
    return exp ? exp * 1000 : Date.now() + 5 * 60_000
  } catch {
    return Date.now() + 5 * 60_000
  }
}

type Cached = { token: string; expiresAt: number }

/**
 * Where `audience`'s token is cached: one per board, and with a login a CLI hands over, one per
 * login too, since it can be someone else's than `vercel login`'s.
 */
const cacheFile = (audience: string, login: string | null) => {
  const key = login ? `${audience}\n${login}` : audience
  return join(configDir(), 'tokens', `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`)
}

async function readCache(audience: string, login: string | null): Promise<Cached | null> {
  try {
    const cached = JSON.parse(await readFile(cacheFile(audience, login), 'utf8')) as Cached
    return cached.expiresAt - 5 * 60_000 > Date.now() ? cached : null
  } catch {
    return null
  }
}

async function writeCache(audience: string, login: string | null, cached: Cached) {
  const tokens = join(configDir(), 'tokens')
  await mkdir(tokens, { recursive: true, mode: 0o700 })
  await writeFile(cacheFile(audience, login), JSON.stringify(cached), { mode: 0o600 })
  // A login that rotates leaves a file per access token: a day on, its token for the board is dead.
  const dead = Date.now() - 24 * 60 * 60_000
  for (const name of await readdir(tokens).catch(() => [])) {
    const file = join(tokens, name)
    const written = (await stat(file).catch(() => null))?.mtimeMs
    if (written !== undefined && written < dead) await unlink(file).catch(() => {})
  }
}

/** The login a CLI that runs board's hands it to ask for (`vercel board`'s), while one does. */
let handed: (() => Promise<string>) | null = null

/**
 * Hands board a login to ask for when a request needs one, as `vercel board` does with its own:
 * nothing asks for it before then, so help, a typo, or misuse never refreshes or prompts. It's the
 * login that goes, wherever the app runs (`appLogin`). Null takes it back.
 */
export function handLogin(login: (() => Promise<string>) | null) {
  handed = login
}

/** The fetch a CLI that runs board's hands it for Vercel's API (`vercel board`'s), while one does. */
let handedFetch: typeof fetch | null = null

/**
 * Hands board the fetch that sends its requests to Vercel's API with the login it's handed, adding
 * that login's credentials itself, as `vercel board` does: a DPoP login's proof is signed for each
 * request's method and URL, so a token alone can't make one. Null takes it back.
 */
export function handFetch(send: typeof fetch | null) {
  handedFetch = send
}

/**
 * A request to Vercel's API as you: through the fetch the CLI that runs board's hands it with its
 * login, which adds its credentials, or with `login` as a Bearer token, through `send`. A token
 * the run was passed goes as a Bearer token always: the app's fetch would add its own login's.
 */
export function asYou(input: RequestInfo | URL, init: RequestInit, login: string, send: typeof fetch = fetch): Promise<Response> {
  if (passed === null && handedFetch && loginHanded()) return handedFetch(input, init)
  // In `init`, where the redirect guard looks for it to drop it across origins, with a `Request`'s own.
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init.headers).forEach((value, name) => headers.set(name, value))
  headers.set('authorization', `Bearer ${login}`)
  return send(input, { ...init, headers })
}

/** The token someone passed the CLI that runs board's for this run (`vercel board --token`), while there is one. */
let passed: string | null = null

/** Where `vb whoami` says a passed token came from. */
export const PASSED = 'the token you passed'

/**
 * Hands board the token someone passed the CLI that runs it, as `vercel board --token` does: the
 * Vercel login for this run, ahead of everything the environment holds, a deployment's own token
 * and `BOARD_TOKEN` included. Whoever passed it said who to be, which no variable does. Board
 * sends it itself, as a Bearer token, never through a handed fetch. Null takes it back.
 */
export function handToken(token: string | null) {
  passed = token
}

/** The token this run was passed, or null. */
export const passedToken = () => passed

/** Whether the login is one a CLI handed over (`createApp`'s `token` or `login`, or `VERCEL_AUTH_TOKEN`). */
export const loginHanded = () => passed !== null || handed !== null || !!process.env.VERCEL_AUTH_TOKEN

/**
 * Whether the app that runs board's CLI in its own process gave it a login (`createApp`'s `token`
 * or `login`). The app says who its commands run as, so that login is the one that goes, wherever
 * the app runs: nothing the environment holds stands in for it, a deployment's own token and
 * `BOARD_TOKEN` included. A variable isn't the app's word (`VERCEL_AUTH_TOKEN`): anything sets one.
 */
export const appLogin = () => passed !== null || handed !== null

/**
 * Your Vercel login: what the CLI that runs board's hands it, as `vercel board` does (the token
 * it was passed, its `login`, or `VERCEL_AUTH_TOKEN`), or else what `vercel login` saved.
 */
export const vercelLogin = () =>
  passed !== null ? Promise.resolve(passed) : handed ? handed() : process.env.VERCEL_AUTH_TOKEN ? Promise.resolve(process.env.VERCEL_AUTH_TOKEN) : getVercelToken()

/**
 * A handed login's token, which its tokens for boards are cached by: null for `vercel login`'s own. One
 * that fails fails the request: `vercel login`'s, cached or in the `vercel` on PATH, can be someone
 * else's.
 */
async function handedToken(): Promise<string | null> {
  if (!loginHanded()) return null
  try {
    return await vercelLogin()
  } catch {
    throw new BoardError('not_logged_in', "You're not logged in to Vercel.", 0, { hint: 'Run vercel login.' })
  }
}

/** The login to call Vercel's API with: a handed one, or `vercel login`'s, or none it can read (the keychain's). */
const apiLogin = async (handed: string | null) => handed ?? (await getVercelToken().catch(() => null))

/**
 * A person's token: their Vercel CLI login mints a development token for the
 * project the board's host is a deployment of, exchanged so its audience is the
 * board's URL. Cached on disk for its 12-hour life. For a board whose discovery
 * names a project: one that names none has no token for a login to mint.
 */
async function personToken(audience: string, discovery: Discovery): Promise<Cached> {
  const login = await handedToken()
  const cached = await readCache(audience, login)
  if (cached) return cached

  const authToken = await apiLogin(login)
  const project = await boardProject(audience, discovery, authToken)
  let development: string
  try {
    if (!authToken) throw new Error('no Vercel CLI credentials file')
    const response = await asYou(
      `https://api.vercel.com/v1/projects/${project.id}/token?source=board${project.team ? `&teamId=${project.team}` : ''}`,
      { method: 'POST' },
      authToken,
    )
    if (response.status === 403 || response.status === 404)
      throw new BoardError(
        'no_access',
        "Your Vercel account can't access this board's project.",
        response.status,
        { hint: "Ask someone on the project's team for access to it." },
      )
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    development = ((await response.json()) as { token: string }).token
  } catch (error) {
    // The `vercel` on PATH mints as `vercel login`'s account, not a handed login's.
    if (error instanceof BoardError || login) throw error
    development = await tokenFromVercelCli(project)
  }

  const token = await exchangeVercelOidcToken({ token: development, audience })
  const fresh: Cached = { token, expiresAt: expiry(token) }
  await writeCache(audience, login, fresh).catch(() => {})
  return fresh
}

/**
 * The project to mint a person's token for: the one Vercel, asked with your own
 * login, says the board's host is a deployment of (its deployment URL, a branch
 * alias, or a domain), found as `vercel curl` finds it. Discovery names a project
 * too, but any board can name any project you can access, and a token for one it
 * isn't could be replayed where that project is trusted, so the two must agree.
 * Vercel knows no loopback host: a board there runs on your machine (`next dev`).
 */
async function boardProject(url: string, discovery: Discovery, authToken: string | null): Promise<{ id: string; team: string | null }> {
  const { host, hostname } = new URL(url)
  if (LOOPBACK.has(hostname)) {
    // A board on this machine names its own project: Vercel has no host to check it against. What it
    // names goes into a request to Vercel's API as you, so it's taken only when it's an ID and nothing more.
    const id = shown(discovery.project_id, PROJECT_ID)
    const team = discovery.team_id == null ? null : shown(discovery.team_id, OWNER_ID)
    if (!id || team === undefined)
      throw new BoardError('wrong_project', `The board at ${url} names a project or team that isn't a Vercel ID, so no token is minted for it.`, 0)
    return { id, team }
  }
  const api: VercelApi = authToken
    ? async (method, path) => {
        const response = await asYou(`https://api.vercel.com${path}`, { method }, authToken)
        return response.ok ? await response.json() : null
      }
    : vercelCliApi
  const found = await findProject(api, host)
  if (!found)
    throw new BoardError('no_access', `Your Vercel login can't see the project ${host} belongs to.`, 0, {
      hint: "Log in as someone on the project's team (vercel login), or ask for access to it.",
    })
  if (found.projectId !== discovery.project_id)
    throw new BoardError(
      'wrong_project',
      `The board at ${url} says its project is ${shown(discovery.project_id, PROJECT_ID) ?? 'another one'}, but it's a deployment of ${found.projectId}, so no token is minted for it.`,
      0,
    )
  return { id: found.projectId, team: found.ownerId.startsWith('team_') ? found.ownerId : null }
}

/** When credentials live in the keychain, the Vercel CLI mints the token itself. */
async function tokenFromVercelCli(project: { id: string; team: string | null }): Promise<string> {
  const args = ['project', 'token', project.id, '--format=json']
  if (project.team) args.push('--scope', project.team)
  try {
    const { stdout } = await promisify(execFile)('vercel', args, { timeout: 30_000 })
    return (JSON.parse(stdout) as { token: string }).token
  } catch {
    throw new BoardError('not_logged_in', "You're not logged in to Vercel.", 0, { hint: 'Run vercel login.' })
  }
}

/** Whether this is a GitHub Actions job that may ask GitHub for an OIDC token (`permissions: id-token: write`). */
export const inGithubActions = () => !!process.env.ACTIONS_ID_TOKEN_REQUEST_URL && !!process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN

/** The job's GitHub Actions OIDC token, made out to `audience`. */
export async function githubActionsToken(audience: string): Promise<string> {
  const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL!)
  url.searchParams.set('audience', audience)
  const response = await fetch(url, {
    headers: { authorization: `bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  })
  if (!response.ok)
    throw new BoardError(
      'no_token',
      `GitHub Actions refused an OIDC token (${response.status}).`,
      0,
      { hint: 'Give the job `permissions: id-token: write`.' },
    )
  return ((await response.json()) as { value: string }).value
}

/** The board the environment points at: `BOARD_URL`. */
export function boardUrl(): string {
  const url = process.env.BOARD_URL?.replace(/\/+$/, '')
  if (!url) throw new BoardError('no_board', "There's no board URL: BOARD_URL isn't set.", 0, { hint: 'Set BOARD_URL, or pass the URL to http().' })
  return url
}

/** How `vb` reaches a board from Node: a fetch that carries your credentials, and who it found you are. */
export type NodeTransport = {
  /** Every request to the board, through Deployment Protection, with a token for it (all but discovery). */
  fetch: typeof fetch
  /** Where the token came from, in words, once one was minted: `vercel login`, `BOARD_TOKEN`, … */
  source(): string | null
}

/**
 * How a client reaches the board at `url` from Node: through Deployment Protection, with a token
 * from `token`, the login of an app that runs board's CLI (`appLogin`), `BOARD_TOKEN`, a local
 * board's token file (`vb serve`), GitHub Actions, the Vercel runtime, or your Vercel CLI login,
 * in that order. Who you are is the token's to say: the board
 * names you from what it verifies. A board with no Vercel project has no token for your login to
 * mint, so a request goes to it with none: what verifies its callers may know you another way, as
 * a board behind `tailscale serve` does.
 */
export function connect(
  url: string,
  options: { token?: Resolvable<string> | undefined; fetch?: typeof fetch | undefined } = {},
): NodeTransport {
  url = url.replace(/\/+$/, '')
  const doFetch = guarded(url, options.fetch ?? ((input, init) => globalThis.fetch(input, init)), options.token)
  // Every token is for `url`, the board it's sent to. A board whose discovery claims another
  // audience gets none, so its answer can't get us to mint one it could replay.
  let discovery: Promise<Discovery> | undefined
  const discover = () =>
    (discovery ??= doFetch(url).then(async (response) => {
      if (!response.ok) throw new BoardError('no_board', `There's no board at ${url}: it answered ${response.status}.`, response.status)
      const found = (await response.json()) as Discovery
      if (found.audience !== url)
        throw new BoardError('wrong_audience', `The board at ${url} says its URL is ${shown(found.audience, URL_SHAPE) ?? 'another one'}.`, 0, {
          hint: shown(found.audience, URL_SHAPE) ? `Use ${found.audience}.` : 'Use the URL its discovery names.',
        })
      return found
    }).catch((error: unknown) => {
      // A failed discovery isn't kept: the next token asks again.
      discovery = undefined
      throw error
    }))

  /** A token to send, or null for a board there's none to mint for: its requests go without one. */
  type Minted = { token: string | null; expiresAt: number }
  let cached: Minted | null = null
  let source: string | null = null
  let person: Promise<Cached> | null = null
  /** A token minted with your Vercel login, which `from` names. */
  const asPerson = async (discovered: Discovery, from: string): Promise<Minted> => {
    person ??= personToken(url, discovered).finally(() => {
      person = null
    })
    const minted = await person
    source = from
    return minted
  }
  // `source` says which of these it picked, for `vb whoami`.
  const mint = async (): Promise<Minted> => {
    if (options.token !== undefined) {
      const token = typeof options.token === 'function' ? await options.token() : options.token
      return { token, expiresAt: expiry(token) }
    }
    // The login of an app that runs board's CLI (a token it was passed, or its own) is a Vercel
    // login, never the board's: it mints one, ahead of what the environment holds. A board with no
    // Vercel project has none for it to mint.
    if (appLogin()) {
      const discovered = await discover()
      if (discovered.project_id) return asPerson(discovered, passed !== null ? PASSED : 'vercel login')
    }
    if (process.env.BOARD_TOKEN) {
      const token = process.env.BOARD_TOKEN
      source = 'BOARD_TOKEN'
      return { token, expiresAt: expiry(token) }
    }
    const local = localToken(url)
    if (local) {
      source = 'vb serve'
      return { token: local.token, expiresAt: expiry(local.token) }
    }
    const discovered = await discover()
    if (inGithubActions()) {
      const token = await githubActionsToken(url)
      source = 'GitHub Actions OIDC'
      return { token, expiresAt: expiry(token) }
    }
    if (process.env.VERCEL === '1') {
      const token = await hostedToken(url)
      source = 'Vercel OIDC'
      return { token, expiresAt: expiry(token) }
    }
    // No project, no token a login could mint: the request goes as it is, for the board to say whose it is.
    if (!discovered.project_id) return { token: null, expiresAt: Date.now() + 5 * 60_000 }
    return asPerson(discovered, 'vercel login')
  }
  const token = async () => {
    // One handed over is asked again each time: a function returns a fresh one.
    if (options.token !== undefined || !cached || cached.expiresAt - 60_000 < Date.now()) cached = await mint()
    return cached.token
  }

  const send = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const href = input instanceof Request ? input.url : String(input)
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const path = (href.startsWith(url) ? href.slice(url.length) : new URL(href).pathname).split('?')[0] || '/'
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
    // Discovery is public: it's what a token is minted from.
    let bare = false
    if (!(method === 'GET' && path === '/') && !headers.has('authorization')) {
      const credential = await token()
      if (credential !== null) headers.set('authorization', `Bearer ${credential}`)
      else bare = true
    }
    const response = await doFetch(input, { ...init, headers })
    // It went with no token, and the board took it for no one's.
    if (bare && response.status === 401) {
      await response.body?.cancel().catch(() => {})
      throw new BoardError('no_project', `The board at ${url} has no Vercel project to mint you a token for, and doesn't know who you are without one.`, 0, {
        hint: 'Pass a token it accepts in BOARD_TOKEN.',
      })
    }
    return response
  }) as typeof fetch

  return { fetch: send, source: () => source }
}

/**
 * The profile the environment names: `BOARD_PROFILE`, with `BOARD_AVATAR`. Nothing else picks one, a coding
 * agent included: without it, you write as yourself.
 */
export function environmentProfile(): ProfileOption {
  const name = process.env.BOARD_PROFILE
  const avatar = process.env.BOARD_AVATAR
  return name ? (avatar ? { name, avatar } : name) : null
}

const WHERE = 'Project → Settings → Deployment Protection → Protection Bypass for Automation'

class Wall extends Error {
  readonly status: number
  constructor(status: number) {
    super('protected')
    this.status = status
  }
}

/**
 * A wall reached after a redirect to another origin, which none of a request's credentials follow,
 * by design: no bypass or token gets through it from here, so none is looked for.
 */
class Moved extends Error {
  readonly origin: string
  readonly status: number
  constructor(origin: string, status: number) {
    super('moved')
    this.origin = origin
    this.status = status
  }
}

/**
 * This deployment's Vercel OIDC token, with `url` as its audience: what a hosted client sends a
 * board, for Deployment Protection's Trusted Sources. Its `cause` says why it couldn't.
 */
async function hostedToken(url: string): Promise<string> {
  try {
    return await getVercelOidcToken({ audience: url })
  } catch (cause) {
    throw Object.assign(
      new BoardError('no_token', `This deployment can't get a Vercel OIDC token for ${url}.`, 0, {
        hint: "Enable OIDC on its project, or pass a token (BOARD_TOKEN), and add its project to the board project's Deployment Protection Trusted Sources.",
      }),
      { cause },
    )
  }
}

/** A host this deployment answers on, as Vercel's system variables name them (bare hosts). */
const ownHost = (host: string) =>
  [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL]
    .some((own) => !!own && own.toLowerCase() === host.toLowerCase())

/**
 * What a sandbox's requests to the board at `url` carry, from this deployment: `token`, or this
 * deployment's own Vercel OIDC token, for `audience` (the board's URL; null for Vercel's API, which
 * takes it as it is), and on a board behind Deployment Protection what a hosted client sends to get
 * through it: this deployment's bypass secret on its own hosts, or else its OIDC token for Trusted
 * Sources. Never a person's login or `VERCEL_TOKEN`: what a policy holds, its sandbox can use.
 */
export async function sandboxHeaders(url: string, audience: string | null, token?: string): Promise<Record<string, string>> {
  const oidc = async () => {
    try {
      return await getVercelOidcToken(audience === null ? undefined : { audience })
    } catch (cause) {
      throw Object.assign(
        new BoardError('no_token', `There's no Vercel OIDC token here to hand a sandbox for ${url}.`, 0, {
          hint: 'Run it in a Vercel deployment with OIDC, or pass the credential: sandboxPolicy({ token }).',
        }),
        { cause },
      )
    }
  }
  const credential = token ?? (await oidc())
  const headers: Record<string, string> = { authorization: `Bearer ${credential}` }
  if (audience === null) return headers
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
  if (bypass && (process.env.VERCEL !== '1' || ownHost(new URL(url).host))) headers['x-vercel-protection-bypass'] = bypass
  else if (process.env.VERCEL === '1') headers['x-vercel-trusted-oidc-idp-token'] = credential
  return headers
}

/** Explicit bypass wins; otherwise hosted calls use OIDC and local people use their saved bypass. */
function guarded(url: string, doFetch: typeof fetch, suppliedToken?: Resolvable<string>): typeof fetch {
  const host = new URL(url).host
  let secret: Promise<string | null> | undefined
  let looked: Promise<{ secret: string; created: boolean }> | undefined
  // On Vercel, a rejected VERCEL_AUTOMATION_BYPASS_SECRET isn't sent again: OIDC follows.
  let envRejected = false
  // A board that moved to another origin says where, instead of that its bypass didn't get through.
  return (input, init) =>
    attempt(input, init).catch((error: unknown) => {
      if (!(error instanceof Moved)) throw error
      const there = shown(`${error.origin}${new URL(url).pathname}`, URL_SHAPE)
      throw new BoardError(
        'redirected',
        `${url} redirects to ${there ? new URL(there).origin : 'another origin'}, and its credentials don't follow it there, so Deployment Protection turns it away.`,
        error.status,
        { hint: there ? `Use ${there}.` : 'Use the URL it redirects to.' },
      )
    })
  async function attempt(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
    init = { ...init, headers }
    // An explicit bypass secret still wins: it's what `vercel env pull` setups used before
    // Trusted Sources. On Vercel it's a system variable, the deployment's own project's secret,
    // so it never leaves its own hosts: another project's board gets OIDC, not a key to this one.
    const fromEnv = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
    if (fromEnv && !envRejected && (process.env.VERCEL !== '1' || ownHost(host))) {
      try {
        return await through(doFetch, input, init, fromEnv)
      } catch (error) {
        if (!(error instanceof Wall)) throw error
        // Hosted, try the board's trust in this project instead.
        if (process.env.VERCEL !== '1')
          throw new BoardError('protected', `${url} is behind Vercel Deployment Protection, and it rejected VERCEL_AUTOMATION_BYPASS_SECRET.`, error.status, {
            hint: `Check VERCEL_AUTOMATION_BYPASS_SECRET against ${WHERE}.`,
          })
        envRejected = true
      }
    }
    // Without one, hosted workloads use project trust, never a person's saved bypass credentials.
    if (process.env.VERCEL === '1') {
      if (!headers.has('x-vercel-trusted-oidc-idp-token')) {
        const bearer = headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1]
        const token = bearer ?? (typeof suppliedToken === 'function' ? await suppliedToken() : suppliedToken)
          ?? (process.env.BOARD_TOKEN || await hostedToken(url))
        headers.set('x-vercel-trusted-oidc-idp-token', token)
      }
      return through(doFetch, input, init, null).catch((error) => {
        if (!(error instanceof Wall)) throw error
        throw new BoardError('protected', `${url} is behind Vercel Deployment Protection, and it rejected this deployment's Vercel OIDC token.`, error.status, {
          hint: "Add this project and environment to the board project's Deployment Protection Trusted Sources.",
        })
      })
    }
    const used = await (secret ??= readBypass(host))
    try {
      return await through(doFetch, input, init, used)
    } catch (error) {
      if (!(error instanceof Wall)) throw error
    }
    // The cached secret (or none) didn't get through: ask Vercel, once per client.
    looked ??= projectBypass(url, host, doFetch).then(
      async (found) => {
        await writeBypass(host, found.secret).catch(() => {})
        return found
      },
      (error: unknown) => {
        // A failed lookup isn't kept: the next request asks Vercel again.
        looked = undefined
        throw error
      },
    )
    const { secret: found, created } = await looked
    secret = Promise.resolve(found)
    try {
      return await through(doFetch, input, init, found).catch(async (error) => {
        if (!(error instanceof Wall) || !created) throw error
        // Like `vercel curl`: a new secret takes a moment to reach the edge.
        await new Promise((resolve) => setTimeout(resolve, 1000))
        return through(doFetch, input, init, found)
      })
    } catch (error) {
      throw error instanceof Wall
        ? new BoardError('protected', `${url} is behind Vercel Deployment Protection, and its project's automation bypass didn't get through.`, error.status, {
            hint: `Set VERCEL_AUTOMATION_BYPASS_SECRET (${WHERE}).`,
          })
        : error
    }
  }
}

/**
 * One request that recognizes the wall: a redirect to `/sso-api`, an HTML
 * page where the board answers JSON (on SAML teams, the redirects end at the
 * IdP's login page with a 200), or Vercel's own 401 (`x-vercel-error`, which
 * Vercel Connect passport answers a fetch with). Only a 2xx, 401, or 403 HTML
 * page counts, so a 404 page keeps its own error; attachments, which may be
 * HTML, come with a `content-disposition`. Other redirects of a GET or HEAD
 * are followed as fetch would, dropping the token and bypass secret on the way
 * to another origin; a redirected POST comes back as its 3xx.
 */
async function through(doFetch: typeof fetch, input: RequestInfo | URL, init: RequestInit, bypass: string | null): Promise<Response> {
  let target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  let headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
  if (bypass) headers.set('x-vercel-protection-bypass', bypass)
  // The last origin it was redirected to, once it left its own: a wall there is one no credential crosses.
  let moved: string | null = null
  const wall = (status: number) => (moved ? new Moved(moved, status) : new Wall(status))
  for (let hops = 0; ; hops++) {
    const response = await doFetch(hops === 0 ? input : target, { ...init, headers, redirect: 'manual' })
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
    if (location) {
      const next = new URL(location, target)
      if (next.pathname.startsWith('/sso-api')) throw wall(response.status)
      if (method === 'GET' || method === 'HEAD') {
        if (hops >= 20) throw new BoardError('too_many_redirects', `${target} redirected more than 20 times.`, response.status)
        if (next.origin !== new URL(target).origin) {
          moved = next.origin
          headers = new Headers(headers)
          headers.delete('authorization')
          headers.delete('x-vercel-trusted-oidc-idp-token')
          headers.delete('x-vercel-protection-bypass')
        }
        target = next.href
        continue
      }
    }
    const { status } = response
    const page = /^text\/html\b/i.test(response.headers.get('content-type') ?? '') && !response.headers.has('content-disposition')
    if (page && ((status >= 200 && status < 300) || status === 401 || status === 403)) throw wall(status)
    // The board's own 401 has no `x-vercel-error`: Vercel sets it only on errors it answers itself.
    if (status === 401 && response.headers.has('x-vercel-error')) throw wall(status)
    return response
  }
}

const bypassFile = (host: string) =>
  join(configDir(), 'bypass', `${createHash('sha256').update(host).digest('hex').slice(0, 32)}.json`)

async function readBypass(host: string): Promise<string | null> {
  try {
    return (JSON.parse(await readFile(bypassFile(host), 'utf8')) as { secret?: string }).secret || null
  } catch {
    return null
  }
}

async function writeBypass(host: string, secret: string) {
  await mkdir(join(configDir(), 'bypass'), { recursive: true, mode: 0o700 })
  await writeFile(bypassFile(host), JSON.stringify({ host, secret }), { mode: 0o600 })
}

type Bypasses = Record<string, { scope?: string }> | undefined
const automationBypass = (bypasses: Bypasses) =>
  Object.entries(bypasses ?? {}).find(([, value]) => value.scope === 'automation-bypass')?.[0] ?? null

type VercelApi = (method: 'GET' | 'PATCH', path: string) => Promise<unknown>

/**
 * The board's project's automation bypass secret, as `vercel curl` finds it:
 * the deployment (or alias) behind the host gives the project, whose
 * `protectionBypass` has it. When there's none, it's created.
 */
async function projectBypass(url: string, host: string, doFetch: typeof fetch): Promise<{ secret: string; created: boolean }> {
  const blocked = (why: string, fix: string) =>
    new BoardError('protected', `${url} is behind Vercel Deployment Protection, and your Vercel login ${why}.`, 0, {
      hint: `${fix}, or set VERCEL_AUTOMATION_BYPASS_SECRET (${WHERE}).`,
    })
  const token = await apiLogin(await handedToken())
  const api: VercelApi = token
    ? async (method, path) => {
        const response = await asYou(
          `https://api.vercel.com${path}`,
          { method, ...(method === 'PATCH' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) },
          token,
          doFetch,
        )
        return response.ok ? await response.json() : null
      }
    : vercelCliApi

  const project = await findProject(api, host)
  if (!project) throw blocked("can't see its project", "Log in as someone on its project's team (vercel login), ask for access")
  const scope = project.ownerId.startsWith('team_') ? `?teamId=${project.ownerId}` : ''
  const details = (await api('GET', `/v9/projects/${project.projectId}${scope}`)) as {
    name?: string
    protectionBypass?: Bypasses
    ssoProtection?: unknown
    passwordProtection?: unknown
    passport?: unknown
  } | null
  // Without the project's settings, creating could add a second bypass.
  if (!details) throw blocked("can't read its project's settings", 'Ask for access to its project')
  const existing = automationBypass(details.protectionBypass)
  if (existing) return { secret: existing, created: false }
  // An HTML page from an unprotected project isn't a wall: it isn't a board, so nothing gets created.
  if (!details.ssoProtection && !details.passwordProtection && !details.passport)
    throw new BoardError('no_board', `There's no board at ${url}: it answered with a web page, and its Vercel project isn't protected.`, 0)
  const created = (await api('PATCH', `/v1/projects/${project.projectId}/protection-bypass${scope}`)) as { protectionBypass?: Bypasses } | null
  const secret = automationBypass(created?.protectionBypass)
  if (!secret) throw blocked("can't read or create its project's automation bypass", 'Ask a project admin to create one')
  process.stderr.write(`created a Protection Bypass for Automation on the Vercel project ${details?.name ?? project.projectId}\n`)
  return { secret, created: true }
}

/** The project behind a host, as `vercel curl` finds it: the deployment, then the alias, in your own scope and then each of your teams. */
async function findProject(api: VercelApi, host: string): Promise<{ projectId: string; ownerId: string } | null> {
  type Found = { projectId?: string; ownerId?: string; team?: { id?: string } } | null
  const lookup = async (kind: 'deployment' | 'alias', team: string | null) => {
    const path = kind === 'deployment' ? `/v13/deployments/${encodeURIComponent(host)}` : `/now/aliases/${encodeURIComponent(host)}`
    const found = (await api('GET', `${path}${team ? `?teamId=${team}` : ''}`).catch(() => null)) as Found
    const owner = found?.ownerId ?? found?.team?.id ?? team
    return found?.projectId && owner ? { projectId: found.projectId, ownerId: owner } : null
  }
  const own = (await lookup('deployment', null)) ?? (await lookup('alias', null))
  if (own) return own
  const { teams } = ((await api('GET', '/v2/teams?limit=100').catch(() => null)) ?? {}) as { teams?: { id: string; limited?: boolean }[] }
  const ids = (teams ?? []).filter((team) => !team.limited).map((team) => team.id)
  for (const kind of ['deployment', 'alias'] as const) {
    // A few at a time: with keychain credentials each lookup is a `vercel` process.
    for (let i = 0; i < ids.length; i += 8) {
      const found = (await Promise.all(ids.slice(i, i + 8).map((id) => lookup(kind, id)))).find(Boolean)
      if (found) return found
    }
  }
  return null
}

/** When credentials live in the keychain, the Vercel CLI makes the API call itself. */
let vercelCli: Promise<boolean> | undefined
const vercelCliApi: VercelApi = async (method, path) => {
  // Signed out, `vercel` starts a login flow and waits: check once, quickly, before any call.
  vercelCli ??= promisify(execFile)('vercel', ['whoami', '--non-interactive'], { timeout: 10_000 }).then(
    () => true,
    () => false,
  )
  if (!(await vercelCli)) throw new BoardError('not_logged_in', "You're not logged in to Vercel.", 0, { hint: 'Run vercel login.' })
  const args = ['api', path, '-X', method, '--raw', '--non-interactive']
  if (method === 'PATCH') args.push('--input', '-')
  try {
    const run = promisify(execFile)('vercel', args, { timeout: 30_000 })
    // A `vercel` that exits before it reads its input closes the pipe: its exit is the answer, and the
    // EPIPE, unhandled, would take the process down.
    run.child.stdin?.on('error', () => {})
    run.child.stdin?.end(method === 'PATCH' ? '{}' : '')
    return JSON.parse((await run).stdout)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new BoardError('not_logged_in', "You're not logged in to Vercel.", 0, { hint: 'Run vercel login.' })
    return null
  }
}
