// Your team's board in Vercel's API, internal: board()'s default backend, and the CLI's. In Node, it finds credentials the way
// a deployment and the Vercel CLI do: the deployment's OIDC token, or else `BOARD_TOKEN`, `VERCEL_AUTH_TOKEN`, a GitHub
// Actions job's OIDC token, or your `vercel login`. Never `VERCEL_TOKEN`, a name people set for other reasons, and nothing in the environment replaces a
// deployment's own token: only the login of an app that runs board's CLI goes ahead of it, since the app says who its commands run as.
import { readFile } from 'node:fs/promises'
import { getVercelOidcToken, getVercelToken } from '@vercel/oidc'
import { decodeJwt } from 'jose'
import { BoardError } from '../client/client.ts'
import { appLogin, asYou, environmentProfile, expiry, githubActionsToken, inGithubActions, loginHanded, PASSED, passedToken, sandboxHeaders, vercelLogin, vercelProjectFile } from '../client/node.ts'
import { createVercel, type VercelBackend, type VercelEnvironment, type VercelOptions } from '../server/backend-vercel.ts'
import { HttpError } from '../server/errors.ts'

/**
 * Whether this deployment's own token is what goes: on Vercel, or with its OIDC token pulled
 * (`vercel env pull`), a deployment acts as its project. Never under an app that runs board's CLI
 * with a login of its own: that login goes.
 */
const asDeployment = () => !appLogin() && (process.env.VERCEL === '1' || !!process.env.VERCEL_OIDC_TOKEN)

/** Off a deployment, a credential Vercel's API takes, set for board: what a sandbox or CI passes. Not ahead of an app's login either. */
const boardToken = () => (appLogin() || asDeployment() ? null : process.env.BOARD_TOKEN || null)

/**
 * Whether a GitHub Actions job's own OIDC token goes: in a job that may ask for one, with nothing above to send.
 * A `VERCEL_AUTH_TOKEN` the workflow sets goes ahead of it: `id-token: write` is often there for something else.
 */
const asGithubActions = () => !appLogin() && !asDeployment() && !boardToken() && !process.env.VERCEL_AUTH_TOKEN && inGithubActions()

/** Whether what goes is a Vercel login: an app's, or with nothing else to send, yours. */
const asLogin = () => !asDeployment() && !boardToken() && !asGithubActions()

/** The audience a GitHub Actions token for Vercel's board is made out to, whichever board it names. */
const GITHUB_AUDIENCE = 'https://api.vercel.com/v1/messageboard'

/** Where that token may go: its audience's origin, or a test's own API on this machine, never anywhere else. */
const githubTokenGoesTo = (url: URL) => url.origin === new URL(GITHUB_AUDIENCE).origin || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url.origin)

/** The job's GitHub Actions token, kept until a minute before it expires: GitHub mints one each time it's asked. */
let github: { job: string; token: Promise<string>; until: number } | null = null

function githubToken(): Promise<string> {
  const job = `${process.env.ACTIONS_ID_TOKEN_REQUEST_URL}\n${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`
  if (github?.job === job && Date.now() < github.until) return github.token
  const held: NonNullable<typeof github> = {
    job,
    until: Infinity,
    token: githubActionsToken(GITHUB_AUDIENCE).then(
      (token) => {
        held.until = expiry(token) - 60_000
        return token
      },
      (error: unknown) => {
        if (github === held) github = null
        // The handle's own words, not that Vercel's API didn't answer.
        if (error instanceof BoardError) throw new HttpError(401, 'no_token', error.message, { ...(error.hint ? { hint: error.hint } : {}), origin: 'handle' })
        throw new HttpError(502, 'no_token', `GitHub Actions gave no OIDC token: ${error instanceof Error ? error.message : String(error)}`, { origin: 'handle' })
      },
    ),
  }
  github = held
  return held.token
}

/**
 * A token Vercel's API takes: the login of the app that runs board's CLI, when it gave one (the
 * token it was passed, as `vercel board --token`, or else its own), or else this deployment's OIDC
 * token, or else `BOARD_TOKEN`, or else `VERCEL_AUTH_TOKEN`, or else a GitHub Actions job's OIDC
 * token, or your `vercel login`.
 */
