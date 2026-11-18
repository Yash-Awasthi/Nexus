// Checks a value against a data schema's definition: the keywords `checkDefinition` lets a
// definition use, and `pattern`, which only the built-ins do. Pure, with no imports and no code
// generation, so it runs wherever a board or a handle does.

import type { SchemaDefinition } from './data-schemas.ts'

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** What JSON Schema calls a value's type: an integer is a number too. */
function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

const isType = (value: unknown, type: unknown) => {
  const actual = typeOf(value)
  return actual === type || (type === 'number' && actual === 'integer')
}

/** Two JSON values that say the same: objects whatever order their keys come in. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, index) => same(item, b[index]))
  if (!isObject(a) || !isObject(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]))
}

// What each format takes: what ajv-formats 2.1.1 takes in its full mode, which is what Vercel's
// API takes, so a value gets one answer on a board anywhere and on Vercel's. These are that
// library's definitions (MIT, https://github.com/ajv-validator/ajv-formats), kept as they are,
// oddities included: a leading zero in an IPv4 address, any two digits in a time's offset. None
// takes a millisecond on the longest message.
const DATE = /^(\d\d\d\d)-(\d\d)-(\d\d)$/
const DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const TIME = /^(\d\d):(\d\d):(\d\d)(\.\d+)?(z|[+-]\d\d(?::?\d\d)?)?$/i
const EMAIL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i
const HOSTNAME = /^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*\.?$/i
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/
const IPV6 =
  /^((([0-9a-f]{1,4}:){7}([0-9a-f]{1,4}|:))|(([0-9a-f]{1,4}:){6}(:[0-9a-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){5}(((:[0-9a-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){4}(((:[0-9a-f]{1,4}){1,3})|((:[0-9a-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){3}(((:[0-9a-f]{1,4}){1,4})|((:[0-9a-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){2}(((:[0-9a-f]{1,4}){1,5})|((:[0-9a-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){1}(((:[0-9a-f]{1,4}){1,6})|((:[0-9a-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9a-f]{1,4}){1,7})|((:[0-9a-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))$/i
const UUID = /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
// RFC 3986's URI, with its scheme: a reference with none is no URI here.
const URI =
  /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)(?:\?(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i
const NOT_A_FRAGMENT = /\/|:/

function isDate(text: string): boolean {
  const found = DATE.exec(text)
  if (!found) return false
  const [year, month, day] = [Number(found[1]), Number(found[2]), Number(found[3])]
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  return month >= 1 && month <= 12 && day >= 1 && day <= (month === 2 && leap ? 29 : DAYS[month]!)
}

function isTime(text: string): boolean {
  const found = TIME.exec(text)
  if (!found) return false
  const [hour, minute, second] = [Number(found[1]), Number(found[2]), Number(found[3])]
  // A leap second is the day's last: 23:59:60. The zone may be left out, and its digits aren't checked.
  return (hour <= 23 && minute <= 59 && second <= 59) || (hour === 23 && minute === 59 && second === 60)
}

const FORMATS: Readonly<Record<string, (text: string) => boolean>> = {
  date: isDate,
  time: isTime,
  'date-time': (text) => {
    // A date, then a `t` or any one whitespace character, then a time.
    const parts = text.split(/t|\s/i)
    return parts.length === 2 && isDate(parts[0]!) && isTime(parts[1]!)
  },
  email: (text) => EMAIL.test(text),
  uri: (text) => NOT_A_FRAGMENT.test(text) && URI.test(text),
  uuid: (text) => UUID.test(text),
  hostname: (text) => HOSTNAME.test(text),
  ipv4: (text) => IPV4.test(text),
  ipv6: (text) => IPV6.test(text),
}

/** A value as a refusal shows it: its JSON, cut short. */
const shown = (value: unknown) => {
  const text = JSON.stringify(value) ?? String(value)
  return text.length > 40 ? `${text.slice(0, 39)}…` : text
}

/** `a`, `a or b`, `a, b, or c`: a few values, as a sentence lists them. */
function oneOf(values: readonly unknown[]): string {
  const listed = values.slice(0, 6).map(shown)
  if (values.length > 6) return `one of ${listed.join(', ')}, …`
  if (listed.length <= 2) return listed.join(' or ')
  return `${listed.slice(0, -1).join(', ')}, or ${listed.at(-1)}`
}

