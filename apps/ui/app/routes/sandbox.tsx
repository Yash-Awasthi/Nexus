// SPDX-License-Identifier: Apache-2.0
/**
 * Code Sandbox — Phase 4.12 / 4.16
 *
 * Execute code directly in the sandbox (JS/Python/TypeScript/Bash/Go/Rust/Ruby) or
 * use the Code Agent to have the LLM write + iteratively fix code for you.
 *
 * API:
 *   POST /api/sandbox/execute           — run code directly
 *   GET  /api/sandbox/status            — sandbox status
 *   POST /api/code-agent/run            — LLM writes + runs code
 *   GET  /api/code-agent/sessions       — past agent sessions
 *   GET  /api/code-agent/sessions/:id   — session detail
 */
import {
  Terminal,
  Play,
  Loader2,
  CheckCircle,
  XCircle,
  Clock,
  Code2,
  Bot,
  Cable,
  ChevronRight,
  Copy,
  Check,
  History,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router";

import { Page, PageHeader } from "~/components/page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  language: string;
  truncated?: boolean;
}

interface SandboxStatus {
  available: boolean;
  dockerAvailable?: boolean;
  languages: string[];
}

/** A run kept by the API so the history survives a reload. */
interface RunRecord {
  executionId: string;
  status: string;
  output: string;
  error?: string;
  durationMs: number;
  language?: string;
  source?: "api" | "helper";
}

interface AgentSession {
  sessionId: string;
  task: string;
  language: string;
  status: "pending" | "running" | "success" | "error";
  iterations: number;
  finalOutput?: string;
  finalError?: string;
  code?: string;
  createdAt: string;
}

/** A response body as JSON, or an empty object when it has none. */
type Body = { error?: string; message?: string } & Record<string, unknown>;
const readJson = async (r: Response): Promise<Body> => (await r.json().catch(() => ({}))) as Body;

// Languages with a lasting interpreter, which keeps variables from one run to the next.
const KERNEL_LANGUAGES = ["python", "r", "julia"];

/** The local helper a browser uses to run code on this machine (see /sandbox/connect). */
const HELPER_URL = "http://127.0.0.1:4789";
const HELPER_TOKEN_KEY = "nexus.sandbox-helper.token";

// ─── Default snippets per language ───────────────────────────────────────────

