// SPDX-License-Identifier: Apache-2.0
/**
 * Council Checkpoints — time-travel debugging for council deliberation runs.
 *
 * Save the state of a council run at any step, replay from a checkpoint,
 * inspect individual step outputs, and reset to a clean slate.
 *
 * API:
 *   POST   /api/council-checkpoints/runs/:runId/save
 *   GET    /api/council-checkpoints/runs/:runId
 *   GET    /api/council-checkpoints/runs/:runId/checkpoints/:stepIndex
 *   POST   /api/council-checkpoints/runs/:runId/replay
 *   DELETE /api/council-checkpoints/runs/:runId
 */
import { useState, useCallback } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import {
  History,
  Save,
  Play,
  Trash2,
  Loader2,
  ChevronRight,
  ChevronDown,
  Search,
  Clock,
  GitCommit,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Checkpoint {
  stepIndex: number;
  label?: string;
  savedAt: string;
  summary?: string;
}

interface RunInfo {
  runId: string;
  query?: string;
  checkpoints: Checkpoint[];
  totalSteps?: number;
  createdAt?: string;
}

interface StepDetail {
  stepIndex: number;
  state: object;
  messages?: { role: string; content: string }[];
  metadata?: object;
}

interface ReplayResult {
  success: boolean;
  newRunId?: string;
  output?: string;
  steps?: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function CouncilCheckpoints() {
  const [runId, setRunId] = useState("");
  const [runInfo, setRunInfo] = useState<RunInfo | null>(null);
  const [loadingRun, setLoadingRun] = useState(false);

  // Save
  const [savingCheckpoint, setSavingCheckpoint] = useState(false);
  const [saveLabel, setSaveLabel] = useState("");
  const [saveMsg, setSaveMsg] = useState("");

  // Step detail
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const [stepDetail, setStepDetail] = useState<StepDetail | null>(null);
  const [loadingStep, setLoadingStep] = useState(false);

  // Replay
  const [replayStep, setReplayStep] = useState<number | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [replayResult, setReplayResult] = useState<ReplayResult | null>(null);

  // Delete
  const [deleting, setDeleting] = useState(false);

  const [err, setErr] = useState("");

  const loadRun = useCallback(async () => {
    if (!runId.trim()) return;
    setLoadingRun(true);
    setErr("");
    setRunInfo(null);
    setStepDetail(null);
    setReplayResult(null);
    const r = await fetch(`/api/council-checkpoints/runs/${runId.trim()}`).catch(() => null);
    if (r?.ok) setRunInfo(await r.json());
    else setErr("Run not found");
    setLoadingRun(false);
  }, [runId]);

  const saveCheckpoint = useCallback(async () => {
    if (!runInfo) return;
    setSavingCheckpoint(true);
    setSaveMsg("");
    const r = await fetch(`/api/council-checkpoints/runs/${runInfo.runId}/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: saveLabel.trim() || undefined }),
    }).catch(() => null);
    if (r?.ok) {
      setSaveMsg("Checkpoint saved!");
      setSaveLabel("");
      loadRun();
    }
    setSavingCheckpoint(false);
  }, [runInfo, saveLabel, loadRun]);

  const loadStep = useCallback(
    async (stepIndex: number) => {
      if (!runInfo) return;
      setSelectedStep(stepIndex);
      setLoadingStep(true);
      setStepDetail(null);
      const r = await fetch(
        `/api/council-checkpoints/runs/${runInfo.runId}/checkpoints/${stepIndex}`,
      ).catch(() => null);
      if (r?.ok) setStepDetail(await r.json());
      setLoadingStep(false);
    },
    [runInfo],
  );

  const replay = useCallback(
    async (fromStep: number) => {
      if (!runInfo) return;
      setReplaying(true);
      setReplayResult(null);
      setReplayStep(fromStep);
      const r = await fetch(`/api/council-checkpoints/runs/${runInfo.runId}/replay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromStep }),
      }).catch(() => null);
      if (r?.ok) setReplayResult(await r.json());
      else setErr("Replay failed");
      setReplaying(false);
    },
    [runInfo],
  );

  const deleteRun = useCallback(async () => {
    if (!runInfo || !confirm("Delete all checkpoints for this run?")) return;
    setDeleting(true);
    await fetch(`/api/council-checkpoints/runs/${runInfo.runId}`, { method: "DELETE" }).catch(
      () => {},
    );
    setRunInfo(null);
    setStepDetail(null);
    setReplayResult(null);
    setDeleting(false);
  }, [runInfo]);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <History className="w-6 h-6 text-rose-500" />
          Council Checkpoints
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Time-travel debugging — inspect, save, and replay council deliberation run states
        </p>
      </div>

      {/* Load a run */}
      <Card>
        <CardContent className="pt-4 space-y-3">
          <label className="text-sm font-medium">Load Run by ID</label>
          <div className="flex gap-2">
            <Input
              placeholder="Enter run ID (e.g. from a council deliberation)…"
              value={runId}
              onChange={(e) => setRunId(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && loadRun()}
              className="flex-1 font-mono text-sm"
            />
            <Button onClick={loadRun} disabled={loadingRun || !runId.trim()}>
              {loadingRun ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Search className="w-4 h-4" />
              )}
            </Button>
          </div>
          {err && <p className="text-red-500 text-xs">{err}</p>}
        </CardContent>
      </Card>

      {runInfo && (
        <div className="grid md:grid-cols-3 gap-6">
          {/* Left: checkpoint list */}
          <div className="space-y-3 md:col-span-1">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Checkpoints ({runInfo.checkpoints.length})</h2>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-red-400"
                onClick={deleteRun}
                disabled={deleting}
              >
                {deleting ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Trash2 className="w-3 h-3" />
                )}
              </Button>
            </div>

            {runInfo.query && (
              <div className="text-xs text-muted-foreground bg-muted/50 rounded-md p-2">
                <span className="font-medium">Query: </span>
                {runInfo.query}
              </div>
            )}

            {/* Save button */}
            <div className="flex gap-2">
              <Input
                placeholder="Label (optional)"
                value={saveLabel}
                onChange={(e) => setSaveLabel(e.target.value)}
                className="text-xs h-8 flex-1"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={saveCheckpoint}
                disabled={savingCheckpoint}
                className="h-8"
              >
                {savingCheckpoint ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Save className="w-3 h-3 mr-1" />
                )}
                Save
              </Button>
            </div>
            {saveMsg && <p className="text-green-600 dark:text-green-400 text-xs">{saveMsg}</p>}

            {/* Checkpoint items */}
            {runInfo.checkpoints.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">
                No checkpoints saved yet
              </p>
            ) : (
              <div className="space-y-1">
                {runInfo.checkpoints.map((cp) => (
                  <button
                    key={cp.stepIndex}
                    onClick={() => loadStep(cp.stepIndex)}
                    className={`w-full text-left p-2.5 rounded-lg border text-sm transition-colors hover:bg-muted/50 ${selectedStep === cp.stepIndex ? "bg-muted border-primary/30" : "border-transparent"}`}
                  >
                    <div className="flex items-center gap-2">
                      <GitCommit className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                      <span className="font-medium">Step {cp.stepIndex}</span>
                      {cp.label && (
                        <Badge variant="outline" className="text-xs">
                          {cp.label}
                        </Badge>
                      )}
                    </div>
                    {cp.summary && (
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                        {cp.summary}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                      <Clock className="w-2.5 h-2.5" />
                      {new Date(cp.savedAt).toLocaleString()}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Right: step detail + replay */}
          <div className="md:col-span-2 space-y-4">
            {loadingStep ? (
              <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading checkpoint…
              </div>
            ) : stepDetail ? (
              <>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center justify-between">
                      <span>Step {stepDetail.stepIndex} State</span>
                      <Button
                        size="sm"
                        onClick={() => replay(stepDetail.stepIndex)}
                        disabled={replaying}
                      >
                        {replaying && replayStep === stepDetail.stepIndex ? (
                          <>
                            <Loader2 className="w-3 h-3 animate-spin mr-1" />
                            Replaying…
                          </>
                        ) : (
                          <>
                            <Play className="w-3 h-3 mr-1" />
                            Replay from here
                          </>
                        )}
                      </Button>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {/* Messages */}
                    {stepDetail.messages && stepDetail.messages.length > 0 && (
                      <div className="space-y-2 mb-4">
                        {stepDetail.messages.map((msg, i) => (
                          <div
                            key={i}
                            className={`text-sm p-2 rounded-md ${msg.role === "assistant" ? "bg-muted" : "bg-primary/5"}`}
                          >
                            <span className="text-xs font-medium text-muted-foreground uppercase">
                              {msg.role}
                            </span>
                            <p className="mt-0.5 text-sm">{msg.content}</p>
                          </div>
                        ))}
                      </div>
                    )}
                    {/* Raw state */}
                    <details>
                      <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                        Raw state
                      </summary>
                      <pre className="text-xs bg-muted p-3 rounded-md mt-2 overflow-auto max-h-64">
                        {JSON.stringify(stepDetail.state, null, 2)}
                      </pre>
                    </details>
                  </CardContent>
                </Card>

                {/* Replay result */}
                {replayResult && replayStep === stepDetail.stepIndex && (
                  <Card
                    className={
                      replayResult.success
                        ? "border-green-200 dark:border-green-800"
                        : "border-red-200 dark:border-red-800"
                    }
                  >
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base">Replay Result</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Badge
                          className={
                            replayResult.success
                              ? "bg-green-100 text-green-700"
                              : "bg-red-100 text-red-700"
                          }
                        >
                          {replayResult.success ? "Success" : "Failed"}
                        </Badge>
                        {replayResult.newRunId && (
                          <span className="text-xs text-muted-foreground font-mono">
                            New run: {replayResult.newRunId}
                          </span>
                        )}
                        {replayResult.steps && (
                          <Badge variant="outline">{replayResult.steps} steps</Badge>
                        )}
                      </div>
                      {replayResult.output && (
                        <p className="text-sm whitespace-pre-wrap bg-muted/30 p-3 rounded-md">
                          {replayResult.output}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                )}
              </>
            ) : (
              <div className="flex items-center justify-center h-48 text-muted-foreground border rounded-lg border-dashed">
                <div className="text-center">
                  <History className="w-10 h-10 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">Select a checkpoint to inspect</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
