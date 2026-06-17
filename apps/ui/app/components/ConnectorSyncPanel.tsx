"use client"

import * as React from "react"
import {
  PlayIcon,
  RefreshCwIcon,
  ScissorsIcon,
  CalendarIcon,
  Trash2Icon,
  PlusIcon,
  XIcon,
  CheckCircleIcon,
  AlertCircleIcon,
  LoaderIcon,
  ClockIcon,
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

type SyncMode = "load" | "poll" | "slim"
type JobStatus = "pending" | "running" | "completed" | "failed"

interface SyncJob {
  id: string
  connectorId: string
  syncMode: SyncMode
  status: JobStatus
  startedAt: string | null
  completedAt: string | null
  documentsProcessed: number
  documentsDeleted: number
  errorMessage: string | null
  createdAt: string
}

interface SyncSchedule {
  id: string
  connectorId: string
  syncMode: SyncMode
  cronExpression: string
  enabled: boolean
  lastRunAt: string | null
  nextRunAt: string | null
  createdAt: string
}

interface ConnectorSyncPanelProps {
  connectorId: string
  apiBase?: string
  className?: string
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
    throw new Error(body.message ?? `Request failed: ${res.status}`)
  }
  return res.json() as Promise<T>
}

// ─── Status Helpers ─────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<JobStatus, { icon: React.ElementType; variant: "default" | "secondary" | "destructive" | "outline"; label: string }> = {
  pending: { icon: ClockIcon, variant: "outline", label: "Pending" },
  running: { icon: LoaderIcon, variant: "secondary", label: "Running" },
  completed: { icon: CheckCircleIcon, variant: "default", label: "Completed" },
  failed: { icon: AlertCircleIcon, variant: "destructive", label: "Failed" },
}

const SYNC_MODE_CONFIG: Record<SyncMode, { icon: React.ElementType; label: string; description: string }> = {
  load: { icon: PlayIcon, label: "Load", description: "Full bulk index -- re-ingest all documents" },
  poll: { icon: RefreshCwIcon, label: "Poll", description: "Incremental update since last sync" },
  slim: { icon: ScissorsIcon, label: "Slim", description: "Lightweight prune -- remove deleted docs" },
}

function StatusBadge({ status }: { status: JobStatus }) {
  const config = STATUS_CONFIG[status]
  const Icon = config.icon
  return (
    <Badge variant={config.variant} className="gap-1">
      <Icon className={`h-3 w-3 ${status === "running" ? "animate-spin" : ""}`} />
      {config.label}
    </Badge>
  )
}

function SyncModeBadge({ mode }: { mode: SyncMode }) {
  const config = SYNC_MODE_CONFIG[mode]
  return (
    <Badge variant="outline" className="gap-1">
      {config.label}
    </Badge>
  )
}

// ─── Component ──────────────────────────────────────────────────────────────

