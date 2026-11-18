import type { JWTVerifyGetKey } from 'jose'
import type { PrincipalInput } from '../api/routes.ts'
import { compileAccess, FULL_ACCESS, parseCan, writtenCan, type Access, type Can, type WrittenCan } from './access.ts'
import { badRequest, forbidden, HttpError, unauthorized } from './errors.ts'
import { admits, grantAccess, subPrefix, type GrantFacts, type GrantSource } from './grants.ts'

/**
 * What a request says about who's calling, beside its credential: labels the caller picks for
 * itself, under whoever the credential turns out to be. They're never security: board() uses them
 * to work out the actor a verified caller writes as.
 */
export type Claims = {
  /** `x-board-profile`: the agent or tool it writes as, `claude`, say. */
  profile: string | null
  /** The `avatar` parameter of `x-board-profile`: an https URL for its picture. */
  avatar: string | null
  /** `x-board-can`: what it narrows itself to, `dev/=read,post`. It only narrows. */
  scope: string | null
}

/** A request, as board() hands it to `authenticate`: what it said, none of it verified yet. */
export type CallerRequest = {
  /** The bearer token, or null when it sent none. */
  credential: string | null
  claims: Claims
  /** The board's URL, which a token must be minted for. */
  audience: string
  /** Its headers, for a verifier that recognizes a session of its own: a same-site page's cookie, say. */
  headers: Headers
}

/** `external`: a platform user writing through sync (`slack:user:U0456`). A local board's people are `local:user:<name>`. */
export type PrincipalKind = 'person' | 'deployment' | 'workflow' | 'external'

/**
 * Who's calling, as board() verified it: an ID in the board's scheme and what its token said.
 * What it may do is board()'s `access` to say.
 */
export type Principal = {
  /** `vercel:user:<id>`, `vercel:project:<id>:<env>`, `github:repo:<id>`, `oidc:<issuer>:<sub>`. */
  id: string
  kind: PrincipalKind
  /** Its handle, as what verified it says: a host's verifier's, a Vercel login's user ID, a deployment's project. */
  handle: string
  expiresAt: Date | null
  /** The verified token's claims, so its access can be worked out again later, as a schedule's sends do. Absent for people and the board's own code. */
  facts?: TokenFacts
  /** The `x-board-can` a proxy sent, which narrows whatever it may do. */
  scope?: string
}

/** A principal and what it may do in each channel, as board()'s `access` worked it out. */
export type Granted = Principal & { access: Access }

/**
 * Whether a caller wrote what `by` says, as far as changing it goes (editing, deleting, canceling a
 * schedule): its principal did, and when it writes as a profile, as that profile. A principal's
 * profiles share its credential (a sandbox's agent writes as one through its deployment's), so the
 * principal alone would let one profile change what another wrote. The principal itself, as no
 * profile, changes what any of them wrote.
 */
export const wroteAs = (caller: { principal: Pick<Principal, 'id'>; actor: { id: string } }, by: { principal: string; actor: string }) =>
  by.principal === caller.principal.id && (caller.actor.id === caller.principal.id || by.actor === caller.actor.id)

/**
 * Principal IDs a board authenticates: its people, deployments, workflows, and its own code. No
 * platform actor sync writes as may have one, or an import could pass for someone signed in.
 */
export const authenticates = (id: string) => /^(vercel|oidc|local|board):/.test(id) || id.startsWith('github:repo:')

/** What a verified token said: its issuer and its claims, never the token itself. */
export type TokenFacts = {
  /** `host`: a host's own verifier recognized the caller; its claims are when that runs out. */
  issuer: 'vercel' | 'github' | 'oidc' | 'host'
  iss: string
  claims: Readonly<Record<string, string | number | boolean>>
}

export type IssuerConfig = {
  /** Accepted `iss` values. */
  issuer: string | RegExp
  /** Key source; defaults to the issuer's published JWKS. */
  jwks?: JWTVerifyGetKey
}

/** `oidcTokens()`'s options: tests point these at a local issuer; production uses the defaults. */
export type OidcTokensOptions = {
  vercel?: IssuerConfig
  github?: IssuerConfig
  /** Keys for the OIDC issuers grants name, by issuer URL, instead of their published JWKS. It trusts no issuer by itself. */
  oidc?: Readonly<Record<string, JWTVerifyGetKey>>
  /**
   * A local board's own issuer (`vb serve`): its tokens' `sub` is a person on
   * this machine, `local:user:<sub>`, with full access. Its keys are never
   * fetched, so `jwks` is required.
   */
  local?: { issuer: string; jwks: JWTVerifyGetKey }
}

