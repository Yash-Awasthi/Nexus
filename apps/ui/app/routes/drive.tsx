// SPDX-License-Identifier: Apache-2.0
/**
 * Nexus Drive — per-user sandboxed storage and shell.
 *
 * API:
 *   GET    /api/v1/drive/status   — quota + sandbox availability
 *   GET    /api/v1/drive/ls       — list a directory
 *   GET    /api/v1/drive/read     — read a file
 *   POST   /api/v1/drive/upload   — write a file
 *   POST   /api/v1/drive/exec     — run a command in the sandbox
 *   GET    /api/v1/drive/export   — the drive as .tar.gz, without any .env
 *   DELETE /api/v1/drive/destroy  — delete the whole drive
 */
import {
  AlertTriangle,
  ChevronRight,
  Download,
  File as FileIcon,
  Folder,
  Loader2,
  RefreshCw,
  Save,
  Terminal,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Page, PageHeader } from "~/components/page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { authFetch } from "~/lib/api";

// ─── Types ────────────────────────────────────────────────────────────────────

interface DriveStatus {
  root: string;
  quota: { used: number; limit: number; pct: number };
  warning: string | null;
  dockerAvailable: boolean;
}

interface DriveFile {
  name: string;
  type: "file" | "dir";
  size: number;
  mtime: string;
}

