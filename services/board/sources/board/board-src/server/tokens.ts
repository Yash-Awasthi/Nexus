import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose'
import {
  GITHUB_ISSUER,
  issuerName,
  subFits,
  markVerified,
  privateHost,
  TOKENS,
  trustedIssuers,
  VERCEL_ISSUER,
  type AuthenticateContext,
  type CallerRequest,
  type IssuerConfig,
  type OidcTokensOptions,
  type Principal,
  type TokenFacts,
} from './auth.ts'
import { unauthorized } from './errors.ts'
import { ownProjectId, ownTeamId } from './identity.ts'

type Claims = JWTPayload & Record<string, unknown>

const REGISTERED = new Set(['aud', 'exp', 'iat', 'nbf', 'jti'])

/** The claims rules can match on: plain values, bounded, as a schedule stores them. */
function factsOf(issuer: TokenFacts['issuer'], iss: string, claims: Claims): TokenFacts {
  const kept: Record<string, string | number | boolean> = {}
  for (const [name, value] of Object.entries(claims)) {
    if (REGISTERED.has(name) || Object.keys(kept).length >= 64) continue
    if (typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && value.length <= 1000)) kept[name] = value
  }
  return { issuer, iss, claims: kept }
}

const issuerMatches = (iss: string, accepted: string | RegExp) =>
  typeof accepted === 'string' ? iss === accepted : accepted.test(iss)

/** The keys of the issuers seen most recently: an issuer a token names costs a fetch, so what stays is bounded. */
const remoteKeys = new Map<string, JWTVerifyGetKey>()
const loading = new Map<string, Promise<JWTVerifyGetKey>>()
const REMOTE_KEYS_MAX = 100
const DISCOVERY_TIMEOUT_MS = 5000

/**
 * An issuer's keys, by OIDC Discovery 1.0: its document under the issuer, naming that issuer
 * (§4.3), and its keys at an https `jwks_uri` (§3), which must be on the internet, as a grant's
 * issuer must. Like jose's own fetch of the keys, it follows no redirect. Callers asking for the
 * same issuer at once share one fetch, and a fetch that stalls gives up.
 */
function keysFor(iss: string): Promise<JWTVerifyGetKey> {
  const cached = remoteKeys.get(iss)
  if (cached) {
    remoteKeys.delete(iss)
    remoteKeys.set(iss, cached)
    return Promise.resolve(cached)
  }
  let pending = loading.get(iss)
  if (!pending) {
    pending = discover(iss).finally(() => loading.delete(iss))
    loading.set(iss, pending)
  }
  return pending
}

async function discover(iss: string): Promise<JWTVerifyGetKey> {
  const unknown = (why: string) => unauthorized(`cannot load keys for issuer ${iss}: ${why}`)
  const response = await fetch(`${iss.replace(/\/+$/, '')}/.well-known/openid-configuration`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  }).catch(() => {
    throw unknown('its discovery did not answer')
  })
  if (response.status !== 200) throw unknown(`its discovery answered ${response.status}`)
  const config = (await response.json().catch(() => null)) as { issuer?: unknown; jwks_uri?: unknown } | null
  if (config?.issuer !== iss) throw unknown("its discovery names another issuer")
  const jwks = typeof config.jwks_uri === 'string' ? URL.parse(config.jwks_uri) : null
  if (jwks?.protocol !== 'https:' || privateHost(jwks.hostname)) throw unknown("its jwks_uri isn't an https URL on the internet")
  const keys = createRemoteJWKSet(jwks, { timeoutDuration: DISCOVERY_TIMEOUT_MS })
  if (remoteKeys.size >= REMOTE_KEYS_MAX) remoteKeys.delete(remoteKeys.keys().next().value!)
  remoteKeys.set(iss, keys)
  return keys
}