export const VERCEL_ISSUER = /^https:\/\/oidc\.vercel\.com(?:\/[a-z0-9-]+)?$/
export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com'

/**
 * `gitlab.com`, `example.com/oidc`, `ci.test%3A8443`: an issuer as a principal
 * names it. A `:` (a port) and a `%` are percent-encoded, so the name has no `:`
 * and the `sub` after it can hold anything. Issuers that differ only in what the
 * URL normalizes (a trailing slash, the host's case) share a name, so the board
 * refuses to trust two of them.
 */
export const issuerName = (iss: string) => {
  const url = new URL(iss)
  return `${url.host}${url.pathname.replace(/\/+$/, '')}`.replace(/[%:]/g, (char) => (char === '%' ? '%25' : '%3A'))
}

/**
 * Whether a token's `sub` can be in a principal's ID. A `+` starts a profile in an actor's ID
 * (`<principal>+claude`), and a `]` or a space ends a mention of one (`@[actor-id]`), so a `sub`
 * with one would read as another workflow's profile. Its token is refused, as a host verifier's
 * principal with one is: an ID is never rewritten, since messages already carry the old ones.
 */
export const subFits = (sub: string) => !/[\s+\]]/.test(sub)

/** OIDC issuers to trust, checked: two that name the same principals can't both be. */
export function trustedIssuers(issuers: readonly string[]): Set<string> {
  const named = new Map<string, string>()
  for (const iss of issuers) {
    const name = issuerName(iss)
    const other = named.get(name)
    if (other !== undefined && other !== iss)
      throw new Error(`oidc issuers ${other} and ${iss} name the same principals, oidc:${name}:<sub>: pin one of them`)
    named.set(name, iss)
  }
  return new Set(issuers)
}

/** A principal as the board keeps it to work its access out again: who it is, its token's facts, and its scope. */
export type Known = Pick<Principal, 'id' | 'kind' | 'handle' | 'facts' | 'scope'> & {
  /** The board token a schedule was made with, from when boards issued them: it stopped with them. */
  token?: string
}

/**
 * Who a grant names, as the board keeps it: IDs, with the names it knows beside them. A board
 * that verifies tokens itself knows none, so it keeps what was written: a user's ID, a project's
 * ID, a repository's `owner/name`.
 */
export type GrantPrincipal =
  | { kind: 'user'; userId: string; email?: string }
  | { kind: 'project'; projectId: string; name?: string; environments: readonly string[]; teamId?: string }
  | { kind: 'github'; repository: string; repositoryId?: string; workflow?: string; branch?: string; event?: string }
  | { kind: 'oidc'; issuer: string; claims: Readonly<Record<string, string | readonly string[]>> }
  | { kind: 'all-users' }
  | { kind: 'all-projects'; environments: readonly string[] }
  | { kind: 'app'; clientId: string; name?: string }
  | { kind: 'all-apps' }
  | { kind: 'everyone' }

/** A grant the board keeps: who it names, and one `can` for all of them, as written. */
export type StoredGrant = { id: string; principals: readonly GrantPrincipal[]; can: WrittenCan }

/**
 * What a grant left without `can` gives: what Vercel's API gives a project it lets use a
 * board. Frozen all the way down: board reads it for every such grant, and @vercel/board/access
 * exports it, so code that imports it can't widen them.
 */
export const DEFAULT_CAN: Can = Object.freeze({ '*': Object.freeze(['read', 'post', 'react', 'label'] as const) })
const GRANT_CLAIMS_MAX = 32
const GRANT_VALUES_MAX = 32
const GRANT_VALUE_MAX = 1000

const invalidGrant = (message: string) => badRequest(message, 'invalid_grant')

/** Whether `host` names something on the board's own network rather than on the internet. */
export function privateHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '')
  if (name.startsWith('[') || /^\d+(\.\d+){3}$/.test(name) || /^\d+$/.test(name)) return true
  if (!name.includes('.') || name === 'localhost') return true
  return /\.(localhost|local|internal|home|lan|corp|intranet)$/.test(name)
}

