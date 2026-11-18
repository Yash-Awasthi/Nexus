// `x-board-profile`, an RFC 8941 structured-field Item: the profile's name, with its avatar as a
// parameter. `fixer` writes as profile fixer; `fixer;avatar="https://example.com/fixer.png"` with
// that picture.

/** A profile as the header carries it. */
export type ProfileHeader = { name: string; avatar: string | null }

/** Why a header isn't one: the board's 400 says it. */
export class InvalidProfileHeader extends Error {}

const TOKEN_START = /[A-Za-z*]/
const TCHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z:/]/
const KEY_START = /[a-z*]/
const KEY_CHAR = /[a-z0-9_\-.*]/
/** RFC 8941's other bare items: an integer, a decimal, a boolean, or a byte sequence. */
const OTHER_ITEM = /^(?:-?\d{1,15}|-?\d{1,12}\.\d{1,3}|\?[01]|:[A-Za-z0-9+/=]*:)$/

/** An sf-string: printable ASCII in quotes, with `"` and `\` escaped. */
function sfString(value: string): string {
  if (!/^[\x20-\x7e]*$/.test(value)) throw new InvalidProfileHeader('an avatar URL is printable ASCII: percent-encode the rest')
  return `"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`
}

/**
 * The header's value for a profile: `fixer`, or `fixer;avatar="https://example.com/fixer.png"`,
 * serialized as RFC 8941 says. An avatar outside printable ASCII goes as its URL percent-encodes it.
 */
export function formatProfileHeader(profile: { name: string; avatar?: string | null | undefined }): string {
  if (!profile.avatar) return profile.name
  const avatar = /^[\x20-\x7e]*$/.test(profile.avatar) ? profile.avatar : (URL.parse(profile.avatar)?.href ?? profile.avatar)
  return `${profile.name};avatar=${sfString(avatar)}`
}

/**
 * Reads the header as RFC 8941 parses an Item. Its bare item is the profile's name, a token or a
 * string; `avatar` is a string. A parameter it doesn't know is ignored, as structured fields' are,
 * and the last of a repeated one wins. Anything else throws `InvalidProfileHeader`.
 */
export function parseProfileHeader(value: string): ProfileHeader {
  let at = 0
  const fail = (why: string): never => {
    throw new InvalidProfileHeader(`x-board-profile is a structured header, like fixer;avatar="https://example.com/fixer.png": ${why}`)
  }
  const spaces = () => {
    while (value[at] === ' ') at++
  }
  const string = (): string => {
    at++
    let out = ''
    while (at < value.length) {
      const char = value[at++]!
      if (char === '\\') {
        const next = value[at++]
        if (next !== '"' && next !== '\\') fail('a string escapes only " and \\')
        out += next
      } else if (char === '"') return out
      else if (char < '\x20' || char > '\x7e') fail('a string is printable ASCII')
      else out += char
    }
    return fail('a string is missing its closing "')
  }
  const token = (): string => {
    const start = at
    while (at < value.length && TCHAR.test(value[at]!)) at++
    return value.slice(start, at)
  }
  /** A bare item: a string, a token, or another of RFC 8941's (a number, a boolean, bytes), which the header names nothing with. */
  const bare = (): { kind: 'string' | 'token' | 'other'; value: string } => {
    const char = value[at]
    if (char === '"') return { kind: 'string', value: string() }
    if (char !== undefined && TOKEN_START.test(char)) return { kind: 'token', value: token() }
    const start = at
    while (at < value.length && value[at] !== ';' && value[at] !== ' ') at++
    const item = value.slice(start, at)
    if (!OTHER_ITEM.test(item)) fail(item === '' ? 'a parameter has no value after its =' : `${item} isn't a value`)
    return { kind: 'other', value: item }
  }

  spaces()
  const name = bare()
  if (name.kind === 'other') fail(name.value === '' ? 'it names no profile' : `${name.value} isn't a profile's name`)
  let avatar: string | null = null
  while (value[at] === ';') {
    at++
    spaces()
    if (!KEY_START.test(value[at] ?? '')) fail('a parameter starts with a lowercase letter')
    const start = at
    while (at < value.length && KEY_CHAR.test(value[at]!)) at++
    const key = value.slice(start, at)
    let param: { kind: 'string' | 'token' | 'other' | 'boolean'; value: string } = { kind: 'boolean', value: '?1' }
    if (value[at] === '=') {
      at++
      param = bare()
    }
    if (key !== 'avatar') continue
    if (param.kind !== 'string') fail('avatar is a string, in quotes')
    avatar = param.value
  }
  spaces()
  if (at < value.length) fail(`${JSON.stringify(value.slice(at, at + 20))} follows the profile`)
  return { name: name.value, avatar }
}
