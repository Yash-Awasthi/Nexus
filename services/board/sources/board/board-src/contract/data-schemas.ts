// Data schemas: what a board's registry holds, and the rules a definition passes before it's kept.
// Plain data and pure checks with no imports, so a board, Vercel's API, and a handle anywhere run
// the same ones.

/** A schema's definition: a JSON Schema for an object, in structural keywords only. */
export type SchemaDefinition = Record<string, unknown>

/** How big a definition gets: its JSON, its nodes (each `enum` and `const` value counts), its subschemas, and its depth. */
export const SCHEMA_BYTES_MAX = 32_768
export const SCHEMA_NODES_MAX = 512
/** Each subschema runs once per value it applies to, so this bounds how long checking a value takes. */
export const SCHEMA_SUBSCHEMAS_MAX = 64
export const SCHEMA_DEPTH_MAX = 16
export const SCHEMA_DESCRIPTION_MAX = 2000
export const SCHEMA_NAME_MAX = 80
export const SCHEMA_VERSION_MAX = 99_999
/** How many versions a board registers, the built-ins aside. */
export const SCHEMAS_MAX = 500

const NAME = `[a-z][a-z0-9._-]{0,${SCHEMA_NAME_MAX - 1}}`
/** A schema's name: lowercase letters, numbers, and `._-`, starting with a letter. */
export const SCHEMA_NAME = new RegExp(`^${NAME}$`)
const SCHEMA_ID = new RegExp(`^(${NAME})@([1-9][0-9]{0,4})$`)

/** `sandbox` and 1 as `sandbox@1`: what names a schema version everywhere. */
export const schemaId = (name: string, version: number) => `${name}@${version}`

/** `sandbox@1` as its name and version, or null for anything else. */
export function parseSchemaId(id: string): { name: string; version: number } | null {
  const found = SCHEMA_ID.exec(id)
  return found ? { name: found[1]!, version: Number(found[2]) } : null
}

const commitSha = { type: 'string', pattern: '^(?:[0-9a-f]{40}|[0-9a-f]{64})$', description: 'Full lowercase commit SHA' }

/**
 * The schemas every board has, as Vercel's API has them: their names are reserved, so no one
 * registers a version of one. They may use what a registered schema can't (`pattern`): they're the
 * board's own, and never change.
 */
export const BUILT_IN_SCHEMAS: readonly { name: string; version: number; description: string; schema: SchemaDefinition }[] = [
  {
    name: 'git-commit',
    version: 1,
    description: 'A Git commit, by its full SHA and the first line of its message.',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['sha', 'title'],
      properties: { sha: commitSha, title: { type: 'string', minLength: 1, maxLength: 1024 } },
    },
  },
  {
    name: 'vercel-deployment',
    version: 1,
    description: 'A Vercel deployment, by its URL and optionally the commit it was built from.',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: { url: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 2048 }, gitSha: commitSha },
    },
  },
]

/** Whether `name` is a built-in schema's: no one registers a version of it. */
export const isBuiltInName = (name: string) => BUILT_IN_SCHEMAS.some((schema) => schema.name === name)

const TYPES: ReadonlySet<unknown> = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
/** The formats a string can name. */
export const SCHEMA_FORMATS = ['date-time', 'date', 'time', 'email', 'uri', 'uuid', 'hostname', 'ipv4', 'ipv6'] as const
const FORMATS: ReadonlySet<unknown> = new Set(SCHEMA_FORMATS)

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
/** A schema inside a schema: an object of keywords, or `true` or `false`. */
const isSubschema = (value: unknown) => isObject(value) || typeof value === 'boolean'
const count = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
const text = (value: unknown) => typeof value === 'string'
const distinct = (values: readonly unknown[]) => new Set(values).size === values.length

/**
 * Every keyword a definition may use, and what its value has to be: structural ones only. No `$ref`,
 * `pattern`, or anything else that runs code or follows a reference, and no `uniqueItems`, which
 * compares every pair of items.
 */
