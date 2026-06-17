import { useState, useRef, useEffect, useCallback } from "react";
import { CodeEditor } from "~/components/CodeEditor";
import { PreviewPane } from "~/components/PreviewPane";
import { DiffViewer } from "~/components/DiffViewer";
import { ContinueEditingBar, loadSession, saveSession, clearSession, type CodegenSession } from "~/components/ContinueEditingBar";

// ── Types ──────────────────────────────────────────────────────────────────────

interface GeneratedFile {
  name: string
  content: string
  language: string
}

// ── Stacks ─────────────────────────────────────────────────────────────────────

const STACKS = [
  { id: 'html',    label: 'HTML/CSS/JS',  icon: '🌐' },
  { id: 'react',   label: 'React',        icon: '⚛' },
  { id: 'vue',     label: 'Vue',          icon: '💚' },
  { id: 'svelte',  label: 'Svelte',       icon: '🔥' },
  { id: 'node',    label: 'Node.js',      icon: '🟢' },
  { id: 'python',  label: 'Python',       icon: '🐍' },
  { id: 'go',      label: 'Go',           icon: '🔵' },
  { id: 'rust',    label: 'Rust',         icon: '🦀' },
]

const MONO = "'JetBrains Mono','Fira Code',monospace"

// ── Component ──────────────────────────────────────────────────────────────────

