"use client"

import * as React from "react"
import {
  PlusIcon,
  Trash2Icon,
  CopyIcon,
  CheckIcon,
  KeyIcon,
  GlobeIcon,
  MonitorSmartphoneIcon,
  ChromeIcon,
  SettingsIcon,
  CodeIcon,
  EyeIcon,
  EyeOffIcon,
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

type Surface = "chrome_extension" | "slack_bot" | "discord_bot" | "widget" | "desktop" | "mobile"
type WidgetTheme = "light" | "dark" | "auto"
type WidgetPosition = "bottom-right" | "bottom-left"

interface Widget {
  id: string
  name: string
  allowedOrigins: string[]
  apiKey: string
  theme: WidgetTheme
  position: WidgetPosition
  customCss: string | null
  isActive: boolean
  createdAt: string
  updatedAt: string
}

interface SurfaceToken {
  id: string
  surface: Surface
  label: string
  lastUsedAt: string | null
  expiresAt: string | null
  createdAt: string
}

interface UsageStats {
  tokensBySurface: Record<string, number>
  widgets: { total: number; active: number }
}

interface SurfaceAccessManagerProps {
  apiBase?: string
  className?: string
}

// ─── Surface metadata ────────────────────────────────────────────────────────

const SURFACE_META: Record<Surface, { label: string; icon: React.ElementType; description: string }> = {
  chrome_extension: { label: "Chrome Extension", icon: ChromeIcon, description: "Browser sidebar + popup" },
  slack_bot: { label: "Slack Bot", icon: GlobeIcon, description: "Slack workspace integration" },
  discord_bot: { label: "Discord Bot", icon: GlobeIcon, description: "Discord server integration" },
  widget: { label: "Website Widget", icon: CodeIcon, description: "Embeddable chat widget" },
  desktop: { label: "Desktop App", icon: MonitorSmartphoneIcon, description: "Native desktop application" },
  mobile: { label: "Mobile App", icon: MonitorSmartphoneIcon, description: "Mobile application" },
}

// ─── API helpers ─────────────────────────────────────────────────────────────

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

// ─── Component ───────────────────────────────────────────────────────────────

export default function SurfaceAccessManager({
  apiBase = "",
  className = "",
}: SurfaceAccessManagerProps) {
  const [widgets, setWidgets] = React.useState<Widget[]>([])
  const [tokens, setTokens] = React.useState<SurfaceToken[]>([])
  const [stats, setStats] = React.useState<UsageStats | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [tab, setTab] = React.useState<"widgets" | "tokens" | "setup">("widgets")
  const [copied, setCopied] = React.useState<string | null>(null)

  // ─── Fetch data ──────────────────────────────────────────────────────────

  const loadData = React.useCallback(async () => {
    try {
      const [wRes, tRes, sRes] = await Promise.all([
        apiFetch<{ widgets: Widget[] }>(`${apiBase}/api/surfaces/widgets`),
        apiFetch<{ tokens: SurfaceToken[] }>(`${apiBase}/api/surfaces/tokens`),
        apiFetch<UsageStats>(`${apiBase}/api/surfaces/stats`),
      ])
      setWidgets(wRes.widgets)
      setTokens(tRes.tokens)
      setStats(sRes)
      setError(null)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load data")
    }
  }, [apiBase])

  React.useEffect(() => { loadData() }, [loadData])

  // ─── Widget actions ──────────────────────────────────────────────────────

  const createWidget = async (name: string, origins: string) => {
    try {
      await apiFetch(`${apiBase}/api/surfaces/widgets`, {
        method: "POST",
        body: JSON.stringify({
          name,
          allowedOrigins: origins.split(",").map(s => s.trim()).filter(Boolean),
        }),
      })
      await loadData()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to create widget")
    }
  }

  const deleteWidget = async (id: string) => {
    try {
      await apiFetch(`${apiBase}/api/surfaces/widgets/${id}`, { method: "DELETE" })
      await loadData()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to delete widget")
    }
  }

  const toggleWidget = async (id: string, isActive: boolean) => {
    try {
      await apiFetch(`${apiBase}/api/surfaces/widgets/${id}`, {
        method: "PUT",
        body: JSON.stringify({ isActive }),
      })
      await loadData()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to update widget")
    }
  }

  // ─── Token actions ───────────────────────────────────────────────────────

  const [newTokenValue, setNewTokenValue] = React.useState<string | null>(null)

  const createToken = async (surface: Surface, label: string, expiresInDays?: number) => {
    try {
      const result = await apiFetch<{ token: string }>(`${apiBase}/api/surfaces/tokens`, {
        method: "POST",
        body: JSON.stringify({ surface, label, expiresInDays }),
      })
      setNewTokenValue(result.token)
      await loadData()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to create token")
    }
  }

  const revokeToken = async (id: string) => {
    try {
      await apiFetch(`${apiBase}/api/surfaces/tokens/${id}`, { method: "DELETE" })
      await loadData()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to revoke token")
    }
  }

  // ─── Clipboard ───────────────────────────────────────────────────────────

  const copyToClipboard = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(null), 2000)
  }

  const getEmbedSnippet = (widget: Widget) => {
    const base = apiBase || window.location.origin
    return `<script src="${base}/api/surfaces/embed.js"\n  data-api-key="${widget.apiKey}"\n  data-theme="${widget.theme}"\n  data-position="${widget.position}"></script>`
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className={`space-y-6 ${className}`}>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Surface Access</h2>
          <p className="text-muted-foreground">
            Access the council from Chrome, Slack, Discord, widgets, desktop, and mobile.
          </p>
        </div>
        {stats && (
          <div className="flex gap-3">
            <Badge variant="outline" className="gap-1">
              <CodeIcon className="h-3 w-3" />
              {stats.widgets.active}/{stats.widgets.total} widgets
            </Badge>
            <Badge variant="outline" className="gap-1">
              <KeyIcon className="h-3 w-3" />
              {Object.values(stats.tokensBySurface).reduce((a, b) => a + b, 0)} tokens
            </Badge>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Tab nav */}
      <div className="flex gap-1 border-b">
        {(["widgets", "tokens", "setup"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t === "widgets" ? "Widgets" : t === "tokens" ? "Access Tokens" : "Setup Guide"}
          </button>
        ))}
      </div>

      {/* ─── Widgets Tab ──────────────────────────────────────────────────── */}
      {tab === "widgets" && (
        <div className="space-y-4">
          <CreateWidgetDialog onCreate={createWidget} />

          {widgets.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center text-muted-foreground">
                No widgets yet. Create one to embed the council on your website.
              </CardContent>
            </Card>
          ) : (
            widgets.map((w) => (
              <Card key={w.id}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-base">{w.name}</CardTitle>
                      <Badge variant={w.isActive ? "default" : "secondary"}>
                        {w.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => toggleWidget(w.id, !w.isActive)}
                        title={w.isActive ? "Deactivate" : "Activate"}
                      >
                        {w.isActive ? <EyeOffIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => deleteWidget(w.id)}
                        title="Delete widget"
                      >
                        <Trash2Icon className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                  <CardDescription>
                    Theme: {w.theme} | Position: {w.position} | Origins: {w.allowedOrigins.length > 0 ? w.allowedOrigins.join(", ") : "any"}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-muted-foreground">API Key:</span>
                      <code className="rounded bg-muted px-2 py-0.5 text-xs font-mono">
                        {w.apiKey.slice(0, 12)}...
                      </code>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => copyToClipboard(w.apiKey, `key-${w.id}`)}
                      >
                        {copied === `key-${w.id}` ? (
                          <CheckIcon className="h-3 w-3 text-green-500" />
                        ) : (
                          <CopyIcon className="h-3 w-3" />
                        )}
                      </Button>
                    </div>
                    <div className="space-y-1">
                      <span className="text-sm text-muted-foreground">Embed snippet:</span>
                      <div className="relative">
                        <pre className="rounded bg-muted p-3 text-xs font-mono overflow-x-auto">
                          {getEmbedSnippet(w)}
                        </pre>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="absolute right-2 top-2 h-6 w-6"
                          onClick={() => copyToClipboard(getEmbedSnippet(w), `embed-${w.id}`)}
                        >
                          {copied === `embed-${w.id}` ? (
                            <CheckIcon className="h-3 w-3 text-green-500" />
                          ) : (
                            <CopyIcon className="h-3 w-3" />
                          )}
                        </Button>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      )}

      {/* ─── Tokens Tab ───────────────────────────────────────────────────── */}
      {tab === "tokens" && (
        <div className="space-y-4">
          <CreateTokenDialog onCreate={createToken} />

          {newTokenValue && (
            <Card className="border-green-500/50 bg-green-500/5">
              <CardContent className="py-4">
                <p className="text-sm font-medium mb-2">
                  Token created successfully. Copy it now — it will not be shown again.
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded bg-muted px-3 py-2 text-xs font-mono break-all">
                    {newTokenValue}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      copyToClipboard(newTokenValue, "new-token")
                      setTimeout(() => setNewTokenValue(null), 3000)
                    }}
                  >
                    {copied === "new-token" ? <CheckIcon className="h-4 w-4" /> : <CopyIcon className="h-4 w-4" />}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {tokens.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center text-muted-foreground">
                No access tokens yet. Create one to connect a surface.
              </CardContent>
            </Card>
          ) : (
            <div className="rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-2 text-left font-medium">Surface</th>
                    <th className="px-4 py-2 text-left font-medium">Label</th>
                    <th className="px-4 py-2 text-left font-medium">Created</th>
                    <th className="px-4 py-2 text-left font-medium">Last Used</th>
                    <th className="px-4 py-2 text-left font-medium">Expires</th>
                    <th className="px-4 py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {tokens.map((t) => {
                    const meta = SURFACE_META[t.surface]
                    return (
                      <tr key={t.id} className="border-b last:border-0">
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-2">
                            {meta && <meta.icon className="h-4 w-4 text-muted-foreground" />}
                            <span>{meta?.label ?? t.surface}</span>
                          </div>
                        </td>
                        <td className="px-4 py-2 text-muted-foreground">{t.label}</td>
                        <td className="px-4 py-2 text-muted-foreground">
                          {new Date(t.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-2 text-muted-foreground">
                          {t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleDateString() : "Never"}
                        </td>
                        <td className="px-4 py-2 text-muted-foreground">
                          {t.expiresAt ? new Date(t.expiresAt).toLocaleDateString() : "Never"}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => revokeToken(t.id)}
                            title="Revoke token"
                          >
                            <Trash2Icon className="h-4 w-4 text-destructive" />
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ─── Setup Guide Tab ──────────────────────────────────────────────── */}
      {tab === "setup" && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ChromeIcon className="h-5 w-5" />
                Chrome Extension
              </CardTitle>
              <CardDescription>
                Access the council from any page via sidebar, popup, or keyboard shortcut.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
                <li>Generate a <strong>Chrome Extension</strong> access token in the Tokens tab.</li>
                <li>
                  Download or build the extension from{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">extensions/chrome/</code>.
                </li>
                <li>
                  Load it in Chrome: go to{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">chrome://extensions</code>,
                  enable Developer Mode, and click "Load unpacked".
                </li>
                <li>Open the extension options and paste your API URL and token.</li>
                <li>
                  Press <kbd className="rounded border bg-muted px-1.5 py-0.5 text-xs">Ctrl+Shift+A</kbd>{" "}
                  to open the council sidebar on any page.
                </li>
              </ol>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CodeIcon className="h-5 w-5" />
                Website Widget
              </CardTitle>
              <CardDescription>
                Embed the council chat on any website with a single script tag.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
                <li>Create a widget in the Widgets tab and configure allowed origins.</li>
                <li>Copy the embed snippet and paste it into your site's HTML.</li>
                <li>The floating chat button will appear in the configured position.</li>
              </ol>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <GlobeIcon className="h-5 w-5" />
                Slack / Discord Bots
              </CardTitle>
              <CardDescription>
                Bring the council into your team chat.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
                <li>Generate a <strong>Slack Bot</strong> or <strong>Discord Bot</strong> token in the Tokens tab.</li>
                <li>Configure the bot integration in your workspace/server settings.</li>
                <li>The bot uses the same council and knowledge base as the web app.</li>
              </ol>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MonitorSmartphoneIcon className="h-5 w-5" />
                Desktop / Mobile
              </CardTitle>
              <CardDescription>
                Use the council from native applications.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
                <li>Generate a <strong>Desktop</strong> or <strong>Mobile</strong> token in the Tokens tab.</li>
                <li>Open the desktop/mobile app and enter your API URL + token in settings.</li>
                <li>Same agents, same knowledge base, accessible natively.</li>
              </ol>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}

// ─── Create Widget Dialog ────────────────────────────────────────────────────

function CreateWidgetDialog({ onCreate }: { onCreate: (name: string, origins: string) => Promise<void> }) {
  const [name, setName] = React.useState("")
  const [origins, setOrigins] = React.useState("")
  const [loading, setLoading] = React.useState(false)

  const handleCreate = async () => {
    if (!name.trim()) return
    setLoading(true)
    await onCreate(name.trim(), origins)
    setName("")
    setOrigins("")
    setLoading(false)
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button>
          <PlusIcon className="mr-2 h-4 w-4" />
          Create Widget
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Embeddable Widget</DialogTitle>
          <DialogDescription>
            Create a new widget to embed the council chat on your website.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Widget Name</label>
            <Input
              placeholder="e.g. Support Widget"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Allowed Origins</label>
            <Input
              placeholder="https://example.com, https://docs.example.com"
              value={origins}
              onChange={(e) => setOrigins(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Comma-separated list of domains. Leave empty to allow any origin.
            </p>
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <DialogClose asChild>
            <Button onClick={handleCreate} disabled={!name.trim() || loading}>
              {loading ? "Creating..." : "Create"}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Create Token Dialog ─────────────────────────────────────────────────────

function CreateTokenDialog({
  onCreate,
}: {
  onCreate: (surface: Surface, label: string, expiresInDays?: number) => Promise<void>
}) {
  const [surface, setSurface] = React.useState<Surface>("chrome_extension")
  const [label, setLabel] = React.useState("")
  const [expiresInDays, setExpiresInDays] = React.useState("")
  const [loading, setLoading] = React.useState(false)

  const handleCreate = async () => {
    if (!label.trim()) return
    setLoading(true)
    const days = expiresInDays ? parseInt(expiresInDays, 10) : undefined
    await onCreate(surface, label.trim(), days)
    setLabel("")
    setExpiresInDays("")
    setLoading(false)
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button>
          <PlusIcon className="mr-2 h-4 w-4" />
          Generate Token
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Generate Access Token</DialogTitle>
          <DialogDescription>
            Create a token for a specific surface. The token is shown once -- copy it immediately.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Surface</label>
            <Select value={surface} onValueChange={(v) => setSurface(v as Surface)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(SURFACE_META) as Surface[]).map((s) => (
                  <SelectItem key={s} value={s}>
                    {SURFACE_META[s].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Label</label>
            <Input
              placeholder="e.g. Work laptop Chrome"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Expires In (days)</label>
            <Input
              type="number"
              placeholder="Leave empty for no expiry"
              min={1}
              max={365}
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <DialogClose asChild>
            <Button onClick={handleCreate} disabled={!label.trim() || loading}>
              {loading ? "Generating..." : "Generate"}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
