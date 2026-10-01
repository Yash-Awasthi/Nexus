// SPDX-License-Identifier: Apache-2.0
/**
 * Terminals — the local terminal plane. Spawns agent CLIs (Claude Code, Codex, …) or any
 * command as a real PTY on this machine and drives it from the browser.
 *
 *   GET    /api/local/status          — whether this is the local app, which CLIs are installed
 *   GET    /api/local/pty             — sessions
 *   POST   /api/local/pty             — spawn (a policy stop returns 202 with an approval id)
 *   GET    /api/local/pty/:id/stream  — SSE output
 *   POST   /api/local/pty/:id/write   — keystrokes
 *   POST   /api/local/pty/:id/resize  — size
 *   DELETE /api/local/pty/:id         — kill
 */
import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Plus, SquareTerminal, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Page, PageHeader } from "~/components/page";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { apiFetch, authFetch } from "~/lib/api";

interface Session {
  id: string;
  command: string;
  exited: boolean;
}

interface Status {
  agentClis: Record<string, boolean>;
}

type Spawned = { session: Session } | { approvalId: string; message: string };

const CLI_COMMANDS: Record<string, string> = { claude: "claude", codex: "codex", vscode: "code" };

function TerminalView({ session, onExit }: { session: Session; onExit: () => void }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = new Terminal({ convertEol: true, fontSize: 13, cursorBlink: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    const resize = () => {
      fit.fit();
      void apiFetch(`/api/local/pty/${session.id}/resize`, {
        method: "POST",
        json: { cols: term.cols, rows: term.rows },
      }).catch(() => {});
    };
    resize();
    window.addEventListener("resize", resize);
    const typed = term.onData((data) => {
      void apiFetch(`/api/local/pty/${session.id}/write`, { method: "POST", json: { data } }).catch(
        () => {},
      );
    });

    const abort = new AbortController();
    void (async () => {
      const res = await authFetch(`/api/local/pty/${session.id}/stream`, {
        signal: abort.signal,
      }).catch(() => null);
      if (!res?.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() ?? "";
        for (const ev of events) {
          if (!ev.startsWith("data: ")) continue;
          const msg = JSON.parse(ev.slice(6)) as {
            type: string;
            data?: string;
            exitCode?: number;
          };
          if (msg.type === "data" && msg.data) term.write(msg.data);
          if (msg.type === "exit") {
            term.write(
              `\r\n[process exited${msg.exitCode != null ? ` with ${msg.exitCode}` : ""}]\r\n`,
            );
            onExit();
          }
        }
      }
    })();

    return () => {
      abort.abort();
      typed.dispose();
      window.removeEventListener("resize", resize);
      term.dispose();
    };
  }, [session.id, onExit]);

  return <div ref={host} className="h-[60vh] w-full overflow-hidden rounded-md bg-black p-1" />;
}

export default function Terminals() {
  const [status, setStatus] = useState<Status | null>(null);
  const [hosted, setHosted] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const d = await apiFetch<{ sessions: Session[] }>("/api/local/pty").catch(() => null);
    if (d) setSessions(d.sessions);
  }, []);

  useEffect(() => {
    apiFetch<Status>("/api/local/status")
      .then((s) => {
        setStatus(s);
        return refresh();
      })
      .catch(() => setHosted(true));
  }, [refresh]);

  const spawn = async (line: string) => {
    const [cmd, ...args] = line.trim().split(/\s+/);
    if (!cmd) return;
    setError("");
    try {
      let out = await apiFetch<Spawned>("/api/local/pty", {
        method: "POST",
        json: { command: cmd, args },
      });
      if ("approvalId" in out) {
        if (!window.confirm(`${out.message}\n\nRun "${line.trim()}" on this machine?`)) return;
        await apiFetch(`/api/v1/exec/approvals/${out.approvalId}/approve`, { method: "POST" });
        out = await apiFetch<Spawned>("/api/local/pty", {
          method: "POST",
          json: { command: cmd, args, approvalId: out.approvalId },
        });
      }
      if ("session" in out) {
        await refresh();
        setActive(out.session.id);
        setCommand("");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the command");
    }
  };

  const kill = async (id: string) => {
    await apiFetch(`/api/local/pty/${id}`, { method: "DELETE" }).catch(() => {});
    if (active === id) setActive(null);
    await refresh();
  };

  const onExit = useCallback(() => void refresh(), [refresh]);
  const current = sessions.find((s) => s.id === active);

  if (hosted)
    return (
      <div className="mx-auto max-w-2xl p-4 sm:p-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <SquareTerminal className="h-6 w-6" /> Terminals
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Terminals run agent CLIs on the machine Nexus runs on, so they are available only in the
          desktop app or a local install.
        </p>
      </div>
    );

  return (
    <Page width="wide">
      <PageHeader
        title="Terminals"
        description="Run Claude Code, Codex or any command on this machine. Commands outside the policy ask before they start."
      />

      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          void spawn(command);
        }}
      >
        <Input
          aria-label="Command"
          placeholder="Command, e.g. claude or git status"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
        />
        <Button type="submit" disabled={!command.trim()}>
          <Plus className="mr-1 h-4 w-4" /> Start
        </Button>
      </form>
      {status && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(status.agentClis)
            .filter(([, installed]) => installed)
            .map(([name]) => (
              <Button
                key={name}
                size="sm"
                variant="outline"
                onClick={() => void spawn(CLI_COMMANDS[name] ?? name)}
              >
                {name}
              </Button>
            ))}
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
        <ul className="space-y-1" aria-label="Sessions">
          {sessions.length === 0 && (
            <li className="text-sm text-muted-foreground">No terminals yet.</li>
          )}
          {sessions.map((s) => (
            <li
              key={s.id}
              className={`flex items-center justify-between rounded-md border px-2 py-1 text-sm ${
                s.id === active ? "border-primary" : ""
              }`}
            >
              <button className="min-w-0 flex-1 truncate text-left" onClick={() => setActive(s.id)}>
                {s.command}
                {s.exited && <span className="ml-1 text-muted-foreground">(exited)</span>}
              </button>
              <button aria-label={`Close ${s.command}`} onClick={() => void kill(s.id)}>
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
        <div className="min-w-0">
          {current ? (
            <TerminalView key={current.id} session={current} onExit={onExit} />
          ) : (
            <p className="text-sm text-muted-foreground">Start or pick a terminal.</p>
          )}
        </div>
      </div>
    </Page>
  );
}
