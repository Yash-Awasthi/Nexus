import React, { useState, useEffect } from 'react'

interface MemoryEntry {
  id: string
  content: string
  created_at: string
}

interface ProjectMemoryPanelProps {
  projectId: string
}

export function ProjectMemoryPanel({ projectId }: ProjectMemoryPanelProps) {
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [newContent, setNewContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  useEffect(() => {
    if (!projectId) return
    setLoading(true)
    fetch(`/api/memory/entries?project_id=${projectId}`)
      .then((r) => (r.ok ? r.json() : { entries: [] }))
      .then((data) => {
        setEntries(data.entries ?? data ?? [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [projectId])

  async function handleForget(id: string) {
    setEntries((prev) => prev.filter((e) => e.id !== id))
    try {
      await fetch(`/api/memory/entries/${id}`, { method: 'DELETE' })
    } catch {}
  }

  async function handleAdd() {
    if (!newContent.trim()) return
    setSaving(true)
    const optimistic: MemoryEntry = {
      id: Date.now().toString(),
      content: newContent.trim(),
      created_at: new Date().toISOString(),
    }
    setEntries((prev) => [optimistic, ...prev])
    setNewContent('')
    setAdding(false)

    try {
      const res = await fetch('/api/memory/entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: optimistic.content, project_id: projectId }),
      })
      if (res.ok) {
        const saved = await res.json()
        setEntries((prev) =>
          prev.map((e) => (e.id === optimistic.id ? { ...e, id: saved.id ?? e.id } : e))
        )
      }
    } catch {}
    setSaving(false)
  }

  function formatDate(iso: string) {
    try {
      return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    } catch {
      return ''
    }
  }

  return (
    <div
      style={{
        width: 240,
        minWidth: 240,
        background: '#0f0f0f',
        borderRight: '1px solid #222',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: '12px 14px', borderBottom: '1px solid #1a1a1a' }}>
        <span
          style={{
            fontSize: 11,
            color: '#888',
            letterSpacing: '1px',
            textTransform: 'uppercase',
          }}
        >
          Memory
        </span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {loading ? (
          [1, 2, 3].map((i) => (
            <div
              key={i}
              style={{
                margin: '6px 14px',
                height: 48,
                background: '#1a1a1a',
                borderRadius: 6,
                opacity: 0.5,
              }}
            />
          ))
        ) : entries.length === 0 ? (
          <div
            style={{
              color: '#555',
              fontSize: 12,
              textAlign: 'center',
              padding: '32px 14px',
              lineHeight: 1.6,
            }}
          >
            No memories yet.
            <br />
            Use "Remember this" on any message.
          </div>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.id}
              onMouseEnter={() => setHoveredId(entry.id)}
              onMouseLeave={() => setHoveredId(null)}
              style={{
                padding: '8px 14px',
                borderBottom: '1px solid #191919',
                position: 'relative',
                background: hoveredId === entry.id ? '#141414' : 'transparent',
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  color: '#ccc',
                  lineHeight: 1.5,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  marginBottom: 3,
                }}
              >
                {entry.content}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 10, color: '#555' }}>{formatDate(entry.created_at)}</span>
                {hoveredId === entry.id && (
                  <span
                    onClick={() => handleForget(entry.id)}
                    style={{
                      fontSize: 11,
                      color: '#ef4444',
                      cursor: 'pointer',
                      padding: '1px 5px',
                    }}
                  >
                    Forget
                  </span>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Add memory */}
      <div style={{ padding: '10px 14px', borderTop: '1px solid #1a1a1a' }}>
        {adding ? (
          <>
            <textarea
              autoFocus
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder="What should I remember?"
              style={{
                width: '100%',
                background: '#0a0a0a',
                border: '1px solid #333',
                color: '#e5e7eb',
                borderRadius: 6,
                padding: '6px 8px',
                fontSize: 12,
                resize: 'none',
                minHeight: 60,
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button
                onClick={handleAdd}
                disabled={saving || !newContent.trim()}
                style={{
                  flex: 1,
                  background: '#2563eb',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 5,
                  padding: '5px 0',
                  fontSize: 12,
                  cursor: saving ? 'not-allowed' : 'pointer',
                }}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={() => { setAdding(false); setNewContent('') }}
                style={{
                  background: 'none',
                  color: '#888',
                  border: '1px solid #333',
                  borderRadius: 5,
                  padding: '5px 10px',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <button
            onClick={() => setAdding(true)}
            style={{
              width: '100%',
              background: 'none',
              border: '1px dashed #333',
              color: '#666',
              borderRadius: 6,
              padding: '6px',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            + Add memory
          </button>
        )}
      </div>
    </div>
  )
}