export default function CodeGenPage() {
  const [prompt, setPrompt]           = useState("")
  const [stack, setStack]             = useState<string>(() => {
    try { return localStorage.getItem('codegen_stack') ?? 'html' } catch { return 'html' }
  })
  const [files, setFiles]             = useState<GeneratedFile[]>([])
  const [activeFile, setActiveFile]   = useState(0)
  const [previewHtml, setPreviewHtml] = useState("")
  const [isGenerating, setIsGenerating] = useState(false)
  const [isIterating, setIsIterating]   = useState(false)
  const [iterPrompt, setIterPrompt]     = useState("")
  const [showDiff, setShowDiff]         = useState(false)
  const [diffOriginal, setDiffOriginal] = useState("")
  const [sessionId, setSessionId]       = useState<string | null>(null)
  const [storedSession, setStoredSession] = useState<CodegenSession | null>(null)
  const [view, setView]                 = useState<'editor' | 'preview' | 'diff'>('editor')
  const abortRef = useRef<AbortController | null>(null)

  // Check for stored session on mount
  useEffect(() => {
    const s = loadSession()
    if (s) setStoredSession(s)
  }, [])

  // Persist stack choice
  useEffect(() => {
    try { localStorage.setItem('codegen_stack', stack) } catch {}
  }, [stack])

  // Auto-compile for preview when file changes
  useEffect(() => {
    const file = files[activeFile]
    if (!file) return
    const timeout = setTimeout(() => compileForPreview(file), 500)
    return () => clearTimeout(timeout)
  }, [files, activeFile])

  async function compileForPreview(file: GeneratedFile) {
    try {
      const r = await fetch('/api/codegen/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: file.content, stack }),
      })
      if (r.ok) {
        const { html } = await r.json()
        setPreviewHtml(html ?? '')
      }
    } catch {}
  }

  async function generate() {
    if (!prompt.trim() || isGenerating) return
    setIsGenerating(true)
    setFiles([])
    setPreviewHtml('')
    setShowDiff(false)
    abortRef.current = new AbortController()

    try {
      const res = await fetch('/api/codegen/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.trim(), stack }),
        signal: abortRef.current.signal,
      })

      if (!res.body) throw new Error('No stream')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let streamedCode = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        for (const line of text.split('\n')) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          try {
            const ev = JSON.parse(data)
            if (ev.type === 'chunk') {
              streamedCode += ev.text
              // Live update the editor
              setFiles([{ name: 'generating…', content: streamedCode, language: 'typescript' }])
            } else if (ev.type === 'done') {
              const genFiles: GeneratedFile[] = ev.files ?? []
              setFiles(genFiles)
              setActiveFile(0)
              setSessionId(ev.sessionId)
              // Save session to localStorage
              saveSession({
                sessionId: ev.sessionId,
                prompt: prompt.trim(),
                stack,
                timestamp: Date.now(),
                files: genFiles,
              })
              setStoredSession(null)
            }
          } catch {}
        }
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        setFiles([{ name: 'error.txt', content: String(e), language: 'text' }])
      }
    } finally {
      setIsGenerating(false)
    }
  }

  async function iterate() {
    if (!iterPrompt.trim() || isIterating || !files[activeFile]) return
    const original = files[activeFile].content
    setDiffOriginal(original)
    setIsIterating(true)
    abortRef.current = new AbortController()

    try {
      const res = await fetch('/api/codegen/iterate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          instruction: iterPrompt.trim(),
          current_code: original,
          stack,
        }),
        signal: abortRef.current.signal,
      })

      if (!res.body) throw new Error('No stream')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let newCode = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        for (const line of text.split('\n')) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          try {
            const ev = JSON.parse(data)
            if (ev.type === 'chunk') newCode += ev.text
            else if (ev.type === 'done' && ev.files?.length) {
              const updated = ev.files[0] as GeneratedFile
              setFiles(prev => prev.map((f, i) => i === activeFile ? updated : f))
              setShowDiff(true)
              setView('diff')
              setIterPrompt('')
            }
          } catch {}
        }
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') console.error(e)
    } finally {
      setIsIterating(false)
    }
  }

  function continueSession(s: CodegenSession) {
    setPrompt(s.prompt)
    setStack(s.stack)
    setFiles(s.files)
    setSessionId(s.sessionId)
    setStoredSession(null)
  }

  function handleFresh() {
    clearSession()
    setStoredSession(null)
  }

  const currentFile = files[activeFile]

  return (
    <div style={{ fontFamily: MONO, background: '#080808', color: '#c8c8c8', height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <style>{`
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #222; border-radius: 2px; }
        textarea::placeholder { color: #3a3a3a; }
      `}</style>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 14px', borderBottom: '1px solid #1a1a1a', background: '#050505', flexShrink: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.25em', color: '#00ff88' }}>CODEGEN</span>
        <span style={{ color: '#222' }}>│</span>

        {/* Stack selector */}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {STACKS.map(s => (
            <button
              key={s.id}
              onClick={() => setStack(s.id)}
              style={{
                fontSize: 10, padding: '2px 8px', borderRadius: 4, cursor: 'pointer',
                background: stack === s.id ? '#1a3a1a' : 'none',
                border: `1px solid ${stack === s.id ? '#00ff88' : '#222'}`,
                color: stack === s.id ? '#00ff88' : '#555',
                fontFamily: MONO,
              }}
            >
              {s.icon} {s.label}
            </button>
          ))}
        </div>

        {/* View toggle */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {(['editor', 'preview', 'diff'] as const).map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                fontSize: 10, padding: '3px 10px', borderRadius: 4, cursor: 'pointer',
                background: view === v ? '#1e1e1e' : 'none',
                border: `1px solid ${view === v ? '#444' : '#222'}`,
                color: view === v ? '#e5e7eb' : '#555',
                fontFamily: MONO,
              }}
            >
              {v.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* Left panel: prompt + iterate + file tabs */}
        <div style={{ width: 280, minWidth: 280, borderRight: '1px solid #1a1a1a', display: 'flex', flexDirection: 'column', background: '#050505' }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>

            {storedSession && (
              <ContinueEditingBar
                session={storedSession}
                onContinue={continueSession}
                onFresh={handleFresh}
              />
            )}

            {/* Prompt */}
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 9, color: '#555', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: 5 }}>Prompt</div>
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generate() }}
                placeholder="describe what to build…"
                rows={4}
                style={{
                  width: '100%', background: '#0a0a0a', border: '1px solid #222', color: '#c8c8c8',
                  borderRadius: 6, padding: '8px 10px', fontSize: 12, resize: 'vertical',
                  outline: 'none', boxSizing: 'border-box', fontFamily: MONO,
                }}
              />
              <button
                onClick={generate}
                disabled={!prompt.trim() || isGenerating}
                style={{
                  marginTop: 6, width: '100%', padding: '7px 0', borderRadius: 5, fontSize: 11,
                  fontFamily: MONO, fontWeight: 700, letterSpacing: '0.1em', cursor: prompt.trim() && !isGenerating ? 'pointer' : 'not-allowed',
                  background: prompt.trim() && !isGenerating ? '#00ff88' : 'transparent',
                  color: prompt.trim() && !isGenerating ? '#050505' : '#555',
                  border: `1px solid ${prompt.trim() && !isGenerating ? '#00ff88' : '#222'}`,
                  transition: 'all 0.15s',
                }}
              >
                {isGenerating ? 'GENERATING…' : '⌘↵ GENERATE'}
              </button>
              {isGenerating && (
                <button
                  onClick={() => abortRef.current?.abort()}
                  style={{ marginTop: 4, width: '100%', padding: '5px 0', borderRadius: 5, fontSize: 10, fontFamily: MONO, cursor: 'pointer', background: 'none', border: '1px solid #ff3355', color: '#ff3355' }}
                >
                  STOP
                </button>
              )}
            </div>

            {/* Iterate */}
            {files.length > 0 && (
              <div style={{ borderTop: '1px solid #1a1a1a', paddingTop: 10 }}>
                <div style={{ fontSize: 9, color: '#555', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: 5 }}>Iterate</div>
                <textarea
                  value={iterPrompt}
                  onChange={e => setIterPrompt(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) iterate() }}
                  placeholder="change, fix, or improve…"
                  rows={3}
                  style={{
                    width: '100%', background: '#0a0a0a', border: '1px solid #1a1a1a', color: '#c8c8c8',
                    borderRadius: 6, padding: '7px 10px', fontSize: 12, resize: 'vertical',
                    outline: 'none', boxSizing: 'border-box', fontFamily: MONO,
                  }}
                />
                <button
                  onClick={iterate}
                  disabled={!iterPrompt.trim() || isIterating}
                  style={{
                    marginTop: 5, width: '100%', padding: '6px 0', borderRadius: 5, fontSize: 10,
                    fontFamily: MONO, letterSpacing: '0.1em', cursor: iterPrompt.trim() && !isIterating ? 'pointer' : 'not-allowed',
                    background: 'none',
                    color: iterPrompt.trim() && !isIterating ? '#00ccff' : '#555',
                    border: `1px solid ${iterPrompt.trim() && !isIterating ? '#00ccff' : '#222'}`,
                  }}
                >
                  {isIterating ? 'ITERATING…' : '⌘↵ ITERATE'}
                </button>
              </div>
            )}

            {/* File tabs */}
            {files.length > 1 && (
              <div style={{ borderTop: '1px solid #1a1a1a', paddingTop: 10, marginTop: 10 }}>
                <div style={{ fontSize: 9, color: '#555', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: 5 }}>Files</div>
                {files.map((f, i) => (
                  <div
                    key={i}
                    onClick={() => setActiveFile(i)}
                    style={{
                      padding: '5px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 11,
                      background: activeFile === i ? '#1a1a1a' : 'none',
                      color: activeFile === i ? '#e5e7eb' : '#666',
                      marginBottom: 2,
                    }}
                  >
                    {f.name}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right panel: editor / preview / diff */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {view === 'editor' && (
            <div style={{ flex: 1, padding: 10, overflow: 'hidden' }}>
              <CodeEditor
                value={currentFile?.content ?? ''}
                language={currentFile?.language ?? 'typescript'}
                filename={currentFile?.name}
                onChange={val => setFiles(prev => prev.map((f, i) => i === activeFile ? { ...f, content: val } : f))}
                readOnly={isGenerating}
                onCopy={() => navigator.clipboard.writeText(currentFile?.content ?? '')}
                onDownload={() => {
                  const a = document.createElement('a')
                  const blob = new Blob([currentFile?.content ?? ''], { type: 'text/plain' })
                  a.href = URL.createObjectURL(blob)
                  a.download = currentFile?.name ?? 'code.txt'
                  a.click()
                }}
              />
            </div>
          )}

          {view === 'preview' && (
            <div style={{ flex: 1, padding: 10, overflow: 'hidden' }}>
              <PreviewPane html={previewHtml} isLoading={isGenerating} stack={stack} />
            </div>
          )}

          {view === 'diff' && (
            <div style={{ flex: 1, padding: 10, overflowY: 'auto' }}>
              {showDiff && currentFile && diffOriginal ? (
                <DiffViewer
                  filename={currentFile.name}
                  original={diffOriginal}
                  modified={currentFile.content}
                  onApply={async (hunks) => {
                    const res = await fetch('/api/diff/apply', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ patches: [{ filename: currentFile.name, hunks }] }),
                    })
                    const data = await res.json()
                    return { rollbackId: data.rollbackId }
                  }}
                />
              ) : (
                <div style={{ color: '#555', fontSize: 12, textAlign: 'center', paddingTop: 40 }}>
                  No diff yet — use Iterate to generate changes
                </div>
              )}
            </div>
          )}
        </div>

        {/* Preview pane as side panel when in editor view */}
        {view === 'editor' && files.length > 0 && (
          <div style={{ width: 380, minWidth: 380, borderLeft: '1px solid #1a1a1a', padding: 10 }}>
            <PreviewPane html={previewHtml} isLoading={isGenerating} stack={stack} />
          </div>
        )}
      </div>
    </div>
  )
}
