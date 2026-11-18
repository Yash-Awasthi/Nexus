// What a caller may do by a board's grants: plain data in, accesses out, with no I/O, so a board
// and Vercel's API decide the same way. `@vercel/board/access` exports it.
import { combine, compileAccess, decide, type Access, type Can, type Level, type Matched, type Permission, type WrittenCan } from './access.ts'
import type { GrantPrincipal } from './auth.ts'

/** Who asks, as a verified token says, in the terms grants name them by. */
export type Caller =
  | { kind: 'user'; userId: string }
  | { kind: 'project'; projectId: string; environment: string; teamId?: string }
  | { kind: 'github'; repository: string; repositoryId?: string; workflowRef?: string; ref?: string; event?: string }
  | { kind: 'oidc'; issuer: string; claims: Readonly<Record<string, unknown>> }
  | { kind: 'app'; clientId: string }

/** A grant as the decision reads it: whom it names, and what it gives where. */
export type DecidingGrant = { readonly principals: readonly GrantPrincipal[]; readonly can: WrittenCan }

/** What decides a caller's access, all of it plain data or a predicate the backend answers. */
export type GrantFacts<G extends DecidingGrant = DecidingGrant> = {
  caller: Caller
  /** The board's grants, as they are, or as a write is about to leave them. */
  grants: readonly G[]
  /** Whether the caller, a user, is a person on the board's team: `all-users` names them, and that lets them in. */
  member?: boolean
  /** Whether the caller, a project, is on the board's team: `all-projects` names it. */
  teamProject?: boolean
  /** Whether the caller, an app, is installed on the board's team: `all-apps` names it. */
  teamApp?: boolean
  /**
   * The most the caller may do anywhere, whatever the grants say: what a backend makes of a
   * person's team role (a viewer is `['read', 'react']`) or an app's scopes. Nothing caps it,
   * without it.
   */
  cap?: readonly Permission[]
  /** A token's `can`, which narrows what the grants give. */
  can?: Can
}

/** Where a matched grant came from: one the board keeps. */
export type GrantSource<G extends DecidingGrant = DecidingGrant> = { grant: G }

/**
 * How close `principal` is to the caller, or null when it doesn't name it: `principal` for its own
 * user, project, repository's runs, issuer's claims, or app; `group` for every person, every
 * project on the team in its environments, or every app on it; `everyone` for everyone.
 */
export function levelOf(principal: GrantPrincipal, facts: Pick<GrantFacts, 'caller' | 'member' | 'teamProject' | 'teamApp'>): Level | null {
  const { caller } = facts
  switch (principal.kind) {
    case 'everyone':
      return 'everyone'
    case 'all-users':
      return caller.kind === 'user' && facts.member === true ? 'group' : null
    case 'user':
      return caller.kind === 'user' && caller.userId === principal.userId ? 'principal' : null
    case 'all-projects':
      return caller.kind === 'project' && facts.teamProject === true && principal.environments.includes(caller.environment) ? 'group' : null
    case 'project':
      // A project the grant knows the team of is that team's: moved to another, whose tokens name
      // that team, it's no longer the grant's. A caller that names no team (a host's, or one
      // stored before the board kept claims) is matched by its ID.
      return caller.kind === 'project' &&
        caller.projectId === principal.projectId &&
        (principal.teamId === undefined || caller.teamId === undefined || caller.teamId === principal.teamId) &&
        principal.environments.includes(caller.environment)
        ? 'principal'
        : null
    case 'github': {
      if (caller.kind !== 'github') return null
      const same = principal.repositoryId !== undefined ? caller.repositoryId === principal.repositoryId : caller.repository === principal.repository
      // All of workflow_ref, `<repository>/<path>@<ref>`, with the token's own ref: a file named
      // `ci.yml@other.yml` isn't `ci.yml`.
      const workflow = principal.workflow === undefined || (caller.ref !== undefined && caller.workflowRef === `${caller.repository}/${principal.workflow}@${caller.ref}`)
      const branch = principal.branch === undefined || caller.ref === `refs/heads/${principal.branch}`
      const event = principal.event === undefined || caller.event === principal.event
      return same && workflow && branch && event ? 'principal' : null
    }
    case 'app':
      return caller.kind === 'app' && caller.clientId === principal.clientId ? 'principal' : null
    case 'all-apps':
      return caller.kind === 'app' && facts.teamApp === true ? 'group' : null
    case 'oidc':
      return caller.kind === 'oidc' &&
        caller.issuer === principal.issuer &&
        Object.entries(principal.claims).every(([name, allowed]) => {
          const value = caller.claims[name]
          if (value === undefined) return false
          const given = String(value)
          return (typeof allowed === 'string' ? [allowed] : allowed).some((one) => {
            const prefix = name === 'sub' ? subPrefix(one) : null
            return prefix === null ? given === one : given.startsWith(prefix)
          })
        })
        ? 'principal'
        : null
  }
}

