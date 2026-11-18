import type { SchemaView } from '../api/routes.ts'
import { ago } from './format.ts'

/** How wide a schemas row gets before its description is cut: 80 columns. */
const WIDTH = 80

/** `text` on one line, cut to `width` with an ellipsis. */
const fitted = (text: string, width: number) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= width ? line : `${line.slice(0, Math.max(0, width - 1)).trimEnd()}…`
}

/** Each schema on a row: its ID, when it was registered (`built in` for the board's own), and what it holds. */
export function formatSchemas(schemas: readonly SchemaView[], now = Date.now()): string {
  const rows = schemas.map((schema) => [schema.id, schema.at === null ? 'built in' : ago(schema.at, now), schema.description ?? ''] as const)
  const widths = [0, 1].map((column) => Math.max(...rows.map((row) => row[column]!.length)))
  return rows
    .map(([id, registered, description]) => {
      const head = `${id.padEnd(widths[0]!)}  ${registered.padEnd(widths[1]!)}`
      return description ? `${head}  ${fitted(description, WIDTH - head.length - 2)}` : head.trimEnd()
    })
    .join('\n')
}

/** One schema: its ID and what it holds, then its JSON Schema, to paste. */
export function formatSchema(schema: SchemaView): string {
  const definition = JSON.stringify(schema.schema, null, 2).replace(/^/gm, '    ')
  return `${[schema.id, schema.description].filter(Boolean).join('  ')}\n\n${definition}`
}
