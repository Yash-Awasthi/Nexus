// SPDX-License-Identifier: Apache-2.0
/**
 * App builder — describe an app; a themed starter is written to your drive and a
 * coding agent builds it out. Download the folder when the run finishes.
 *
 * API: POST /api/v1/apps/generate, GET /api/v1/sse/agent/:sessionId,
 *      GET /api/v1/drive/export?dir=
 */
import { Download, Loader2, Wand2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Page, PageHeader } from "~/components/page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Textarea } from "~/components/ui/textarea";
import { apiFetch, authFetch } from "~/lib/api";

interface Generated {
  sessionId: string;
  app: string;
  design: { style: string; color: string; font: string; radius: string };
}

interface Step {
  stepIndex: number;
  toolCalls: string[];
}

export default function AppBuilderPage() {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [run, setRun] = useState<Generated | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [status, setStatus] = useState("");

  const generate = async () => {
    setBusy(true);
    setError("");
    setRun(null);
    setSteps([]);
    setStatus("");
    try {
      // Named here so the shell approval, which the server binds to this id, matches on the retry.
      const sessionId = crypto.randomUUID();
      const start = (approvalId?: string) =>
        apiFetch<Generated & { approvalId?: string }>("/api/v1/apps/generate", {
          method: "POST",
          json: { prompt: prompt.trim(), sessionId, approvalId },
        });
      let out = await start();
      if (out.approvalId) {
        const ok = window.confirm(
          "The agent installs packages and runs builds on this machine for this one run. Allow it once?",
        );
        if (!ok) return;
        await apiFetch(`/api/v1/exec/approvals/${out.approvalId}/approve`, { method: "POST" });
        out = await start(out.approvalId);
      }
      setRun(out);
      setStatus("running");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!run) return;
    const abort = new AbortController();
    void (async () => {
      const res = await authFetch(`/api/v1/sse/agent/${run.sessionId}`, {
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
        const blocks = buf.split("\n\n");
        buf = blocks.pop() ?? "";
        for (const block of blocks) {
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (!event || !data) continue;
          const payload = JSON.parse(data) as Record<string, unknown>;
          if (event === "agent.step") setSteps((s) => [...s, payload as unknown as Step]);
          if (event === "agent.status") setStatus(String(payload.status ?? ""));
        }
      }
    })();
    return () => abort.abort();
  }, [run]);

  const download = async () => {
    if (!run) return;
    const r = await authFetch(`/api/v1/drive/export?dir=${encodeURIComponent(run.app)}`).catch(
      () => null,
    );
    if (!r?.ok) {
      setError("Could not download the app");
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await r.blob());
    a.download = `${run.app.split("/").pop()}.tar.gz`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const running = status === "running";

  return (
    <Page width="default">
      <PageHeader
        title="App builder"
        description="Describe an app. It starts from a themed React starter in your drive and an agent builds it out."
      />

      <Card>
        <CardContent className="space-y-3 pt-6">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="A recipe box where I can save recipes, tag them and search by ingredient"
            rows={4}
            aria-label="Describe the app"
          />
          <Button onClick={() => void generate()} disabled={busy || running || !prompt.trim()}>
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Wand2 className="mr-2 h-4 w-4" />
            )}
            Generate
          </Button>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>

      {run && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {run.app}
              {running && <Loader2 className="h-4 w-4 animate-spin" aria-label="Running" />}
              {status && !running && <Badge variant="secondary">{status}</Badge>}
            </CardTitle>
            <CardDescription className="flex flex-wrap gap-1">
              {Object.entries(run.design).map(([k, v]) => (
                <Badge key={k} variant="outline">
                  {k}: {v}
                </Badge>
              ))}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ol className="space-y-1 text-sm text-muted-foreground" aria-live="polite">
              {steps.map((s) => (
                <li key={s.stepIndex}>
                  Step {s.stepIndex + 1}
                  {s.toolCalls.length ? `: ${s.toolCalls.join(", ")}` : ": done"}
                </li>
              ))}
              {!steps.length && running && <li>Starting…</li>}
            </ol>
            <Button variant="outline" onClick={() => void download()}>
              <Download className="mr-2 h-4 w-4" />
              Download
            </Button>
          </CardContent>
        </Card>
      )}
    </Page>
  );
}
