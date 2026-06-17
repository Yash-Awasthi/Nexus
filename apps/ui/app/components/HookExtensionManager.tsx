"use client"

import * as React from "react"
import {
  PlusIcon,
  Trash2Icon,
  PlayIcon,
  PauseIcon,
  CodeIcon,
  ListOrderedIcon,
  CheckIcon,
  AlertTriangleIcon,
  ClockIcon,
  SettingsIcon,
  CopyIcon,
  FileTextIcon,
  ShieldIcon,
  SearchIcon,
  FilterIcon,
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

type HookPoint =
  | "pre_indexing"
  | "post_indexing"
  | "pre_query"
  | "post_query"
  | "pre_response"
  | "post_response"
  | "pre_council"
  | "post_council"

type HookLanguage = "javascript" | "typescript"

interface HookExtension {
  id: number
  userId: number
  name: string
  description: string | null
  hookPoint: HookPoint
  executionOrder: number
  code: string
  language: HookLanguage
  isActive: boolean
  config: Record<string, unknown> | null
  timeout: number
  createdAt: string
  updatedAt: string
}

interface BuiltInTemplate {
  type: string
  name: string
  description: string
  hookPoint: HookPoint
  language: HookLanguage
  code: string
  defaultConfig: Record<string, unknown>
  timeout: number
}

interface HookExecutionLog {
  id: number
  hookId: number
  conversationId: string | null
  executionTimeMs: number
  status: "success" | "error" | "timeout" | "skipped"
  inputSize: number
  outputSize: number
  errorMessage: string | null
  createdAt: string
}

interface ValidationResult {
  valid: boolean
  errors: string[]
}

interface TestResult {
  ok: boolean
  result?: { content: string; metadata: Record<string, unknown> }
  error?: string
  durationMs: number
}

interface HookExtensionManagerProps {
  apiBase?: string
  className?: string
}

// ─── Hook Point metadata ────────────────────────────────────────────────────

const HOOK_POINT_META: Record<HookPoint, { label: string; description: string; color: string }> = {
  pre_indexing: { label: "Pre-Indexing", description: "Before content is indexed", color: "bg-blue-100 text-blue-800" },
  post_indexing: { label: "Post-Indexing", description: "After content is indexed", color: "bg-blue-100 text-blue-800" },
  pre_query: { label: "Pre-Query", description: "Before query is processed", color: "bg-green-100 text-green-800" },
  post_query: { label: "Post-Query", description: "After query results", color: "bg-green-100 text-green-800" },
  pre_response: { label: "Pre-Response", description: "Before response is delivered", color: "bg-amber-100 text-amber-800" },
  post_response: { label: "Post-Response", description: "After response is delivered", color: "bg-amber-100 text-amber-800" },
  pre_council: { label: "Pre-Council", description: "Before the council sees it", color: "bg-purple-100 text-purple-800" },
  post_council: { label: "Post-Council", description: "After the council deliberates", color: "bg-purple-100 text-purple-800" },
}

const HOOK_POINTS: HookPoint[] = [
  "pre_indexing", "post_indexing", "pre_query", "post_query",
  "pre_response", "post_response", "pre_council", "post_council",
]

const STATUS_COLORS: Record<string, string> = {
  success: "bg-green-100 text-green-800",
  error: "bg-red-100 text-red-800",
  timeout: "bg-amber-100 text-amber-800",
  skipped: "bg-gray-100 text-gray-800",
}

// ─── API helpers ────────────────────────────────────────────────────────────

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Request failed: ${res.status}`)
  }
  return res.json() as Promise<T>
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function HookExtensionManager({
  apiBase = "",
  className = "",
}: HookExtensionManagerProps) {
  const [hooks, setHooks] = React.useState<HookExtension[]>([])
  const [templates, setTemplates] = React.useState<BuiltInTemplate[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [tab, setTab] = React.useState<"hooks" | "templates" | "logs">("hooks")
  const [filterPoint, setFilterPoint] = React.useState<string>("all")

  // Editor state
  const [editingHook, setEditingHook] = React.useState<Partial<HookExtension> | null>(null)
  const [isCreating, setIsCreating] = React.useState(false)
  const [validationErrors, setValidationErrors] = React.useState<string[]>([])

  // Test panel state
  const [testHookId, setTestHookId] = React.useState<number | null>(null)
  const [testInput, setTestInput] = React.useState("")
  const [testResult, setTestResult] = React.useState<TestResult | null>(null)
  const [isTesting, setIsTesting] = React.useState(false)

  // Logs state
  const [selectedHookId, setSelectedHookId] = React.useState<number | null>(null)
  const [logs, setLogs] = React.useState<HookExecutionLog[]>([])

  // ─── Fetch data ─────────────────────────────────────────────────────────

  const loadHooks = React.useCallback(async () => {
    try {
      const params = filterPoint !== "all" ? `?hookPoint=${filterPoint}` : ""
      const res = await apiFetch<{ hooks: HookExtension[] }>(`${apiBase}/api/hook-extensions${params}`)
      setHooks(res.hooks)
      setError(null)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load hooks")
    }
  }, [apiBase, filterPoint])

  const loadTemplates = React.useCallback(async () => {
    try {
      const res = await apiFetch<{ templates: BuiltInTemplate[] }>(`${apiBase}/api/hook-extensions/built-in`)
      setTemplates(res.templates)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load templates")
    }
  }, [apiBase])

  const loadLogs = React.useCallback(async (hookId: number) => {
    try {
      const res = await apiFetch<{ logs: HookExecutionLog[]; total: number }>(
        `${apiBase}/api/hook-extensions/${hookId}/logs?limit=50`
      )
      setLogs(res.logs)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load logs")
    }
  }, [apiBase])

  React.useEffect(() => {
    loadHooks()
    loadTemplates()
  }, [loadHooks, loadTemplates])

  React.useEffect(() => {
    if (selectedHookId) {
      loadLogs(selectedHookId)
    }
  }, [selectedHookId, loadLogs])

  // ─── CRUD handlers ──────────────────────────────────────────────────────

  const handleCreate = async () => {
    if (!editingHook) return
    try {
      await apiFetch<HookExtension>(`${apiBase}/api/hook-extensions`, {
        method: "POST",
        body: JSON.stringify(editingHook),
      })
      setEditingHook(null)
      setIsCreating(false)
      setValidationErrors([])
      loadHooks()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to create hook")
    }
  }

  const handleUpdate = async () => {
    if (!editingHook?.id) return
    try {
      await apiFetch<HookExtension>(`${apiBase}/api/hook-extensions/${editingHook.id}`, {
        method: "PUT",
        body: JSON.stringify(editingHook),
      })
      setEditingHook(null)
      setValidationErrors([])
      loadHooks()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to update hook")
    }
  }

  const handleDelete = async (id: number) => {
    try {
      await fetch(`${apiBase}/api/hook-extensions/${id}`, { method: "DELETE" })
      loadHooks()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to delete hook")
    }
  }

  const handleToggle = async (id: number, isActive: boolean) => {
    try {
      await apiFetch<HookExtension>(`${apiBase}/api/hook-extensions/${id}/toggle`, {
        method: "PATCH",
        body: JSON.stringify({ isActive }),
      })
      loadHooks()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to toggle hook")
    }
  }

  const handleValidate = async (code: string) => {
    try {
      const res = await apiFetch<ValidationResult>(`${apiBase}/api/hook-extensions/validate`, {
        method: "POST",
        body: JSON.stringify({ code, language: editingHook?.language ?? "javascript" }),
      })
      setValidationErrors(res.errors)
      return res.valid
    } catch {
      return false
    }
  }

  const handleTest = async () => {
    if (!testHookId || !testInput) return
    setIsTesting(true)
    try {
      const res = await apiFetch<TestResult>(`${apiBase}/api/hook-extensions/${testHookId}/test`, {
        method: "POST",
        body: JSON.stringify({ content: testInput }),
      })
      setTestResult(res)
    } catch (e: unknown) {
      setTestResult({
        ok: false,
        error: e instanceof Error ? e.message : "Test failed",
        durationMs: 0,
      })
    } finally {
      setIsTesting(false)
    }
  }

  const handleInstallTemplate = (template: BuiltInTemplate) => {
    setEditingHook({
      name: template.name,
      description: template.description,
      hookPoint: template.hookPoint,
      code: template.code,
      language: template.language,
      config: template.defaultConfig,
      timeout: template.timeout,
      isActive: true,
    })
    setIsCreating(true)
    setTab("hooks")
  }

  // ─── Filtered hooks ─────────────────────────────────────────────────────

  const filteredHooks = filterPoint === "all"
    ? hooks
    : hooks.filter((h) => h.hookPoint === filterPoint)

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className={`space-y-6 ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Hook Extensions</h2>
          <p className="text-muted-foreground text-sm">
            Code injection points for compliance: PII scrubbing, content filtering, query
            transformation, and more.
          </p>
        </div>
        <Button
          onClick={() => {
            setEditingHook({
              name: "",
              hookPoint: "pre_indexing",
              code: 'function handler(context) {\n  const { content, config } = context;\n  return { content, metadata: {} };\n}',
              language: "javascript",
              timeout: 5000,
              isActive: true,
            })
            setIsCreating(true)
          }}
        >
          <PlusIcon className="mr-2 h-4 w-4" /> New Hook
        </Button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-md p-3 text-red-800 text-sm flex items-center gap-2">
          <AlertTriangleIcon className="h-4 w-4" />
          {error}
          <button onClick={() => setError(null)} className="ml-auto text-red-600 underline text-xs">
            Dismiss
          </button>
        </div>
      )}

      {/* Tab navigation */}
      <div className="flex gap-2 border-b pb-2">
        <Button variant={tab === "hooks" ? "default" : "ghost"} size="sm" onClick={() => setTab("hooks")}>
          <CodeIcon className="mr-1 h-4 w-4" /> Hooks ({hooks.length})
        </Button>
        <Button variant={tab === "templates" ? "default" : "ghost"} size="sm" onClick={() => setTab("templates")}>
          <ShieldIcon className="mr-1 h-4 w-4" /> Built-in Templates
        </Button>
        <Button variant={tab === "logs" ? "default" : "ghost"} size="sm" onClick={() => setTab("logs")}>
          <FileTextIcon className="mr-1 h-4 w-4" /> Execution Logs
        </Button>
      </div>

      {/* ─── Hooks Tab ─────────────────────────────────────────────────────── */}
      {tab === "hooks" && (
        <div className="space-y-4">
          {/* Filter */}
          <div className="flex items-center gap-2">
            <FilterIcon className="h-4 w-4 text-muted-foreground" />
            <Select value={filterPoint} onValueChange={setFilterPoint}>
              <SelectTrigger className="w-48">
                <SelectValue placeholder="Filter by hook point" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Hook Points</SelectItem>
                {HOOK_POINTS.map((hp) => (
                  <SelectItem key={hp} value={hp}>
                    {HOOK_POINT_META[hp].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Hooks list */}
          {filteredHooks.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <CodeIcon className="mx-auto mb-3 h-10 w-10 opacity-50" />
                <p>No hook extensions yet.</p>
                <p className="text-xs mt-1">
                  Create one or install a built-in template to get started.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-3">
              {filteredHooks.map((hook) => (
                <Card key={hook.id}>
                  <CardContent className="flex items-center justify-between py-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium truncate">{hook.name}</h3>
                        <Badge variant="outline" className={HOOK_POINT_META[hook.hookPoint].color}>
                          {HOOK_POINT_META[hook.hookPoint].label}
                        </Badge>
                        <Badge variant={hook.isActive ? "default" : "secondary"}>
                          {hook.isActive ? "Active" : "Inactive"}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          Order: {hook.executionOrder}
                        </span>
                      </div>
                      {hook.description && (
                        <p className="text-sm text-muted-foreground mt-1 truncate">
                          {hook.description}
                        </p>
                      )}
                      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                        <span>{hook.language}</span>
                        <span>Timeout: {hook.timeout}ms</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 ml-4">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleToggle(hook.id, !hook.isActive)}
                        title={hook.isActive ? "Disable" : "Enable"}
                      >
                        {hook.isActive ? <PauseIcon className="h-4 w-4" /> : <PlayIcon className="h-4 w-4" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setTestHookId(hook.id)
                          setTestResult(null)
                          setTestInput("")
                        }}
                        title="Test"
                      >
                        <SearchIcon className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditingHook(hook)
                          setIsCreating(false)
                        }}
                        title="Edit"
                      >
                        <SettingsIcon className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setSelectedHookId(hook.id)
                          setTab("logs")
                        }}
                        title="View Logs"
                      >
                        <FileTextIcon className="h-4 w-4" />
                      </Button>
                      <Dialog>
                        <DialogTrigger asChild>
                          <Button variant="ghost" size="sm" title="Delete">
                            <Trash2Icon className="h-4 w-4 text-red-500" />
                          </Button>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>Delete Hook</DialogTitle>
                            <DialogDescription>
                              Are you sure you want to delete "{hook.name}"? This cannot be undone.
                            </DialogDescription>
                          </DialogHeader>
                          <DialogFooter>
                            <DialogClose asChild>
                              <Button variant="outline">Cancel</Button>
                            </DialogClose>
                            <DialogClose asChild>
                              <Button variant="destructive" onClick={() => handleDelete(hook.id)}>
                                Delete
                              </Button>
                            </DialogClose>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ─── Templates Tab ─────────────────────────────────────────────────── */}
      {tab === "templates" && (
        <div className="grid gap-4 md:grid-cols-2">
          {templates.map((tpl) => (
            <Card key={tpl.type}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{tpl.name}</CardTitle>
                  <Badge variant="outline" className={HOOK_POINT_META[tpl.hookPoint].color}>
                    {HOOK_POINT_META[tpl.hookPoint].label}
                  </Badge>
                </div>
                <CardDescription>{tpl.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {tpl.language} | Timeout: {tpl.timeout}ms
                  </span>
                  <Button size="sm" onClick={() => handleInstallTemplate(tpl)}>
                    <PlusIcon className="mr-1 h-3 w-3" /> Install
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* ─── Logs Tab ──────────────────────────────────────────────────────── */}
      {tab === "logs" && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Select
              value={selectedHookId?.toString() ?? ""}
              onValueChange={(v) => setSelectedHookId(Number(v))}
            >
              <SelectTrigger className="w-64">
                <SelectValue placeholder="Select hook to view logs" />
              </SelectTrigger>
              <SelectContent>
                {hooks.map((h) => (
                  <SelectItem key={h.id} value={h.id.toString()}>
                    {h.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {logs.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                <ClockIcon className="mx-auto mb-3 h-8 w-8 opacity-50" />
                <p>No execution logs yet.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="border rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Status</th>
                    <th className="px-3 py-2 text-left font-medium">Time (ms)</th>
                    <th className="px-3 py-2 text-left font-medium">Input Size</th>
                    <th className="px-3 py-2 text-left font-medium">Output Size</th>
                    <th className="px-3 py-2 text-left font-medium">Error</th>
                    <th className="px-3 py-2 text-left font-medium">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((logEntry) => (
                    <tr key={logEntry.id} className="border-t">
                      <td className="px-3 py-2">
                        <Badge variant="outline" className={STATUS_COLORS[logEntry.status]}>
                          {logEntry.status}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">{logEntry.executionTimeMs}</td>
                      <td className="px-3 py-2">{logEntry.inputSize} B</td>
                      <td className="px-3 py-2">{logEntry.outputSize} B</td>
                      <td className="px-3 py-2 max-w-[200px] truncate text-red-600">
                        {logEntry.errorMessage ?? "-"}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {new Date(logEntry.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ─── Editor Dialog ─────────────────────────────────────────────────── */}
      {editingHook && (
        <Dialog
          open={!!editingHook}
          onOpenChange={(open) => {
            if (!open) {
              setEditingHook(null)
              setValidationErrors([])
            }
          }}
        >
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{isCreating ? "Create Hook Extension" : "Edit Hook Extension"}</DialogTitle>
              <DialogDescription>
                {isCreating
                  ? "Define a new hook that runs at a specific pipeline point."
                  : "Update hook configuration and code."}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium">Name</label>
                  <Input
                    value={editingHook.name ?? ""}
                    onChange={(e) => setEditingHook({ ...editingHook, name: e.target.value })}
                    placeholder="My Hook"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">Hook Point</label>
                  <Select
                    value={editingHook.hookPoint ?? "pre_indexing"}
                    onValueChange={(v) => setEditingHook({ ...editingHook, hookPoint: v as HookPoint })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {HOOK_POINTS.map((hp) => (
                        <SelectItem key={hp} value={hp}>
                          {HOOK_POINT_META[hp].label} - {HOOK_POINT_META[hp].description}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <label className="text-sm font-medium">Description</label>
                <Input
                  value={editingHook.description ?? ""}
                  onChange={(e) => setEditingHook({ ...editingHook, description: e.target.value })}
                  placeholder="What does this hook do?"
                />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="text-sm font-medium">Language</label>
                  <Select
                    value={editingHook.language ?? "javascript"}
                    onValueChange={(v) =>
                      setEditingHook({ ...editingHook, language: v as HookLanguage })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="javascript">JavaScript</SelectItem>
                      <SelectItem value="typescript">TypeScript</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-sm font-medium">Timeout (ms)</label>
                  <Input
                    type="number"
                    value={editingHook.timeout ?? 5000}
                    onChange={(e) =>
                      setEditingHook({ ...editingHook, timeout: Number(e.target.value) })
                    }
                    min={100}
                    max={30000}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">Execution Order</label>
                  <Input
                    type="number"
                    value={editingHook.executionOrder ?? 0}
                    onChange={(e) =>
                      setEditingHook({ ...editingHook, executionOrder: Number(e.target.value) })
                    }
                    min={0}
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-sm font-medium">Code</label>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleValidate(editingHook.code ?? "")}
                  >
                    <CheckIcon className="mr-1 h-3 w-3" /> Validate
                  </Button>
                </div>
                <textarea
                  className="w-full h-64 font-mono text-sm p-3 border rounded-md bg-muted/30 resize-y"
                  value={editingHook.code ?? ""}
                  onChange={(e) => setEditingHook({ ...editingHook, code: e.target.value })}
                  spellCheck={false}
                />
                {validationErrors.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {validationErrors.map((err, i) => (
                      <p key={i} className="text-red-600 text-xs flex items-center gap-1">
                        <AlertTriangleIcon className="h-3 w-3" /> {err}
                      </p>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <label className="text-sm font-medium">Config (JSON)</label>
                <textarea
                  className="w-full h-24 font-mono text-sm p-3 border rounded-md bg-muted/30 resize-y"
                  value={editingHook.config ? JSON.stringify(editingHook.config, null, 2) : "{}"}
                  onChange={(e) => {
                    try {
                      setEditingHook({ ...editingHook, config: JSON.parse(e.target.value) })
                    } catch {
                      // Allow invalid JSON while typing
                    }
                  }}
                  spellCheck={false}
                />
              </div>
            </div>

            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <Button onClick={isCreating ? handleCreate : handleUpdate}>
                {isCreating ? "Create" : "Save Changes"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* ─── Test Dialog ───────────────────────────────────────────────────── */}
      {testHookId !== null && (
        <Dialog
          open={testHookId !== null}
          onOpenChange={(open) => {
            if (!open) {
              setTestHookId(null)
              setTestResult(null)
            }
          }}
        >
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>Test Hook</DialogTitle>
              <DialogDescription>
                Provide sample input content to test hook #{testHookId}.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium">Input Content</label>
                <textarea
                  className="w-full h-32 font-mono text-sm p-3 border rounded-md bg-muted/30 resize-y"
                  value={testInput}
                  onChange={(e) => setTestInput(e.target.value)}
                  placeholder="Enter sample content to process..."
                />
              </div>

              <Button onClick={handleTest} disabled={isTesting || !testInput}>
                {isTesting ? (
                  <>
                    <ClockIcon className="mr-2 h-4 w-4 animate-spin" /> Running...
                  </>
                ) : (
                  <>
                    <PlayIcon className="mr-2 h-4 w-4" /> Run Test
                  </>
                )}
              </Button>

              {testResult && (
                <div
                  className={`border rounded-md p-4 ${testResult.ok ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"}`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    {testResult.ok ? (
                      <CheckIcon className="h-4 w-4 text-green-600" />
                    ) : (
                      <AlertTriangleIcon className="h-4 w-4 text-red-600" />
                    )}
                    <span className="text-sm font-medium">
                      {testResult.ok ? "Success" : "Failed"} ({testResult.durationMs}ms)
                    </span>
                  </div>
                  {testResult.ok && testResult.result && (
                    <div className="space-y-2">
                      <div>
                        <p className="text-xs font-medium text-muted-foreground">Output:</p>
                        <pre className="text-xs bg-white p-2 rounded border mt-1 whitespace-pre-wrap">
                          {testResult.result.content}
                        </pre>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-muted-foreground">Metadata:</p>
                        <pre className="text-xs bg-white p-2 rounded border mt-1">
                          {JSON.stringify(testResult.result.metadata, null, 2)}
                        </pre>
                      </div>
                    </div>
                  )}
                  {testResult.error && (
                    <p className="text-sm text-red-700">{testResult.error}</p>
                  )}
                </div>
              )}
            </div>

            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Close</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