const GRANT_PRINCIPALS_MAX = 32
/** The environments every Vercel project has: the only ones a grant for every project may name. */
export const TEAM_ENVIRONMENTS: readonly string[] = ['production', 'preview', 'development']
const PROJECT_ID = /^prj_[A-Za-z0-9]+$/
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/
/** A login that's a user's ID where the board's verifier names people by one: what a principal's ID can hold, so no `+`. */
export const LOGIN = /^[a-z0-9][a-z0-9._-]{0,63}@[a-z0-9][a-z0-9.-]{0,127}$/
/** An app's client ID, as a board that verifies tokens itself takes it. */
const APP_ID = USER_ID
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/** An OIDC issuer a grant may name: an https URL on the internet, not Vercel's or GitHub's, which have kinds of their own. */
function checkIssuer(issuer: string, trusted: readonly string[]) {
  let url: URL
  try {
    url = new URL(issuer)
  } catch {
    throw invalidGrant(`an oidc principal's issuer is an https URL, got ${issuer}`)
  }
  if (VERCEL_ISSUER.test(issuer)) throw invalidGrant("name Vercel's deployments as a project or all-projects, not as an oidc issuer")
  if (issuer === GITHUB_ISSUER) throw invalidGrant("name GitHub Actions runs as a github principal, not as an oidc issuer")
  if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password)
    throw invalidGrant(`an oidc principal's issuer is an https URL with no query or credentials, got ${issuer}`)
  if (privateHost(url.hostname)) throw invalidGrant(`an oidc principal's issuer is on the internet, not ${url.hostname}`)
  const name = issuerName(issuer)
  const other = trusted.find((candidate) => candidate !== issuer && /^https:/.test(candidate) && issuerName(candidate) === name)
  if (other !== undefined) throw invalidGrant(`issuers ${other} and ${issuer} name the same principals, oidc:${name}:<sub>: use ${other}`)
}

/**
 * An issuer's claims, keys and lists sorted. They name a `sub`, exact or a pattern `subPrefix`
 * takes: an issuer signs tokens for everyone it serves, and only `sub` says whose a token is. A
 * removal is checked for neither, so a principal stored without one can still be taken out.
 */
function checkClaims(issuer: string, given: Readonly<Record<string, string | readonly string[]>>, removal: boolean): Record<string, string | string[]> {
  const entries = typeof given === 'object' && given !== null ? Object.entries(given) : []
  if (!removal && !entries.some(([name]) => name === 'sub'))
    throw invalidGrant(`name a sub for ${issuer}, like project_path:acme/api:*: it signs tokens for everyone it serves, and only a sub says whose a token is`)
  if (entries.length > GRANT_CLAIMS_MAX) throw invalidGrant(`an oidc principal names at most ${GRANT_CLAIMS_MAX} claims`)
  const claims: Record<string, string | string[]> = {}
  for (const [name, value] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    const values = typeof value === 'string' ? [value] : Array.isArray(value) ? [...new Set(value as readonly unknown[])] : []
    if (values.length === 0 || values.some((one) => typeof one !== 'string' || one === ''))
      throw invalidGrant(`claim ${name} has no value to match: give a string, or a list of them`)
    if (values.length > GRANT_VALUES_MAX || values.some((one) => (one as string).length > GRANT_VALUE_MAX))
      throw invalidGrant(`claim ${name} lists at most ${GRANT_VALUES_MAX} values of up to ${GRANT_VALUE_MAX} characters`)
    const wild = name === 'sub' && !removal ? (values as string[]).find((one) => one.includes('*') && subPrefix(one) === null) : undefined
    if (wild === '*') throw invalidGrant(`sub * is everyone ${issuer} serves: name a sub, or how one starts, like project_path:acme/api:*`)
    if (wild !== undefined) throw invalidGrant(`a sub's * goes last, right after a : or a /, like project_path:acme/api:*, got ${wild}`)
    const sorted = (values as string[]).sort()
    claims[name] = sorted.length === 1 ? sorted[0]! : sorted
  }
  return claims
}

