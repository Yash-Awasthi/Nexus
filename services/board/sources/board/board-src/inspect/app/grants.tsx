import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Explanation, GrantCan, GrantView, PrincipalInput } from '../../api/routes.ts'
// `@vercel/board/access`, in an app of yours.
import { PERMISSIONS } from '../../server/access.ts'
import type { ExplainPrincipal } from '../../server/index.default.ts'
import * as board from './board.ts'
import { Ago, here, navigate, type Where } from './nav.tsx'
import { Actions } from './settings.tsx'
import { canFromLines, nameOf, type State, type Viewer } from './store.ts'
import { fieldMenu, nativeMenu, Panel, Suggest, Unlisted } from './ui.tsx'
import { principalName, said } from './words.ts'

// Access: what you may do, the grants that let everyone else in, and the board's own answer to
// "who decides this channel, for whom". The page shows what the board says; it works nothing out.

/** Who a grant, or a question, can be about, and what the page asks to name one. */
const KINDS = {
  user: { label: 'user', fields: [{ name: 'id', placeholder: 'email, or a user ID' }] },
  project: {
    label: 'project',
    fields: [
      { name: 'id', placeholder: 'project name or ID' },
      { name: 'environment', placeholder: 'environment (production)' },
    ],
  },
  github: {
    label: 'github',
    fields: [
      { name: 'id', placeholder: 'owner/repository' },
      { name: 'workflow', placeholder: 'workflow, e.g. ci.yml (any)' },
      { name: 'branch', placeholder: 'branch (any)' },
    ],
  },
  app: { label: 'app', fields: [{ name: 'id', placeholder: 'app slug or client ID' }] },
} as const
type Kind = keyof typeof KINDS
const isKind = (value: string | null): value is Kind => value !== null && value in KINDS

export function Access(props: { state: State; viewer: Viewer; where: Where }) {
  const { state, viewer } = props
  useEffect(() => {
    void board.loadGrants()
  }, [])
  const me = state.me!
  const grants = state.grants
  const mayGrant = Object.values(me.can).some((permissions) => permissions.includes('manage'))
  return (
    <>
      {mayGrant && (
        <Actions>
          <NewGrant />
        </Actions>
      )}
      <h3>you</h3>
      <div className="grant-row" {...nativeMenu}>
        <span className="faint" />
        <span className="grant-who">{nameOf(state, me.actor)}</span>
        <Can can={me.can} />
      </div>
      <h3>explain</h3>
      <Explain state={state} where={props.where} />
      <h3>grants</h3>
      <Unlisted listed={grants} />
      {grants.is === 'here' && grants.items.length === 0 && <p className="empty">no grants</p>}
      {grants.is === 'here' && grants.items.map((grant) => <GrantRow key={grant.id} grant={grant} state={state} revoke={viewer.manages} />)}
    </>
  )
}

/** What a `can` gives, pattern by pattern, as the board wrote it. */
function Can({ can }: { can: Record<string, 'all' | readonly string[]> }) {
  return (
    <span className="grant-can">
      {Object.entries(can).map(([pattern, gives]) => (
        <span key={pattern} className="label">
          <b>{pattern}</b> {gives === 'all' ? 'all' : gives.length > 0 ? gives.join(' ') : 'none'}
        </span>
      ))}
    </span>
  )
}

function GrantRow({ grant, state, revoke }: { grant: GrantView; state: State; revoke: boolean }) {
  const who = grant.principals.map(principalName).join(', ')
  return (
    <div className="grant-row" {...nativeMenu}>
      <span className="faint">{grant.id}</span>
      <span className="grant-who" title={who}>
        {who}
        {grant.capped && <span className="badge" title="a person's team role caps what it gives them">capped by role</span>}
      </span>
      <Can can={grant.can} />
      <span className="faint small">
        {grant.by && grant.at ? (
          <>
            {nameOf(state, grant.by)} · <Ago iso={grant.at} />
          </>
        ) : (
          "the board's own"
        )}
      </span>
      {revoke && (
        <button className="act quiet" onClick={() => confirm(`Revoke ${grant.id}? ${who} can't use what it gave from their next request.`) && void board.revokeGrant(grant.id)}>
          revoke
        </button>
      )}
    </div>
  )
}

