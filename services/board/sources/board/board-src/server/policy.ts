import { compileAccess, parseCan, PERMISSIONS, type Access, type Level, type Permission } from './access.ts'
import { explainGrants } from './grants.ts'
import { resolveActor } from './actors.ts'
import {
  createAuthority,
  fromTokens,
  GITHUB_ISSUER,
  grantIssuers,
  verifiedIssuers,
  hostPrincipal,
  namesByLogin,
  VERCEL_ISSUER,
  verifiesTokens,
  type Authenticate,
  type AuthenticateContext,
  type CallerRequest,
  type HostPrincipal,
  type Known,
  type Principal,
  type StoredGrant,
} from './auth.ts'
import type { Identity, Trust } from './backend.ts'
import { HttpError, RejectedError, unauthorized } from './errors.ts'
import type { ProjectIdentity } from './identity.ts'

/** What decides a channel for a principal: the winning pattern and level, the grants there or the rule, and what they give. */
export type Decided = { pattern: string | null; over: string[]; level: Level | null; grants: StoredGrant[]; permissions: Permission[] }

/** Who may use a board, and what they may do: `board()`'s options for it. */
export type PolicyOptions = {
  /**
   * Who a request is: `oidcTokens()` from `@vercel/board/access` by default, which checks its bearer token
   * for the board's URL (pass it `local` for `vb serve`'s, or test issuers). Or a host's own
   * verifier, `(request) => ({ id, kind, handle })`: who the request is in the board's ID scheme,
   * from its credential or its headers (a session cookie). It replaces the built-in one, so no
   * token's audience or the board's own project counts then, unless it calls `oidcTokens()` itself.
   * Null when it recognizes nothing; to reject, return or throw a `Response`.
   *
   * What a principal may do isn't its to say: people, and the board's own deployments in its
   * environment, may do everything, and anyone else what the board's grants give.
   */
  authenticate?: Authenticate
}

/** What a build of board finds in its environment for a board's policy: Node's verifies OIDC tokens and reads the board's Vercel project. */
export type Serving = {
  oidcTokens(): Authenticate
  ownProjectId(): Promise<string | null>
  ownTeamId(): Promise<string | null>
  discoveryIdentity(headers: Headers | null): Promise<ProjectIdentity>
}

/** board()'s policy: who each request is, and what principals may do, now and at every send and match. */
export type Policy = ReturnType<typeof createPolicy>

/**
 * The policy a board's options say: verifying requests, and what they and the principals its
 * backend stores may do. `keeps`: the backend keeps the board, so it serves requests; one that
 * uses another board's answers only wake-ups and webhooks on Vercel's, and nothing at `BOARD_URL`.
 */
