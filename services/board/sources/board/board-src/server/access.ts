import { ChannelPath, CAN_MAX } from '../contract/schemas.ts'
import { forbidden } from './errors.ts'

/**
 * What a principal may do in a channel. `read` covers messages, threads,
 * `/events`, and schedules; `post` starts threads and edits your own messages;
 * `manage` is the board's own bookkeeping (inbox, sources).
 */
export const PERMISSIONS = ['read', 'post', 'react', 'label', 'sync', 'manage'] as const

/**
 * A `can`, a channel pattern, a permission, or a scope that doesn't parse, saying what to write
 * instead: what a board answers 400 for. Its `code` is `invalid_can`.
 */
export class InvalidCan extends Error {
  readonly code = 'invalid_can'
  constructor(message: string) {
    super(message)
    this.name = 'InvalidCan'
  }
}
export type Permission = (typeof PERMISSIONS)[number]

/**
 * One hop of implication, kept as data like Vercel's git broker
 * (`ACTION_IMPLICATIONS`). Each verb that addresses a message by ID implies
 * `read`, so none of them is a blind existence oracle. `post` implies nothing:
 * write-only is `['post']`.
 */
export const IMPLIES: Readonly<Record<Permission, readonly Permission[]>> = {
  read: [],
  post: [],
  react: ['read'],
  label: ['read'],
  sync: ['read'],
  manage: ['read', 'post', 'react', 'label', 'sync'],
}

/** `*`, a channel (`feedback`), or a channel and its subtree (`feedback/`). */
export type ChannelPattern = string
export type Grant = 'all' | readonly Permission[]
/** `'all'`, a list for every channel (`['post']` is `{ '*': ['post'] }`), or a map from pattern to grant. */
export type Can = Grant | Readonly<Record<ChannelPattern, Grant>>
/** Each pattern's whole answer, implications included. */
export type AccessSummary = Readonly<Record<ChannelPattern, readonly Permission[]>>

type Pattern = { kind: 'all' } | { kind: 'exact'; path: string } | { kind: 'subtree'; path: string }

const ORDER = new Map(PERMISSIONS.map((permission, index) => [permission, index]))
const SHAPE = 'write *, a channel, or a channel and its subtree (feedback/)'

/** A pattern's parts; any other `*` throws, and says what to type instead. */
export function parsePattern(pattern: string): Pattern {
  if (pattern === '*') return { kind: 'all' }
  if (pattern.includes('*')) {
    const before = pattern.slice(0, pattern.indexOf('*')).replace(/\/+$/, '')
    const hint =
      before === ''
        ? 'write * for every channel'
        : ChannelPath.safeParse(before).success
          ? `write ${before}/ for ${before} and its subtree`
          : SHAPE
    throw new InvalidCan(`invalid channel pattern ${pattern}: ${hint}`)
  }
  const subtree = pattern.endsWith('/')
  const path = subtree ? pattern.slice(0, -1) : pattern
  if (!ChannelPath.safeParse(path).success) throw new InvalidCan(`invalid channel pattern ${pattern || '(empty)'}: ${SHAPE}`)
  return subtree ? { kind: 'subtree', path } : { kind: 'exact', path }
}

const key = (pattern: Pattern) =>
  pattern.kind === 'all' ? '*' : pattern.kind === 'subtree' ? `${pattern.path}/` : pattern.path

/** A grant with its implications, closed: `['label']` is `read` and `label`. */
export function expand(grant: Grant): ReadonlySet<Permission> {
  const out = new Set<Permission>()
  const add = (permission: Permission) => {
    if (!ORDER.has(permission)) throw new InvalidCan(`unknown permission ${String(permission)}: use ${PERMISSIONS.join(', ')}`)
    if (out.has(permission)) return
    out.add(permission)
    for (const implied of IMPLIES[permission]) add(implied)
  }
  for (const permission of grant === 'all' ? PERMISSIONS : grant) add(permission)
  return out
}

const NOTHING: ReadonlySet<Permission> = new Set()

/** Rules compiled for resolution: an exact channel beats the longest subtree, which beats `*`. */
type Rules = {
  all: ReadonlySet<Permission> | null
  exact: ReadonlyMap<string, ReadonlySet<Permission>>
  /** Longest path first. */
  subtrees: readonly (readonly [string, ReadonlySet<Permission>])[]
}

type Entry = readonly [Pattern, ReadonlySet<Permission>]

