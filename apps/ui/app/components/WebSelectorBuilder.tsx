"use client"

import * as React from "react"
import {
  PlusIcon,
  Trash2Icon,
  PlayIcon,
  SearchIcon,
  RefreshCwIcon,
  CheckCircleIcon,
  XCircleIcon,
  ClockIcon,
  ZapIcon,
  GlobeIcon,
  CodeIcon,
  CopyIcon,
  HistoryIcon,
  WrenchIcon,
  LayersIcon,
} from "lucide-react"

import { Button } from "~/components/ui/button"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "~/components/ui/card"
import { Input } from "~/components/ui/input"
import { Badge } from "~/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select"
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "~/components/ui/dialog"

// ─── Types ──────────────────────────────────────────────────────────────────

interface WebSelector {
  id: number
  name: string
  description: string
  url: string | null
  resolvedSelector: string | null
  selectorType: "css" | "xpath" | "aria"
  confidence: number
  lastResolvedAt: string | null
  failCount: number
  createdAt: string
  updatedAt: string
}

interface ExecutionResult {
  success: boolean
  selector: string
  selectorType: "css" | "xpath" | "aria"
  content: string | null
  confidence: number
  executionTimeMs: number
  error?: string
}

interface ExecutionHistory {
  id: number
  selectorId: number
  url: string
  success: boolean
  resolvedSelector: string
  extractedContent: string | null
  executionTimeMs: number
  errorMessage: string | null
  createdAt: string
}

interface ResolveResult {
  candidates: {
    selector: string
    type: "css" | "xpath" | "aria"
    confidence: number
    reasoning: string
  }[]
  bestSelector: string | null
  bestType: "css" | "xpath" | "aria"
  confidence: number
}

// ─── API Helpers ────────────────────────────────────────────────────────────

const API_BASE = "/api/web-selectors"