export function createPolicy(options: PolicyOptions, keeps: boolean, serving: (() => Promise<Serving>) | null, trust: Trust | null = null) {
  const grants = trust ? () => trust.grants() : null

  /** The board's own Vercel project and team, from the environment, asked once. */
  let own: Promise<{ id: string | null; teamId: string | null }> | null = null
  const project = () =>
    (own ??= (async () => {
      if (!serving) return { id: null, teamId: null }
      const found = await serving()
      const [id, teamId] = await Promise.all([found.ownProjectId(), found.ownTeamId()])
      return { id, teamId }
    })()).catch((error: unknown) => {
      own = null
      throw error
    })

  /** What discovery says the board's project is, as a request shows it: clients mint tokens with it. */
  async function discoveryIdentity(headers: Headers): Promise<ProjectIdentity> {
    if (!serving) return { projectId: null, teamId: null }
    return (await serving()).discoveryIdentity(headers)
  }

  let tokens: Promise<Authenticate> | null = null
  /** The verifier: `authenticate`, or `oidcTokens()` where this build has it. */
  const verifier = (): Promise<Authenticate> =>
    options.authenticate
      ? Promise.resolve(options.authenticate)
      : (tokens ??= serving
          ? serving().then((found) => found.oidcTokens())
          : Promise.reject(new HttpError(501, 'no_verifier', "this build of board verifies no tokens: pass board({ authenticate })")))

  // What callers may do: requests, and stored principals. A board whose verifier is the built-in one
  // alone takes no host's principals.
  const authority = createAuthority({ project, hosts: options.authenticate !== undefined && !verifiesTokens(options.authenticate), grants })
  /** One for every request, so a verifier keeps what it built: its issuers change only when grants name new ones. */
  const context: { project: AuthenticateContext['project']; issuers: readonly string[] } = { project, issuers: [] }

  /**
   * Trusts the issuers grants name, before a token from one is verified: only for a token from an
   * issuer neither Vercel nor GitHub is, so most requests read no grants for it.
   */
  async function learnIssuers(credential: string) {
    if (!grants) return
    const iss = issuerOf(credential)
    // A grant's issuer is https: a local board's own (`vb serve`'s) never is.
    if (iss === null || !iss.startsWith('https://') || iss === GITHUB_ISSUER || VERCEL_ISSUER.test(iss)) return
    const issuers = verifiedIssuers([], grantIssuers(await grants()))
    if (issuers.join('\n') !== context.issuers.join('\n')) context.issuers = issuers
  }

  /** Verified principals by credential, until they expire, so a stream's polls don't verify from scratch. */
  const verified = new Map<string, { principal: Promise<Principal>; until: number }>()
  /** And by request, for one with no credential (a session cookie), for as long as it's served. */
  const perRequest = new WeakMap<CallerRequest, Promise<Principal>>()

  /** Who a request's credential is: a 401 or the host's own rejection when it's no one. */
  async function principalOf(request: CallerRequest): Promise<Principal> {
    const live = (principal: Principal) => principal.expiresAt === null || principal.expiresAt.getTime() > Date.now()
    const known = perRequest.get(request)
    if (known) {
      const principal = await known
      if (live(principal)) return principal
    }
    const key = request.credential === null ? null : [request.audience, request.credential].join('\u001f')
    const cached = key === null ? undefined : verified.get(key)
    if (cached && cached.until > Date.now()) {
      perRequest.set(request, cached.principal)
      return cached.principal
    }
    const principal = verify(request)
    perRequest.set(request, principal)
    if (key !== null)
      principal.then(
        (found) => {
          // A host's principals may lose access any time, so only a token's are kept: until it expires.
          if (found.facts?.issuer === 'host' || found.expiresAt === null) return
          if (verified.size >= 1000) verified.delete(verified.keys().next().value!)
          verified.set(key, { principal, until: found.expiresAt.getTime() })
        },
        () => perRequest.delete(request),
      )
    return principal
  }

  async function verify(request: CallerRequest): Promise<Principal> {
    if (request.credential !== null) await learnIssuers(request.credential)
    const authenticate = await verifier()
    let result: Awaited<ReturnType<Authenticate>>
    try {
      result = await authenticate({ ...request, board: context })
    } catch (error) {
      // A thrown `Response` rejects like a returned one.
      if (error instanceof Response) throw new RejectedError(error)
      throw error
    }
    if (result instanceof Response) throw new RejectedError(result)
    // Nothing it recognizes: no token, and no credential of a host's own.
    if (result === null || result === undefined) throw unauthorized('missing bearer token')
    // What the built-in verifier made stands as it is; anything else is a host's, checked.
    return fromTokens(result) ? (result as Principal) : hostPrincipal(result as HostPrincipal)
  }

  /**
   * Which pattern, level, and grants decide `channel` for `principal`, and what they give it there,
   * narrowed by its scope: what explain answers, through `explainGrants`. Nothing for a principal
   * nothing lets in.
   */
  async function explain(principal: Known, channel: string): Promise<Decided> {
    let resolved: Awaited<ReturnType<typeof authority.resolve>>
    try {
      resolved = await authority.resolve(principal)
    } catch (error) {
      const status = (error as { status?: number }).status
      if (status === 401 || status === 403) return { pattern: null, over: [], level: null, grants: [], permissions: [] }
      throw error
    }
    const scope = principal.scope === undefined ? null : compileAccess(parseCan(principal.scope))
    const allowed = (permissions: readonly Permission[]) => (scope ? permissions.filter((permission) => scope.can(permission, channel)) : [...permissions])
    if ('fixed' in resolved) return { pattern: null, over: [], level: null, grants: [], permissions: allowed(PERMISSIONS.filter((permission) => resolved.fixed.can(permission, channel))) }
    const { pattern, over, level, grants, permissions } = explainGrants(resolved.facts, channel)
    return { pattern, over, level, grants, permissions: allowed(permissions) }
  }

  return {
    /** Whether requests are served at all: only where the backend keeps the board. */
    open: keeps,
    /** Whether the verifier names people by their logins, so a grant here names a user by one. */
    logins: options.authenticate !== undefined && namesByLogin(options.authenticate),
    project,
    discoveryIdentity,
    /**
     * Who a request is, and what it may do now: verified, under the rules, with the profile it
     * claims. Each call works its access out again; its principal is verified once per credential
     * until it expires.
     */
    async identify(request: CallerRequest): Promise<Identity> {
      const found = await principalOf(request)
      const { claims } = request
      const principal = claims.scope === null ? found : { ...found, scope: claims.scope }
      const { author, actor } = resolveActor(principal, claims)
      return { principal: { ...principal, access: await authority.grant(principal) }, author, actor }
    },
    explain,
    /** What a stored principal (a schedule's creator, a watcher's registrant) may do now: null once nothing, or once it was made with a board token. */
    async accessNow(principal: Known, grants?: readonly StoredGrant[]): Promise<Access | null> {
      if (principal.token !== undefined) return null
      return authority.accessNow(principal, grants)
    },
  }
}

/** A JWT's `iss`, read but not verified: which issuer's keys would check it. Null for anything else. */
function issuerOf(credential: string): string | null {
  const payload = credential.split('.')[1]
  if (payload === undefined) return null
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '='))
    const { iss } = JSON.parse(json) as { iss?: unknown }
    return typeof iss === 'string' ? iss : null
  } catch {
    return null
  }
}