/** The principal the fields name, as `explain` takes one. */
function whomOf(kind: Kind | 'you', fields: Record<string, string>): ExplainPrincipal {
  const id = fields.id ?? ''
  if (kind === 'user') return { user: id }
  if (kind === 'project') return { project: id, ...(fields.environment ? { environment: fields.environment } : {}) }
  if (kind === 'github') return { github: id, ...(fields.workflow ? { workflow: fields.workflow } : {}), ...(fields.branch ? { branch: fields.branch } : {}) }
  if (kind === 'app') return { app: id }
  return {}
}

/** Picks who it's about: one of the kinds, and what names one. */
function Who<K extends string>(props: { kinds: readonly K[]; labels: Record<K, string>; kind: K; onKind: (kind: K) => void; fields: Record<string, string>; onField: (name: string, value: string) => void }) {
  const named = isKind(props.kind) ? KINDS[props.kind].fields : []
  return (
    <>
      <div className="segments">
        {props.kinds.map((kind) => (
          <button key={kind} type="button" className={`segment${props.kind === kind ? ' on' : ''}`} onClick={() => props.onKind(kind)}>
            {props.labels[kind]}
          </button>
        ))}
      </div>
      {named.length > 0 && (
        <div className="who-fields">
          {named.map((field) => (
            <label key={field.name} className="suggest">
              <input value={props.fields[field.name] ?? ''} placeholder={field.placeholder} spellCheck={false} onChange={(event) => props.onField(field.name, event.target.value)} />
            </label>
          ))}
        </div>
      )}
    </>
  )
}

const EXPLAIN_KINDS = ['you', 'user', 'project', 'github', 'app'] as const
const EXPLAIN_LABELS = { you: 'you', user: 'user', project: 'project', github: 'github', app: 'app' }
const FIELDS = ['id', 'environment', 'workflow', 'branch']