/** What tokens are verified with: the platform's issuers, OIDC issuers the board's grants name, and test issuers. */
function createVerifier(options: {
  projectId: () => Promise<string | null>
  /** OIDC issuers past Vercel's and GitHub's whose tokens are verified: the ones the board's grants name. */
  issuers: readonly string[]
  auth?: OidcTokensOptions | undefined
}) {
  const vercelIssuer: IssuerConfig = options.auth?.vercel ?? { issuer: VERCEL_ISSUER }
  const githubIssuer: IssuerConfig = options.auth?.github ?? { issuer: GITHUB_ISSUER }
  // The only issuers past Vercel's and GitHub's whose tokens are verified, or whose keys are fetched.
  const oidcIssuers = trustedIssuers(options.issuers)

  async function verify(token: string, audience: string): Promise<Principal> {
    let iss: string
    try {
      iss = String(decodeJwt(token).iss ?? '')
    } catch {
      throw unauthorized('malformed token')
    }

    const local = options.auth?.local
    if (local && iss === local.issuer) return localPerson(token, local, audience)

    const isVercel = issuerMatches(iss, vercelIssuer.issuer)
    const isGitHub = !isVercel && issuerMatches(iss, githubIssuer.issuer)
    const isOidc = !isVercel && !isGitHub && oidcIssuers.has(iss)
    if (!isVercel && !isGitHub && !isOidc) throw unauthorized(`untrusted issuer: ${iss || '(none)'}`)

    let claims: Claims
    try {
      const keys = isOidc
        ? (options.auth?.oidc?.[iss] ?? (await keysFor(iss)))
        : ((isVercel ? vercelIssuer : githubIssuer).jwks ?? (await keysFor(iss)))
      ;({ payload: claims } = (await jwtVerify(token, keys, { issuer: iss, audience })) as {
        payload: Claims
      })
    } catch (error) {
      if ((error as { status?: number }).status === 401) throw error
      throw unauthorized(`invalid token: ${(error as Error).message}`)
    }
    const facts = factsOf(isOidc ? 'oidc' : isGitHub ? 'github' : 'vercel', iss, claims)
    const expiresAt = claims.exp ? new Date(claims.exp * 1000) : null

    if (isOidc) {
      if (typeof claims.sub !== 'string' || claims.sub === '') throw unauthorized(`token from ${iss} without sub`)
      if (!subFits(claims.sub)) throw unauthorized(`token from ${iss} has a sub with a +, a ], or a space, which a principal's ID can't hold`)
      return { id: `oidc:${issuerName(iss)}:${claims.sub}`, kind: 'workflow', handle: claims.sub.slice(0, 128), expiresAt, facts }
    }
    if (isGitHub)
      return { id: `github:repo:${String(claims.repository_id)}`, kind: 'workflow', handle: String(claims.repository), expiresAt, facts }

    const environment = String(claims.environment ?? '')
    const project = String(claims.project ?? '')
    const ownProject = (await options.projectId()) ?? null
    if (ownProject !== null && claims.project_id === ownProject && environment === 'development') {
      // A development token minted with someone's Vercel login carries their user ID, and nothing else of who they are.
      if (typeof claims.user_id !== 'string') throw unauthorized('development token without user_id')
      return { id: `vercel:user:${claims.user_id}`, kind: 'person', handle: claims.user_id, expiresAt }
    }
    return deployment(facts, project, environment, expiresAt)
  }

  return { verify }
}

const LOCAL_SUB = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/

async function localPerson(token: string, local: NonNullable<OidcTokensOptions['local']>, audience: string): Promise<Principal> {
  let claims: Claims
  try {
    ;({ payload: claims } = (await jwtVerify(token, local.jwks, { issuer: local.issuer, audience })) as { payload: Claims })
  } catch (error) {
    throw unauthorized(`invalid token: ${(error as Error).message}`)
  }
  const sub = String(claims.sub ?? '')
  if (!LOCAL_SUB.test(sub)) throw unauthorized('local token without a valid sub')
  return { id: `local:user:${sub}`, kind: 'person', handle: sub, expiresAt: claims.exp ? new Date(claims.exp * 1000) : null }
}

const deployment = (facts: TokenFacts, project: string, environment: string, expiresAt: Date | null): Principal => ({
  id: `vercel:project:${String(facts.claims.project_id)}:${environment}`,
  kind: 'deployment',
  // Its project's name in every environment: the environment shows in its name, `support (preview)`.
  handle: project,
  expiresAt,
  facts,
})

/** The board's own project, for a verifier asked outside a board that knows it: from the environment. */
const environmentBoard: AuthenticateContext = {
  project: async () => ({ id: await ownProjectId(), teamId: await ownTeamId() }),
  issuers: [],
}

/**
 * The OIDC tokens made out to this board: a request's bearer token, from Vercel (people and
 * deployments), GitHub Actions, an issuer a grant names, or `local`'s (`vb serve`'s), verified
 * for the board's URL. Null for a request with no token, and a 401 for one whose token fails.
 * Without `request.board`, the board's project is the environment's, and it trusts no issuer past
 * Vercel's and GitHub's.
 */
export function oidcTokens(options: OidcTokensOptions = {}): (request: CallerRequest & { board?: AuthenticateContext }) => Promise<Principal | null> {
  let made: { board: AuthenticateContext; issuers: string; verify: ReturnType<typeof createVerifier>['verify'] } | null = null
  const authenticate = async (request: CallerRequest & { board?: AuthenticateContext }): Promise<Principal | null> => {
    if (request.credential === null) return null
    const board = request.board ?? environmentBoard
    const issuers = board.issuers.join('\n')
    if (made?.board !== board || made.issuers !== issuers)
      made = {
        board,
        issuers,
        verify: createVerifier({
          projectId: async () => (await board.project()).id,
          issuers: board.issuers,
          auth: options,
        }).verify,
      }
    return markVerified(await made.verify(request.credential, request.audience))
  }
  return Object.assign(authenticate, { [TOKENS]: true })
}
