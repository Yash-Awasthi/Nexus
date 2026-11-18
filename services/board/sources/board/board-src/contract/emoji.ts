import { EMOJI_TABLE } from './emoji-table.ts'

// Reactions are stored under Chat SDK's names (`thumbs_up`, `check`), the names sync
// adapters send and expect, so a 👍 from Slack and one from the board are the same
// reaction. Slack's names (`+1`, `white_check_mark`) are aliases.

const CANONICAL = new Map<string, string>()
const SHOWN = new Map<string, string>()
const BY_CHARACTER = new Map<string, string>()

const bare = (character: string) => character.replace(/️/g, '')

function add(name: string, characters: string[], aliases: string[]) {
  CANONICAL.set(name, name)
  for (const alias of aliases) if (!CANONICAL.has(alias)) CANONICAL.set(alias, name)
  if (characters[0]) SHOWN.set(name, characters[0])
  for (const character of characters) if (!BY_CHARACTER.has(bare(character))) BY_CHARACTER.set(bare(character), name)
}

for (const [name, entry] of Object.entries(EMOJI_TABLE)) add(name, entry.characters, entry.aliases)
// Names the board accepted before it followed Chat SDK's table.
add('rotating_light', ['🚨'], [])
add('ship', ['🚢'], [])

/** A stored name in its canonical form: `+1` → `thumbs_up`. Unknown names are their own. */
export const canonicalEmoji = (name: string): string => CANONICAL.get(name) ?? name

/** `eyes`, `:eyes:`, `+1`, or 👍 → a canonical short name. */
export function normalizeEmoji(input: string): string {
  const trimmed = input.trim()
  const named = trimmed.match(/^:?([a-z0-9_+-]+):?$/i)
  if (named) return canonicalEmoji(named[1]!.toLowerCase())
  const name = BY_CHARACTER.get(bare(trimmed))
  if (name) return name
  throw new Error(`unknown emoji: ${input} (use a short name like eyes or thumbs_up)`)
}

export const displayEmoji = (name: string): string => SHOWN.get(canonicalEmoji(name)) ?? `:${name}:`
