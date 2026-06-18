"use client"

import * as React from "react"
import {
  PlusIcon,
  Trash2Icon,
  PlayIcon,
  SearchIcon,
  DownloadIcon,
  CheckCircleIcon,
  XCircleIcon,
  ClockIcon,
  ZapIcon,
  GlobeIcon,
  EyeIcon,
  LayoutTemplateIcon,
  WandIcon,
  TableIcon,
  FileJsonIcon,
  FileTextIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  Loader2Icon,
  RefreshCwIcon,
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

interface SchemaField {
  name: string
  type: "string" | "number" | "boolean" | "date" | "url" | "email" | "array" | "object"
  required?: boolean
  description?: string
  children?: SchemaField[]
}

interface ExtractionSchema {
  id: number
  name: string
  description: string | null
  schema: { fields: SchemaField[] }
  outputFormat: "json" | "csv" | "table"
  isPublic: boolean
  version: number
  createdAt: string
  updatedAt: string
}

interface ExtractionJob {
  id: number
  schemaId: number
  url: string
  status: "pending" | "running" | "completed" | "failed"
  result: { rows: Record<string, unknown>[]; totalRows: number; confidence: number; warnings: string[] } | null
  extractedRows: number
  pagesProcessed: number
  executionTimeMs: number | null
  errorMessage: string | null
  createdAt: string
}

interface ExtractionTemplate {
  id?: number
  name: string
  description: string
  category: string
  schema: { fields: SchemaField[] }
  sampleUrls?: string[]
}

const FIELD_TYPES = [
  "string", "number", "boolean", "date", "url", "email", "array", "object",
] as const

const STATUS_STYLES: Record<string, { color: string; icon: React.ComponentType<any> }> = {
  pending:   { color: "bg-yellow-100 text-yellow-800", icon: ClockIcon },
  running:   { color: "bg-blue-100 text-blue-800", icon: Loader2Icon },
  completed: { color: "bg-green-100 text-green-800", icon: CheckCircleIcon },
  failed:    { color: "bg-red-100 text-red-800", icon: XCircleIcon },
}

// ─── API Helpers ────────────────────────────────────────────────────────────

const API_BASE = "/api/extraction"

async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...opts.headers },
    ...opts,
  })
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }))
    throw new Error(err.error ?? resp.statusText)
  }
  return resp.json()
}

// ─── Schema Builder Sub-Component ───────────────────────────────────────────