function compile(entries: Iterable<Entry>): Rules {
  let all: ReadonlySet<Permission> | null = null
  const exact = new Map<string, ReadonlySet<Permission>>()
  const subtrees: [string, ReadonlySet<Permission>][] = []
  for (const [pattern, permissions] of entries) {
    if (pattern.kind === 'all') all = permissions
    else if (pattern.kind === 'exact') exact.set(pattern.path, permissions)
    else subtrees.push([pattern.path, permissions])
  }
  subtrees.sort((a, b) => b[0].length - a[0].length)
  return { all, exact, subtrees }
}

const under = (channel: string, path: string) => channel === path || channel.startsWith(`${path}/`)

/** What the most specific pattern covering `channel` gives; with `subtreeOnly`, ignoring an exact rule for it. */
function resolve(rules: Rules, channel: string, subtreeOnly = false): ReadonlySet<Permission> {
  if (!subtreeOnly) {
    const exact = rules.exact.get(channel)
    if (exact) return exact
  }
  for (const [path, permissions] of rules.subtrees) if (under(channel, path)) return permissions
  return rules.all ?? NOTHING
}

/**
 * What `rules` gives every channel `pattern` governs where nothing more
 * specific does. The patterns matching one channel form a chain, so that's one
 * answer: an exact channel resolves as itself, a subtree as whatever covers the
 * subtree's root, ignoring an exact rule for the root.
 */
const at = (rules: Rules, pattern: Pattern) =>
  pattern.kind === 'all' ? (rules.all ?? NOTHING) : resolve(rules, pattern.path, pattern.kind === 'subtree')

const equal = (a: ReadonlySet<Permission>, b: ReadonlySet<Permission>) =>
  a.size === b.size && [...a].every((permission) => b.has(permission))

/** The answer of the pattern next less specific than `pattern` in `rules`. */
function parent(rules: Rules, pattern: Pattern): ReadonlySet<Permission> {
  if (pattern.kind === 'exact') return resolve(rules, pattern.path, true)
  if (pattern.kind === 'subtree')
    for (const [path, permissions] of rules.subtrees)
      if (path !== pattern.path && under(pattern.path, path)) return permissions
  return rules.all ?? NOTHING
}

/** Drops rules that say what their parent says, and an empty `*`, so equal access has one summary. */
function canonical(entries: Entry[]): Rules {
  const rules = compile(entries)
  return compile(
    entries.filter(([pattern, permissions]) =>
      pattern.kind === 'all' ? permissions.size > 0 : !equal(permissions, parent(rules, pattern)),
    ),
  )
}

function entriesOf(can: Can): Entry[] {
  if (can === 'all' || Array.isArray(can)) return [[{ kind: 'all' }, expand(can as Grant)]]
  return Object.entries(can as Record<string, Grant>).map(([pattern, grant]) => [parsePattern(pattern), expand(grant)] as const)
}

const entriesIn = (rules: Rules): Entry[] => [
  ...(rules.all ? [[{ kind: 'all' }, rules.all] as const] : []),
  ...rules.subtrees.map(([path, permissions]) => [{ kind: 'subtree', path }, permissions] as const),
  ...[...rules.exact].map(([path, permissions]) => [{ kind: 'exact', path }, permissions] as const),
]

export type Access = {
  can(permission: Permission, channel: string): boolean
  /** The hot path for feeds: memoized per channel. */
  readable(channel: string): boolean
  /** `read` in every channel, including ones that don't exist yet. */
  readsAll: boolean
  /** `permission` in every channel, including ones that don't exist yet: `everywhere('manage')` is full access. */
  everywhere(permission: Permission): boolean
  /** `permission` in some channel. */
  anywhere(permission: Permission): boolean
  /**
   * `permission` where `pattern` itself decides: at `*`, what `*` gives, whatever a more specific
   * pattern says; at `security/`, what covers `security` as a subtree. `checkGrantChange` checks
   * `manage` this way.
   */
  at(permission: Permission, pattern: ChannelPattern): boolean
  /** Only what both this and `scope` allow, channel by channel. It never widens. */
  narrow(scope: Can | Access): Access
  /** Each pattern and its permissions, `*` first and the rest sorted; an empty `*` is left out. */
  summary(): AccessSummary
}

const RULES = Symbol('board.access')
/** How many channels an access remembers whether it may read. */
const READABLE_MAX = 4096
type Compiled = Access & { readonly [RULES]: Rules }
const isAccess = (value: Can | Access): value is Compiled => typeof value === 'object' && RULES in value