/**
 * What a `sub` pattern matches the start of: `project_path:acme/api:` for `project_path:acme/api:*`.
 * Null for any other value, which matches exactly: a `*` only ends a pattern, right after a `:` or
 * a `/`, so no pattern lets `acme-evil` in for `acme`.
 */
export function subPrefix(value: string): string | null {
  if (!value.endsWith('*')) return null
  const prefix = value.slice(0, -1)
  return /.[:/]$/.test(prefix) && !prefix.includes('*') ? prefix : null
}

const RANK: Record<Level, number> = { principal: 0, group: 1, everyone: 2 }

/** The grants that name the caller, each as close as its closest principal; without `everyone`'s, when `own`. */
export function matchedFor<G extends DecidingGrant>(facts: GrantFacts<G>, own = false): Matched<GrantSource<G>>[] {
  const matched: Matched<GrantSource<G>>[] = []
  for (const grant of facts.grants) {
    let best: Level | null = null
    for (const principal of grant.principals) {
      if (own && principal.kind === 'everyone') continue
      const level = levelOf(principal, facts)
      if (level !== null && (best === null || RANK[level] < RANK[best])) best = level
    }
    if (best !== null) matched.push({ level: best, can: grant.can, source: { grant } })
  }
  return matched
}

/** Whether anything but `everyone` lets the caller in: a grant, or, for a person, the team. */
export function admits<G extends DecidingGrant>(facts: GrantFacts<G>, matched: readonly Matched<GrantSource<G>>[] = matchedFor(facts)): boolean {
  if (facts.caller.kind === 'user' && facts.member === true) return true
  return matched.some((found) => found.level !== 'everyone')
}

/** `access`, capped and narrowed by its token. */
function limited(access: Access, facts: GrantFacts<DecidingGrant>): Access {
  let out = facts.cap === undefined ? access : access.narrow({ '*': [...facts.cap] })
  if (facts.can !== undefined) out = out.narrow(compileAccess(facts.can))
  return out
}

/**
 * What the caller may do by the board's grants: `caller`, all of it, as `GET /me` says, and `own`,
 * the same without `everyone`'s grants, what `checkGrantChange` judges reach by. At each channel the
 * most specific pattern a grant naming it gives decides, then the closest principal there, and
 * grants tied there add up; `cap` caps both, and a token's `can` narrows them. Null when
 * nothing but `everyone` names it, since `everyone` lets no one in itself.
 */
export function grantAccess<G extends DecidingGrant>(facts: GrantFacts<G>): { caller: Access; own: Access } | null {
  const matched = matchedFor(facts)
  if (!admits(facts, matched)) return null
  return { caller: limited(combine(matched), facts), own: limited(combine(matchedFor(facts, true)), facts) }
}

/**
 * Which grants decide `channel` for the caller: the `pattern` that wins there, the patterns it wins
 * `over`, most specific first, the `level` that wins at it, the `grants` at that level, which add
 * up, and what the caller may do there, `permissions`, after its `cap` and its token's `can`.
 * `capped` says whether the cap took anything away. `pattern` and `level` are null for a caller
 * nothing lets in, whose `permissions` are empty. What `grantAccess` gives, explained.
 */
export type GrantExplanation<G extends DecidingGrant = DecidingGrant> = {
  pattern: string | null
  over: string[]
  level: Level | null
  grants: G[]
  capped: boolean
  permissions: Permission[]
}

/** Which grants decide `channel` for the caller `facts` describes, from plain data, as a board explains it. */
export function explainGrants<G extends DecidingGrant>(facts: GrantFacts<G>, channel: string): GrantExplanation<G> {
  const matched = matchedFor(facts)
  if (!admits(facts, matched)) return { pattern: null, over: [], level: null, grants: [], capped: false, permissions: [] }
  const decision = decide(matched, channel)
  const cap = facts.cap === undefined ? null : compileAccess({ '*': [...facts.cap] })
  const capped = cap ? decision.permissions.filter((permission) => cap.can(permission, channel)) : [...decision.permissions]
  const token = facts.can === undefined ? null : compileAccess(facts.can)
  return {
    pattern: decision.pattern,
    over: [...decision.over],
    level: decision.level,
    grants: decision.sources.map((source) => source.grant),
    capped: capped.length < decision.permissions.length,
    permissions: token ? capped.filter((permission) => token.can(permission, channel)) : capped,
  }
}