async function token(): Promise<string> {
  if (asDeployment()) return getVercelOidcToken()
  const set = boardToken()
  if (set) return set
  // With no login to send, that's what it says, as `http()`'s does, not that the API didn't answer.
  return vercelLogin().catch(() => {
    throw new HttpError(401, 'not_logged_in', "You're not logged in to Vercel.", { hint: 'Run vercel login.', origin: 'handle' })
  })
}

/** Where `token` comes from, in words: what `vb whoami` says. */
export function credentialSource(): string {
  if (passedToken() !== null) return PASSED
  if (asDeployment()) return 'Vercel OIDC'
  if (boardToken()) return 'BOARD_TOKEN'
  if (asGithubActions()) return 'GitHub Actions OIDC'
  return loginHanded() ? 'the Vercel CLI' : 'vercel login'
}

/** The team a CLI that runs board's resolves itself (`vercel board`'s), while one does. */
let handed: (() => Promise<string | null>) | null = null

/**
 * Hands board the team to use when nothing names one (`--scope` still wins), resolved as the app
 * resolves its own and asked for only when a request needs it. Null takes it back.
 */
export function handTeam(resolve: (() => Promise<string | null>) | null) {
  handed = resolve
}

/**
 * The team: the one a CLI that runs board's hands it, `VERCEL_ORG_ID`, the one the deployment's OIDC
 * token names when that token is what goes, or the linked project's (the nearest
 * `.vercel/project.json`). A handed one that throws fails the request with what it threw: the
 * app's own words, not an internal error.
 */
async function team(): Promise<string | null> {
  if (handed) {
    try {
      return await handed()
    } catch (error) {
      throw new HttpError(502, 'no_team', error instanceof Error ? error.message : String(error), { origin: 'handle' })
    }
  }
  if (process.env.VERCEL_ORG_ID) return process.env.VERCEL_ORG_ID
  if (asDeployment()) {
    try {
      const owner = decodeJwt(await getVercelOidcToken()).owner_id
      if (typeof owner === 'string') return owner
    } catch {}
  }
  const file = vercelProjectFile()
  if (!file) return null
  try {
    const linked = JSON.parse(await readFile(file, 'utf8')) as { orgId?: unknown }
    if (typeof linked.orgId === 'string') return linked.orgId
  } catch {}
  return null
}

/**
 * A request with the job's GitHub Actions token: only to Vercel's API, which the token is made out
 * to, and only on a team the request names, since the token names none. Checked where the token
 * is sent, so a `board({ fetch })` with credentials of its own is never held to it.
 */
async function withGithubActions(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (!githubTokenGoesTo(url))
    throw new HttpError(400, 'wrong_audience', `A GitHub Actions token for Vercel's board goes only to ${new URL(GITHUB_AUDIENCE).origin}, not ${url.origin}.`, {
      origin: 'handle',
    })
  if (!url.searchParams.has('teamId') && !url.searchParams.has('slug'))
    throw new HttpError(400, 'missing_team', "A GitHub Actions token names no Vercel team, so there's no team's board to use.", {
      hint: 'Pass --scope <team ID>, or set VERCEL_ORG_ID.',
      origin: 'handle',
    })
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${await githubToken()}`)
  return globalThis.fetch(input, { ...init, headers })
}

const environment: VercelEnvironment = {
  fetch: () => async (input, init = {}) => {
    if (asGithubActions()) return withGithubActions(input, init)
    const credential = await token()
    // Your login goes through the fetch the CLI that runs board's hands it, which adds its own
    // credentials. A deployment's token, or BOARD_TOKEN, goes as it is.
    if (asLogin()) return asYou(input, init, credential)
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${credential}`)
    return globalThis.fetch(input, { ...init, headers })
  },
  team,
  profile: environmentProfile,
  sandbox: (url, token) => sandboxHeaders(url, null, token),
}

/** The fetch `vercel()` sends by default, with the credentials it finds: for the CLI to add a header of its own to. */
export const credentialed = (): typeof fetch => environment.fetch()

/**
 * Your team's board, in Vercel's API: this board keeps nothing, and reads and writes that one as
 * this deployment's project, or as you. Without `board`, the team's board; without `fetch`, it
 * sends the credentials the Vercel CLI or the deployment has.
 */
export function vercel(options: VercelOptions = {}): VercelBackend {
  return createVercel(options, environment)
}

export type { VercelBackend, VercelOptions }