/** Environments without repeats, in Vercel's order (production, preview, development), then custom ones by ID. */
const environmentsOf = (given: readonly string[]) => {
  const rank = (environment: string) => (TEAM_ENVIRONMENTS.includes(environment) ? TEAM_ENVIRONMENTS.indexOf(environment) : TEAM_ENVIRONMENTS.length)
  return [...new Set(given)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

/** `ci.yml` is `.github/workflows/ci.yml`, as GitHub names a workflow in a token's `workflow_ref`. */
export const workflowPath = (workflow: string) => (workflow.includes('/') ? workflow : `.github/workflows/${workflow}`)

/**
 * A principal as a board that verifies tokens itself keeps it, or a 400 `invalid_grant` that says
 * what to write. Such a board has nothing to look a name up with, so it takes IDs: a user's ID, a
 * project's `prj_…`, and a repository's `owner/name`, which it matches on the token's claims.
 * `removal`: one to take out of a grant, which names a project without its environments, and an
 * issuer's tokens without a `sub`. `team`: the board's own team, which a project it names is kept
 * on, so it no longer matches once it's moved to another; null where the board doesn't know it, and
 * then a project is its ID on any team. `logins`: the board's verifier names people by their
 * logins, so a user's email is its ID, with nothing to look up.
 */
export function checkPrincipal(input: PrincipalInput, trusted: readonly string[], removal = false, team: string | null = null, logins = false): GrantPrincipal {
  switch (input.kind) {
    case 'user': {
      if (input.email !== undefined && input.userId !== undefined) throw invalidGrant('a user is its email or its userId, not both')
      if (input.email !== undefined && !logins) throw invalidGrant(`this board can't look up ${input.email}: it verifies tokens itself, so name the user by ID, { kind: 'user', userId }`)
      // Written either way, a login is the ID: people get it from what verified them, in lowercase.
      const login = (input.email ?? (logins && input.userId?.includes('@') ? input.userId : undefined))?.toLowerCase()
      if (login !== undefined) {
        if (!LOGIN.test(login)) throw invalidGrant(`a user here is the login they're known by, like ada@example.com, got ${login}`)
        return { kind: 'user', userId: login }
      }
      if (input.userId === undefined || !USER_ID.test(input.userId)) throw invalidGrant("a user is its userId, letters, numbers, and ._-")
      return { kind: 'user', userId: input.userId }
    }
    case 'project': {
      if (!PROJECT_ID.test(input.project)) throw invalidGrant(`this board can't look up the project ${input.project}: it verifies tokens itself, so name it by ID, prj_…`)
      if (removal) return { kind: 'project', projectId: input.project, environments: [] }
      if (input.environments === undefined) throw invalidGrant(`a project names the environments its deployments get in from, like ['production']`)
      return { kind: 'project', projectId: input.project, environments: environmentsOf(input.environments), ...(team !== null ? { teamId: team } : {}) }
    }
    case 'all-projects': {
      if (removal) return { kind: 'all-projects', environments: [] }
      if (input.environments === undefined) throw invalidGrant(`all-projects names the environments its deployments get in from, like ['production']`)
      const custom = input.environments.filter((environment) => !TEAM_ENVIRONMENTS.includes(environment))
      if (custom.length > 0) throw invalidGrant(`all-projects names production, preview, or development: ${custom[0]} is one project's`)
      return { kind: 'all-projects', environments: environmentsOf(input.environments) }
    }
    case 'github':
      if (!REPOSITORY.test(input.repository)) throw invalidGrant(`a github principal's repository is owner/name, got ${input.repository}`)
      return {
        kind: 'github',
        repository: input.repository,
        ...(input.workflow !== undefined ? { workflow: workflowPath(input.workflow) } : {}),
        ...(input.branch !== undefined ? { branch: input.branch.replace(/^refs\/heads\//, '') } : {}),
        ...(input.event !== undefined ? { event: input.event } : {}),
      }
    case 'oidc':
      checkIssuer(input.issuer, trusted)
      return { kind: 'oidc', issuer: input.issuer, claims: checkClaims(input.issuer, input.claims, removal) }
    case 'app':
      if (!APP_ID.test(input.app)) throw invalidGrant(`an app is its client ID, letters, numbers, and ._-, got ${input.app}`)
      return { kind: 'app', clientId: input.app }
    case 'all-users':
    case 'all-apps':
    case 'everyone':
      return { kind: input.kind }
  }
}

/** One principal's key: two that share it are the same principal. */
export const principalKey = (principal: GrantPrincipal) => JSON.stringify(principal)

/** Principals checked, without repeats, and a `can` kept as written: what a board that verifies tokens itself stores of a grant. */
export function checkGrant(body: { principals: readonly PrincipalInput[]; can: unknown }, trusted: readonly string[], team: string | null = null, logins = false): { principals: GrantPrincipal[]; can: WrittenCan } {
  if (body.principals.length === 0) throw invalidGrant('a grant names at least one principal')
  if (body.principals.length > GRANT_PRINCIPALS_MAX) throw invalidGrant(`a grant names at most ${GRANT_PRINCIPALS_MAX} principals`)
  // Each against the issuers before it in the grant too: two that name the same principals can't sit side by side.
  const seen = [...trusted]
  const checked = body.principals.map((input) => {
    const principal = checkPrincipal(input, seen, false, team, logins)
    if (principal.kind === 'oidc') seen.push(principal.issuer)
    return principal
  })
  const principals = [...new Map(checked.map((principal) => [principalKey(principal), principal])).values()]
  return { principals, can: checkCan(body.can) }
}

/** A grant's `can`, as written, or a 400 `invalid_grant`. */
export function checkCan(can: unknown): WrittenCan {
  try {
    return writtenCan(can)
  } catch (error) {
    throw invalidGrant((error as Error).message)
  }
}

/**
 * Whether `removal` takes `principal` out of a grant: the same user, project, or issuer and
 * claims, whatever its environments; a repository's principals with the workflow, branch, and
 * event it names, any of them where it names none; a group or everyone by its kind.
 */
export function removes(removal: GrantPrincipal, principal: GrantPrincipal): boolean {
  if (removal.kind !== principal.kind) return false
  switch (removal.kind) {
    case 'user':
      return removal.userId === (principal as typeof removal).userId
    case 'project':
      return removal.projectId === (principal as typeof removal).projectId
    case 'github': {
      const other = principal as typeof removal
      return (
        removal.repository === other.repository &&
        (removal.workflow === undefined || removal.workflow === other.workflow) &&
        (removal.branch === undefined || removal.branch === other.branch) &&
        (removal.event === undefined || removal.event === other.event)
      )
    }
    case 'oidc': {
      const other = principal as typeof removal
      return removal.issuer === other.issuer && JSON.stringify(removal.claims) === JSON.stringify(other.claims)
    }
    case 'app':
      return removal.clientId === (principal as typeof removal).clientId
    default:
      return true
  }
}

/**
 * `added` joined into `principal` when it's the same principal, as a removal would find it: a
 * project's environments, or every project's, together. Null when it's another principal. Adding
 * never narrows what a grant names; a remove and an add in one update do.
 */
export function joined(added: GrantPrincipal, principal: GrantPrincipal): GrantPrincipal | null {
  if (added.kind !== principal.kind) return null
  if (added.kind === 'project' || added.kind === 'all-projects') {
    const other = principal as typeof added
    if (added.kind === 'project' && added.projectId !== (other as typeof added).projectId) return null
    return { ...other, environments: environmentsOf([...other.environments, ...added.environments]) }
  }
  return principalKey(added) === principalKey(principal) ? principal : null
}

/** A person's user ID: `vercel:user:u_123` is `u_123`, and a local board's `local:user:jb` is `jb`. */
export const userIdOf = (id: string) => id.split(':').slice(2).join(':')

/**
 * A verified principal as `grantAccess` takes it: who it is in grants' terms, and what the board
 * knows of its team. A person on a board that lets them in is on its team; a deployment's project
 * is when its token's `owner_id` is the board's `team`. Null for one no grant names, such as the
 * board's own code.
 */
export function callerFacts(principal: Known, facts: TokenFacts | null, team: string | null): Pick<GrantFacts, 'caller' | 'member' | 'teamProject'> | null {
  const claims = facts?.claims ?? {}
  if (principal.kind === 'person') return { caller: { kind: 'user', userId: userIdOf(principal.id) }, member: true }
  if (facts?.issuer === 'vercel')
    return {
      caller: {
        kind: 'project',
        projectId: String(claims.project_id ?? ''),
        environment: String(claims.environment ?? ''),
        ...(typeof claims.owner_id === 'string' ? { teamId: claims.owner_id } : {}),
      },
      teamProject: team !== null && claims.owner_id === team,
    }
  if (facts?.issuer === 'github')
    return {
      caller: {
        kind: 'github',
        repository: String(claims.repository ?? ''),
        ...(claims.repository_id !== undefined ? { repositoryId: String(claims.repository_id) } : {}),
        ...(claims.workflow_ref !== undefined ? { workflowRef: String(claims.workflow_ref) } : {}),
        ...(claims.ref !== undefined ? { ref: String(claims.ref) } : {}),
        ...(claims.event_name !== undefined ? { event: String(claims.event_name) } : {}),
      },
    }
  if (facts?.issuer === 'oidc') return { caller: { kind: 'oidc', issuer: facts.iss, claims } }
  return null
}

/**
 * The issuers a verifier trusts for grants, beside its own: a grant's issuer only while it's an
 * https URL on the internet and names principals no issuer before it does. A board refuses any
 * other when it's granted; one stored before it did is never asked for keys, and never breaks the
 * verifier for everyone else.
 */
export function verifiedIssuers(base: readonly string[], granted: readonly string[]): string[] {
  const taken = new Set(base.map(issuerName))
  const issuers = [...base]
  for (const issuer of granted) {
    if (base.includes(issuer)) continue
    const url = URL.parse(issuer)
    if (url?.protocol !== 'https:' || privateHost(url.hostname)) continue
    const name = issuerName(issuer)
    if (taken.has(name)) continue
    taken.add(name)
    issuers.push(issuer)
  }
  return issuers
}

/** The OIDC issuers grants name: their tokens are verified too. */
export const grantIssuers = (grants: readonly Pick<StoredGrant, 'principals'>[]) => [
  ...new Set(grants.flatMap((grant) => grant.principals.flatMap((principal) => (principal.kind === 'oidc' ? [principal.issuer] : [])))),
]

/** What decided part of a principal's access: a grant the board keeps. */
export type Source = GrantSource<StoredGrant>

/**
 * What decides a principal's access: `fixed` for what no grant meets (the board's own code, its
 * own deployments where it runs, a board that keeps no grants), or the facts `grantAccess` decides
 * from: who it is, and the grants.
 */
export type Resolved = { fixed: Access } | { facts: GrantFacts<StoredGrant> }

/** A token no grant lets in, and the grant that would. */
const notGranted = (who: string, grant: string) =>
  new HttpError(403, 'forbidden', `this token can't use this board: no grant lets in ${who}`, { hint: `Grant it: vb grants create ${grant}` })

/**
 * What principals may do, by the board's grants, as `grantAccess` decides: at each channel, the
 * most specific pattern decides, then the closest principal, and ties add up. People are always
 * let in, and the board's own deployments in its environment may do everything.
 */
export function createAuthority(options: {
  /** Whether a host's verifier makes this board's principals: false for one whose verifier is the built-in one alone. */
  hosts: boolean
  /** The board's own Vercel project and team. */
  project: () => Promise<{ id: string | null; teamId: string | null }>
  /** The grants the board keeps, as they are now. Null where it keeps none: there, people may do everything. */
  grants?: (() => Promise<readonly StoredGrant[]>) | null
}) {
  /** What `grantAccess` decides `principal` from: the grants of `snapshot`, when given, or as they are now. Null facts for one no grant names. */
  async function factsFor(principal: Known, facts: TokenFacts | null, team: string | null, snapshot?: readonly StoredGrant[]): Promise<{ grants: readonly StoredGrant[]; facts: GrantFacts<StoredGrant> | null }> {
    const grants = snapshot ?? (options.grants ? await options.grants() : [])
    const known = callerFacts(principal, facts, team)
    return { grants, facts: known ? { ...known, grants } : null }
  }

  /**
   * What decides a principal that isn't a person: everything for the board's own deployments in
   * its environment, and for anyone else, the grants that name it. `everyone` lets no one in: a
   * 401 or 403 that says which grant would, when nothing else names it.
   */
  async function byGrants(principal: Known, facts: TokenFacts | null, snapshot?: readonly StoredGrant[]): Promise<Resolved> {
    const claims = facts?.claims ?? {}
    const own = facts?.issuer === 'vercel' ? await options.project() : null
    const environment = String(claims.environment ?? '')
    // A deployment in the board's own environment runs the board's code. A
    // preview runs any branch's, so a production board doesn't trust them.
    const here = boardEnvironment()
    const ownDeployment = own !== null && own.id !== null && claims.project_id === own.id
    if (ownDeployment && here !== null && environment === here) return { fixed: FULL_ACCESS }
    if (!facts) throw forbidden("this token can't use this board")
    const { grants, facts: found } = await factsFor(principal, facts, own?.teamId ?? null, snapshot)
    if (found && admits(found)) return { facts: found }
    // An issuer a grant names is trusted: its token just isn't one the grant lets in.
    if (facts.issuer === 'oidc' && !grantIssuers(grants).includes(facts.iss)) throw unauthorized(`untrusted issuer: ${facts.iss}`)
    if (facts.issuer === 'oidc') throw forbidden("this token can't use this board: no grant lets in its claims")
    if (facts.issuer === 'github') {
      const repository = String(claims.repository ?? '')
      throw notGranted(repository || 'its repository', `--github ${repository || '<OWNER/REPO>'}`)
    }
    const project = String(claims.project_id ?? '') || '<PROJECT_ID>'
    const grant = `--project ${project} --environment ${environment || '<ENVIRONMENT>'}`
    if (ownDeployment)
      throw new HttpError(403, 'forbidden', `this token can't use this board: it runs in ${here ?? 'no Vercel environment'}, and its ${environment || 'unnamed'} deployments need a grant`, {
        hint: `Grant them: vb grants create ${grant}`,
      })
    throw notGranted(`project ${project} in ${environment || 'no environment'}`, grant)
  }

  /**
   * What decides a principal's access, before its scope narrows it: the board's own code and the
   * platform users sync writes as may do everything; a person is always let in, with what the
   * grants that name them give (everything, where the board keeps no grants); anyone else as
   * `byGrants` says. A host's principal is what its kind is, until it expires. A 401 or 403 when
   * it may do nothing.
   */
  async function resolve(principal: Known, snapshot?: readonly StoredGrant[]): Promise<Resolved> {
    const hosted = principal.facts?.issuer === 'host'
    // A platform user sync writes as is `external` too, but one a host's verifier returns is the host's to give access.
    if (principal.id.startsWith('board:') || (principal.kind === 'external' && !hosted)) return { fixed: FULL_ACCESS }
    if (hosted) {
      // One a host's verifier made, on a board whose verifier is now the built-in one alone, is from before it switched.
      if (!options.hosts) throw forbidden("this token can't use this board: its board no longer takes a host's principals")
      const { exp } = principal.facts!.claims
      if (typeof exp === 'number' && exp * 1000 <= Date.now()) throw unauthorized('token expired')
    }
    if (principal.kind === 'person') {
      if (!options.grants) return { fixed: FULL_ACCESS }
      const { facts } = await factsFor(principal, null, null, snapshot)
      return { facts: facts! }
    }
    // A host's says nothing past its ID, as a principal stored before the board kept claims.
    return byGrants(principal, (hosted ? undefined : principal.facts) ?? factsFromId(principal.id), snapshot)
  }

  /**
   * What a principal may do now, narrowed by its scope, or under `snapshot`, grants as a write is
   * about to change them. A 401 or 403 when it may do nothing.
   */
  async function grant(principal: Known, snapshot?: readonly StoredGrant[]): Promise<Access> {
    const resolved = await resolve(principal, snapshot)
    const scope = principal.scope === undefined ? undefined : parseCan(principal.scope)
    if ('fixed' in resolved) return scope === undefined ? resolved.fixed : resolved.fixed.narrow(scope)
    const decided = grantAccess({ ...resolved.facts, ...(scope !== undefined ? { can: scope } : {}) })
    if (!decided) throw forbidden("this token can't use this board")
    return decided.caller
  }

  /** What a stored principal (a schedule's creator, a watcher's registrant) may do now: null once nothing. */
  async function accessNow(principal: Known, snapshot?: readonly StoredGrant[]): Promise<Access | null> {
    try {
      return await grant(principal, snapshot)
    } catch (error) {
      const status = (error as { status?: number }).status
      if (status === 401 || status === 403) return null
      throw error
    }
  }

  return { grant, accessNow, resolve }
}

/**
 * The Vercel environment the board runs in: `production`, `preview`, or a
 * custom environment's name. `VERCEL_TARGET_ENV` names custom environments,
 * where `VERCEL_ENV` says `preview`. Null outside Vercel, where only people
 * get in without a grant.
 */
const boardEnvironment = (): string | null => process.env.VERCEL_TARGET_ENV || process.env.VERCEL_ENV || null

/**
 * What a principal's ID still says, for one stored before the board kept
 * claims: a deployment's project ID and environment. A workflow's ID names
 * neither its repository nor its run, so it says nothing, and a grant that
 * needs more than the ID no longer matches.
 */
function factsFromId(id: string): TokenFacts | null {
  const deployment = id.match(/^vercel:project:([^:]+):([^:]+)$/)
  return deployment ? { issuer: 'vercel', iss: '', claims: { project_id: deployment[1]!, environment: deployment[2]! } } : null
}

/** What board() knows that verifying a request needs: its own Vercel project, and the OIDC issuers its grants trust. */
export type AuthenticateContext = {
  /** The board's own Vercel project and team: its people's development tokens are for it. */
  project(): Promise<{ id: string | null; teamId: string | null }>
  /** OIDC issuers past Vercel's and GitHub's whose tokens may be trusted: the ones grants name. */
  issuers: readonly string[]
}

/** What a verifier gets: what the request said, and what the board knows that verifying it needs. */
export type AuthenticateRequest = CallerRequest & { board: AuthenticateContext }

/**
 * Who a request is, in the board's ID scheme: `oidcTokens()` checks its bearer token for the
 * board's URL, and a host's own verifier recognizes its own credentials (a session cookie in
 * `request.headers`, say). Null when the request carries nothing it recognizes, so verifiers
 * compose: `(request) => (await staff(request)) ?? (await tokens(request))`. To reject a
 * credential that fails, throw an `HttpError` (a 401), or return or throw a `Response`; anything
 * else thrown is a 500. What a principal may do is the board's defaults' and grants' to say.
 */
export type Authenticate = (
  request: AuthenticateRequest,
) => Principal | HostPrincipal | Response | null | undefined | Promise<Principal | HostPrincipal | Response | null | undefined>

/** What a host's own verifier returns: a principal in the board's ID scheme. */
export type HostPrincipal = {
  /** `vercel:user:<id>`, `vercel:project:<id>:<env>`, …: records keep their shape. */
  id: string
  kind: PrincipalKind
  /**
   * Who it is to people, its handle and its name: the board takes it as checked, so a person posts to Slack under
   * it as a plain sender. A verifier that knows only an ID gives that.
   */
  handle: string
  expiresAt?: Date | null
}

/** What marks `oidcTokens()`, so board() can tell it makes no host's principals. */
export const TOKENS = Symbol('board.oidcTokens')
/**
 * What marks a verifier whose people's user IDs are the logins they're known by (`ada@example.com`),
 * as Tailscale's are: a grant on its board names a user by one, where any other board that verifies
 * tokens itself has nothing to look an email up with.
 */
export const LOGINS = Symbol('board.logins')
/** Whether `authenticate` names people by their logins. */
export const namesByLogin = (authenticate: Authenticate) => LOGINS in authenticate
/** The principals `oidcTokens()` made: board() takes them as they are, and checks the rest as a host's. */
const verifiedTokens = new WeakSet<object>()

/** Marks a principal `oidcTokens()` made. */
export function markVerified(principal: Principal): Principal {
  verifiedTokens.add(principal)
  return principal
}

/** Whether `authenticate` is `oidcTokens()`'s alone: it makes no host's principals. */
export const verifiesTokens = (authenticate: Authenticate) => TOKENS in authenticate

/** Whether `oidcTokens()` made `principal`, as opposed to a host's own verifier. */
export const fromTokens = (principal: object) => verifiedTokens.has(principal)

const PRINCIPAL_ID = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*:[^\s+\]]{1,200}$/
const KINDS: readonly PrincipalKind[] = ['person', 'deployment', 'workflow', 'external']

/**
 * Checks what a host's own verifier returned. A malformed principal is the host's bug, so it
 * fails the request rather than letting a half-identity write.
 */
export function hostPrincipal(value: HostPrincipal): Principal {
  const fail = (why: string): never => {
    throw new TypeError(`authenticate returned an invalid principal: ${why}`)
  }
  if (typeof value !== 'object' || value === null) fail('not an object')
  if (typeof value.id !== 'string' || !PRINCIPAL_ID.test(value.id) || value.id.startsWith('board:'))
    fail(`id must look like \`vercel:user:<id>\`, got ${JSON.stringify(value.id)}`)
  if (!KINDS.includes(value.kind)) fail(`kind must be one of ${KINDS.join(', ')}`)
  if (typeof value.handle !== 'string' || !/^\S{1,64}$/.test(value.handle)) fail('handle must be 1-64 characters, no spaces')
  const expiresAt = value.expiresAt ?? null
  if (expiresAt !== null && (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime()))) fail('expiresAt must be a Date or null')
  if (expiresAt !== null && expiresAt.getTime() <= Date.now()) throw unauthorized('token expired')
  const claims: Record<string, number> = expiresAt === null ? {} : { exp: Math.floor(expiresAt.getTime() / 1000) }
  return { id: value.id, kind: value.kind, handle: value.handle, expiresAt, facts: { issuer: 'host', iss: '', claims } }
}