async function apiCall<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || "Request failed")
  }
  return res.json()
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function WebSelectorBuilder() {
  const [selectors, setSelectors] = React.useState<WebSelector[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Create form state
  const [newName, setNewName] = React.useState("")
  const [newDescription, setNewDescription] = React.useState("")
  const [newUrl, setNewUrl] = React.useState("")
  const [newType, setNewType] = React.useState<"css" | "xpath" | "aria">("css")
  const [createOpen, setCreateOpen] = React.useState(false)

  // Execute state
  const [executeUrl, setExecuteUrl] = React.useState("")
  const [executeResult, setExecuteResult] = React.useState<ExecutionResult | null>(null)
  const [executing, setExecuting] = React.useState(false)
  const [executeDialogId, setExecuteDialogId] = React.useState<number | null>(null)

  // Resolve state
  const [resolveDescription, setResolveDescription] = React.useState("")
  const [resolveUrl, setResolveUrl] = React.useState("")
  const [resolveResult, setResolveResult] = React.useState<ResolveResult | null>(null)
  const [resolving, setResolving] = React.useState(false)

  // History state
  const [historyId, setHistoryId] = React.useState<number | null>(null)
  const [history, setHistory] = React.useState<ExecutionHistory[]>([])
  const [historyLoading, setHistoryLoading] = React.useState(false)

  // ── Fetch selectors ───────────────────────────────────────────────

  const fetchSelectors = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiCall<{ selectors: WebSelector[] }>(API_BASE)
      setSelectors(data.selectors)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load selectors")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    fetchSelectors()
  }, [fetchSelectors])

  // ── Create ────────────────────────────────────────────────────────

  async function handleCreate() {
    if (!newName.trim() || !newDescription.trim()) return
    setLoading(true)
    try {
      await apiCall(`${API_BASE}`, {
        method: "POST",
        body: JSON.stringify({
          name: newName.trim(),
          description: newDescription.trim(),
          url: newUrl.trim() || undefined,
          selectorType: newType,
        }),
      })
      setNewName("")
      setNewDescription("")
      setNewUrl("")
      setNewType("css")
      setCreateOpen(false)
      await fetchSelectors()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create selector")
    } finally {
      setLoading(false)
    }
  }

  // ── Delete ────────────────────────────────────────────────────────

  async function handleDelete(id: number) {
    try {
      await apiCall(`${API_BASE}/${id}`, { method: "DELETE" })
      await fetchSelectors()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete selector")
    }
  }

  // ── Execute ───────────────────────────────────────────────────────

  async function handleExecute(id: number) {
    if (!executeUrl.trim()) return
    setExecuting(true)
    setExecuteResult(null)
    try {
      const data = await apiCall<{ execution: ExecutionResult }>(`${API_BASE}/${id}/execute`, {
        method: "POST",
        body: JSON.stringify({ url: executeUrl.trim() }),
      })
      setExecuteResult(data.execution)
    } catch (err) {
      setExecuteResult({
        success: false,
        selector: "",
        selectorType: "css",
        content: null,
        confidence: 0,
        executionTimeMs: 0,
        error: err instanceof Error ? err.message : "Execution failed",
      })
    } finally {
      setExecuting(false)
    }
  }

  // ── Self-Heal ─────────────────────────────────────────────────────

  async function handleHeal(id: number, url: string) {
    setExecuting(true)
    try {
      const data = await apiCall<{ execution: ExecutionResult }>(`${API_BASE}/${id}/heal`, {
        method: "POST",
        body: JSON.stringify({ url }),
      })
      setExecuteResult(data.execution)
      await fetchSelectors()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Self-heal failed")
    } finally {
      setExecuting(false)
    }
  }

  // ── Resolve (Stateless) ───────────────────────────────────────────

  async function handleResolve() {
    if (!resolveDescription.trim()) return
    setResolving(true)
    setResolveResult(null)
    try {
      const data = await apiCall<ResolveResult & { success: boolean }>(`${API_BASE}/resolve`, {
        method: "POST",
        body: JSON.stringify({
          description: resolveDescription.trim(),
          url: resolveUrl.trim() || undefined,
        }),
      })
      setResolveResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resolution failed")
    } finally {
      setResolving(false)
    }
  }

  // ── History ───────────────────────────────────────────────────────

  async function fetchHistory(id: number) {
    setHistoryLoading(true)
    setHistoryId(id)
    try {
      const data = await apiCall<{ executions: ExecutionHistory[] }>(`${API_BASE}/${id}/history`)
      setHistory(data.executions)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load history")
    } finally {
      setHistoryLoading(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Natural Language Web Selectors</h2>
          <p className="text-muted-foreground">
            Describe what you want from a page in plain language. AI locates the element.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={fetchSelectors} disabled={loading}>
            <RefreshCwIcon className="mr-2 h-4 w-4" />
            Refresh
          </Button>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button>
                <PlusIcon className="mr-2 h-4 w-4" />
                New Selector
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Selector</DialogTitle>
                <DialogDescription>
                  Describe the element you want to select in natural language.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <Input
                  placeholder="Name (e.g. Product Price)"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
                <textarea
                  className="flex min-h-[100px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  placeholder="Describe the element (e.g. 'the main product price displayed prominently on the product detail page')"
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                />
                <Input
                  placeholder="Target URL (optional)"
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                />
                <Select value={newType} onValueChange={(v) => setNewType(v as "css" | "xpath" | "aria")}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selector type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="css">CSS</SelectItem>
                    <SelectItem value="xpath">XPath</SelectItem>
                    <SelectItem value="aria">ARIA</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline">Cancel</Button>
                </DialogClose>
                <Button onClick={handleCreate} disabled={!newName.trim() || !newDescription.trim()}>
                  Create
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/15 p-3 text-sm text-destructive">{error}</div>
      )}

      {/* Quick Resolve Panel */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ZapIcon className="h-5 w-5" />
            Quick Resolve
          </CardTitle>
          <CardDescription>
            Test a natural language description without saving. See which selectors AI generates.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <textarea
              className="flex min-h-[60px] flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="Describe what you want to select..."
              value={resolveDescription}
              onChange={(e) => setResolveDescription(e.target.value)}
            />
            <div className="flex flex-col gap-2">
              <Input
                placeholder="URL to test against"
                value={resolveUrl}
                onChange={(e) => setResolveUrl(e.target.value)}
                className="w-[280px]"
              />
              <Button onClick={handleResolve} disabled={resolving || !resolveDescription.trim()}>
                {resolving ? (
                  <RefreshCwIcon className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <SearchIcon className="mr-2 h-4 w-4" />
                )}
                Resolve
              </Button>
            </div>
          </div>

          {resolveResult && (
            <div className="mt-4 space-y-2">
              {resolveResult.bestSelector ? (
                <>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="font-mono">
                      {resolveResult.bestType.toUpperCase()}
                    </Badge>
                    <code className="rounded bg-muted px-2 py-1 text-sm">{resolveResult.bestSelector}</code>
                    <Badge variant={resolveResult.confidence > 0.7 ? "default" : "secondary"}>
                      {(resolveResult.confidence * 100).toFixed(0)}% confidence
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => navigator.clipboard.writeText(resolveResult.bestSelector || "")}
                    >
                      <CopyIcon className="h-3 w-3" />
                    </Button>
                  </div>
                  {resolveResult.candidates.length > 1 && (
                    <details className="text-sm">
                      <summary className="cursor-pointer text-muted-foreground">
                        {resolveResult.candidates.length} candidates
                      </summary>
                      <div className="mt-2 space-y-1">
                        {resolveResult.candidates.map((c, i) => (
                          <div key={i} className="flex items-center gap-2 rounded bg-muted/50 px-2 py-1">
                            <Badge variant="outline" className="text-xs font-mono">{c.type}</Badge>
                            <code className="text-xs">{c.selector}</code>
                            <span className="text-xs text-muted-foreground">
                              {(c.confidence * 100).toFixed(0)}% — {c.reasoning}
                            </span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">No matching selectors found.</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Selector List */}
      {loading && selectors.length === 0 ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <RefreshCwIcon className="mr-2 h-5 w-5 animate-spin" />
          Loading selectors...
        </div>
      ) : selectors.length === 0 ? (
        <Card className="py-12 text-center">
          <CardContent>
            <GlobeIcon className="mx-auto mb-4 h-12 w-12 text-muted-foreground/50" />
            <p className="text-lg font-medium">No selectors yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Create your first natural language selector to start extracting web content.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {selectors.map((sel) => (
            <Card key={sel.id}>
              <CardContent className="pt-6">
                <div className="flex items-start justify-between">
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold">{sel.name}</h3>
                      <Badge variant="outline" className="font-mono text-xs">
                        {sel.selectorType.toUpperCase()}
                      </Badge>
                      {sel.failCount > 0 && (
                        <Badge variant="destructive" className="text-xs">
                          {sel.failCount} failures
                        </Badge>
                      )}
                      {sel.confidence > 0 && (
                        <Badge
                          variant={sel.confidence > 0.7 ? "default" : "secondary"}
                          className="text-xs"
                        >
                          {(sel.confidence * 100).toFixed(0)}%
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">{sel.description}</p>
                    {sel.url && (
                      <p className="text-xs text-muted-foreground">
                        <GlobeIcon className="mr-1 inline h-3 w-3" />
                        {sel.url}
                      </p>
                    )}
                    {sel.resolvedSelector && (
                      <div className="flex items-center gap-1">
                        <CodeIcon className="h-3 w-3 text-muted-foreground" />
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                          {sel.resolvedSelector}
                        </code>
                      </div>
                    )}
                    {sel.lastResolvedAt && (
                      <p className="text-xs text-muted-foreground">
                        <ClockIcon className="mr-1 inline h-3 w-3" />
                        Last resolved: {new Date(sel.lastResolvedAt).toLocaleString()}
                      </p>
                    )}
                  </div>

                  <div className="flex gap-1">
                    {/* Execute */}
                    <Dialog
                      open={executeDialogId === sel.id}
                      onOpenChange={(open) => {
                        setExecuteDialogId(open ? sel.id : null)
                        if (!open) {
                          setExecuteResult(null)
                          setExecuteUrl(sel.url || "")
                        } else {
                          setExecuteUrl(sel.url || "")
                        }
                      }}
                    >
                      <DialogTrigger asChild>
                        <Button variant="outline" size="sm">
                          <PlayIcon className="mr-1 h-3 w-3" />
                          Execute
                        </Button>
                      </DialogTrigger>
                      <DialogContent className="max-w-2xl">
                        <DialogHeader>
                          <DialogTitle>Execute: {sel.name}</DialogTitle>
                          <DialogDescription>{sel.description}</DialogDescription>
                        </DialogHeader>
                        <div className="space-y-4">
                          <div className="flex gap-2">
                            <Input
                              placeholder="URL to extract from"
                              value={executeUrl}
                              onChange={(e) => setExecuteUrl(e.target.value)}
                              className="flex-1"
                            />
                            <Button
                              onClick={() => handleExecute(sel.id)}
                              disabled={executing || !executeUrl.trim()}
                            >
                              {executing ? (
                                <RefreshCwIcon className="mr-2 h-4 w-4 animate-spin" />
                              ) : (
                                <PlayIcon className="mr-2 h-4 w-4" />
                              )}
                              Run
                            </Button>
                            {sel.resolvedSelector && (
                              <Button
                                variant="outline"
                                onClick={() => handleHeal(sel.id, executeUrl)}
                                disabled={executing}
                                title="Self-heal: re-resolve selector"
                              >
                                <WrenchIcon className="h-4 w-4" />
                              </Button>
                            )}
                          </div>

                          {executeResult && (
                            <div className="rounded-md border p-4">
                              <div className="flex items-center gap-2 mb-2">
                                {executeResult.success ? (
                                  <CheckCircleIcon className="h-5 w-5 text-green-500" />
                                ) : (
                                  <XCircleIcon className="h-5 w-5 text-red-500" />
                                )}
                                <span className="font-medium">
                                  {executeResult.success ? "Success" : "Failed"}
                                </span>
                                <Badge variant="outline" className="font-mono text-xs">
                                  {executeResult.selectorType}
                                </Badge>
                                <span className="text-xs text-muted-foreground">
                                  {executeResult.executionTimeMs}ms
                                </span>
                              </div>
                              {executeResult.selector && (
                                <p className="text-xs font-mono text-muted-foreground mb-2">
                                  {executeResult.selector}
                                </p>
                              )}
                              {executeResult.content && (
                                <pre className="max-h-60 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap">
                                  {executeResult.content}
                                </pre>
                              )}
                              {executeResult.error && (
                                <p className="text-sm text-destructive">{executeResult.error}</p>
                              )}
                            </div>
                          )}
                        </div>
                      </DialogContent>
                    </Dialog>

                    {/* History */}
                    <Dialog
                      open={historyId === sel.id}
                      onOpenChange={(open) => {
                        if (open) {
                          fetchHistory(sel.id)
                        } else {
                          setHistoryId(null)
                          setHistory([])
                        }
                      }}
                    >
                      <DialogTrigger asChild>
                        <Button variant="ghost" size="sm">
                          <HistoryIcon className="h-3 w-3" />
                        </Button>
                      </DialogTrigger>
                      <DialogContent className="max-w-2xl">
                        <DialogHeader>
                          <DialogTitle>Execution History: {sel.name}</DialogTitle>
                        </DialogHeader>
                        {historyLoading ? (
                          <div className="flex justify-center py-8">
                            <RefreshCwIcon className="h-5 w-5 animate-spin text-muted-foreground" />
                          </div>
                        ) : history.length === 0 ? (
                          <p className="py-8 text-center text-muted-foreground">No executions yet</p>
                        ) : (
                          <div className="max-h-96 space-y-2 overflow-auto">
                            {history.map((exec) => (
                              <div
                                key={exec.id}
                                className="flex items-start gap-2 rounded border p-3 text-sm"
                              >
                                {exec.success ? (
                                  <CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
                                ) : (
                                  <XCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                                )}
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="truncate font-mono text-xs">{exec.url}</span>
                                    <span className="text-xs text-muted-foreground">
                                      {exec.executionTimeMs}ms
                                    </span>
                                  </div>
                                  <p className="text-xs font-mono text-muted-foreground mt-1">
                                    {exec.resolvedSelector}
                                  </p>
                                  {exec.extractedContent && (
                                    <p className="mt-1 truncate text-xs">{exec.extractedContent}</p>
                                  )}
                                  {exec.errorMessage && (
                                    <p className="mt-1 text-xs text-destructive">{exec.errorMessage}</p>
                                  )}
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    {new Date(exec.createdAt).toLocaleString()}
                                  </p>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </DialogContent>
                    </Dialog>

                    {/* Delete */}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => handleDelete(sel.id)}
                    >
                      <Trash2Icon className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
