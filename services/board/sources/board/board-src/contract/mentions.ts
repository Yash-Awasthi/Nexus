import { findBlocks } from './blocks.ts'
const FENCED_CODE = /```[\s\S]*?```/g
const INLINE_CODE = /`[^`\n]*`/g
const NAME = '[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?'
// `@ada` and `@julian/claude`; never part of an email or a longer token. A colon ends one when
// it's punctuation (`@ada: can you look?`), and not when it joins it to more (`@slack:U0456`).
const MENTION = new RegExp(
  `(?<![\\w@.-])@(${NAME}(?:/${NAME})?)(?!:\\S|[a-z0-9_/-]|\\.(?=[a-z0-9]))`,
  'gi',
)
// `@[slack:T0123:U0456]` names an exact actor.
const EXACT = /(?<![\w@.-])@\[([^\]\s]+)\]/g

/**
 * Blanks out code so mentions inside it never count. A block's fence is code whatever it's fenced
 * with and whatever its JSON holds, so nothing that reads or rewrites mentions touches its data.
 */
function proseOnly(text: string): string {
  let prose = text.replace(FENCED_CODE, (match) => ' '.repeat(match.length)).replace(INLINE_CODE, (match) => ' '.repeat(match.length))
  if (text.includes('json#'))
    for (const { start, end } of findBlocks(text)) prose = `${prose.slice(0, start)}${' '.repeat(end - start)}${prose.slice(end)}`
  return prose
}

export type MentionToken =
  | { kind: 'handle'; handle: string }
  | { kind: 'actor'; actor: string }

/** Mentions in prose order, deduplicated. Handles are lowercased. */
export function extractMentions(text: string): MentionToken[] {
  const prose = proseOnly(text)
  const found: { index: number; token: MentionToken; key: string }[] = []
  for (const match of prose.matchAll(EXACT)) {
    const actor = match[1]
    if (actor !== undefined)
      found.push({
        index: match.index,
        token: { kind: 'actor', actor },
        key: `actor:${actor}`,
      })
  }
  for (const match of prose.replace(EXACT, (m) => ' '.repeat(m.length)).matchAll(MENTION)) {
    const handle = match[1]?.toLowerCase()
    if (handle !== undefined)
      found.push({
        index: match.index,
        token: { kind: 'handle', handle },
        key: `handle:${handle}`,
      })
  }
  const seen = new Set<string>()
  return found
    .sort((a, b) => a.index - b.index)
    .filter(({ key }) => !seen.has(key) && seen.add(key))
    .map(({ token }) => token)
}

/** An email, as `@[ada@vercel.com]` names one: no actor ID has an `@` without a `:`. */
export const isEmail = (value: string) => /^[^\s@:]+@[^\s@:]+$/.test(value)

/** A mention as filters match it: an actor ID (it has a colon) as written, anything else (a handle, an email) lowercased. */
export const mentionTerm = (name: string): string => (name.includes(':') ? name : name.toLowerCase())

/** What `text` mentions, as filters match it: each `@handle` and `@[…]`, as `mentionTerm` has it. */
export const mentionTerms = (text: string): string[] => [...new Set(extractMentions(text).map((token) => mentionTerm(token.kind === 'handle' ? token.handle : token.actor)))]

/**
 * Rewrites each mention in prose with `replace`, which also gets the mention as
 * written; one it returns null for stays as written.
 * Code is left alone, as in `extractMentions`.
 */
export function replaceMentions(text: string, replace: (token: MentionToken, written: string) => string | null): string {
  const prose = proseOnly(text)
  const found: { index: number; length: number; token: MentionToken }[] = []
  for (const match of prose.matchAll(EXACT))
    found.push({ index: match.index, length: match[0].length, token: { kind: 'actor', actor: match[1]! } })
  for (const match of prose.replace(EXACT, (m) => ' '.repeat(m.length)).matchAll(MENTION))
    found.push({ index: match.index, length: match[0].length, token: { kind: 'handle', handle: match[1]!.toLowerCase() } })
  let out = ''
  let at = 0
  for (const { index, length, token } of found.sort((a, b) => a.index - b.index)) {
    const written = text.slice(index, index + length)
    out += text.slice(at, index) + (replace(token, written) ?? written)
    at = index + length
  }
  return out + text.slice(at)
}

/** An actor as a write's answer names them. */
export type MentionedActor = { id: string; handle: string; name: string }

/**
 * What became of an `@handle` a write typed. With `actor`, it named that one actor and the text now
 * has `@[actor-id]` in its place. With `actor: null`, it's still in the text as typed, a mention of
 * no one: `candidates` is who it could have meant, the several who have that handle, or for a handle
 * with no `/`, whoever has it under a name (`support/malte` for `@malte`).
 */
export type Mentioned = { written: string; actor: MentionedActor | null; candidates: MentionedActor[] }

/** An actor ID as `@[…]` can hold it: no space and no `]`. */
const HOLDABLE = /^[^\]\s]+$/

/**
 * Settles the `@handle`s in a text among `actors`, whoever its writer can see: each becomes
 * `@[actor-id]` when exactly one of them has that handle, in full, and stays as typed otherwise.
 * Of several who have it, `prefer` may pick one: board passes the one who wrote in the thread. A
 * handle no one has in full names no one, even when someone has it under a name: `@malte` isn't
 * `support/malte`, whom a project could import to take the name, so they're only a candidate.
 * `@[…]` is exact already, and is left alone.
 */
export function settleMentions(
  text: string,
  actors: readonly MentionedActor[],
  prefer: (candidates: readonly MentionedActor[]) => MentionedActor | null = () => null,
): { text: string; mentions: Mentioned[] } {
  const found = new Map<string, Mentioned>()
  const settled = replaceMentions(text, (token, written) => {
    if (token.kind !== 'handle') return null
    let mention = found.get(token.handle)
    if (!mention) {
      const named = (of: (handle: string) => string) => actors.filter((actor) => of(actor.handle.toLowerCase()) === token.handle && HOLDABLE.test(actor.id))
      const full = named((handle) => handle)
      const actor = full.length === 1 ? full[0]! : full.length > 1 ? prefer(full) : null
      const under = full.length > 0 || token.handle.includes('/') ? full : named((handle) => handle.slice(handle.indexOf('/') + 1))
      mention = { written, actor, candidates: actor ? [] : under }
      found.set(token.handle, mention)
    }
    return mention.actor ? `@[${mention.actor.id}]` : null
  })
  return { text: settled, mentions: [...found.values()] }
}