interface ExecEntry {
  cwd: string;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const UNITS = ["B", "KB", "MB", "GB"];

export function formatBytes(n: number): string {
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${UNITS[unit]}`;
}

/** `dir` joined with `name`, with no leading slash — the shape /drive/ls wants. */
export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function parentPath(dir: string): string {
  const cut = dir.lastIndexOf("/");
  return cut === -1 ? "" : dir.slice(0, cut);
}

/** The API's JSON, named. `Response.json()` is `any`, which spreads. */
async function readJson<T>(r: Response): Promise<T> {
  return (await r.json()) as T;
}

interface ErrorBody {
  error?: string;
  message?: string;
  used?: number;
  limit?: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Drive() {
  const [status, setStatus] = useState<DriveStatus | null>(null);
  const [dir, setDir] = useState("");
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [err, setErr] = useState("");

  const [openFile, setOpenFile] = useState<string | null>(null);
  const [fileBody, setFileBody] = useState("");
  const [saving, setSaving] = useState(false);

  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<ExecEntry[]>([]);
  const [running, setRunning] = useState(false);
  const termEnd = useRef<HTMLDivElement>(null);

  // ── Loaders ────────────────────────────────────────────────────────────────

  const loadStatus = useCallback(async () => {
    try {
      const r = await authFetch("/api/v1/drive/status");
      if (r.ok) setStatus(await readJson<DriveStatus>(r));
    } catch {
      /* the quota meter is not worth an error banner */
    }
  }, []);

  const loadFiles = useCallback(async (target: string) => {
    setLoadingFiles(true);
    try {
      const r = await authFetch(
        `/api/v1/drive/ls${target ? `?dir=${encodeURIComponent(target)}` : ""}`,
      );
      if (!r.ok) {
        setErr("Could not list that directory");
        return;
      }
      const data = await readJson<{ files?: DriveFile[] }>(r);
      setFiles(Array.isArray(data.files) ? data.files : []);
      setErr("");
    } catch {
      setErr("Could not list that directory");
    } finally {
      setLoadingFiles(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    void loadFiles(dir);
  }, [dir, loadFiles]);

  useEffect(() => {
    termEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [history]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const open = useCallback(
    async (file: DriveFile) => {
      if (file.type === "dir") {
        setOpenFile(null);
        setDir(joinPath(dir, file.name));
        return;
      }
      const target = joinPath(dir, file.name);
      try {
        const r = await authFetch(`/api/v1/drive/read?path=${encodeURIComponent(target)}`);
        if (!r.ok) {
          setErr("Could not read that file");
          return;
        }
        const data = await readJson<{ content?: string }>(r);
        setOpenFile(target);
        setFileBody(data.content ?? "");
        setErr("");
      } catch {
        setErr("Could not read that file");
      }
    },
    [dir],
  );

  const save = useCallback(async () => {
    if (!openFile) return;
    setSaving(true);
    try {
      const r = await authFetch("/api/v1/drive/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: openFile, content: fileBody }),
      });
      if (!r.ok) {
        const data = await readJson<ErrorBody>(r).catch(() => ({}) as ErrorBody);
        setErr(
          data.error === "quota_exceeded"
            ? `Drive full — ${formatBytes(data.used ?? 0)} of ${formatBytes(data.limit ?? 0)} used`
            : (data.message ?? data.error ?? "Save failed"),
        );
        return;
      }
      setErr("");
      await Promise.all([loadStatus(), loadFiles(dir)]);
    } catch {
      setErr("Save failed");
    } finally {
      setSaving(false);
    }
  }, [openFile, fileBody, dir, loadFiles, loadStatus]);

  const newFile = useCallback(() => {
    setOpenFile(joinPath(dir, "untitled.txt"));
    setFileBody("");
  }, [dir]);

  const run = useCallback(async () => {
    const cmd = command.trim();
    if (!cmd) return;
    setRunning(true);
    try {
      const r = await authFetch("/api/v1/drive/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd, cwd: dir || undefined }),
      });
      const data = await readJson<ErrorBody & Partial<ExecEntry>>(r).catch(
        () => ({}) as ErrorBody & Partial<ExecEntry>,
      );
      if (!r.ok) {
        setHistory((h) => [
          ...h,
          {
            cwd: dir,
            command: cmd,
            stdout: "",
            stderr:
              data.error === "quota_exceeded"
                ? "Drive is full — delete files before running anything else."
                : (data.message ?? data.error ?? `Request failed (${r.status})`),
            exitCode: null,
            timedOut: false,
          },
        ]);
        return;
      }
      setHistory((h) => [
        ...h,
        {
          cwd: dir,
          command: cmd,
          stdout: data.stdout ?? "",
          stderr: data.stderr ?? "",
          exitCode: data.exitCode ?? null,
          timedOut: Boolean(data.timedOut),
        },
      ]);
      setCommand("");
      await Promise.all([loadStatus(), loadFiles(dir)]);
    } catch {
      setErr("Command failed");
    } finally {
      setRunning(false);
    }
  }, [command, dir, loadFiles, loadStatus]);

  const exportDrive = useCallback(async () => {
    const r = await authFetch("/api/v1/drive/export").catch(() => null);
    if (!r?.ok) {
      setErr(r?.status === 404 ? "The drive is empty." : "Could not export the drive");
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await r.blob());
    a.download = "nexus-drive.tar.gz";
    a.click();
    URL.revokeObjectURL(a.href);
  }, []);

  const destroy = useCallback(async () => {
    if (!confirm("Delete every file in your drive? This cannot be undone.")) return;
    try {
      await authFetch("/api/v1/drive/destroy", { method: "DELETE" });
      setOpenFile(null);
      setFileBody("");
      setDir("");
      setHistory([]);
      await Promise.all([loadStatus(), loadFiles("")]);
    } catch {
      setErr("Could not delete the drive");
    }
  }, [loadFiles, loadStatus]);

  // ── Render ─────────────────────────────────────────────────────────────────

  const pct = status?.quota.pct ?? 0;
  const crumbs = dir ? dir.split("/") : [];

  return (
    <Page width="wide">
      <PageHeader
        title="Drive"
        description="Your own storage, with a shell that can see it. Agents read and write here too."
        actions={
          <>
            <Badge
              variant="outline"
              className={status?.dockerAvailable ? "text-success" : "text-warning"}
            >
              {status?.dockerAvailable ? "Sandboxed" : "Shell runs unsandboxed"}
            </Badge>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => void loadFiles(dir)}
              aria-label="Refresh"
            >
              <RefreshCw />
            </Button>
            <Button size="sm" variant="outline" onClick={() => void exportDrive()}>
              <Download /> Export
            </Button>
            <Button size="sm" variant="outline" onClick={() => void destroy()}>
              <Trash2 /> Delete drive
            </Button>
          </>
        }
      />

      {/* Quota meter */}
      <Card>
        <CardContent className="pt-6 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="font-medium">
              {formatBytes(status?.quota.used ?? 0)} of {formatBytes(status?.quota.limit ?? 0)} used
            </span>
            <span className="text-muted-foreground">{pct}%</span>
          </div>
          <div
            className="h-2 w-full rounded-full bg-muted overflow-hidden"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Drive quota used"
          >
            <div
              className={`h-full rounded-full transition-all ${
                pct >= 90 ? "bg-destructive" : pct >= 70 ? "bg-warning" : "bg-primary"
              }`}
              style={{ width: `${Math.min(pct, 100)}%` }}
            />
          </div>
          {status?.warning && (
            <p className="text-sm text-warning flex items-center gap-1">
              <AlertTriangle className="w-4 h-4" />
              {status.warning}
            </p>
          )}
        </CardContent>
      </Card>

      {err && (
        <p className="text-sm text-destructive" role="alert">
          {err}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Files */}
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base flex items-center gap-2">
              <Folder className="w-4 h-4" />
              Files
            </CardTitle>
            <Button size="sm" variant="outline" onClick={newFile}>
              New file
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-1 text-sm text-muted-foreground flex-wrap">
              <button className="hover:underline" onClick={() => setDir("")}>
                drive
              </button>
              {crumbs.map((part, i) => (
                <span key={`${part}-${i}`} className="flex items-center gap-1">
                  <ChevronRight className="w-3 h-3" />
                  <button
                    className="hover:underline"
                    onClick={() => setDir(crumbs.slice(0, i + 1).join("/"))}
                  >
                    {part}
                  </button>
                </span>
              ))}
            </div>

            {loadingFiles ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <ul className="divide-y text-sm">
                {dir && (
                  <li>
                    <button
                      className="w-full text-left py-2 hover:underline"
                      onClick={() => setDir(parentPath(dir))}
                    >
                      ..
                    </button>
                  </li>
                )}
                {files.map((f) => (
                  <li key={f.name} className="flex items-center justify-between py-2 gap-3">
                    <button
                      className="flex items-center gap-2 min-w-0 hover:underline"
                      onClick={() => void open(f)}
                    >
                      {f.type === "dir" ? (
                        <Folder className="w-4 h-4 shrink-0 text-primary" />
                      ) : (
                        <FileIcon className="w-4 h-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate">{f.name}</span>
                    </button>
                    <span className="text-muted-foreground shrink-0">
                      {f.type === "dir" ? "—" : formatBytes(f.size)}
                    </span>
                  </li>
                ))}
                {files.length === 0 && !dir && (
                  <li className="py-6 text-center text-muted-foreground">
                    Nothing here yet. Create a file or run a command.
                  </li>
                )}
              </ul>
            )}

            {openFile && (
              <div className="space-y-2 pt-2 border-t">
                <Input
                  value={openFile}
                  onChange={(e) => setOpenFile(e.target.value)}
                  aria-label="File path"
                />
                <Textarea
                  value={fileBody}
                  onChange={(e) => setFileBody(e.target.value)}
                  rows={10}
                  className="font-mono text-xs"
                  aria-label="File contents"
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void save()} disabled={saving}>
                    {saving ? (
                      <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                    ) : (
                      <Save className="w-4 h-4 mr-1" />
                    )}
                    Save
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setOpenFile(null)}>
                    Close
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Terminal */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Terminal className="w-4 h-4" />
              Terminal
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="h-80 overflow-y-auto rounded bg-muted p-3 font-mono text-xs text-muted-foreground">
              {history.length === 0 && (
                <p className="text-muted-foreground">Commands run inside your drive.</p>
              )}
              {history.map((h, i) => (
                <div key={i} className="mb-3">
                  <p className="text-primary">
                    {`~/${h.cwd}`} $ {h.command}
                  </p>
                  {h.stdout && <pre className="whitespace-pre-wrap">{h.stdout}</pre>}
                  {h.stderr && (
                    <pre className="whitespace-pre-wrap text-destructive">{h.stderr}</pre>
                  )}
                  {h.timedOut && <p className="text-warning">timed out</p>}
                </div>
              ))}
              <div ref={termEnd} />
            </div>
            <div className="flex gap-2">
              <Input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !running) void run();
                }}
                placeholder="ls -la"
                className="font-mono"
                aria-label="Command"
              />
              <Button onClick={() => void run()} disabled={running || !command.trim()}>
                {running ? <Loader2 className="w-4 h-4 animate-spin" /> : "Run"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}