export function ConnectorSyncPanel({
  connectorId,
  apiBase = "/api/connectors",
  className,
}: ConnectorSyncPanelProps) {
  const [jobs, setJobs] = React.useState<SyncJob[]>([])
  const [schedules, setSchedules] = React.useState<SyncSchedule[]>([])
  const [loading, setLoading] = React.useState(true)
  const [syncing, setSyncing] = React.useState<SyncMode | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  // Schedule dialog state
  const [showScheduleDialog, setShowScheduleDialog] = React.useState(false)
  const [newScheduleMode, setNewScheduleMode] = React.useState<SyncMode>("poll")
  const [newScheduleCron, setNewScheduleCron] = React.useState("0 */6 * * *")

  const baseUrl = `${apiBase}/${connectorId}/sync`

  // ─── Data Fetching ──────────────────────────────────────────────────────

  const fetchData = React.useCallback(async () => {
    try {
      setLoading(true)
      const [jobsRes, schedulesRes] = await Promise.all([
        apiFetch<{ jobs: SyncJob[] }>(`${baseUrl}/jobs?limit=20`),
        apiFetch<{ schedules: SyncSchedule[] }>(`${baseUrl}/schedules`),
      ])
      setJobs(jobsRes.jobs)
      setSchedules(schedulesRes.schedules)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [baseUrl])

  React.useEffect(() => {
    fetchData()
  }, [fetchData])

  // ─── Trigger Sync ───────────────────────────────────────────────────────

  async function triggerSync(mode: SyncMode) {
    try {
      setSyncing(mode)
      setError(null)
      await apiFetch(`${baseUrl}`, {
        method: "POST",
        body: JSON.stringify({ mode }),
      })
      await fetchData()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSyncing(null)
    }
  }

  // ─── Cancel Job ─────────────────────────────────────────────────────────

  async function cancelJob(jobId: string) {
    try {
      setError(null)
      await apiFetch(`${baseUrl}/jobs/${jobId}`, { method: "DELETE" })
      await fetchData()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  // ─── Create Schedule ────────────────────────────────────────────────────

  async function handleCreateSchedule() {
    try {
      setError(null)
      await apiFetch(`${baseUrl}/schedules`, {
        method: "POST",
        body: JSON.stringify({
          syncMode: newScheduleMode,
          cronExpression: newScheduleCron,
        }),
      })
      setShowScheduleDialog(false)
      setNewScheduleCron("0 */6 * * *")
      await fetchData()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  // ─── Toggle Schedule ────────────────────────────────────────────────────

  async function toggleSchedule(scheduleId: string, enabled: boolean) {
    try {
      setError(null)
      await apiFetch(`${baseUrl}/schedules/${scheduleId}`, {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      })
      await fetchData()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  // ─── Delete Schedule ────────────────────────────────────────────────────

  async function deleteSchedule(scheduleId: string) {
    try {
      setError(null)
      await apiFetch(`${baseUrl}/schedules/${scheduleId}`, { method: "DELETE" })
      await fetchData()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className={className}>
      {/* Error Banner */}
      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600">
            <XIcon className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Sync Actions */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-lg">Sync Modes</CardTitle>
          <CardDescription>
            Trigger a sync to keep your knowledge base current.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            {(Object.keys(SYNC_MODE_CONFIG) as SyncMode[]).map((mode) => {
              const config = SYNC_MODE_CONFIG[mode]
              const Icon = config.icon
              const isSyncing = syncing === mode
              return (
                <Button
                  key={mode}
                  variant="outline"
                  disabled={syncing !== null}
                  onClick={() => triggerSync(mode)}
                  className="gap-2"
                >
                  <Icon className={`h-4 w-4 ${isSyncing ? "animate-spin" : ""}`} />
                  {isSyncing ? `Running ${config.label}...` : config.label}
                </Button>
              )
            })}
          </div>
          <div className="mt-3 space-y-1">
            {(Object.keys(SYNC_MODE_CONFIG) as SyncMode[]).map((mode) => (
              <p key={mode} className="text-xs text-muted-foreground">
                <span className="font-medium">{SYNC_MODE_CONFIG[mode].label}:</span>{" "}
                {SYNC_MODE_CONFIG[mode].description}
              </p>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Schedules */}
      <Card className="mb-4">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <div>
            <CardTitle className="text-lg">Schedules</CardTitle>
            <CardDescription>Automated sync schedules for this connector.</CardDescription>
          </div>
          <Dialog open={showScheduleDialog} onOpenChange={setShowScheduleDialog}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline" className="gap-1">
                <PlusIcon className="h-4 w-4" />
                Add Schedule
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Sync Schedule</DialogTitle>
                <DialogDescription>
                  Set up an automated sync on a cron schedule.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div>
                  <label className="text-sm font-medium">Sync Mode</label>
                  <Select value={newScheduleMode} onValueChange={(v) => setNewScheduleMode(v as SyncMode)}>
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="load">Load (Full)</SelectItem>
                      <SelectItem value="poll">Poll (Incremental)</SelectItem>
                      <SelectItem value="slim">Slim (Prune)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-sm font-medium">Cron Expression</label>
                  <Input
                    className="mt-1"
                    value={newScheduleCron}
                    onChange={(e) => setNewScheduleCron(e.target.value)}
                    placeholder="0 */6 * * *"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Standard 5-field cron: minute hour day-of-month month day-of-week
                  </p>
                </div>
              </div>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline">Cancel</Button>
                </DialogClose>
                <Button onClick={handleCreateSchedule}>Create Schedule</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent>
          {schedules.length === 0 ? (
            <p className="text-sm text-muted-foreground">No schedules configured.</p>
          ) : (
            <div className="space-y-2">
              {schedules.map((schedule) => (
                <div
                  key={schedule.id}
                  className="flex items-center justify-between rounded-md border p-3"
                >
                  <div className="flex items-center gap-3">
                    <CalendarIcon className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <div className="flex items-center gap-2">
                        <SyncModeBadge mode={schedule.syncMode} />
                        <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                          {schedule.cronExpression}
                        </code>
                        <Badge variant={schedule.enabled ? "default" : "secondary"}>
                          {schedule.enabled ? "Active" : "Paused"}
                        </Badge>
                      </div>
                      {schedule.lastRunAt && (
                        <p className="text-xs text-muted-foreground mt-1">
                          Last run: {new Date(schedule.lastRunAt).toLocaleString()}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => toggleSchedule(schedule.id, !schedule.enabled)}
                    >
                      {schedule.enabled ? "Pause" : "Resume"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-red-500 hover:text-red-700"
                      onClick={() => deleteSchedule(schedule.id)}
                    >
                      <Trash2Icon className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Job History */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <div>
            <CardTitle className="text-lg">Sync History</CardTitle>
            <CardDescription>Recent sync jobs for this connector.</CardDescription>
          </div>
          <Button size="sm" variant="ghost" onClick={fetchData} disabled={loading}>
            <RefreshCwIcon className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </CardHeader>
        <CardContent>
          {loading && jobs.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <LoaderIcon className="h-5 w-5 animate-spin mr-2" />
              Loading...
            </div>
          ) : jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sync jobs yet. Trigger a sync above.</p>
          ) : (
            <div className="space-y-2">
              {jobs.map((job) => (
                <div
                  key={job.id}
                  className="flex items-center justify-between rounded-md border p-3"
                >
                  <div className="flex items-center gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <SyncModeBadge mode={job.syncMode} />
                        <StatusBadge status={job.status} />
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                        {job.startedAt && (
                          <span>Started: {new Date(job.startedAt).toLocaleString()}</span>
                        )}
                        {job.documentsProcessed > 0 && (
                          <span>{job.documentsProcessed} docs processed</span>
                        )}
                        {job.documentsDeleted > 0 && (
                          <span>{job.documentsDeleted} docs deleted</span>
                        )}
                      </div>
                      {job.errorMessage && (
                        <p className="text-xs text-red-500 mt-1 max-w-md truncate">
                          {job.errorMessage}
                        </p>
                      )}
                    </div>
                  </div>
                  <div>
                    {(job.status === "pending" || job.status === "running") && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-red-500 hover:text-red-700"
                        onClick={() => cancelJob(job.id)}
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