function fromRules(rules: Rules): Access {
  const entries = entriesIn(rules)
  const everywhere = (permission: Permission) =>
    (rules.all?.has(permission) ?? false) && entries.every(([, permissions]) => permissions.has(permission))
  // One that names nothing but `*` answers the same everywhere, so it remembers nothing; another
  // remembers at most READABLE_MAX channels, starting over when it's full, so a long-lived one
  // (FULL_ACCESS, a rule's) doesn't keep every channel name it was ever asked about.
  const uniform = rules.exact.size === 0 && rules.subtrees.length === 0 ? (rules.all?.has('read') ?? false) : null
  const readable = new Map<string, boolean>()
  const compiled: Compiled = {
    [RULES]: rules,
    can: (permission, channel) => resolve(rules, channel).has(permission),
    readable(channel) {
      if (uniform !== null) return uniform
      let found = readable.get(channel)
      if (found === undefined) {
        if (readable.size >= READABLE_MAX) readable.clear()
        readable.set(channel, (found = resolve(rules, channel).has('read')))
      }
      return found
    },
    readsAll: everywhere('read'),
    everywhere,
    anywhere: (permission) => entries.some(([, permissions]) => permissions.has(permission)),
    at: (permission, pattern) => at(rules, parsePattern(pattern)).has(permission),
    narrow(scope) {
      const other = isAccess(scope) ? scope[RULES] : canonical(entriesOf(scope as Can))
      // `*` and every pattern either side names: each governs channels where both answers are fixed.
      const patterns = new Map<string, Pattern>([['*', { kind: 'all' }]])
      for (const [pattern] of [...entries, ...entriesIn(other)]) patterns.set(key(pattern), pattern)
      return fromRules(
        canonical(
          [...patterns.values()].map((pattern) => {
            const theirs = at(other, pattern)
            return [pattern, new Set([...at(rules, pattern)].filter((permission) => theirs.has(permission)))] as const
          }),
        ),
      )
    },
    summary() {
      const named = entries.map(([pattern, permissions]) => [key(pattern), permissions] as const)
      named.sort(([a], [b]) => (a === '*' ? -1 : b === '*' ? 1 : a.localeCompare(b)))
      const out: Record<ChannelPattern, Permission[]> = {}
      for (const [name, permissions] of named) out[name] = [...permissions].sort((a, b) => ORDER.get(a)! - ORDER.get(b)!)
      return out
    },
  }
  // Board hands the same objects to its own code and principals (FULL_ACCESS), so no importer may change one.
  return Object.freeze(compiled)
}

/** Access from config: `'all'`, a list for every channel, or a map from pattern to grant. Throws on a bad pattern or permission. */
export function compileAccess(can: Can): Access {
  return fromRules(canonical(entriesOf(can)))
}

export const FULL_ACCESS = compileAccess('all')
const NO_ACCESS = compileAccess([])

/** What any of `accesses` allows, channel by channel: grants that match one principal add up. */
export function union(accesses: readonly Access[]): Access {
  const all = accesses.filter(isAccess)
  if (all.length === 0) return NO_ACCESS
  const rules = all.map((access) => access[RULES])
  // `*` and every pattern any side names: each governs channels where every answer is fixed.
  const patterns = new Map<string, Pattern>([['*', { kind: 'all' }]])
  for (const side of rules) for (const [pattern] of entriesIn(side)) patterns.set(key(pattern), pattern)
  return fromRules(canonical([...patterns.values()].map((pattern) => [pattern, new Set(rules.flatMap((side) => [...at(side, pattern)]))] as const)))
}

/** A grant's `can` as it was written: each pattern and `'all'` or its permissions, `[]` for none. */
export type WrittenCan = Readonly<Record<ChannelPattern, 'all' | readonly Permission[]>>

/**
 * A grant's `can`, checked and kept as written, patterns and all, since each pattern counts where
 * grants meet: `{ 'security/': [] }` closes `security/` though it gives nothing. Its lists are
 * sorted, without repeats. A bad pattern or permission throws, saying what to write.
 */
