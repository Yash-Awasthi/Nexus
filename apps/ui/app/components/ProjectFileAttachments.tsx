import React, { useState, useRef, useCallback } from 'react'

interface AttachedFile {
  id: string
  filename: string
  size: number
  added_at: string
  content?: string
}

interface ProjectFileAttachmentsProps {
  projectId: string
}

const MAX_FILES = 10
const MAX_SIZE  = 5 * 1024 * 1024 // 5 MB
const ACCEPTED  = ['.txt', '.md', '.ts', '.tsx', '.js', '.jsx', '.py', '.json', '.yaml', '.yml', '.pdf', '.csv']

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) } catch { return '' }
}

function storageKey(projectId: string) { return `project_files_${projectId}` }

function loadFiles(projectId: string): AttachedFile[] {
  try { return JSON.parse(localStorage.getItem(storageKey(projectId)) ?? '[]') } catch { return [] }
}

function saveFiles(projectId: string, files: AttachedFile[]) {
  try { localStorage.setItem(storageKey(projectId), JSON.stringify(files)) } catch {}
}

const FILE_ICONS: Record<string, string> = {
  ts: '🔷', tsx: '🔷', js: '🟡', jsx: '🟡', py: '🐍',
  json: '📋', md: '📝', txt: '📄', pdf: '📕', yaml: '⚙️', yml: '⚙️', csv: '📊',
}

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return FILE_ICONS[ext] ?? '📄'
}

export function ProjectFileAttachments({ projectId }: ProjectFileAttachmentsProps) {
  const [files, setFiles]     = useState<AttachedFile[]>(() => loadFiles(projectId))
  const [dragging, setDragging] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  function addFiles(fileList: File[]) {
    setError(null)
    const current = loadFiles(projectId)
    const toAdd: AttachedFile[] = []

    for (const f of fileList) {
      if (current.length + toAdd.length >= MAX_FILES) {
        setError(`Max ${MAX_FILES} files per project`); break
      }
      if (f.size > MAX_SIZE) {
        setError(`"${f.name}" exceeds 5 MB limit`); continue
      }
      const ext = '.' + (f.name.split('.').pop()?.toLowerCase() ?? '')
      if (!ACCEPTED.includes(ext)) {
        setError(`"${f.name}" — unsupported type`); continue
      }
      toAdd.push({
        id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        filename: f.name,
        size: f.size,
        added_at: new Date().toISOString(),
      })
    }

    if (toAdd.length === 0) return
    const updated = [...current, ...toAdd]
    setFiles(updated)
    saveFiles(projectId, updated)

    // Also attempt to sync to backend (fire-and-forget)
    for (const f of fileList) {
      const fd = new FormData()
      fd.append('file', f)
      fetch(`/api/v1/projects/${projectId}/files`, { method: 'POST', body: fd }).catch(() => {})
    }
  }

  function removeFile(id: string) {
    const updated = files.filter(f => f.id !== id)
    setFiles(updated)
    saveFiles(projectId, updated)
    fetch(`/api/v1/projects/${projectId}/files/${id}`, { method: 'DELETE' }).catch(() => {})
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    addFiles(Array.from(e.dataTransfer.files))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0d0d0d' }}>
      {/* Header */}
      <div style={{ padding: '10px 14px', borderBottom: '1px solid #1a1a1a', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: '1px' }}>
          Files ({files.length}/{MAX_FILES})
        </span>
        <button
          onClick={() => inputRef.current?.click()}
          style={{ fontSize: 11, color: '#3b82f6', background: 'none', border: '1px solid #1d4ed8', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }}
        >
          + Add
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPTED.join(',')}
          style={{ display: 'none' }}
          onChange={e => { if (e.target.files) addFiles(Array.from(e.target.files)); e.target.value = '' }}
        />
      </div>

      {/* Error */}
      {error && (
        <div style={{ margin: '8px 14px', padding: '6px 10px', background: '#2b0d0d', border: '1px solid #7f1d1d', borderRadius: 5, fontSize: 11, color: '#fca5a5', display: 'flex', justifyContent: 'space-between' }}>
          {error}
          <span onClick={() => setError(null)} style={{ cursor: 'pointer', color: '#f87171' }}>×</span>
        </div>
      )}

      {/* File list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {files.length === 0 ? (
          /* Drop zone */
          <div
            onDragOver={e => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
            style={{
              margin: '12px 14px',
              border: `2px dashed ${dragging ? '#3b82f6' : '#333'}`,
              borderRadius: 8,
              background: dragging ? '#0d1b2e' : '#111',
              padding: '28px 16px',
              textAlign: 'center',
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
          >
            <div style={{ fontSize: 20, marginBottom: 8 }}>📂</div>
            <div style={{ fontSize: 12, color: '#666' }}>Drop files here or click to browse</div>
            <div style={{ fontSize: 10, color: '#444', marginTop: 4 }}>{ACCEPTED.join('  ')}</div>
          </div>
        ) : (
          <>
            {files.map(f => (
              <div
                key={f.id}
                onMouseEnter={() => setHoveredId(f.id)}
                onMouseLeave={() => setHoveredId(null)}
                style={{
                  padding: '7px 14px',
                  borderBottom: '1px solid #141414',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  background: hoveredId === f.id ? '#141414' : 'transparent',
                }}
              >
                <span style={{ fontSize: 14, flexShrink: 0 }}>{fileIcon(f.filename)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: '#e5e7eb', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.filename}
                  </div>
                  <div style={{ fontSize: 10, color: '#555', marginTop: 1 }}>
                    {formatSize(f.size)} · {formatDate(f.added_at)}
                  </div>
                </div>
                {hoveredId === f.id && (
                  <span
                    onClick={() => removeFile(f.id)}
                    style={{ color: '#ef4444', cursor: 'pointer', fontSize: 14, flexShrink: 0, padding: '0 2px' }}
                  >
                    ×
                  </span>
                )}
              </div>
            ))}
            {/* Drop more zone */}
            {files.length < MAX_FILES && (
              <div
                onDragOver={e => { e.preventDefault(); setDragging(true) }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                style={{
                  margin: '8px 14px',
                  border: `1px dashed ${dragging ? '#3b82f6' : '#222'}`,
                  borderRadius: 6,
                  padding: '8px',
                  textAlign: 'center',
                  fontSize: 11,
                  color: '#444',
                  cursor: 'default',
                  transition: 'all 0.15s',
                }}
              >
                Drop more files here
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
