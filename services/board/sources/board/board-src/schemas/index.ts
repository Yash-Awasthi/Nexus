// `@vercel/board/schemas`: the rules a board keeps schemas and reads blocks by, as plain functions
// that import nothing, for a server that keeps a board itself, as Vercel's API does, and for a tool
// that checks data before it sends it. What they decide here, every board decides.

export { BUILT_IN_SCHEMAS, canonical, checkDefinition, parseSchemaId, type SchemaDefinition } from '../contract/data-schemas.ts'
export { checkValue } from '../contract/data-values.ts'
export { block, findBlocks, type FoundBlock } from '../contract/blocks.ts'
