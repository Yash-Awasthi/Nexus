// How `grants create`, `update`, and `explain` read their flags, and how explain says its answer.
// A principal flag starts a principal, and the modifiers after it (`--environment`, `--workflow`,
// `--claim`, …) belong to it, so the flags are read in the order they were typed: a parser that
// groups values by name would lose which principal each modifier is for.
import type { Protocol } from '../api/protocol.ts'
import type { Explanation } from '../api/routes.ts'
import type { ExplainPrincipal } from '../client/client.ts'
import { PERMISSIONS, type Permission } from '../server/access.ts'
import type { Recovery } from './failure.ts'

/** An option as it was typed, in order: its name without the dashes, and its value. */
export type OptionToken = { name: string; value: string | undefined }

/** What's wrong with the flags, as misuse: the headline, and its ways out when they aren't help. */
export class GrantMisuse extends Error {
  readonly next: Recovery[] | undefined
  constructor(message: string, next?: Recovery[]) {
    super(message)
    this.next = next
  }
}

type PrincipalInput = Protocol['createGrant']['input']['principals'][number]
type GrantCan = Record<string, 'all' | Permission[]>

/** What starts a principal, after `--`, `--add-`, or `--remove-`. */
export const KINDS = ['user', 'project', 'github', 'oidc', 'app', 'all-users', 'all-projects', 'all-apps', 'everyone'] as const
type Kind = (typeof KINDS)[number]
export type Prefix = '' | 'add-' | 'remove-'

/** Each modifier, and the principals it fits. */
const MODIFIERS: Record<string, readonly Kind[]> = {
  environment: ['project', 'all-projects'],
  workflow: ['github'],
  'git-branch': ['github'],
  event: ['github'],
  claim: ['oidc'],
}
const fits = (modifier: string) => MODIFIERS[modifier]!.map((kind) => `--${kind}`).join(' or ')

type Started = {
  prefix: Prefix
  kind: Kind
  value: string | undefined
  environments?: string[]
  workflow?: string
  branch?: string
  event?: string
  claims?: Record<string, string | string[]>
}

const flagOf = (started: Started) => `--${started.prefix}${started.kind}${started.value !== undefined ? ` ${started.value}` : ''}`

/** The principals the flags name, each with the prefix its flag had, in the order they were typed. */
export function principalsIn(tokens: readonly OptionToken[], prefixes: readonly Prefix[], removal?: (started: { kind: string; value: string | undefined }) => Recovery[]): { prefix: Prefix; principal: PrincipalInput }[] {
  const started: Started[] = []
  for (const { name, value } of tokens) {
    const prefix = prefixes.find((candidate) => (KINDS as readonly string[]).includes(name.slice(candidate.length)) && name.startsWith(candidate))
    if (prefix !== undefined) {
      const kind = name.slice(prefix.length) as Kind
      if (kind === 'github' && !/^[^/\s]+\/[^/\s]+$/.test(value ?? '')) throw new GrantMisuse(`--${name} takes owner/repo, like acme/web: got ${value}.`)
      started.push({ prefix, kind, value })
      continue
    }
    if (!Object.hasOwn(MODIFIERS, name)) continue
    const last = started.at(-1)
    if (!last) throw new GrantMisuse(`--${name} goes after the ${fits(name)} it's for.`)
    if (!MODIFIERS[name]!.includes(last.kind)) throw new GrantMisuse(`--${name} is for ${fits(name)}, not ${flagOf(last)}.`)
    const given = value ?? ''
    switch (name) {
      case 'environment': {
        // A removal goes by who it is: the project, whatever its environments.
        if (last.prefix === 'remove-')
          throw new GrantMisuse(`${flagOf(last)} removes it whatever its environments, so it takes no --environment.`, removal?.({ kind: last.kind, value: last.value }))
        const environments = given.split(',').map((environment) => environment.trim())
        if (environments.some((environment) => environment === '')) throw new GrantMisuse(`--environment takes environments, comma-separated, like production,preview: got ${JSON.stringify(given)}.`)
        last.environments = [...new Set([...(last.environments ?? []), ...environments])]
        break
      }
      case 'workflow':
      case 'git-branch':
      case 'event': {
        // `--git-branch` is the principal's `branch`, as the Vercel CLI names a Git branch.
        const field = name === 'git-branch' ? 'branch' : name
        if (last[field] !== undefined) throw new GrantMisuse(`${flagOf(last)} takes one --${name}: name the repository again for another.`)
        last[field] = given
        break
      }
      case 'claim': {
        const at = given.indexOf('=')
        if (at <= 0) throw new GrantMisuse(`--claim takes name=value, like project_id=42: got ${JSON.stringify(given)}.`)
        const claims = (last.claims ??= {})
        const [claim, one] = [given.slice(0, at), given.slice(at + 1)]
        const had = claims[claim]
        claims[claim] = had === undefined ? one : [...[had].flat(), one]
        break
      }
    }
  }
  return started.map((one) => ({ prefix: one.prefix, principal: inputOf(one) }))
}