function SchemaFieldEditor({
  field,
  onChange,
  onRemove,
  depth = 0,
}: {
  field: SchemaField
  onChange: (updated: SchemaField) => void
  onRemove: () => void
  depth?: number
}) {
  const [expanded, setExpanded] = React.useState(true)
  const hasChildren = field.type === "object" || field.type === "array"

  function addChild() {
    const children = [...(field.children ?? []), { name: "", type: "string" as const, required: false }]
    onChange({ ...field, children })
  }

  function updateChild(index: number, updated: SchemaField) {
    const children = [...(field.children ?? [])]
    children[index] = updated
    onChange({ ...field, children })
  }

  function removeChild(index: number) {
    const children = (field.children ?? []).filter((_, i) => i !== index)
    onChange({ ...field, children })
  }

  return (
    <div className={`border rounded-md p-3 space-y-2 ${depth > 0 ? "ml-6 border-dashed" : ""}`}>
      <div className="flex items-center gap-2">
        {hasChildren && (
          <button onClick={() => setExpanded(!expanded)} className="p-0.5">
            {expanded ? <ChevronDownIcon className="h-4 w-4" /> : <ChevronRightIcon className="h-4 w-4" />}
          </button>
        )}
        <Input
          placeholder="Field name"
          value={field.name}
          onChange={(e) => onChange({ ...field, name: e.target.value })}
          className="w-40"
        />
        <Select
          value={field.type}
          onValueChange={(v) => onChange({ ...field, type: v as SchemaField["type"] })}
        >
          <SelectTrigger className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FIELD_TYPES.map((t) => (
              <SelectItem key={t} value={t}>{t}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-1 text-sm">
          <input
            type="checkbox"
            checked={field.required ?? false}
            onChange={(e) => onChange({ ...field, required: e.target.checked })}
          />
          Required
        </label>
        <Input
          placeholder="Description"
          value={field.description ?? ""}
          onChange={(e) => onChange({ ...field, description: e.target.value })}
          className="flex-1"
        />
        <Button variant="ghost" size="icon" onClick={onRemove}>
          <Trash2Icon className="h-4 w-4 text-red-500" />
        </Button>
      </div>

      {hasChildren && expanded && (
        <div className="space-y-2">
          {(field.children ?? []).map((child, i) => (
            <SchemaFieldEditor
              key={i}
              field={child}
              onChange={(updated) => updateChild(i, updated)}
              onRemove={() => removeChild(i)}
              depth={depth + 1}
            />
          ))}
          <Button variant="outline" size="sm" onClick={addChild}>
            <PlusIcon className="h-3 w-3 mr-1" /> Add Child Field
          </Button>
        </div>
      )}
    </div>
  )
}

// ─── Result Viewer Sub-Component ────────────────────────────────────────────

function ResultViewer({ job }: { job: ExtractionJob }) {
  const [viewFormat, setViewFormat] = React.useState<"json" | "table">("table")

  if (!job.result || !job.result.rows.length) {
    return <p className="text-sm text-muted-foreground">No data extracted.</p>
  }

  const { rows, confidence, warnings } = job.result
  const columns = Object.keys(rows[0] ?? {})

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge variant="outline">{rows.length} rows</Badge>
          <Badge variant="outline">{(confidence * 100).toFixed(0)}% confidence</Badge>
          <Badge variant="outline">{job.pagesProcessed} page(s)</Badge>
          {job.executionTimeMs && (
            <Badge variant="outline">{(job.executionTimeMs / 1000).toFixed(1)}s</Badge>
          )}
        </div>
        <div className="flex gap-1">
          <Button
            variant={viewFormat === "table" ? "default" : "outline"}
            size="sm"
            onClick={() => setViewFormat("table")}
          >
            <TableIcon className="h-3 w-3 mr-1" /> Table
          </Button>
          <Button
            variant={viewFormat === "json" ? "default" : "outline"}
            size="sm"
            onClick={() => setViewFormat("json")}
          >
            <FileJsonIcon className="h-3 w-3 mr-1" /> JSON
          </Button>
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="text-xs text-yellow-700 bg-yellow-50 p-2 rounded">
          {warnings.map((w, i) => <div key={i}>{w}</div>)}
        </div>
      )}

      {viewFormat === "table" ? (
        <div className="overflow-x-auto border rounded">
          <table className="w-full text-sm">
            <thead className="bg-muted">
              <tr>
                {columns.map((col) => (
                  <th key={col} className="px-3 py-2 text-left font-medium">{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 50).map((row, i) => (
                <tr key={i} className="border-t">
                  {columns.map((col) => (
                    <td key={col} className="px-3 py-2 max-w-[200px] truncate">
                      {formatCell(row[col])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 50 && (
            <p className="text-xs text-muted-foreground p-2">Showing 50 of {rows.length} rows</p>
          )}
        </div>
      ) : (
        <pre className="text-xs bg-muted p-3 rounded overflow-x-auto max-h-96">
          {JSON.stringify(rows, null, 2)}
        </pre>
      )}
    </div>
  )
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "-"
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (Array.isArray(value)) return `[${value.length} items]`
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

// ─── Main Panel ─────────────────────────────────────────────────────────────

type Tab = "schemas" | "jobs" | "templates"

export default function StructuredExtractionPanel() {
  const [tab, setTab] = React.useState<Tab>("schemas")
  const [schemas, setSchemas] = React.useState<ExtractionSchema[]>([])
  const [jobs, setJobs] = React.useState<ExtractionJob[]>([])
  const [templates, setTemplates] = React.useState<ExtractionTemplate[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Schema creation state
  const [showCreate, setShowCreate] = React.useState(false)
  const [newName, setNewName] = React.useState("")
  const [newDescription, setNewDescription] = React.useState("")
  const [newFields, setNewFields] = React.useState<SchemaField[]>([
    { name: "", type: "string", required: true },
  ])
  const [newFormat, setNewFormat] = React.useState<"json" | "csv" | "table">("json")

  // Job runner state
  const [runSchemaId, setRunSchemaId] = React.useState<number | null>(null)
  const [runUrl, setRunUrl] = React.useState("")
  const [showRunner, setShowRunner] = React.useState(false)

  // Job detail state
  const [selectedJob, setSelectedJob] = React.useState<ExtractionJob | null>(null)

  // Infer schema state
  const [inferUrl, setInferUrl] = React.useState("")
  const [inferring, setInferring] = React.useState(false)

  // ── Data fetching ─────────────────────────────────────────────────
  const loadSchemas = React.useCallback(async () => {
    try {
      setLoading(true)
      const data = await api<{ schemas: ExtractionSchema[] }>("/schemas")
      setSchemas(data.schemas)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadJobs = React.useCallback(async () => {
    try {
      setLoading(true)
      const data = await api<{ jobs: ExtractionJob[] }>("/jobs")
      setJobs(data.jobs)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadTemplates = React.useCallback(async () => {
    try {
      setLoading(true)
      const data = await api<{ templates: ExtractionTemplate[] }>("/templates")
      setTemplates(data.templates)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (tab === "schemas") loadSchemas()
    else if (tab === "jobs") loadJobs()
    else if (tab === "templates") loadTemplates()
  }, [tab, loadSchemas, loadJobs, loadTemplates])

  // ── Schema CRUD ───────────────────────────────────────────────────
  async function handleCreateSchema() {
    try {
      setError(null)
      await api("/schemas", {
        method: "POST",
        body: JSON.stringify({
          name: newName,
          description: newDescription || undefined,
          schema: { fields: newFields },
          outputFormat: newFormat,
        }),
      })
      setShowCreate(false)
      setNewName("")
      setNewDescription("")
      setNewFields([{ name: "", type: "string", required: true }])
      loadSchemas()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function handleDeleteSchema(id: number) {
    try {
      await api(`/schemas/${id}`, { method: "DELETE" })
      loadSchemas()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // ── Run extraction ────────────────────────────────────────────────
  async function handleRunExtraction() {
    if (!runSchemaId || !runUrl) return
    try {
      setError(null)
      await api("/run", {
        method: "POST",
        body: JSON.stringify({ schemaId: runSchemaId, url: runUrl }),
      })
      setShowRunner(false)
      setRunUrl("")
      setTab("jobs")
      loadJobs()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // ── Infer schema ──────────────────────────────────────────────────
  async function handleInferSchema() {
    if (!inferUrl) return
    try {
      setInferring(true)
      setError(null)
      const data = await api<{ inferred: { suggestedName: string; fields: SchemaField[] } }>("/infer-schema", {
        method: "POST",
        body: JSON.stringify({ url: inferUrl }),
      })
      setNewName(data.inferred.suggestedName)
      setNewFields(data.inferred.fields.length > 0 ? data.inferred.fields : [{ name: "", type: "string", required: true }])
      setInferUrl("")
      setShowCreate(true)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setInferring(false)
    }
  }

  // ── Export ────────────────────────────────────────────────────────
  async function handleExport(jobId: number, format: "json" | "csv") {
    try {
      const resp = await fetch(`${API_BASE}/jobs/${jobId}/export?format=${format}`)
      if (!resp.ok) throw new Error("Export failed")
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `extraction-${jobId}.${format}`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // ── Use template ──────────────────────────────────────────────────
  function handleUseTemplate(template: ExtractionTemplate) {
    setNewName(template.name)
    setNewDescription(template.description)
    setNewFields(template.schema.fields)
    setShowCreate(true)
    setTab("schemas")
  }

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ZapIcon className="h-5 w-5" />
            Structured Web Data Extraction
          </CardTitle>
          <CardDescription>
            Define schemas, extract structured data from any URL. Works on dynamic pages, authenticated content, and paginated results.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="text-sm text-red-600 bg-red-50 p-2 rounded">{error}</div>
          )}

          {/* Tab navigation */}
          <div className="flex gap-2 border-b pb-2">
            {(["schemas", "jobs", "templates"] as Tab[]).map((t) => (
              <Button
                key={t}
                variant={tab === t ? "default" : "ghost"}
                size="sm"
                onClick={() => setTab(t)}
              >
                {t === "schemas" && <FileJsonIcon className="h-3 w-3 mr-1" />}
                {t === "jobs" && <PlayIcon className="h-3 w-3 mr-1" />}
                {t === "templates" && <LayoutTemplateIcon className="h-3 w-3 mr-1" />}
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </Button>
            ))}
          </div>

          {/* ── Schemas Tab ─────────────────────────────────────── */}
          {tab === "schemas" && (
            <div className="space-y-4">
              <div className="flex gap-2">
                <Button size="sm" onClick={() => setShowCreate(true)}>
                  <PlusIcon className="h-3 w-3 mr-1" /> New Schema
                </Button>
                <div className="flex gap-1 flex-1">
                  <Input
                    placeholder="Enter URL to auto-infer schema..."
                    value={inferUrl}
                    onChange={(e) => setInferUrl(e.target.value)}
                    className="flex-1"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleInferSchema}
                    disabled={inferring || !inferUrl}
                  >
                    {inferring ? <Loader2Icon className="h-3 w-3 mr-1 animate-spin" /> : <WandIcon className="h-3 w-3 mr-1" />}
                    Infer Schema
                  </Button>
                </div>
              </div>

              {loading ? (
                <div className="flex justify-center py-8">
                  <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : schemas.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No extraction schemas yet. Create one or use a template to get started.
                </p>
              ) : (
                <div className="space-y-2">
                  {schemas.map((schema) => (
                    <div key={schema.id} className="border rounded-md p-3 flex items-center justify-between">
                      <div>
                        <div className="font-medium flex items-center gap-2">
                          {schema.name}
                          <Badge variant="outline" className="text-xs">v{schema.version}</Badge>
                          <Badge variant="outline" className="text-xs">{schema.outputFormat}</Badge>
                          {schema.isPublic && <Badge variant="secondary" className="text-xs">Public</Badge>}
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {schema.schema.fields.length} fields
                          {schema.description ? ` — ${schema.description}` : ""}
                        </p>
                      </div>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => { setRunSchemaId(schema.id); setShowRunner(true) }}
                        >
                          <PlayIcon className="h-3 w-3 mr-1" /> Run
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleDeleteSchema(schema.id)}
                        >
                          <Trash2Icon className="h-3 w-3 text-red-500" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Jobs Tab ────────────────────────────────────────── */}
          {tab === "jobs" && (
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <p className="text-sm text-muted-foreground">{jobs.length} extraction job(s)</p>
                <Button size="sm" variant="outline" onClick={loadJobs}>
                  <RefreshCwIcon className="h-3 w-3 mr-1" /> Refresh
                </Button>
              </div>

              {loading ? (
                <div className="flex justify-center py-8">
                  <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : jobs.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No extraction jobs yet. Run an extraction from the Schemas tab.
                </p>
              ) : (
                <div className="space-y-2">
                  {jobs.map((job) => {
                    const statusStyle = STATUS_STYLES[job.status] ?? STATUS_STYLES.pending
                    const StatusIcon = statusStyle.icon
                    const isSelected = selectedJob?.id === job.id
                    return (
                      <div key={job.id}>
                        <div
                          className="border rounded-md p-3 cursor-pointer hover:bg-muted/50"
                          onClick={() => setSelectedJob(isSelected ? null : job)}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <StatusIcon className={`h-4 w-4 ${job.status === "running" ? "animate-spin" : ""}`} />
                              <Badge className={statusStyle.color}>{job.status}</Badge>
                              <span className="text-sm font-mono truncate max-w-[300px]">{job.url}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              {job.status === "completed" && (
                                <>
                                  <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); handleExport(job.id, "json") }}>
                                    <FileJsonIcon className="h-3 w-3" />
                                  </Button>
                                  <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); handleExport(job.id, "csv") }}>
                                    <FileTextIcon className="h-3 w-3" />
                                  </Button>
                                </>
                              )}
                              <span className="text-xs text-muted-foreground">
                                {new Date(job.createdAt).toLocaleString()}
                              </span>
                            </div>
                          </div>
                        </div>
                        {isSelected && (
                          <div className="border border-t-0 rounded-b-md p-3 bg-muted/20">
                            <ResultViewer job={job} />
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── Templates Tab ───────────────────────────────────── */}
          {tab === "templates" && (
            <div className="space-y-4">
              {loading ? (
                <div className="flex justify-center py-8">
                  <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {templates.map((tpl, i) => (
                    <Card key={tpl.id ?? i} className="cursor-pointer hover:ring-2 ring-primary/50" onClick={() => handleUseTemplate(tpl)}>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-base flex items-center gap-2">
                          <LayoutTemplateIcon className="h-4 w-4" />
                          {tpl.name}
                        </CardTitle>
                        <Badge variant="outline" className="w-fit text-xs">{tpl.category}</Badge>
                      </CardHeader>
                      <CardContent>
                        <p className="text-sm text-muted-foreground">{tpl.description}</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {tpl.schema.fields.length} fields
                        </p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Create Schema Dialog ────────────────────────────────── */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create Extraction Schema</DialogTitle>
            <DialogDescription>
              Define the fields you want to extract from web pages.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <Input
              placeholder="Schema name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <Input
              placeholder="Description (optional)"
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
            />

            <div>
              <label className="text-sm font-medium mb-2 block">Output Format</label>
              <Select value={newFormat} onValueChange={(v) => setNewFormat(v as typeof newFormat)}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="json">JSON</SelectItem>
                  <SelectItem value="csv">CSV</SelectItem>
                  <SelectItem value="table">Table</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-sm font-medium mb-2 block">Fields</label>
              <div className="space-y-2">
                {newFields.map((field, i) => (
                  <SchemaFieldEditor
                    key={i}
                    field={field}
                    onChange={(updated) => {
                      const copy = [...newFields]
                      copy[i] = updated
                      setNewFields(copy)
                    }}
                    onRemove={() => setNewFields(newFields.filter((_, j) => j !== i))}
                  />
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setNewFields([...newFields, { name: "", type: "string", required: false }])}
                >
                  <PlusIcon className="h-3 w-3 mr-1" /> Add Field
                </Button>
              </div>
            </div>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={handleCreateSchema} disabled={!newName || newFields.length === 0}>
              Create Schema
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Run Extraction Dialog ───────────────────────────────── */}
      <Dialog open={showRunner} onOpenChange={setShowRunner}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run Extraction</DialogTitle>
            <DialogDescription>
              Enter the URL to extract data from using the selected schema.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <Input
              placeholder="https://example.com/products"
              value={runUrl}
              onChange={(e) => setRunUrl(e.target.value)}
            />
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={handleRunExtraction} disabled={!runUrl}>
              <PlayIcon className="h-3 w-3 mr-1" /> Extract
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
