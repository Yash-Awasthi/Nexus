// SPDX-License-Identifier: Apache-2.0
/**
 * Discussion — the council shape with no rounds.
 *
 * Deliberations (`/chat`) runs the debate: every member answers, then every
 * member sees the others and revises, in lockstep. Here each participant reads
 * the shared ledger from its own position and contributes whenever it is ready,
 * so a fast model can speak three times while a slow one speaks once. A
 * supervisor keeps the record and decides when the discussion has a result.
 *
 * The council membership is the same one Deliberations uses (Settings →
 * Council), so the two surfaces never disagree about who is in the room.
 */

import { Loader2, Play, Square, Settings as SettingsIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/discussion";

import { Page, PageHeader } from "~/components/page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Textarea } from "~/components/ui/textarea";
import { syncCouncilFromServer, type CouncilMember } from "~/lib/council";

export function meta(_: Route.MetaArgs) {
  return [
    { title: "NEXUS - Discussion" },
    { name: "description", content: "Council discussion with participants on independent clocks" },
  ];
}

interface LedgerEntry {
  line: number;
  at: string;
  author: string;
  kind: "contribution" | "digest";
  text: string;
}

interface Outcome {
  settled: boolean;
  reason: string;
  contributions: number;
  totalTokens: number;
  digest: string;
  markdown: string;
}

/** Why a run ended, in the words a reader needs rather than the wire value. */
const REASON_TEXT: Record<string, string> = {
  settled: "the supervisor judged the discussion resolved",
  "contribution-cap": "the contribution limit was reached",
  "time-cap": "the time limit was reached",
  "token-cap": "the token limit was reached",
  "participants-failed": "no participant could answer",
};

const CONTRIBUTION_CHOICES = [6, 12, 18, 24];

export default function Discussion() {
  const [topic, setTopic] = useState("");
  const [maxContributions, setMaxContributions] = useState(12);
  const [members, setMembers] = useState<CouncilMember[]>([]);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    void syncCouncilFromServer().then((all) =>
      setMembers(all.filter((m) => m.enabled && m.provider && m.model)),
    );
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const start = useCallback(async () => {
    const question = topic.trim();
    if (!question || running) return;

    setEntries([]);
    setOutcome(null);
    setError(null);
    setRunning(true);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetch("/api/v1/discussion/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: question,
          participants: members.map((m) => ({
            label: m.label,
            provider: m.provider,
            model: m.model,
          })),
          maxContributions,
        }),
        signal: abort.signal,
      });

      if (!res.ok || !res.body) {
        const detail = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(detail?.message ?? `Discussion failed: ${res.status}`);
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        // SSE frames are separated by a blank line; a partial frame stays in
        // the buffer until its terminator arrives.
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const frame of frames) {
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (!event || !data) continue;
          const payload = JSON.parse(data) as Record<string, unknown>;
          if (event === "entry") setEntries((prev) => [...prev, payload as unknown as LedgerEntry]);
          else if (event === "done") setOutcome(payload as unknown as Outcome);
          else if (event === "error") setError(String(payload.message ?? "Discussion failed"));
          else if (event === "member_error")
            setError((prev) => {
              const line = `${String(payload.label)}: ${String(payload.message)}`;
              return prev?.includes(line) ? prev : prev ? `${prev}\n${line}` : line;
            });
        }
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : "Discussion failed");
      }
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
      setRunning(false);
    }
  }, [topic, members, maxContributions, running]);

  return (
    <Page width="default">
      <PageHeader
        title="Discussion"
        description={
          <>
            A round-free council: members post when they have something to add, and a supervisor
            keeps one running record. For a structured debate with a synthesis, use the{" "}
            <Link to="/chat" className="text-primary hover:underline">
              council
            </Link>
            .
          </>
        }
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Topic</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="What should the council discuss?"
            rows={3}
            disabled={running}
          />

          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Contribution limit</span>
              {CONTRIBUTION_CHOICES.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setMaxContributions(n)}
                  disabled={running}
                  className={`px-2 py-0.5 rounded-md text-[11px] font-medium border transition-colors ${
                    maxContributions === n
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>

            <div className="flex-1" />

            {running ? (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={stop}>
                <Square className="size-3.5" /> Stop
              </Button>
            ) : (
              <Button
                size="sm"
                className="gap-1.5"
                onClick={() => void start()}
                disabled={!topic.trim() || members.length === 0}
              >
                <Play className="size-3.5" /> Start discussion
              </Button>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
            {members.length === 0 ? (
              <span className="flex items-center gap-1.5">
                No council members enabled.
                <Link
                  to="/settings"
                  className="inline-flex items-center gap-1 underline underline-offset-4"
                >
                  <SettingsIcon className="size-3" /> Configure the council
                </Link>
              </span>
            ) : (
              <>
                <span>Participants:</span>
                {members.map((m) => (
                  <Badge key={m.id ?? m.label} variant="outline" className="text-[10px]">
                    {m.label}
                  </Badge>
                ))}
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {error && (
        <p className="whitespace-pre-line break-words text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-sm font-semibold">Ledger</CardTitle>
          {running && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> running
            </span>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing yet. Every contribution lands here with its own line number, and the
              supervisor&apos;s record is folded in as the discussion moves.
            </p>
          ) : (
            entries.map((entry) => (
              <div
                key={entry.line}
                className={`rounded-lg border p-3 ${
                  entry.kind === "digest" ? "border-primary/30 bg-primary/5" : "border-border"
                }`}
              >
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground mb-1.5">
                  <span className="font-mono">L{entry.line}</span>
                  <span className="font-medium text-foreground">{entry.author}</span>
                  {entry.kind === "digest" && (
                    <Badge variant="outline" className="text-[10px] h-4 px-1">
                      record
                    </Badge>
                  )}
                  <span>{new Date(entry.at).toLocaleTimeString()}</span>
                </div>
                <p className="text-sm whitespace-pre-wrap">{entry.text}</p>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {outcome && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Result</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-muted-foreground">
              Ended because {REASON_TEXT[outcome.reason] ?? outcome.reason}, after{" "}
              {outcome.contributions} contribution{outcome.contributions === 1 ? "" : "s"} and{" "}
              {outcome.totalTokens.toLocaleString()} tokens.
            </p>
            {outcome.digest ? (
              <p className="whitespace-pre-wrap">{outcome.digest}</p>
            ) : (
              <p className="text-muted-foreground">The supervisor produced no record.</p>
            )}
          </CardContent>
        </Card>
      )}
    </Page>
  );
}