/** A type, or several, as a sentence names them: `a string`, `an object or null`. */
const named = (type: unknown): string =>
  (Array.isArray(type) ? type : [type]).map((one) => (one === 'null' ? 'null' : `${/^[aeio]/.test(String(one)) ? 'an' : 'a'} ${one}`)).join(' or ')

/**
 * Why `value` doesn't match `schema`, or null when it does: the first thing wrong, said of the
 * field it's wrong in (`action must be "started" or "stopped"`, `config.vcpus must be an integer`).
 */
export function checkValue(schema: SchemaDefinition | boolean, value: unknown): string | null {
  return problemIn(schema, value, '')
}

function problemIn(schema: unknown, value: unknown, at: string): string | null {
  const it = at || 'it'
  if (schema === true) return null
  if (schema === false) return `${it} isn't allowed`
  if (!isObject(schema)) return null
  const within = (key: string | number) => (typeof key === 'number' ? `${at}[${key}]` : at ? `${at}.${key}` : key)

  const { type } = schema
  if (type !== undefined && !(Array.isArray(type) ? type : [type]).some((one) => isType(value, one))) return `${it} must be ${named(type)}`
  if ('const' in schema && !same(value, schema.const)) return `${it} must be ${shown(schema.const)}`
  if (Array.isArray(schema.enum) && !schema.enum.some((one) => same(value, one))) return `${it} must be ${oneOf(schema.enum)}`

  if (typeof value === 'string') {
    // A length is in characters, as people count them: an emoji is one.
    const length = [...value].length
    if (typeof schema.minLength === 'number' && length < schema.minLength) return `${it} must be at least ${schema.minLength} characters`
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) return `${it} must be at most ${schema.maxLength} characters`
    if (typeof schema.format === 'string' && FORMATS[schema.format]?.(value) === false) return `${it} must be ${/^[aeiu]/.test(schema.format) ? 'an' : 'a'} ${schema.format}`
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) return `${it} must match ${schema.pattern}`
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return `${it} must be at least ${schema.minimum}`
    if (typeof schema.maximum === 'number' && value > schema.maximum) return `${it} must be at most ${schema.maximum}`
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) return `${it} must be above ${schema.exclusiveMinimum}`
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) return `${it} must be below ${schema.exclusiveMaximum}`
    if (typeof schema.multipleOf === 'number' && !Number.isInteger(value / schema.multipleOf)) return `${it} must be a multiple of ${schema.multipleOf}`
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return `${it} must have at least ${schema.minItems} items`
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return `${it} must have at most ${schema.maxItems} items`
    // One schema for every item, or a list of them, one for each place. Items past the list are
    // free: no registry takes `additionalItems`, and Vercel's takes a list only with `minItems` and
    // `maxItems` at its length.
    const places = Array.isArray(schema.items) ? schema.items : null
    if (schema.items !== undefined)
      for (let index = 0; index < (places ? Math.min(places.length, value.length) : value.length); index++) {
        const problem = problemIn(places ? places[index] : schema.items, value[index], within(index))
        if (problem !== null) return problem
      }
  }

  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {}
    if (Array.isArray(schema.required)) for (const name of schema.required) if (typeof name === 'string' && !Object.hasOwn(value, name)) return `${within(name)} is missing`
    for (const [name, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, name)) {
        const problem = problemIn(properties[name], child, within(name))
        if (problem !== null) return problem
      } else if (schema.additionalProperties !== undefined) {
        if (schema.additionalProperties === false) return `${within(name)} isn't one of its fields`
        const problem = problemIn(schema.additionalProperties, child, within(name))
        if (problem !== null) return problem
      }
    }
  }

  if (Array.isArray(schema.allOf))
    for (const one of schema.allOf) {
      const problem = problemIn(one, value, at)
      if (problem !== null) return problem
    }
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const options = schema[keyword]
    if (!Array.isArray(options)) continue
    const problems = options.map((one) => problemIn(one, value, at))
    const matched = problems.filter((problem) => problem === null).length
    if (matched === 0) return problems.length === 1 ? problems[0]! : `${it} matches none of the ${problems.length} it can be: ${[...new Set(problems)].slice(0, 4).join('; ')}`
    if (keyword === 'oneOf' && matched > 1) return `${it} matches ${matched} of the ${problems.length} it can be, and must match one`
  }
  if (schema.not !== undefined && problemIn(schema.not, value, at) === null) return `${it} matches what it must not`
  return null
}