/** A principal as the handle takes it, which makes a project's environments production when they're left out. */
function inputOf(started: Started): PrincipalInput {
  const { environments } = started
  const value = started.value!
  switch (started.kind) {
    case 'user':
      return value.includes('@') ? { kind: 'user', email: value } : { kind: 'user', userId: value }
    case 'project':
      return { kind: 'project', project: value, ...(environments ? { environments } : {}) }
    case 'github':
      return {
        kind: 'github',
        repository: value,
        ...(started.workflow !== undefined ? { workflow: started.workflow } : {}),
        ...(started.branch !== undefined ? { branch: started.branch } : {}),
        ...(started.event !== undefined ? { event: started.event } : {}),
      }
    case 'oidc':
      return { kind: 'oidc', issuer: value, claims: started.claims ?? {} }
    case 'app':
      return { kind: 'app', app: value }
    case 'all-projects':
      return { kind: 'all-projects', ...(environments ? { environments } : {}) }
    default:
      return { kind: started.kind }
  }
}

/** Each pattern `--can` flags name, as typed: what a grant made with them reaches. */
export const patternsIn = (values: readonly string[]): string[] => [
  ...new Set(values.flatMap((value) => value.split(';')).map((entry) => entry.slice(0, Math.max(entry.indexOf('='), 0)).trim()).filter(Boolean)),
]

const WORDS: readonly string[] = [...PERMISSIONS, 'all', 'none']

/**
 * A grant's `can`, from each `--can pattern=permissions`, repeated or `;`-joined: `all` for every
 * permission and `none` for no permissions, each alone. The board keeps it as written.
 */
export function grantCanOf(values: readonly string[]): GrantCan {
  const can: Record<string, 'all' | Permission[]> = {}
  for (const entry of values.flatMap((value) => value.split(';')).map((one) => one.trim()).filter(Boolean)) {
    const at = entry.indexOf('=')
    if (at <= 0) throw new GrantMisuse(`--can takes pattern=permissions, like ci/=read,post: got ${JSON.stringify(entry)}.`)
    const pattern = entry.slice(0, at).trim()
    if (Object.hasOwn(can, pattern)) throw new GrantMisuse(`--can names ${pattern} twice: say it once, with every permission it gives.`)
    const words = entry
      .slice(at + 1)
      .split(',')
      .map((word) => word.trim())
      .filter(Boolean)
    for (const word of words) if (!WORDS.includes(word)) throw new GrantMisuse(`--can: ${word} isn't a permission. Permissions are ${WORDS.slice(0, -1).join(', ')}, or ${WORDS.at(-1)}.`)
    for (const alone of ['all', 'none'])
      if (words.includes(alone) && words.length > 1)
        throw new GrantMisuse(`--can: ${alone} is ${alone === 'all' ? 'every permission' : 'no permissions'}, so it goes alone: ${pattern}=${alone}.`)
    can[pattern] = words[0] === 'all' ? 'all' : words[0] === 'none' ? [] : (words as Permission[])
  }
  return can
}