const KEYWORDS: Readonly<Record<string, { takes: string; ok: (value: unknown) => boolean }>> = {
  $schema: { takes: 'a string', ok: text },
  title: { takes: 'a string', ok: text },
  description: { takes: 'a string', ok: text },
  type: {
    takes: 'object, array, string, number, integer, boolean, or null, or a list of them',
    ok: (value) => TYPES.has(value) || (Array.isArray(value) && value.length > 0 && value.every((one) => TYPES.has(one)) && distinct(value)),
  },
  properties: { takes: 'an object of schemas, by property', ok: (value) => isObject(value) && Object.values(value).every(isSubschema) },
  required: { takes: 'a list of property names, each once', ok: (value) => Array.isArray(value) && value.every(text) && distinct(value) },
  additionalProperties: { takes: 'a schema, or true or false', ok: isSubschema },
  items: { takes: 'one schema for every item', ok: isSubschema },
  minItems: { takes: 'a whole number, 0 or more', ok: count },
  maxItems: { takes: 'a whole number, 0 or more', ok: count },
  minLength: { takes: 'a whole number, 0 or more', ok: count },
  maxLength: { takes: 'a whole number, 0 or more', ok: count },
  minimum: { takes: 'a number', ok: finite },
  maximum: { takes: 'a number', ok: finite },
  exclusiveMinimum: { takes: 'a number', ok: finite },
  exclusiveMaximum: { takes: 'a number', ok: finite },
  multipleOf: { takes: 'a number above 0', ok: (value) => finite(value) && (value as number) > 0 },
  enum: { takes: 'a list of at least one value', ok: (value) => Array.isArray(value) && value.length > 0 },
  const: { takes: 'any value', ok: () => true },
  oneOf: { takes: 'a list of at least one schema', ok: (value) => Array.isArray(value) && value.length > 0 && value.every(isSubschema) },
  anyOf: { takes: 'a list of at least one schema', ok: (value) => Array.isArray(value) && value.length > 0 && value.every(isSubschema) },
  allOf: { takes: 'a list of at least one schema', ok: (value) => Array.isArray(value) && value.length > 0 && value.every(isSubschema) },
  not: { takes: 'a schema', ok: isSubschema },
  format: { takes: `one of ${SCHEMA_FORMATS.join(', ')}`, ok: (value) => FORMATS.has(value) },
}

/** Whether the board can keep `value`: text with no NUL character and no lone surrogate. */
const keepable = (value: string) => !value.includes('\u0000') && value.isWellFormed()

class Problem extends Error {}

/**
 * Why `schema` can't be registered, or null when it can: it describes an object, stays small, and
 * uses only the structural keywords, each with a value that means something. Checking a value
 * against one then costs the value's size times the schema's, and both are bounded.
 */
export function checkDefinition(schema: unknown): string | null {
  if (!isObject(schema) || schema.type !== 'object') return 'a schema describes a JSON object: give it "type": "object"'
  if (new TextEncoder().encode(JSON.stringify(schema)).length > SCHEMA_BYTES_MAX) return `a schema is at most ${SCHEMA_BYTES_MAX} bytes of JSON`
  let nodes = 0
  let subschemas = 0
  const counted = (depth: number) => {
    if (++nodes > SCHEMA_NODES_MAX || depth > SCHEMA_DEPTH_MAX) throw new Problem(`a schema has at most ${SCHEMA_NODES_MAX} nodes and ${SCHEMA_DEPTH_MAX} levels`)
  }
  const kept = (value: unknown) => {
    if (typeof value === 'string' && !keepable(value)) throw new Problem('a schema has a NUL character or a lone surrogate in its text')
  }
  // `enum` and `const` hold data, not schema, but each value costs a comparison.
  const data = (value: unknown, depth: number) => {
    counted(depth)
    kept(value)
    if (typeof value !== 'object' || value === null) return
    for (const [key, child] of Object.entries(value)) {
      kept(key)
      data(child, depth + 1)
    }
  }
  const visit = (value: unknown, depth: number, at: string, properties: boolean) => {
    counted(depth)
    kept(value)
    if (typeof value !== 'object' || value === null) return
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, depth + 1, `${at}/${index}`, false))
      return
    }
    if (properties) {
      for (const [name, child] of Object.entries(value)) {
        kept(name)
        visit(child, depth + 1, `${at}/${name}`, false)
      }
      return
    }
    if (++subschemas > SCHEMA_SUBSCHEMAS_MAX) throw new Problem(`a schema has at most ${SCHEMA_SUBSCHEMAS_MAX} subschemas`)
    for (const [keyword, child] of Object.entries(value)) {
      const rule = Object.hasOwn(KEYWORDS, keyword) ? KEYWORDS[keyword] : undefined
      if (!rule) throw new Problem(`schemas don't take "${keyword}"${at ? ` (at ${at})` : ''}: no references, patterns, uniqueItems, or keywords of your own`)
      if (!rule.ok(child)) throw new Problem(`"${keyword}"${at ? ` at ${at}` : ''} takes ${rule.takes}`)
      if (keyword === 'enum' || keyword === 'const') data(child, depth + 1)
      else visit(child, depth + 1, `${at}/${keyword}`, keyword === 'properties')
    }
  }
  try {
    visit(schema, 0, '', false)
  } catch (error) {
    if (error instanceof Problem) return error.message
    throw error
  }
  return null
}

/** `value` as JSON with every object's keys in order: two definitions that say the same are the same text. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) =>
    isObject(child) ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : child,
  )
}