export function writtenCan(can: unknown, max = 64): WrittenCan {
  if (typeof can !== 'object' || can === null || Array.isArray(can))
    throw new InvalidCan("a grant's can is a map from channel pattern to permissions, like { 'ci/': ['read', 'post'] }")
  const entries = Object.entries(can as Record<string, unknown>)
  if (entries.length === 0) throw new InvalidCan("a grant's can names at least one channel pattern, like { '*': ['read'] }")
  if (entries.length > max) throw new InvalidCan(`a grant's can names at most ${max} channel patterns`)
  const out: Record<ChannelPattern, 'all' | Permission[]> = {}
  for (const [pattern, grant] of entries.sort(([a], [b]) => (a === '*' ? -1 : b === '*' ? 1 : a.localeCompare(b)))) {
    parsePattern(pattern)
    if (grant === 'all') {
      out[pattern] = 'all'
      continue
    }
    if (!Array.isArray(grant)) throw new InvalidCan(`${pattern} takes 'all' or a list of permissions: ${PERMISSIONS.join(', ')}`)
    for (const permission of grant)
      if (!ORDER.has(permission as Permission)) throw new InvalidCan(`unknown permission ${String(permission)} at ${pattern}: use ${PERMISSIONS.join(', ')}, or all`)
    out[pattern] = [...new Set(grant as Permission[])].sort((a, b) => ORDER.get(a)! - ORDER.get(b)!)
  }
  return out
}

/** Each pattern a written `can` names. */
export const patternsOf = (can: WrittenCan): ChannelPattern[] => Object.keys(can)

/**
 * How close a grant's principal is to a caller: one named principal (a user, a project, a
 * repository's workflows, an issuer's claims), a group of them (`all-users`, `all-projects`), or
 * `everyone`. The closest decides where grants name the same pattern.
 */
export const LEVELS = ['principal', 'group', 'everyone'] as const
export type Level = (typeof LEVELS)[number]

/** A grant that matched a caller: how close its principal is, and what its `can` gives at each pattern. */
export type Matched<Source = unknown> = { level: Level; can: Can; source: Source }

/** What `decide` found for one channel: the pattern that won, the others it won over, the level that won there, the sources at it, and what they give. */
export type Decision<Source = unknown> = {
  pattern: ChannelPattern | null
  /** The other patterns the matched grants name that cover the channel, most specific first. */
  over: ChannelPattern[]
  level: Level | null
  sources: Source[]
  permissions: readonly Permission[]
}

const RANK = new Map(LEVELS.map((level, index) => [level, index]))

/** Each pattern a `can` names, with what it gives, implications included. */
const namedIn = (can: Can): Entry[] => entriesOf(can)

/**
 * For each pattern any matched grant names: the closest level among the grants naming it, and
 * what those grants give there, added up.
 */
function closest<Source>(matched: readonly Matched<Source>[]) {
  const byPattern = new Map<string, { pattern: Pattern; level: Level; permissions: Set<Permission>; sources: Source[] }>()
  for (const grant of matched)
    for (const [pattern, permissions] of namedIn(grant.can)) {
      const name = key(pattern)
      const found = byPattern.get(name)
      if (!found || RANK.get(grant.level)! < RANK.get(found.level)!)
        byPattern.set(name, { pattern, level: grant.level, permissions: new Set(permissions), sources: [grant.source] })
      else if (found.level === grant.level) {
        for (const permission of permissions) found.permissions.add(permission)
        if (!found.sources.includes(grant.source)) found.sources.push(grant.source)
      }
    }
  return byPattern
}

/**
 * What a caller may do from the grants that match it. At each channel, the most specific pattern
 * any of them names decides (an exact channel, then the longest subtree, then `*`); among the
 * grants naming that pattern, the closest principal does; and grants tied there add up.
 */
export function combine(matched: readonly Matched[]): Access {
  return fromRules(canonical([...closest(matched).values()].map(({ pattern, permissions }) => [pattern, permissions] as const)))
}

/** Which pattern, level, and grants decide `channel` for a caller, and what they give: `combine`'s answer, explained. */
export function decide<Source>(matched: readonly Matched<Source>[], channel: string): Decision<Source> {
  const byPattern = closest(matched)
  const covering = [...byPattern.values()].filter(({ pattern }) =>
    pattern.kind === 'all' ? true : pattern.kind === 'exact' ? pattern.path === channel : under(channel, pattern.path),
  )
  // An exact channel, then the longest subtree, then `*`.
  const specificity = ({ pattern }: { pattern: Pattern }) => (pattern.kind === 'exact' ? Infinity : pattern.kind === 'subtree' ? pattern.path.length : -1)
  const [winner, ...beaten] = covering.sort((a, b) => specificity(b) - specificity(a))
  if (!winner) return { pattern: null, over: [], level: null, sources: [], permissions: [] }
  return {
    pattern: key(winner.pattern),
    over: beaten.map(({ pattern }) => key(pattern)),
    level: winner.level,
    sources: winner.sources,
    permissions: [...winner.permissions].sort((a, b) => ORDER.get(a)! - ORDER.get(b)!),
  }
}

