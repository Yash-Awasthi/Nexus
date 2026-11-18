import { reducer } from 'experimental-a2'
import { createServer } from 'experimental-a2/server'
import type { Protocol } from '../api/protocol.ts'
import type { SchemaView } from '../api/routes.ts'
import { SCHEMAS_SESSION, schemasContract, type SchemasEvent } from '../contract/contract.ts'
import { BUILT_IN_SCHEMAS, canonical, checkDefinition, isBuiltInName, parseSchemaId, SCHEMA_DESCRIPTION_MAX, SCHEMA_NAME, SCHEMA_VERSION_MAX, schemaId, SCHEMAS_MAX, type SchemaDefinition } from '../contract/data-schemas.ts'
import type { Identity } from './backend.ts'
import { badRequest, forbidden, HttpError, notFound } from './errors.ts'
import { whileHeadMoves } from './writes.ts'

/** A registered version, as the fold keeps it. */
type SchemaRow = { name: string; version: number; description: string | null; schema: SchemaDefinition; by: string; at: number }
/** Every registered version, by its ID. */
export type SchemasState = { byId: Record<string, SchemaRow> }

/** The schemas session's fold: a version is its first event, and nothing changes it after. */
export function foldSchemas(state: SchemasState, event: SchemasEvent): SchemasState {
  const { name, version, description, schema, by } = event.payload
  state.byId[schemaId(name, version)] ??= { name, version, description, schema, by, at: new Date(event.createdAt).getTime() }
  return state
}

export const schemasReducer = reducer({ contract: schemasContract, name: 'board.schemas.v1', initialState: { byId: {} } as SchemasState }).fold(foldSchemas)

const builtIns: SchemaView[] = BUILT_IN_SCHEMAS.map((schema) => ({ id: schemaId(schema.name, schema.version), ...schema, builtIn: true, by: null, at: null }))

const view = (row: SchemaRow): SchemaView => ({
  id: schemaId(row.name, row.version),
  name: row.name,
  version: row.version,
  description: row.description,
  schema: row.schema,
  builtIn: false,
  by: row.by,
  at: new Date(row.at).toISOString(),
})

/**
 * The board's schema registry, in session `schemas` of its log: what a local board answers for
 * them. Anyone the board let in reads it, and registering takes `manage` at `*`, since a schema is
 * the whole board's.
 */
export function createSchemas(options: { store: Parameters<typeof createServer>[0]['store'] }) {
  const session = createServer({ contract: schemasContract, store: options.store }).session(SCHEMAS_SESSION)
  const read = async () => (await session.state(schemasReducer)).state
  /** The registry as it is now, and the index a conditional write holds it at. */
  const latest = () => session.state(schemasReducer, { through: 'latest' })

  return {
    async schemas(): Promise<Protocol['schemas']['output']> {
      const own = Object.values((await read()).byId).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version - b.version))
      return { schemas: [...builtIns, ...own.map(view)] }
    },
    async schema({ id }: Protocol['schema']['input']): Promise<Protocol['schema']['output']> {
      if (!parseSchemaId(id)) throw badRequest(`${id} doesn't name a schema: one is name@version, like sandbox@1`, 'invalid_schema_id')
      const builtIn = builtIns.find((schema) => schema.id === id)
      if (builtIn) return { schema: builtIn }
      const row = (await read()).byId[id]
      if (!row) throw notFound(`schema not found: ${id}`, 'schema_not_found')
      return { schema: view(row) }
    },
    async createSchema({ principal, actor }: Identity, body: Protocol['createSchema']['input']): Promise<Protocol['createSchema']['output']> {
      if (!principal.access.at('manage', '*')) throw forbidden("this token can't register schemas: it needs manage at *")
      if (!SCHEMA_NAME.test(body.name)) throw badRequest('name: a schema name is up to 80 lowercase letters, numbers, and ._-, starting with a letter')
      if (body.version > SCHEMA_VERSION_MAX) throw badRequest(`version: a schema version is at most ${SCHEMA_VERSION_MAX.toLocaleString('en-US')}`)
      if (body.description !== undefined && body.description.length > SCHEMA_DESCRIPTION_MAX) throw badRequest(`description: a schema description is at most ${SCHEMA_DESCRIPTION_MAX.toLocaleString('en-US')} characters`)
      const id = schemaId(body.name, body.version)
      if (isBuiltInName(body.name)) throw new HttpError(409, 'reserved_schema', `${body.name} is a built-in schema: register yours under another name`)
      const problem = checkDefinition(body.schema)
      if (problem !== null) throw badRequest(problem, 'invalid_schema')
      const description = body.description ?? null
      // On the registry as it is when it lands: of two that register one version at once, one makes it.
      return whileHeadMoves(async () => {
        const { state, index } = await latest()
        const existing = state.byId[id]
        if (existing) {
          // Which part differs, so what `inspect` shows isn't the same as what was sent with no word why.
          const differs = canonical(existing.schema) !== canonical(body.schema) ? 'definition' : existing.description !== description ? 'description' : null
          if (differs !== null) throw new HttpError(409, 'schema_immutable', `${id} is registered with another ${differs}, and a version never changes: register a new version`)
          return { schema: view(existing), created: false }
        }
        if (Object.keys(state.byId).length >= SCHEMAS_MAX) throw badRequest(`a board registers at most ${SCHEMAS_MAX} schema versions`, 'too_many_schemas')
        await session.append.ifLastIndex(index, { type: 'schema.created', payload: { name: body.name, version: body.version, description, schema: body.schema, by: actor.id } })
        const made = (await read()).byId[id]
        if (!made) throw new Error('a schema was registered but its log has no record of it')
        return { schema: view(made), created: true }
      })
    },
  }
}
