import { Braces } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { BlockView, SchemaView } from '../../api/routes.ts'
import * as board from './board.ts'
import { Link } from './nav.tsx'
import { blockFields } from './store.ts'
import { nativeMenu } from './ui.tsx'

// A block is data a message carries: JSON in a fence that names a schema, which the board checked
// when the message was written. It shows as a small card: its schema, and its fields.

/** A field's value as a card shows it: text as it is, a link for a URL, and anything nested as JSON. */
function Value({ value }: { value: unknown }) {
  if (typeof value === 'string') {
    if (/^https?:\/\/\S+$/.test(value))
      return (
        <a href={value} target="_blank" rel="noreferrer">
          {value}
        </a>
      )
    return <>{value}</>
  }
  if (value === null) return <span className="faint">null</span>
  if (typeof value === 'object') return <code>{JSON.stringify(value)}</code>
  return <>{String(value)}</>
}

/**
 * One block. `schema` is its registered version: undefined when the registry doesn't hold it (the
 * page shows the data as it is), and `registry` says whether the registry has been read at all.
 */
export function BlockCard({ block, schema, registry }: { block: BlockView; schema: SchemaView | undefined; registry: boolean }) {
  const [raw, setRaw] = useState(false)
  const id = `${block.schema}@${block.version}`
  useEffect(() => {
    if (registry && !schema) void board.findSchema(id)
  }, [registry, schema === undefined, id])
  const fields = blockFields(block, schema)
  return (
    <div className="block">
      <div className="block-head">
        <Link to={`/settings/schemas/${id}`} className="block-schema" title={schema?.description ?? `schema ${id}`}>
          {block.schema}
          <span className="faint">@{block.version}</span>
        </Link>
        {registry && !schema && <span className="faint">unknown schema</span>}
        <span className="spacer" />
        <button className={`tool${raw ? ' on' : ''}`} aria-pressed={raw} title={raw ? 'show its fields' : 'show its JSON'} onClick={() => setRaw(!raw)}>
          <Braces size={13} strokeWidth={1.75} />
        </button>
      </div>
      {raw ? (
        <pre className="block-raw" {...nativeMenu}>
          {JSON.stringify(block.data, null, 2)}
        </pre>
      ) : fields.length === 0 ? (
        <div className="block-fields faint">no fields</div>
      ) : (
        <dl className="block-fields" {...nativeMenu}>
          {fields.map((field) => (
            <div key={field.name} className="block-field">
              <dt title={field.description}>{field.name}</dt>
              <dd>
                <Value value={field.value} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}