/** An access as `x-board-can` writes it, `dev/=read,post;ci/=read`, or `*=` for nothing: what a stored principal keeps. */
export function canText(access: Access): string {
  const entries = Object.entries(access.summary()).map(([pattern, permissions]) => `${pattern}=${permissions.join(',')}`)
  return entries.length > 0 ? entries.join(';') : '*='
}

/**
 * `x-board-can`: `dev/=read,post,react,label;ci/=read`. Each entry is a
 * pattern and its permissions (or `all`). It's meant for a proxy that holds the
 * credential, like Pi's sandbox: the board intersects it with the principal's
 * access, so it can only narrow, and a caller holding its own token gains
 * nothing by sending it. `name` is what its errors call it: the CLI's `--can` writes the same.
 */
export function parseCan(header: string, name = 'x-board-can'): Can {
  if (header.length > CAN_MAX) throw new InvalidCan(`${name} is longer than ${CAN_MAX} characters`)
  const out: Record<ChannelPattern, Grant> = {}
  const entries = header.split(';').map((entry) => entry.trim())
  if (entries.every((entry) => entry === '')) throw new InvalidCan(`${name} is empty: write pattern=permissions, like dev/=read,post`)
  for (const entry of entries) {
    if (entry === '') continue
    const split = entry.indexOf('=')
    if (split < 0) throw new InvalidCan(`${name} entry ${entry} needs =: write pattern=permissions, like dev/=read,post`)
    const pattern = entry.slice(0, split).trim()
    const list = entry.slice(split + 1).trim()
    if (Object.hasOwn(out, pattern)) throw new InvalidCan(`${name} lists ${pattern} twice`)
    parsePattern(pattern)
    const permissions = list === '' ? [] : list.split(',').map((permission) => permission.trim())
    if (permissions.length === 1 && permissions[0] === 'all') {
      out[pattern] = 'all'
      continue
    }
    for (const permission of permissions)
      if (!ORDER.has(permission as Permission))
        throw new InvalidCan(`${name}: unknown permission ${permission || '(empty)'}: use ${PERMISSIONS.join(', ')}, or all`)
    out[pattern] = permissions as Permission[]
  }
  return out
}

declare const proven: unique symbol
/**
 * That `permission` was checked in `channel`. Write functions take one, look
 * their target up themselves, and refuse a target in another channel, so a
 * check made against one channel can't be spent on another.
 * Only `authorize` makes one.
 */
export type Proof<P extends Permission = Permission> = {
  readonly permission: P
  readonly channel: string
  readonly [proven]: true
}

const PHRASE: Record<Permission, (channel: string) => string> = {
  read: (channel) => `read ${channel}`,
  post: (channel) => `post in ${channel}`,
  react: (channel) => `react in ${channel}`,
  label: (channel) => `label in ${channel}`,
  sync: (channel) => `sync in ${channel}`,
  manage: (channel) => `manage ${channel}`,
}

/**
 * A proof that `access` allows `permission` in `channel`, or a 403 naming what's
 * missing: `this token can't label in dev`. Pass the channel the board looked
 * up, never one the request named. What the caller can't read should answer as
 * if it didn't exist: pass that error as `hidden`, and it's thrown instead
 * whenever `channel` isn't readable.
 */
export function authorize<P extends Permission>(
  access: Access,
  permission: P,
  channel: string,
  hidden?: () => Error,
): Proof<P> {
  if (hidden && !access.readable(channel)) throw hidden()
  if (!access.can(permission, channel)) throw forbidden(`this token can't ${PHRASE[permission](channel)}`)
  return Object.freeze({ permission, channel }) as unknown as Proof<P>
}

/** A grant as `checkGrantChange` reads it: whom it names, by kind, and what it gives where. */
export type GrantShape = { readonly principals: readonly { readonly kind: string }[]; readonly can: WrittenCan }

