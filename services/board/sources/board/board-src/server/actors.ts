import { own } from '../contract/own.ts'
import type { ActorsState, Actor } from '../contract/folds.ts'
import { toStorable, type Author } from '../contract/schemas.ts'
import type { Via } from '../contract/profiles.ts'
import { parseCan } from './access.ts'
import type { Claims, Principal } from './auth.ts'
import { badRequest } from './errors.ts'
import { parseProfileHeader } from '../contract/profile-header.ts'

/** Agents whose marks the board serves at `/avatars/<name>`, for a caller to pass as an avatar. */
export const KNOWN_AGENTS = ['fx', 'claude', 'codex', 'grok', 'pi'] as const

const PROFILE = /^[A-Za-z][A-Za-z0-9-]{0,31}$/

export type ResolvedActor = {
  author: Author
  actor: Actor
}

/**
 * What a request's headers say about its caller, checked for shape: a 400 for one that's
 * malformed. None of it is verified; board() works out the actor from it once it knows who the
 * credential is.
 */
export function claimsOf(headers: Headers): Claims {
  const { profile, avatar } = profileOf(headers.get('x-board-profile'))
  // What clients sent before, which released `vb` still does and which changes no one's identity, is read by
  // nothing: a person's picture (`x-board-avatar`), whom an avatar comes to only through a profile's header
  // now, a coding agent's session (`x-board-session`), which is never kept, and a handle and name
  // (`x-board-handle`, `x-board-name`), which come from what verified the caller.
  // Set by a proxy that holds the credential (Pi's sandbox); it only narrows.
  // The old name, refused rather than ignored: ignoring it would give a proxy that still sends it the token's whole access.
  if (headers.get('x-board-scope') !== null) throw badRequest('x-board-scope is x-board-can now: send the same value as x-board-can', 'invalid_scope')
  const scope = headers.get('x-board-can')
  if (scope !== null)
    try {
      parseCan(scope)
    } catch (error) {
      throw badRequest((error as Error).message, 'invalid_scope')
    }
  return { profile, avatar, scope }
}

/** `x-board-profile`'s profile and avatar, checked: a 400 for a header that isn't one. */
function profileOf(header: string | null): { profile: string | null; avatar: string | null } {
  if (header === null || header.trim() === '') return { profile: null, avatar: null }
  let parsed: ReturnType<typeof parseProfileHeader>
  try {
    parsed = parseProfileHeader(header)
  } catch (error) {
    throw badRequest((error as Error).message, 'invalid_profile')
  }
  if (!PROFILE.test(parsed.name)) throw badRequest('profile names start with a letter and use up to 32 letters, numbers, and hyphens', 'invalid_profile')
  if (parsed.avatar !== null && !isAvatarUrl(parsed.avatar)) throw badRequest('avatars must be https URLs (http only on localhost)', 'invalid_profile')
  return { profile: parsed.name, avatar: parsed.avatar }
}

/**
 * The actor a caller writes as: its principal, plus the profile it claims (`vercel:user:u_123+claude`).
 * Its handle and name are what verified its principal said: a host's verifier's handle, a Vercel
 * login's user ID, a deployment's project (named with its environment outside production,
 * `support (preview)`). A profile's name and avatar are the ones it sends, under that handle.
 */
export function resolveActor(principal: Principal, claims: Claims): ResolvedActor {
  const profile = claims.profile?.toLowerCase() ?? null
  const id = profile === null ? principal.id : `${principal.id}+${profile}`
  const via = viaOf(principal)
  const actor: Actor = {
    id,
    kind: profile === null ? principal.kind : 'agent',
    handle: profile === null ? principal.handle : `${principal.handle}/${profile}`,
    name: claims.profile ?? (via.environment !== null && via.environment !== 'production' ? `${via.name} (${via.environment})` : principal.handle),
    avatar: claims.avatar,
    ...(profile === null ? {} : { via }),
  }
  return {
    author: { actor: id, principal: principal.id, profile },
    actor,
  }
}

/**
 * The actor `author` writes as, shown as its principal names it now: a stored one (a schedule's
 * creator) whose handle, name, or picture a client sent, before they were checked, shows as its
 * principal does instead. A profile keeps its spelling and its avatar, which are its own to choose; a
 * platform user, whom its sync names, stays as it is.
 */
export function ownedActor(principal: Principal, author: Author, actor: Actor): Actor {
  if (principal.kind === 'external' || principal.id.startsWith('board:')) return actor
  const profile = author.profile === null ? null : actor.name.toLowerCase() === author.profile ? actor.name : author.profile
  const { actor: named } = resolveActor(principal, { profile, avatar: profile === null ? null : actor.avatar, scope: null })
  return { ...actor, handle: named.handle, name: named.name, avatar: named.avatar, ...(named.via ? { via: named.via } : {}) }
}

/**
 * Who a profile of `principal` acts through, as the board shows it: a deployment by its project's name
 * and its environment, anyone else by their handle. A deployment's handle is its project's name in
 * every environment; one a board stored with its environment after it (`www@preview`) still shows as `www`.
 */
export function viaOf(principal: { id: string; handle: string }): Via {
  const environment = /^vercel:project:[^:]+:([^:]+)$/.exec(principal.id)?.[1] ?? null
  const suffix = `@${environment}`
  const name = environment !== null && principal.handle.endsWith(suffix) && principal.handle.length > suffix.length ? principal.handle.slice(0, -suffix.length) : principal.handle
  return { name, environment }
}

function isAvatarUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
    )
  } catch {
    return false
  }
}

/**
 * An `actor.seen` event, or null when the board already knows these details. `host`: the actor is
 * a host's principal or one of its profiles, which the board records once. `seen.verified`: this
 * write's credential named it as shown, which each write says anew.
 */
export function actorSeen(seen: Actor, known: ActorsState, host = false) {
  const existing = own(known.byId, seen.id)
  // Platforms don't always send an avatar (GitHub comments via Chat SDK omit it,
  // its webhooks include it): a missing one keeps the avatar the board knows. A
  // schedule kept from before profiles said who they act through keeps that too.
  const avatar = seen.kind === 'external' && seen.avatar === null ? { avatar: existing?.avatar ?? null } : {}
  const via = seen.via === undefined && existing?.via ? { via: existing.via } : {}
  const platform = seen.platform === undefined && existing?.platform ? { platform: existing.platform } : {}
  const actor: Actor = { ...seen, ...avatar, ...via, ...platform }
  if (
    existing &&
    existing.kind === actor.kind &&
    existing.handle === actor.handle &&
    existing.name === actor.name &&
    existing.avatar === actor.avatar &&
    existing.via?.name === actor.via?.name &&
    existing.via?.environment === actor.via?.environment &&
    existing.platform === actor.platform &&
    existing.verified === actor.verified &&
    (!host || existing.host)
  )
    return null
  return {
    type: 'actor.seen' as const,
    payload: {
      actor: actor.id,
      kind: actor.kind,
      // A platform's names can hold what the board can't store.
      handle: toStorable(actor.handle),
      name: toStorable(actor.name),
      avatar: actor.avatar,
      ...(actor.via ? { via: { name: toStorable(actor.via.name), environment: actor.via.environment } } : {}),
      ...(actor.platform ? { platform: actor.platform } : {}),
      ...(host ? { host: true as const } : {}),
      ...(actor.verified ? { verified: true as const } : {}),
    },
  }
}
