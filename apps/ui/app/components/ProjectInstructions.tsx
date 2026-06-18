import React, { useState, useEffect } from 'react'

interface STMModule {
  id: string
  name: string
  description: string
  active: boolean
}

interface ProjectInstructionsProps {
  projectId: string
}

const MAX_CHARS = 2000

function instrKey(id: string) { return `project_instructions_${id}` }

function load(projectId: string): string {
  try { return localStorage.getItem(instrKey(projectId)) ?? '' } catch { return '' }
}

function save(projectId: string, value: string) {
  try { localStorage.setItem(instrKey(projectId), value) } catch {}
}

export function ProjectInstructions({ projectId }: ProjectInstructionsProps) {
  const [instructions, setInstructions] = useState(() => load(projectId))
  const [saving, setSaving]             = useState(false)
  const [saved, setSaved]               = useState(false)
  const [modules, setModules]           = useState<STMModule[]>([])
  const [activeModules, setActiveModules] = useState<Set<string>>(new Set())

  // Load STM modules
  useEffect(() => {
    fetch('/api/stm')
      .then(r => r.ok ? r.json() : { modules: [] })
      .then(data => {
        const mods: STMModule[] = data.modules ?? data ?? []
        setModules(mods)
        setActiveModules(new Set(mods.filter((m: STMModule) => m.active).map((m: STMModule) => m.id)))
      })
      .catch(() => {})
  }, [])

  // Load per-project instructions from backend (fire-and-forget, fallback to localStorage)
  useEffect(() => {
    fetch(`/api/stm/project/${projectId}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.instructions) {
          setInstructions(data.instructions)
          save(projectId, data.instructions)
        }
      })
      .catch(() => {})
  }, [projectId])

  async function handleSave() {
    save(projectId, instructions)
    setSaving(true)
    try {
      await fetch(`/api/stm/project/${projectId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instructions }),
      })
    } catch {}
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  function toggleModule(id: string) {
    setActiveModules(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      // Sync to backend (fire-and-forget)
      fetch('/api/stm/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, active: next.has(id) }),
      }).catch(() => {})
      return next
    })
  }

  const remaining = MAX_CHARS - instructions.length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Header */}
      <div style={{ padding: '10px 14px', borderBottom: '1px solid #1a1a1a' }}>
        <span style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: '1px' }}>
          Instructions
        </span>
      </div>

      <div style={{ padding: '12px 14px' }}>
        {/* Instruction textarea */}
        <textarea
          value={instructions}
          onChange={e => setInstructions(e.target.value.slice(0, MAX_CHARS))}
          placeholder="Custom instructions for this project&#10;e.g. Always respond in TypeScript. Prefer functional patterns."
          rows={6}
          style={{
            width: '100%', background: '#0a0a0a', border: '1px solid #2a2a2a',
            color: '#e5e7eb', borderRadius: 6, padding: '8px 10px', fontSize: 12,
            resize: 'vertical', outline: 'none', boxSizing: 'border-box',
            fontFamily: 'inherit', lineHeight: 1.5,
          }}
        />

        {/* Char count + Save */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
          <span style={{ fontSize: 10, color: remaining < 100 ? '#ef4444' : '#555' }}>
            {remaining} chars left
          </span>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              fontSize: 11,
              color: saved ? '#22c55e' : '#e5e7eb',
              background: saved ? '#0a2a0a' : '#1e1e1e',
              border: `1px solid ${saved ? '#16a34a' : '#333'}`,
              borderRadius: 5,
              padding: '4px 12px',
              cursor: saving ? 'not-allowed' : 'pointer',
              transition: 'all 0.2s',
            }}
          >
            {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save'}
          </button>
        </div>

        {/* STM module toggles */}
        {modules.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 10, color: '#555', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 8 }}>
              Active STM Modules
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {modules.map(m => {
                const on = activeModules.has(m.id)
                return (
                  <button
                    key={m.id}
                    onClick={() => toggleModule(m.id)}
                    title={m.description}
                    style={{
                      fontSize: 11,
                      color: on ? '#a855f7' : '#555',
                      background: on ? '#1a0d2e' : 'none',
                      border: `1px solid ${on ? '#7c3aed' : '#333'}`,
                      borderRadius: 4,
                      padding: '3px 9px',
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                    }}
                  >
                    {on ? '◈' : '○'} {m.name}
                  </button>
                )
              })}
            </div>
            <div style={{ marginTop: 8 }}>
              <a href="/stm" style={{ fontSize: 10, color: '#555', textDecoration: 'none' }}>
                Edit modules in STM →
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