/** A change that makes or widens a grant, as `checkGrantChange` judges it. */
export type GrantChange = {
  /**
   * What the caller may do, narrowed by its token, on the grants the change applies to: what
   * `GET /me` says. For an owner a token narrows, what its token's `can` gives.
   */
  caller: Access
  /**
   * What the caller may do by its own limits alone: `caller` without `everyone` grants, so its role,
   * the grants that name it or a group it's in, and its token. For an owner a token narrows, `caller`.
   */
  own: Access
  /** An owner no token narrows, whom nothing here limits. */
  owner?: boolean
  /** Every grant as it would be after the change, the changed one included. */
  after: readonly GrantShape[]
  /** The grant made or widened, as it would be after the change: judged by reach and admission. */
  changed?: { readonly can: WrittenCan }
  /**
   * A grant revoked, or the one principals are removed from, or an update's grant as it was:
   * judged by reach alone. Lifting what it held back widens whoever it named, but lets no one new in.
   */
  revoked?: { readonly can: WrittenCan }
  /**
   * What the caller may do once the change has landed, as `caller` and `own` are on the grants it
   * applies to: judged for a lockout. Left out, as for a caller that said to go ahead, none is.
   */
  then?: { readonly caller: Access; readonly own: Access }
}

/**
 * Why `checkGrantChange` refuses a change, and where: `pattern` is the spot it failed at. A
 * `lockout` is a change the caller may make, and couldn't take back.
 */
export type GrantChangeRefusal =
  | { reason: 'reach'; pattern: ChannelPattern; permission: 'manage' }
  | { reason: 'admission'; pattern: ChannelPattern; permission: Permission }
  | { reason: 'lockout'; pattern: ChannelPattern; permission: 'manage' }

/** Whether `other` is a pattern more specific than `pattern`, and under it. */
const isUnder = (other: string, pattern: string) =>
  other !== pattern && (pattern === '*' || (pattern.endsWith('/') && (other === pattern.slice(0, -1) || other.startsWith(pattern))))

/**
 * Whether a caller may change grants so: make or widen one (`changed`), or revoke one or remove
 * from it (`revoked`). You can't grant what you don't have. Your token's and your own grants'
 * limits count, an `everyone` lock doesn't, and anyone you let in gets what `everyone` gets. Null
 * when it may; otherwise why not, and where.
 *
 * - **Reach:** `manage` at each of the changed grant's patterns, by `caller` and by `own`, and at
 *   every more specific spot under them by `own`. A lock binds whoever the grant names as much as
 *   the caller, now and once it's lifted, so it doesn't count against the caller there; the
 *   caller's own limits do. At the grant's own patterns it counts too: there the grant would meet
 *   the lock at the same pattern, and its principal is closer.
 * - **Admission:** wherever `everyone` gives something, `caller` has it too, since any principal a
 *   grant lets in gets what `everyone` gives. A revoke or a removal lets no one in, so it's judged
 *   by reach alone, at the patterns of the grant as it was.
 * - **Lockout:** a change that passes both, and takes the caller's own `manage` at a pattern it
 *   names, is one the caller couldn't take back: closing `security/` to everyone closes it to
 *   whoever closes it, unless a grant keeps them in. Judged only with `then`, what the caller may
 *   do once the change has landed, so a caller that says to go ahead is let through.
 *
 * It looks only at the spots where access can change: the grants' patterns, the `everyone`
 * grants', and the caller's own, from `summary()`. It does no I/O, so a board and Vercel's API run
 * the same rule.
 */
export function checkGrantChange(change: GrantChange): GrantChangeRefusal | null {
  if (change.owner) return null
  const { caller, own, then } = change
  const everyone = change.after.filter((grant) => grant.principals.some((principal) => principal.kind === 'everyone'))
  const lifted = Object.keys(change.revoked?.can ?? {})
  const made = Object.keys(change.changed?.can ?? {})
  const touched = [...new Set([...lifted, ...made])]
  const spots = [...new Set([...touched, ...everyone.flatMap((grant) => Object.keys(grant.can)), ...Object.keys(caller.summary()), ...Object.keys(own.summary())])]
  for (const pattern of touched) {
    if (!caller.at('manage', pattern) || !own.at('manage', pattern)) return { reason: 'reach', pattern, permission: 'manage' }
    for (const spot of spots) if (isUnder(spot, pattern) && !own.at('manage', spot)) return { reason: 'reach', pattern: spot, permission: 'manage' }
  }
  if (made.length > 0) {
    const gives = combine(everyone.map((grant) => ({ level: 'everyone' as const, can: grant.can, source: null })))
    for (const spot of spots) for (const permission of PERMISSIONS) if (gives.at(permission, spot) && !caller.at(permission, spot)) return { reason: 'admission', pattern: spot, permission }
  }
  // Reach held at each of these before the change, so one that doesn't hold after is the change's own doing.
  if (then) for (const pattern of touched) if (!then.caller.at('manage', pattern) || !then.own.at('manage', pattern)) return { reason: 'lockout', pattern, permission: 'manage' }
  return null
}
