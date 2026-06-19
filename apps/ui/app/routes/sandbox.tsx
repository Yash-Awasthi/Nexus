// SPDX-License-Identifier: Apache-2.0
/**
 * Code Sandbox — Phase 4.12 / 4.16
 *
 * Execute code directly in the sandbox (JS/Python/TypeScript/Bash) or
 * use the Code Agent to have the LLM write + iteratively fix code for you.
 *
 * API:
 *   POST /api/sandbox/execute           — run code directly
 *   GET  /api/sandbox/status            — sandbox status
 *   POST /api/code-agent/run            — LLM writes + runs code
 *   GET  /api/code-agent/sessions       — past agent sessions
 *   GET  /api/code-agent/sessions/:id   — session detail
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Textarea } from "~/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Terminal,
  Play,
  Loader2,
  CheckCircle,
  XCircle,
  RefreshCw,
  Clock,
  Code2,
  Bot,
  ChevronRight,
  Trash2,
  Copy,
  Check,
} from "lucide-react";

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

// ─── Default snippets per language ───────────────────────────────────────────

const SNIPPETS: Record<string, string> = {
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
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setSandboxStatus(d))
      .catch(() => {});
    // Load recent agent sessions
    loadAgentSessions();
  }, []);

  const loadAgentSessions = useCallback(async () => {
    try {
      const r = await fetch("/api/code-agent/sessions");
      if (r.ok) {
        const d = await r.json();
        setAgentSessions(Array.isArray(d) ? d : (d?.sessions ?? []));
      }
    } catch {}
  }, []);

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
      const r = await fetch("/api/sandbox/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim(), language }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setErr(d.error ?? "Execution failed");
        return;
      }
      const raw = await r.json();
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
    } catch {
      setErr("Execution failed");
    } finally {
      setRunning(false);
    }
  }, [code, language]);

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
        const d = await r.json().catch(() => ({}));
        setErr(d.error ?? "Agent run failed");
        return;
      }
      const data = await r.json();
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
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Terminal className="w-6 h-6 text-emerald-500" />
            Code Sandbox
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Execute code or let the AI agent write and run it for you
          </p>
        </div>
        <div className="flex items-center gap-3">
          {sandboxStatus && (
            <Badge
              className={
                sandboxStatus.available
                  ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400"
                  : "bg-red-100 text-red-700"
              }
            >
              {sandboxStatus.available ? "● Sandbox ready" : "● Sandbox unavailable"}
            </Badge>
          )}
          <div className="flex gap-1">
            <Button
              size="sm"
              variant={tab === "execute" ? "default" : "outline"}
              onClick={() => setTab("execute")}
            >
              <Code2 className="w-3 h-3 mr-1" />
              Execute
            </Button>
            <Button
              size="sm"
              variant={tab === "agent" ? "default" : "outline"}
              onClick={() => setTab("agent")}
            >
              <Bot className="w-3 h-3 mr-1" />
              Code Agent
            </Button>
          </div>
        </div>
      </div>

      {err && (
        <p className="text-red-500 text-sm flex items-center gap-2">
          <XCircle className="w-4 h-4" />
          {err}
        </p>
      )}

      {/* ── Execute Tab ── */}
      {tab === "execute" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Left: editor */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Select value={language} onValueChange={setLanguage}>
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["javascript", "typescript", "python", "bash"].map((l) => (
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
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {result.durationMs}ms
                  </span>
                  <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={copyResult}>
                    {copied ? (
                      <Check className="w-3 h-3 text-green-500" />
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
              <div className="rounded-lg border h-[460px] overflow-auto bg-slate-950 dark:bg-slate-900">
                <div className="p-3 border-b border-slate-800 flex items-center gap-2">
                  {result.exitCode === 0 ? (
                    <CheckCircle className="w-4 h-4 text-green-400" />
                  ) : (
                    <XCircle className="w-4 h-4 text-red-400" />
                  )}
                  <span className="text-xs text-slate-400">
                    Exit {result.exitCode} · {result.durationMs}ms · {result.language}
                  </span>
                  {result.truncated && (
                    <Badge variant="outline" className="text-xs text-yellow-400 border-yellow-600">
                      truncated
                    </Badge>
                  )}
                </div>
                {result.stdout && (
                  <pre className="p-4 text-xs text-green-300 font-mono whitespace-pre-wrap break-all">
                    {result.stdout}
                  </pre>
                )}
                {result.stderr && (
                  <pre className="p-4 text-xs text-red-400 font-mono whitespace-pre-wrap break-all border-t border-slate-800">
                    {result.stderr}
                  </pre>
                )}
              </div>
            ) : null}
          </div>
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
                  <Bot className="w-4 h-4 text-violet-500" />
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
                      {["python", "javascript", "typescript"].map((l) => (
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
                            ? "bg-green-100 text-green-700"
                            : agentResult.status === "error"
                              ? "bg-red-100 text-red-700"
                              : "bg-blue-100 text-blue-700"
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
                      <pre className="rounded-lg bg-slate-950 p-3 text-xs text-green-300 font-mono overflow-auto max-h-48 whitespace-pre-wrap">
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
                      <p className="text-xs font-medium text-red-500 mb-1">Error:</p>
                      <pre className="rounded-lg bg-red-950/20 p-3 text-xs text-red-400 font-mono overflow-auto max-h-40 whitespace-pre-wrap">
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
                Past runs
              </p>
              <Button variant="ghost" size="sm" onClick={loadAgentSessions}>
                <RefreshCw className="w-3 h-3" />
              </Button>
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
                            ? "bg-green-500"
                            : s.status === "error"
                              ? "bg-red-500"
                              : "bg-blue-500"
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
    </div>
  );
}
