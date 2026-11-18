import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SchemaView } from '../../api/routes.ts'
import * as board from './board.ts'
import { toast } from './chrome.ts'
import { Ago, Link, navigate } from './nav.tsx'
import { Actions } from './settings.tsx'
import { nameOf, schemaFields, schemasByName, type State, type Viewer } from './store.ts'
import { fieldMenu, nativeMenu, Panel, Suggest } from './ui.tsx'

// The board's schema registry: what a message's blocks can hold. A version never changes, so a
// block that names one always means the same.

export function Schemas(props: { state: State; viewer: Viewer; selected: string | null }) {
  const { state } = props
  // Nothing in the feed says when a version is registered, so the tab asks each time it opens, like the other lists.
  useEffect(() => {
    void board.loadSchemas()
  }, [])
  const schemas = state.schemas
  const groups = schemasByName(schemas ?? [])
  if (state.schemasRefused !== null && schemas === null) return <p className="empty error">{state.schemasRefused}</p>
  if (schemas === null) return <p className="empty">loading…</p>
  return (
    <>
      {props.viewer.manages && (
        <Actions>
          <RegisterSchema groups={groups} />
        </Actions>
      )}
      {groups.length === 0 && <p className="empty">no schemas</p>}
      {groups.map((group) => {
        const open = group.versions.find((schema) => schema.id === props.selected)
        const latest = group.versions.at(-1)!
        return (
          <section key={group.name} className="schema">
            <div className="schema-row">
              <span className="schema-name">{group.name}</span>
              <span className="schema-versions">
                {group.versions.map((schema) => (
                  <Link key={schema.id} to={open === schema ? '/settings/schemas' : `/settings/schemas/${schema.id}`} className="tab" current={open === schema} title={schema.id}>
                    @{schema.version}
                  </Link>
                ))}
              </span>
              <span className="schema-about" {...nativeMenu}>
                {(open ?? latest).description ?? ''}
              </span>
              <span className="faint small">{group.builtIn ? 'built in' : nameOf(state, latest.by ?? '')}</span>
            </div>
            {open && <SchemaDetail schema={open} state={state} />}
          </section>
        )
      })}
    </>
  )
}

/** One version: who registered it, its fields at a glance, and its JSON Schema as the board keeps it. */
function SchemaDetail({ schema, state }: { schema: SchemaView; state: State }) {
  const fields = schemaFields(schema.schema)
  const json = JSON.stringify(schema.schema, null, 2)
  const fence = `\`\`\`json#${schema.id}`
  return (
    <div className="schema-detail">
      <p className="hint">
        {schema.builtIn ? 'built in' : schema.by && schema.at ? (
          <>
            {nameOf(state, schema.by)} · <Ago iso={schema.at} />
          </>
        ) : null}
        {' · '}
        <code>{fence}</code>
      </p>
      {fields.length > 0 && (
        <div className="schema-fields" {...nativeMenu}>
          {fields.map((field) => (
            <div key={field.name} className="schema-field">
              <span className="field-name">
                {field.name}
                {field.required && <span className="faint" title="required"> *</span>}
              </span>
              <span className="faint">{field.type}</span>
              <span>{field.description}</span>
            </div>
          ))}
        </div>
      )}
      <div className="schema-json">
        <pre {...nativeMenu}>{json}</pre>
        <button
          className="act"
          onClick={() =>
            void navigator.clipboard.writeText(json).then(
              () => toast(`copied ${schema.id}`),
              () => toast(`couldn't copy ${schema.id}`),
            )
          }
        >
          copy
        </button>
      </div>
    </div>
  )
}

const STARTER = `{
  "type": "object",
  "additionalProperties": false,
  "required": ["title"],
  "properties": {
    "title": { "type": "string" }
  }
}`

/** Registers a version, where you may: the board checks the definition, and says what's wrong with one it refuses. */
function RegisterSchema({ groups }: { groups: ReturnType<typeof schemasByName> }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [version, setVersion] = useState('')
  const [description, setDescription] = useState('')
  const [definition, setDefinition] = useState(STARTER)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const own = groups.filter((group) => !group.builtIn)
  // The next version of a name that's there, or 1 of a new one.
  const next = (own.find((group) => group.name === name.trim())?.versions.at(-1)?.version ?? 0) + 1
  useEffect(() => setProblem(null), [name, version, description, definition])
  const register = async () => {
    let schema: unknown
    try {
      schema = JSON.parse(definition)
    } catch (error) {
      return setProblem(`the definition isn't JSON: ${(error as Error).message}`)
    }
    if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return setProblem('the definition is a JSON object')
    setBusy(true)
    const id = `${name.trim()}@${version.trim() || next}`
    const refused = await board.registerSchema({
      name: name.trim(),
      version: Number(version.trim() || next),
      ...(description.trim() ? { description: description.trim() } : {}),
      schema: schema as Record<string, unknown>,
    })
    setBusy(false)
    if (refused) return setProblem(refused)
    setOpen(false)
    setName('')
    setVersion('')
    setDescription('')
    navigate(`/settings/schemas/${id}`)
  }
  return (
    <Panel
      title="register a schema version"
      trigger={
        <>
          <Plus size={14} /> register
        </>
      }
      triggerClass="act"
      open={open}
      onOpenChange={setOpen}
    >
      <form
        className="ask"
        onSubmit={(event) => {
          event.preventDefault()
          void register()
        }}
        {...fieldMenu}
      >
        <div className="label-add">
          <Suggest className="grow" value={name} onChange={setName} items={own.map((group) => group.name)} placeholder="name, e.g. test-run" autoFocus />
          <span className="faint">@</span>
          <label className="suggest version">
            <input value={version} onChange={(event) => setVersion(event.target.value.replace(/\D/g, ''))} placeholder={String(next)} inputMode="numeric" />
          </label>
        </div>
        <label className="suggest">
          <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="what it holds, in a line (optional)" />
        </label>
        <textarea className="code" rows={10} value={definition} spellCheck={false} onChange={(event) => setDefinition(event.target.value)} />
        {problem ? <p className="hint error-text">{problem}</p> : <p className="hint">A JSON Schema for an object. A version never changes.</p>}
        <button type="submit" className="send small" disabled={busy || !name.trim()}>
          register
        </button>
      </form>
    </Panel>
  )
}