export const SNIPPETS: Record<string, string> = {
  javascript: `// JavaScript in Node.js sandbox
const nums = [1, 2, 3, 4, 5];
const doubled = nums.map(n => n * 2);
console.log('Doubled:', doubled);
console.log('Sum:', doubled.reduce((a, b) => a + b, 0));`,

  typescript: `// TypeScript sandbox
interface Point { x: number; y: number; }

function distance(a: Point, b: Point): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

const p1: Point = { x: 0, y: 0 };
const p2: Point = { x: 3, y: 4 };
console.log('Distance:', distance(p1, p2)); // 5`,

  python: `# Python sandbox
import math

def fibonacci(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a

for i in range(10):
    print(f"fib({i}) = {fibonacci(i)}")`,

  bash: `#!/bin/bash
echo "Current date: $(date)"
echo "Files in /tmp: $(ls /tmp 2>/dev/null | wc -l)"
echo "Memory info:"
free -h 2>/dev/null || echo "(free not available)"`,

  go: `// Go sandbox
package main

import "fmt"

func main() {
	values := []int{1, 2, 3, 4, 5}
	sum := 0
	for _, v := range values {
		sum += v
	}
	fmt.Println("Sum:", sum)
}`,

  rust: `// Rust sandbox
fn main() {
    let nums = [1, 2, 3, 4, 5];
    println!("Sum: {}", nums.iter().sum::<i32>());
}`,

  ruby: `# Ruby sandbox
def fibonacci(n)
  a, b = 0, 1
  n.times { a, b = b, a + b }
  a
end

(0...10).each { |i| puts "fib(#{i}) = #{fibonacci(i)}" }`,
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function Sandbox() {
  const [tab, setTab] = useState<"execute" | "agent">("execute");

  // Direct execution
  const [code, setCode] = useState(SNIPPETS.javascript);
  const [language, setLanguage] = useState("javascript");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ExecResult | null>(null);
  const [sandboxStatus, setSandboxStatus] = useState<SandboxStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const [keepState, setKeepState] = useState(false);
  const [kernel, setKernel] = useState<{ id: string; language: string } | null>(null);
  const [source, setSource] = useState<"api" | "helper" | null>(null);

  // Local helper: a process on this machine the page talks to directly.
  const [helper, setHelper] = useState<"checking" | "connected" | "offline">("checking");
  const [pairOpen, setPairOpen] = useState(false);
  const [pairCode, setPairCode] = useState("");
  const [pairError, setPairError] = useState("");
  const [pairing, setPairing] = useState(false);
  const [history, setHistory] = useState<RunRecord[]>([]);

  // Code agent
  const [agentTask, setAgentTask] = useState("");
  const [agentLang, setAgentLang] = useState("python");
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentResult, setAgentResult] = useState<AgentSession | null>(null);
  const [agentSessions, setAgentSessions] = useState<AgentSession[]>([]);
  const [err, setErr] = useState("");

  useEffect(() => {
    // Load sandbox status
    fetch("/api/sandbox/status")
      .then((r) => (r.ok ? (r.json() as Promise<SandboxStatus>) : null))
      .then((d) => d && setSandboxStatus(d))
      .catch(() => {});
  }, []);

  /** Probe the helper with a short budget: a page load must not wait on a stopped process. */
  const probeHelper = useCallback(async () => {
    try {
      const r = await fetch(`${HELPER_URL}/health`, { signal: AbortSignal.timeout(500) });
      setHelper(r.ok ? "connected" : "offline");
    } catch {
      setHelper("offline");
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const r = await fetch("/api/sandbox/runs");
      if (!r.ok) return;
      const d = (await r.json()) as { runs?: RunRecord[] };
      setHistory(d.runs ?? []);
    } catch {
      /* history is a convenience, not a reason to fail the page */
    }
  }, []);

  useEffect(() => {
    void probeHelper();
    void loadHistory();
  }, [probeHelper, loadHistory]);

  /** Store a locally-run result through the API, so it survives a reload. */
  const rememberRun = useCallback(
    async (exec: ExecResult) => {
      try {
        await fetch("/api/sandbox/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            language: exec.language,
            stdout: exec.stdout,
            stderr: exec.stderr,
            exitCode: exec.exitCode,
            durationMs: exec.durationMs,
          }),
        });
      } finally {
        void loadHistory();
      }
    },
    [loadHistory],
  );

  const submitPair = useCallback(async () => {
    setPairing(true);
    setPairError("");
    try {
      const r = await fetch(`${HELPER_URL}/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: pairCode.trim() }),
        signal: AbortSignal.timeout(5_000),
      });
      const d = await readJson(r);
      if (!r.ok) {
        setPairError(d.message ?? "That code was not accepted.");
        return;
      }
      localStorage.setItem(HELPER_TOKEN_KEY, String(d.token));
      setPairOpen(false);
      setPairCode("");
      setHelper("connected");
    } catch {
      setPairError("The helper did not answer. Is it running?");
    } finally {
      setPairing(false);
    }
  }, [pairCode]);

  const dropKernel = useCallback((id: string) => {
    void fetch(`/api/code-agent/sessions/${id}`, { method: "DELETE" }).catch(() => {});
    setKernel(null);
  }, []);
  // A kernel is a process on the server; leaving the page ends it.
  useEffect(
    () => () =>
      void (kernel && fetch(`/api/code-agent/sessions/${kernel.id}`, { method: "DELETE" })),
    [kernel],
  );

  // Auto-update snippet when language changes
  useEffect(() => {
    if (SNIPPETS[language]) setCode(SNIPPETS[language]);
  }, [language]);

  const runCode = useCallback(async () => {
    if (!code.trim()) return;
    setRunning(true);
    setErr("");
    setResult(null);
    try {
      if (keepState && KERNEL_LANGUAGES.includes(language)) {
        let k = kernel?.language === language ? kernel : null;
        if (!k) {
          if (kernel) dropKernel(kernel.id);
          const made = await fetch("/api/code-agent/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ language }),
          });
          const d = await readJson(made);
          if (!made.ok) {
            setErr(d.message ?? d.error ?? "Could not start a kernel");
            return;
          }
          k = { id: String(d.sessionId), language };
          setKernel(k);
        }
        const t0 = Date.now();
        const r = await fetch(`/api/code-agent/sessions/${k.id}/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: code.trim(), timeoutMs: 30_000 }),
        });
        const d = await readJson(r);
        if (!r.ok) {
          setErr(d.message ?? d.error ?? "Execution failed");
          return;
        }
        setResult({
          stdout: String(d.stdout ?? ""),
          stderr: String(d.stderr ?? ""),
          exitCode: d.stderr ? 1 : 0,
          durationMs: Date.now() - t0,
          language,
          truncated: false,
        });
        setSource("api");
        void loadHistory();
        return;
      }
      if (helper === "connected") {
        const token = localStorage.getItem(HELPER_TOKEN_KEY) ?? "";
        const r = await fetch(`${HELPER_URL}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ language, code: code.trim(), timeoutMs: 30_000 }),
          signal: AbortSignal.timeout(35_000),
        });
        if (r.status === 401) {
          // The helper restarted, or its pairing expired: ask for the code again.
          setHelper("offline");
          setPairOpen(true);
          setErr("The local sandbox needs to be paired again.");
          return;
        }
        const d = await readJson(r);
        if (!r.ok) {
          setErr(d.message ?? "Execution failed");
          return;
        }
        const exec: ExecResult = {
          stdout: String(d.stdout ?? ""),
          stderr: String(d.stderr ?? ""),
          exitCode: typeof d.exitCode === "number" ? d.exitCode : 1,
          durationMs: typeof d.durationMs === "number" ? d.durationMs : 0,
          language,
        };
        setResult(exec);
        setSource("helper");
        await rememberRun(exec);
        return;
      }
      const r = await fetch("/api/sandbox/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim(), language }),
      });
      if (!r.ok) {
        const d = await readJson(r);
        setErr(d.message ?? d.error ?? "Execution failed");
        return;
      }
      const raw = (await r.json()) as Partial<ExecResult> & {
        output?: string;
        error?: string;
        status?: string;
      };
      // Normalize API shape: backend returns {output, error, durationMs, status}
      // UI expects {stdout, stderr, exitCode, durationMs, language, truncated}
      setResult({
        stdout: raw.stdout ?? raw.output ?? "",
        stderr: raw.stderr ?? raw.error ?? "",
        exitCode: raw.exitCode ?? (raw.status === "error" ? 1 : raw.error ? 1 : 0),
        durationMs: raw.durationMs ?? 0,
        language: raw.language ?? language,
        truncated: raw.truncated ?? false,
      });
      setSource("api");
      void loadHistory();
    } catch {
      setErr("Execution failed");
    } finally {
      setRunning(false);
    }
  }, [code, language, keepState, kernel, dropKernel, helper, rememberRun, loadHistory]);

  const runAgent = useCallback(async () => {
    if (!agentTask.trim()) return;
    setAgentRunning(true);
    setAgentResult(null);
    setErr("");
    try {
      const r = await fetch("/api/code-agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: agentTask.trim(), language: agentLang }),
      });
      if (!r.ok) {
        const d = await readJson(r);
        setErr(d.message ?? d.error ?? "Agent run failed");
        return;
      }
      const data = (await r.json()) as AgentSession & { session?: AgentSession };
      const session: AgentSession = data.session ?? data;
      setAgentResult(session);
      setAgentSessions((prev) => [
        session,
        ...prev.filter((s) => s.sessionId !== session.sessionId),
      ]);
    } catch {
      setErr("Agent run failed");
    } finally {
      setAgentRunning(false);
    }
  }, [agentTask, agentLang]);

  const copyResult = useCallback(() => {
    const text = result?.stdout || result?.stderr || "";
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [result]);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <Page width="default">
      <PageHeader
        title="Sandbox"
        description="Run code in an isolated container, or let the code agent write, run and fix it for you."
        actions={
          <>
            {sandboxStatus && (
              <Badge
                variant="outline"
                className={sandboxStatus.available ? "text-success" : "text-destructive"}
              >
                {sandboxStatus.available ? "Sandbox ready" : "Sandbox unavailable"}
              </Badge>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => (helper === "connected" ? void probeHelper() : setPairOpen(true))}
            >
              <Cable
                className={
                  helper === "connected"
                    ? "text-success"
                    : helper === "checking"
                      ? "text-muted-foreground animate-pulse"
                      : "text-muted-foreground"
                }
              />
              {helper === "connected"
                ? "local sandbox: connected"
                : helper === "checking"
                  ? "local sandbox: checking…"
                  : "Connect local sandbox"}
            </Button>
            <div className="flex rounded-lg border p-0.5">
              <Button
                size="sm"
                variant={tab === "execute" ? "secondary" : "ghost"}
                onClick={() => setTab("execute")}
              >
                <Code2 /> Run code
              </Button>
              <Button
                size="sm"
                variant={tab === "agent" ? "secondary" : "ghost"}
                onClick={() => setTab("agent")}
              >
                <Bot /> Code agent
              </Button>
            </div>
          </>
        }
      />

      {err && (
        <p className="text-destructive text-sm flex items-center gap-2">
          <XCircle className="w-4 h-4" />
          {err}
        </p>
      )}

      {/* ── Execute Tab ── */}
      {tab === "execute" && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Left: editor */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Select value={language} onValueChange={setLanguage}>
                  <SelectTrigger className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* Only advertise languages the backend reports as runnable
                      (JS + Python always; the rest need a self-hosted Piston). */}
                    {(sandboxStatus?.languages?.length
                      ? sandboxStatus.languages
                      : ["javascript", "python"]
                    ).map((l) => (
                      <SelectItem key={l} value={l} className="capitalize">
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button onClick={runCode} disabled={running || !code.trim()} className="flex-1">
                  {running ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Running…
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4 mr-2" />
                      Run
                    </>
                  )}
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={keepState}
                    disabled={!KERNEL_LANGUAGES.includes(language)}
                    onChange={(e) => setKeepState(e.target.checked)}
                  />
                  Keep variables between runs
                </label>
                {kernel && (
                  <Button size="sm" variant="ghost" onClick={() => dropKernel(kernel.id)}>
                    Reset kernel
                  </Button>
                )}
              </div>
              {helper === "offline" && (
                <p className="text-xs text-muted-foreground">
                  Local sandbox: not connected, so code runs on the server.{" "}
                  <button
                    type="button"
                    className="underline underline-offset-4 hover:text-foreground"
                    onClick={() => setPairOpen(true)}
                  >
                    Connect
                  </button>{" "}
                  or read the{" "}
                  <Link
                    to="/sandbox/connect"
                    className="underline underline-offset-4 hover:text-foreground"
                  >
                    setup guide
                  </Link>
                  .
                </p>
              )}
              <Textarea
                value={code}
                onChange={(e) => setCode(e.target.value)}
                rows={22}
                className="font-mono text-sm resize-none"
                placeholder="// Write your code here…"
                spellCheck={false}
              />
            </div>

            {/* Right: output */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                  Output
                </p>
                {result && (
                  <div className="flex items-center gap-2">
                    {source && (
                      <Badge variant="outline" className="text-xs">
                        {source === "helper" ? "local helper" : "server"}
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {result.durationMs}ms
                    </span>
                    <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={copyResult}>
                      {copied ? (
                        <Check className="w-3 h-3 text-success" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                    </Button>
                  </div>
                )}
              </div>

              {!result && !running ? (
                <div className="rounded-lg border-2 border-dashed h-[460px] flex items-center justify-center text-muted-foreground">
                  <div className="text-center">
                    <Terminal className="w-10 h-10 mx-auto mb-3 opacity-30" />
                    <p className="text-sm">Output will appear here</p>
                  </div>
                </div>
              ) : running ? (
                <div className="rounded-lg border h-[460px] flex items-center justify-center text-muted-foreground bg-muted/20">
                  <div className="text-center">
                    <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" />
                    <p className="text-sm">Executing {language}…</p>
                  </div>
                </div>
              ) : result ? (
                <div className="rounded-lg border h-[460px] overflow-auto bg-muted">
                  <div className="p-3 border-b border-border flex items-center gap-2">
                    {result.exitCode === 0 ? (
                      <CheckCircle className="w-4 h-4 text-success" />
                    ) : (
                      <XCircle className="w-4 h-4 text-destructive" />
                    )}
                    <span className="text-xs text-muted-foreground">
                      Exit {result.exitCode} · {result.durationMs}ms · {result.language}
                    </span>
                    {result.truncated && (
                      <Badge variant="outline" className="text-xs text-warning border-warning/30">
                        truncated
                      </Badge>
                    )}
                  </div>
                  {result.stdout && (
                    <pre className="p-4 text-xs text-success font-mono whitespace-pre-wrap break-all">
                      {result.stdout}
                    </pre>
                  )}
                  {result.stderr && (
                    <pre className="p-4 text-xs text-destructive font-mono whitespace-pre-wrap break-all border-t border-border">
                      {result.stderr}
                    </pre>
                  )}
                </div>
              ) : null}
            </div>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <History className="w-4 h-4" /> Recent runs
              </CardTitle>
            </CardHeader>
            <CardContent>
              {history.length === 0 ? (
                <p className="text-xs text-muted-foreground">Nothing has run yet.</p>
              ) : (
                <ul className="space-y-1">
                  {history.slice(0, 8).map((run) => (
                    <li key={run.executionId}>
                      <button
                        type="button"
                        className="w-full text-left rounded-lg border px-3 py-2 hover:bg-accent/50"
                        onClick={() =>
                          setResult({
                            stdout: run.output,
                            stderr: run.error ?? "",
                            exitCode: run.status === "done" ? 0 : 1,
                            durationMs: run.durationMs,
                            language: run.language ?? language,
                          })
                        }
                      >
                        <span className="text-xs text-muted-foreground">
                          {run.language ?? "code"} · {run.status} · {run.durationMs}ms ·{" "}
                          {run.source === "helper" ? "local" : "server"}
                        </span>
                        <span className="block text-xs font-mono truncate">
                          {(run.output || run.error || "(no output)").split("\n")[0]}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Code Agent Tab ── */}
      {tab === "agent" && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Left: task input + result */}
          <div className="lg:col-span-2 space-y-4">
            <Card>
              <CardContent className="pt-4 space-y-3">
                <div className="flex items-center gap-2">
                  <Bot className="w-4 h-4 text-primary" />
                  <p className="text-sm font-medium">Describe what you want the agent to build</p>
                </div>
                <Textarea
                  placeholder="e.g. Write a function that calculates the nth prime number and print the first 20 primes"
                  value={agentTask}
                  onChange={(e) => setAgentTask(e.target.value)}
                  rows={4}
                  className="resize-none"
                />
                <div className="flex gap-2">
                  <Select value={agentLang} onValueChange={setAgentLang}>
                    <SelectTrigger className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(sandboxStatus?.languages?.length
                        ? sandboxStatus.languages
                        : ["python", "javascript"]
                      ).map((l) => (
                        <SelectItem key={l} value={l} className="capitalize">
                          {l}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    className="flex-1"
                    onClick={runAgent}
                    disabled={agentRunning || !agentTask.trim()}
                  >
                    {agentRunning ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Agent working…
                      </>
                    ) : (
                      <>
                        <Bot className="w-4 h-4 mr-2" />
                        Run agent
                      </>
                    )}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  The LLM writes code, runs it, reads the output, and iteratively fixes errors until
                  it works.
                </p>
              </CardContent>
            </Card>

            {agentResult && (
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm">Agent Result</CardTitle>
                    <div className="flex items-center gap-2">
                      <Badge
                        className={
                          agentResult.status === "success"
                            ? "bg-success/10 text-success"
                            : agentResult.status === "error"
                              ? "bg-destructive/10 text-destructive"
                              : "bg-primary/10 text-primary"
                        }
                      >
                        {agentResult.status}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {agentResult.iterations} iteration{agentResult.iterations !== 1 ? "s" : ""}
                      </span>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* Generated code */}
                  {agentResult.code && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1">
                        Generated code:
                      </p>
                      <pre className="rounded-lg bg-muted p-3 text-xs text-success font-mono overflow-auto max-h-48 whitespace-pre-wrap">
                        {agentResult.code}
                      </pre>
                    </div>
                  )}
                  {/* Output */}
                  {agentResult.finalOutput && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1">Output:</p>
                      <pre className="rounded-lg bg-muted p-3 text-xs font-mono overflow-auto max-h-40 whitespace-pre-wrap">
                        {agentResult.finalOutput}
                      </pre>
                    </div>
                  )}
                  {agentResult.finalError && (
                    <div>
                      <p className="text-xs font-medium text-destructive mb-1">Error:</p>
                      <pre className="rounded-lg bg-destructive/10 p-3 text-xs text-destructive font-mono overflow-auto max-h-40 whitespace-pre-wrap">
                        {agentResult.finalError}
                      </pre>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>

          {/* Right: past sessions */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Runs this visit
              </p>
            </div>
            {agentSessions.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-4">No sessions yet</p>
            ) : (
              agentSessions.slice(0, 10).map((s) => (
                <Card
                  key={s.sessionId}
                  className="cursor-pointer hover:bg-accent/50 transition-colors"
                  onClick={() => setAgentResult(s)}
                >
                  <CardContent className="pt-2 pb-2">
                    <div className="flex items-center gap-2">
                      <div
                        className={`w-2 h-2 rounded-full shrink-0 ${
                          s.status === "success"
                            ? "bg-success"
                            : s.status === "error"
                              ? "bg-destructive"
                              : "bg-primary"
                        }`}
                      />
                      <p className="text-xs flex-1 truncate">{s.task}</p>
                      <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
                    </div>
                    <p className="text-xs text-muted-foreground ml-4">
                      {s.language} · {s.iterations} iter
                    </p>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </div>
      )}
      <Dialog open={pairOpen} onOpenChange={setPairOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect the local sandbox</DialogTitle>
            <DialogDescription>
              Start the helper on this machine and type the six-digit code it printed. It listens on{" "}
              <code>{HELPER_URL}</code>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label htmlFor="pair-code" className="text-xs font-medium">
              Pairing code
            </label>
            <Input
              id="pair-code"
              value={pairCode}
              onChange={(e) => setPairCode(e.target.value)}
              placeholder="123456"
              inputMode="numeric"
              maxLength={6}
              autoComplete="off"
            />
            {pairError && <p className="text-xs text-destructive">{pairError}</p>}
            <p className="text-xs text-muted-foreground">
              Not running?{" "}
              <Link
                to="/sandbox/connect"
                className="underline underline-offset-4 hover:text-foreground"
                onClick={() => setPairOpen(false)}
              >
                Read the setup guide
              </Link>
              .
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPairOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void submitPair()}
              disabled={pairing || pairCode.trim().length !== 6}
            >
              {pairing ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Pairing…
                </>
              ) : (
                "Pair"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