/** Whom explain asks about, from the one principal its flags name, as the board takes it. */
export function explainPrincipalOf(tokens: readonly OptionToken[]): { principal: ExplainPrincipal; subject: string | null; kind: Kind | null } {
  const named = principalsIn(tokens, [''])
  if (named.length === 0) return { principal: {}, subject: null, kind: null }
  if (named.length > 1) throw new GrantMisuse('explain asks about one principal at a time.')
  const { principal } = named[0]!
  switch (principal.kind) {
    case 'user': {
      const user = principal.email ?? principal.userId!
      return { principal: { user }, subject: user, kind: 'user' }
    }
    case 'project': {
      const environments = principal.environments ?? []
      if (environments.length > 1) throw new GrantMisuse(`explain asks about one environment at a time: --environment ${environments[0]}.`)
      const environment = environments[0] ?? 'production'
      return { principal: { project: principal.project, environment }, subject: `${principal.project} in ${environment}`, kind: 'project' }
    }
    case 'github': {
      const { repository, workflow, branch, event } = principal
      return { principal: { github: repository, ...(workflow ? { workflow } : {}), ...(branch ? { branch } : {}), ...(event ? { event } : {}) }, subject: repository, kind: 'github' }
    }
    case 'oidc': {
      const claims: Record<string, string> = {}
      for (const [name, value] of Object.entries(principal.claims)) {
        if (Array.isArray(value)) throw new GrantMisuse(`explain asks about one token: give --claim ${name} once.`)
        claims[name] = value as string
      }
      return { principal: { oidc: principal.issuer, claims }, subject: principal.issuer, kind: 'oidc' }
    }
    case 'app':
      return { principal: { app: principal.app }, subject: principal.app, kind: 'app' }
    default:
      throw new GrantMisuse(`explain asks about someone: --user, --project, --github, --oidc, or --app, not --${principal.kind}.`)
  }
}

/** Permissions as `--can` writes them: `all` for every one, `none` for none. */
const canWords = (can: readonly Permission[]) => (can.length === PERMISSIONS.length ? 'all' : can.length === 0 ? 'none' : can.join(','))

/** The principal flag a level names, for whom explain asked about: `--user`, `--all-projects`, `--everyone`. */
function levelFlag(level: NonNullable<Explanation['level']>, kind: Kind | null, grants: Explanation['grants']): string | null {
  if (level === 'everyone') return '--everyone'
  const kinds = [...new Set(grants.flatMap((grant) => grant.principals.map((principal) => principal.kind)))]
  const group = level === 'group'
  const of = kinds.filter((one) => (one === 'all-users' || one === 'all-projects' || one === 'all-apps') === group && one !== 'everyone')
  if (group) {
    if (kind === 'user') return '--all-users'
    if (kind === 'project') return '--all-projects'
    if (kind === 'app') return '--all-apps'
    return of.length === 1 ? `--${of[0]}` : null
  }
  if (kind !== null) return `--${kind}`
  return of.length === 1 ? `--${of[0]}` : null
}

/**
 * Explain's answer in a sentence or two: which pattern won, and over what; the closest grants
 * there; and what they give.
 * `security/ wins over *. Closest grant for bob@acme.com: g4 (--user): all.`
 */
export function explanationLine(answer: Explanation, subject: string | null, kind: Kind | null): string {
  const whom = subject ?? 'you'
  const given = `${canWords(answer.can)}${answer.capped !== null ? `, capped by the ${answer.capped} role` : ''}`
  if (answer.pattern === null || answer.level === null) {
    if (answer.can.length === 0) return `Nothing lets ${whom} into ${answer.channel}.`
    return `The board lets ${whom} in itself, outside its grants: ${given}.`
  }
  const wins = answer.over.length > 0 ? `${answer.pattern} wins over ${answer.over.join(', ')}.` : `${answer.pattern} wins.`
  const flag = levelFlag(answer.level, kind, answer.grants)
  const at = flag ? ` (${flag})` : ''
  const which = answer.grants.map((grant) => `${grant.id}${at}`)
  // Grants name whom else they let in, so a caller that can't list them sees only that they're there.
  const closest = which.length > 0 ? `${which.length === 1 ? 'grant' : 'grants'} for ${whom}: ${which.join(', ')}` : `grant for ${whom}: ${flag ? `a ${flag} grant` : 'one'} you can't list`
  return `${wins} Closest ${closest}: ${given}.`
}