/** Asks the board which grants decide a channel, for you or a principal you name. The question lives in the URL. */
function Explain({ state, where }: { state: State; where: Where }) {
  const asked = where.params.get('channel') ?? ''
  const askedKind = where.params.get('who')
  const [channel, setChannel] = useState(asked)
  const [kind, setKind] = useState<(typeof EXPLAIN_KINDS)[number]>(isKind(askedKind) ? askedKind : 'you')
  const [fields, setFields] = useState<Record<string, string>>(() => Object.fromEntries(FIELDS.map((name) => [name, where.params.get(name) ?? ''])))
  const [answer, setAnswer] = useState<{ explanation: Explanation } | { problem: string } | null>(null)
  const query = where.params.toString()
  useEffect(() => {
    if (!asked) return setAnswer(null)
    let current = true
    const params = where.params
    board.explain(asked, whomOf(isKind(params.get('who')) ? (params.get('who') as Kind) : 'you', Object.fromEntries(FIELDS.map((name) => [name, params.get(name) ?? ''])))).then(
      (explanation) => current && setAnswer({ explanation }),
      (error) => current && setAnswer({ problem: said(error) }),
    )
    return () => {
      current = false
    }
  }, [query])
  const ask = () => {
    const place = channel.trim().replace(/^#/, '')
    if (!place) return
    navigate(here({ params: { channel: place, who: kind === 'you' ? null : kind, ...Object.fromEntries(FIELDS.map((name) => [name, kind === 'you' ? null : fields[name]?.trim() || null])) } }))
  }
  const subject = askedKind && isKind(askedKind) ? (where.params.get('id') ?? askedKind) : 'you'
  return (
    <form
      className="explain"
      onSubmit={(event) => {
        event.preventDefault()
        ask()
      }}
      {...fieldMenu}
    >
      <div className="explain-ask">
        <Suggest prefix="#" value={channel} onChange={setChannel} items={Object.keys(state.channels).sort()} placeholder="channel" onEnter={ask} />
        <span className="faint">for</span>
        <Who kinds={EXPLAIN_KINDS} labels={EXPLAIN_LABELS} kind={kind} onKind={setKind} fields={fields} onField={(name, value) => setFields((current) => ({ ...current, [name]: value }))} />
        <button type="submit" className="send small" disabled={!channel.trim()}>
          explain
        </button>
      </div>
      {answer && 'problem' in answer && <p className="hint error-text">{answer.problem}</p>}
      {answer && 'explanation' in answer && <Explained explanation={answer.explanation} subject={subject} state={state} />}
    </form>
  )
}

/** The board's answer, as it gave it: what they may do there, the pattern that decided, at which level, and the grants that add up to it. */
function Explained({ explanation, subject, state }: { explanation: Explanation; subject: string; state: State }) {
  const { channel, pattern, over, level, grants, capped, can } = explanation
  return (
    <div className="explained" {...nativeMenu}>
      <p>
        In <b>#{channel}</b>, {subject} may {can.length > 0 ? <b>{can.join(', ')}</b> : <b>do nothing</b>}.
      </p>
      <dl className="facts">
        <dt>decided</dt>
        <dd>
          {pattern === null ? (
            can.length > 0 ? 'by no grant: the board lets its own code and deployments in' : 'by no grant: nothing lets them in'
          ) : (
            <>
              at <b>{pattern}</b>, by {level === 'principal' ? 'a grant that names them' : level === 'group' ? 'a grant that names a group they are in' : 'a grant for everyone'}
              {over.length > 0 && <span className="faint"> (over {over.join(', ')})</span>}
            </>
          )}
        </dd>
        {capped !== null && (
          <>
            <dt>capped</dt>
            <dd>by their team role: {capped}</dd>
          </>
        )}
      </dl>
      {grants.map((grant) => (
        <GrantRow key={grant.id} grant={grant} state={state} revoke={false} />
      ))}
    </div>
  )
}

const GRANT_KINDS = ['user', 'project', 'github', 'app', 'all-users', 'all-projects', 'all-apps', 'everyone'] as const
const GRANT_LABELS = { user: 'user', project: 'project', github: 'github', app: 'app', 'all-users': 'every user', 'all-projects': 'every project', 'all-apps': 'every app', everyone: 'everyone' }

/** The principal the fields name, as a grant takes one. */
function principalOf(kind: (typeof GRANT_KINDS)[number], fields: Record<string, string>): PrincipalInput {
  const id = (fields.id ?? '').trim()
  const environment = (fields.environment ?? '').trim()
  const environments = environment ? { environments: environment.split(',').map((name) => name.trim()).filter(Boolean) } : {}
  if (kind === 'user') return id.includes('@') ? { kind, email: id } : { kind, userId: id }
  if (kind === 'project') return { kind, project: id, ...environments }
  if (kind === 'github') return { kind, repository: id, ...(fields.workflow?.trim() ? { workflow: fields.workflow.trim() } : {}), ...(fields.branch?.trim() ? { branch: fields.branch.trim() } : {}) }
  if (kind === 'app') return { kind, app: id }
  return { kind }
}

/** A new grant: who, and what they may do where. The board checks it, and says what's wrong with one it refuses. */
function NewGrant() {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<(typeof GRANT_KINDS)[number]>('user')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [lines, setLines] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => setProblem(null), [kind, fields, lines])
  const named = !isKind(kind) || (fields.id ?? '').trim() !== ''
  const grant = async () => {
    const read = canFromLines(lines)
    if ('problem' in read) return setProblem(read.problem)
    setBusy(true)
    // The lines' permissions go as written: which ones there are is the board's to say.
    const refused = await board.createGrant({ principals: [principalOf(kind, fields)], can: read.can as GrantCan })
    setBusy(false)
    if (refused) return setProblem(refused)
    setOpen(false)
    setFields({})
    setLines('')
  }
  return (
    <Panel
      title="a new grant"
      trigger={
        <>
          <Plus size={14} /> grant
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
          void grant()
        }}
        {...fieldMenu}
      >
        <Who kinds={GRANT_KINDS} labels={GRANT_LABELS} kind={kind} onKind={setKind} fields={fields} onField={(name, value) => setFields((current) => ({ ...current, [name]: value }))} />
        <textarea className="code can" rows={3} value={lines} spellCheck={false} placeholder={'work/=read,post\nsecrets/=none'} onChange={(event) => setLines(event.target.value)} />
        {problem ? (
          <p className="hint error-text">{problem}</p>
        ) : (
          <p className="hint">A line per pattern: all, none, or any of {PERMISSIONS.join(', ')}.</p>
        )}
        <button type="submit" className="send small" disabled={busy || !named || !lines.trim()}>
          grant
        </button>
      </form>
    </Panel>
  )
}
