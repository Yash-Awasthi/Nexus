// SPDX-License-Identifier: Apache-2.0
/**
 * agent-handler — `agent.run` BullMQ job: drive the native tool-calling agent loop.
 *
 * Builds a @nexus/llm-drivers driver (BYOK: key from the payload or env), bridges
 * it to the loop's tool-aware LLM via `llmDriverToToolFn`, assembles the coding +
 * MCP tool set, applies a permission policy (Phase 2), and runs a
 * `ToolAgentRuntime`. Returns the final content + token usage; per-step progress
 * is logged as structured telemetry (an SSE relay over the event bus is a
 * follow-up).
 *
 * Permission policy (Phase 2): read-only tools auto-allow; mutating tools
 * (write/edit/run_command/MCP) are gated per `permissionPolicy`:
 *   - "allow"  (default): run everything (trusted single-tenant workspace)
 *   - "deny"   : deny all mutating tools (dry-run / read-only audit)
 *   - "allowlist": allow only tools named in `allowedTools`
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ToolAgentRuntime,
  llmDriverToToolFn,
  createProgrammaticToolTool,
  COMPACTION_SUMMARY_PROMPT,
  type LlmToolDriver,
  type LlmToolFn,
  type ToolStepRecord,
  type RuntimeMessage,
  type CompactionResult,
  type PresetName,
} from "@nexus/agent-runtime";
import { db } from "@nexus/db";
import { agentSessions } from "@nexus/db/schema";
import {
  AnthropicDriver,
  GroqDriver,
  OpenRouterDriver,
  OpenAIDriver,
  GeminiDriver,
  DeepSeekDriver,
  type LlmDriver,
  type LlmRole,
} from "@nexus/llm-drivers";
import {
  toolTranscriptEvent,
  type CouncilTranscript,
  type ILLMTransport,
} from "@nexus/council";
import { FixedEmbedder, MemoryManager, PgVectorStore, createBestEmbedder } from "@nexus/memory";
import { eq } from "drizzle-orm";

import { publishAgentEvent } from "./agent-events.js";
import { defaultAgentGovernanceEngine, makeGovernanceGate } from "./agent-governance.js";
import {
  mcpToolsFromServers,
  councilRuntimeToolsFromTransport,
  debateRuntimeTool,
  type McpServerConfig,
} from "./agent-mcp.js";
import { proposeLearningUpdates, reviewSession } from "./agent-review.js";
import { createCodingToolSet } from "./agent-tools.js";
import {
  WorkspaceManager,
  WorkspaceRunner,
  collectChecks,
  loadNexusSettings,
  runScriptBounded,
  type NexusSettings,
  type RunHandle,
  type Workspace,
} from "./workspace-manager.js";

/** Max time a `.nexus` setup script may run before it is stopped (5 min). */
const SETUP_TIMEOUT_MS = 5 * 60_000;

export interface AgentRunPayload {
  taskId?: string;
  /** Instruction / objective (first non-empty of these wins). */
  instruction?: string;
  prompt?: string;
  goal?: string;
  /** Provider: anthropic (default) | groq | openrouter. */
  provider?: string;
  model?: string;
  /** BYOK key; falls back to the provider's env var. */
  apiKey?: string;
  systemPrompt?: string;
  maxSteps?: number;
  /** Workspace root the coding tools are confined to (default: AGENT_WORKSPACE env or cwd). */
  workspaceDir?: string;
  /** External MCP servers whose tools are exposed to the agent this run. */
  mcpServers?: McpServerConfig[];
  /** Permission policy for mutating tools. Default "allow". */
  permissionPolicy?: "allow" | "deny" | "allowlist";
  /** When permissionPolicy is "allowlist", the mutating tools that are permitted. */
  allowedTools?: string[];
  /** Bypass the @nexus/governance safety net (still honors permissionPolicy). Default false. */
  disableGovernance?: boolean;
  /** Disable context compaction (on by default for long sessions). */
  disableCompaction?: boolean;
  /** Disable the programmatic-tool-calling (PTC) meta-tool (on by default). */
  disablePtc?: boolean;
  /**
   * Disable the built-in served deliberation tools (council protocols + the
   * converging debate tool, on by default when a driver is present).
   */
  disableCouncilTools?: boolean;
  /** Run PTC scripts in a worker_thread sandbox (hard timeout for sync loops). Default false. */
  ptcSandbox?: boolean;
  /** Run a forked post-run learning review (off by default — extra LLM call). */
  review?: boolean;
  /** Context token budget for compaction (default: model window). */
  tokenBudget?: number;
  /**
   * Compress tool-result text before it re-enters context. `"lossless"` (default,
   * meaning-preserving) or `"off"`/`false` to disable. Set from the
   * `x-nexus-compress` request header at the API edge.
   */
  compressToolOutput?: PresetName | false;
  /** Resume an existing agent_sessions row (loads its messages, continues it). */
  sessionId?: string;
  /** Owning user id, persisted on a new session. */
  userId?: string;
  /**
   * Run inside an isolated git-worktree workspace (Phase 3). When set, the
   * coding tools are confined to a fresh worktree cut from `origin/<baseBranch>`
   * instead of `workspaceDir`. The branch is left for merge/PR unless
   * `archiveOnComplete` is set.
   */
  worktree?: {
    /** Main git checkout to cut the worktree from. */
    repoPath: string;
    /** Base branch to fork the worktree from (fetched first when an origin exists). */
    baseBranch: string;
    /** Workspace name (default: sessionId ?? taskId). Reused across resume. */
    name?: string;
    /** Override the created branch name (default `nexus/<name>`). */
    branch?: string;
    /** Run `.nexus/settings.toml` [scripts].setup before the agent. Default true. */
    runSetup?: boolean;
    /** Start `.nexus/settings.toml` [scripts].run for the duration of the agent run. Default false. */
    startRun?: boolean;
    /** Archive the workspace (remove dir, keep branch) after the run. Default false. */
    archiveOnComplete?: boolean;
    /** Override where worktrees live. */
    workspacesRoot?: string;
    /** First port to probe for the reserved range. */
    portBase?: number;
  };
}

/** Load prior messages for a session being resumed; [] if none/not found. */
async function loadSessionMessages(sessionId: string): Promise<RuntimeMessage[]> {
  try {
    const [row] = await db
      .select({ messages: agentSessions.messages })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1);
    return (row?.messages as RuntimeMessage[] | undefined) ?? [];
  } catch {
    return [];
  }
}

/** Persist the session's messages + status + usage (upsert by id). */
async function saveSession(
  sessionId: string,
  payload: AgentRunPayload,
  data: { status: string; messages: unknown[]; usage?: Record<string, number>; error?: string },
): Promise<void> {
  try {
    await db
      .insert(agentSessions)
      .values({
        id: sessionId,
        ...(payload.userId ? { userId: payload.userId } : {}),
        ...(payload.taskId ? { taskId: payload.taskId } : {}),
        instruction: payload.instruction ?? payload.prompt ?? payload.goal ?? null,
        status: data.status,
        messages: data.messages,
        ...(data.usage ? { usage: data.usage } : {}),
        ...(data.error ? { error: data.error } : {}),
      })
      .onConflictDoUpdate({
        target: agentSessions.id,
        set: {
          status: data.status,
          messages: data.messages,
          ...(data.usage ? { usage: data.usage } : {}),
          ...(data.error ? { error: data.error } : {}),
        },
      });
  } catch (e) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "agent.session_persist_failed",
        sessionId,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }
}

/** A summarizer for compaction: ask the LLM (no tools) for a digest of `messages`. */
function makeSummarizer(llm: LlmToolFn): (messages: RuntimeMessage[]) => Promise<string> {
  return async (messages) => {
    const transcript = messages
      .map((m) => `[${m.role}] ${m.content}`)
      .join("\n")
      .slice(0, 100_000); // bound the summarizer's own input
    const turn = await llm([{ role: "user", content: transcript }], {
      systemPrompt: COMPACTION_SUMMARY_PROMPT,
    });
    return turn.content;
  };
}

/**
 * Build the permission gate: the run's static policy layered over the shared
 * @nexus/governance safety net (§7.1). Read-only tools never reach here — the
 * runtime auto-allows them.
 */
function makePermissionGate(payload: AgentRunPayload) {
  return makeGovernanceGate({
    policy: payload.permissionPolicy ?? "allow",
    ...(payload.allowedTools ? { allowedTools: payload.allowedTools } : {}),
    ...(payload.disableGovernance ? {} : { engine: defaultAgentGovernanceEngine() }),
    onDeny: ({ tool, reason, layer }) =>
      console.log(
        JSON.stringify({
          level: "warn",
          event: "agent.permission_denied",
          taskId: payload.taskId,
          tool,
          layer,
          reason,
        }),
      ),
  });
}

/**
 * Provision (or reuse) a worktree workspace for this run. Idempotent across
 * resume: an active workspace of the same name is reused, an archived one is
 * restored, otherwise a fresh worktree is cut. Returns null when no worktree
 * was requested.
 */
async function provisionWorkspace(
  payload: AgentRunPayload,
): Promise<{ ws: Workspace; mgr: WorkspaceManager } | null> {
  const wt = payload.worktree;
  if (!wt?.repoPath) return null;
  const name = wt.name ?? payload.sessionId ?? payload.taskId;
  if (!name) throw new Error("worktree requires a name (or sessionId/taskId)");
  const mgr = new WorkspaceManager({
    repoPath: wt.repoPath,
    ...(wt.workspacesRoot ? { workspacesRoot: wt.workspacesRoot } : {}),
    ...(wt.portBase ? { portBase: wt.portBase } : {}),
  });
  const existing = await mgr.get(name);
  let ws: Workspace;
  if (existing && !existing.archived) ws = existing;
  else if (existing) ws = await mgr.restore(name);
  else
    ws = await mgr.create({
      name,
      baseBranch: wt.baseBranch,
      ...(wt.branch ? { branch: wt.branch } : {}),
    });
  return { ws, mgr };
}

/** Run the workspace's `.nexus` setup script to completion (bounded by a timeout). */
async function runSetupScript(
  ws: Workspace,
  settings: NexusSettings,
  taskId?: string,
): Promise<void> {
  const cmd = settings.scripts.setup;
  if (!cmd) return;
  await runScriptBounded({
    cwd: ws.path,
    env: ws.env,
    command: cmd,
    timeoutMs: SETUP_TIMEOUT_MS,
    onExit: (code) =>
      console.log(
        JSON.stringify({
          level: "info",
          event: "agent.workspace_setup",
          taskId,
          ws: ws.name,
          exit: code,
        }),
      ),
  });
}

/** Build a driver from the payload (BYOK), falling back to env keys. */
function makeDriver(payload: AgentRunPayload): LlmDriver {
  const provider = (payload.provider ?? process.env.AGENT_PROVIDER ?? "anthropic").toLowerCase();
  const model = payload.model;
  // BYOK env fallback per provider (mirrors apps/api getRegistry): the worker
  // only supported groq/openrouter/anthropic, so OpenAI (ChatGPT), Gemini and
  // DeepSeek role-agents could never run. Keys resolve payload-first, then the
  // matching server env key.
  const envKey =
    provider === "groq"
      ? process.env.GROQ_API_KEY
      : provider === "openrouter"
        ? process.env.OPENROUTER_API_KEY
        : provider === "openai"
          ? process.env.OPENAI_API_KEY
          : provider === "gemini"
            ? process.env.GEMINI_API_KEY
            : provider === "deepseek"
              ? process.env.DEEPSEEK_API_KEY
              : process.env.ANTHROPIC_API_KEY;
  const apiKey = payload.apiKey ?? envKey ?? "";
  // Fail fast with a clear error rather than deferring to an opaque 401.
  if (!apiKey) throw new Error(`missing_api_key (provider=${provider})`);
  switch (provider) {
    case "groq":
      return new GroqDriver({ apiKey, ...(model ? { model } : {}) });
    case "openrouter":
      return new OpenRouterDriver({ apiKey, ...(model ? { model } : {}) });
    case "openai":
      return new OpenAIDriver({ apiKey, ...(model ? { model } : {}) });
    case "gemini":
      return new GeminiDriver({ apiKey, ...(model ? { model } : {}) });
    case "deepseek":
      return new DeepSeekDriver({ apiKey, ...(model ? { model } : {}) });
    default:
      return new AnthropicDriver({ apiKey, ...(model ? { model } : {}) });
  }
}

export async function handleAgentRunJob(
  payload: AgentRunPayload,
): Promise<Record<string, unknown>> {
  const instruction = (payload.instruction ?? payload.prompt ?? payload.goal ?? "").trim();
  if (!instruction) return { ok: false, error: "no_instruction" };

  // Live telemetry: stream events to SSE clients via the Redis bridge. Scoped to
  // the run's sessionId/taskId; a no-op when neither is set or REDIS_URL is unset.
  const stream = payload.sessionId ?? payload.taskId;
  const emit = (
    type:
      | "run_started"
      | "step"
      | "compaction"
      | "status"
      | "learnings"
      | "learning_proposal"
      | "tool_compress",
    data: Record<string, unknown>,
  ): void => {
    if (stream) void publishAgentEvent(stream, type, data);
  };

  let driver: LlmDriver;
  try {
    driver = makeDriver(payload);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "driver_init_failed" };
  }
  // The real driver satisfies the loop's structural LlmToolDriver (native tools).
  const llm = llmDriverToToolFn(driver satisfies LlmToolDriver);

  // Phase 3: optionally run inside an isolated git-worktree workspace.
  let provisioned: { ws: Workspace; mgr: WorkspaceManager } | null;
  try {
    provisioned = await provisionWorkspace(payload);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "workspace_provision_failed" };
  }
  const workingDir = provisioned
    ? provisioned.ws.path
    : (payload.workspaceDir ?? process.env.AGENT_WORKSPACE ?? process.cwd());

  // Load the workspace's `.nexus/settings.toml` once for setup + run.
  const settings = provisioned ? await loadNexusSettings(provisioned.ws.path) : null;
  if (provisioned && settings && payload.worktree?.runSetup !== false) {
    await runSetupScript(provisioned.ws, settings, payload.taskId);
  }

  // Optionally start the long-lived run server for the duration of the agent run.
  const runner = new WorkspaceRunner();
  let runHandle: RunHandle | null = null;
  if (provisioned && settings && payload.worktree?.startRun) {
    runHandle = runner.start(provisioned.ws, settings);
    if (runHandle) {
      console.log(
        JSON.stringify({
          level: "info",
          event: "agent.workspace_run_started",
          taskId: payload.taskId,
          ws: provisioned.ws.name,
          url: runHandle.url,
        }),
      );
    }
  }

  const permissionGate = makePermissionGate(payload);

  const toolSet = createCodingToolSet({
    rootDir: workingDir,
    ...(provisioned ? { env: provisioned.ws.env } : {}),
  });
  if (payload.mcpServers?.length) {
    for (const tool of await mcpToolsFromServers(payload.mcpServers)) toolSet.add(tool);
  }
  // Built-in served deliberation tools (council protocols + converging debate)
  // driven by the same driver that runs the loop. Opt-out per job. Every
  // invocation leaves the pass-58 inspectable transcript as a JSON event.
  if (!payload.disableCouncilTools) {
    const transcriptHooks = {
      onTranscript: (transcript: CouncilTranscript) => {
        console.log(JSON.stringify(toolTranscriptEvent(payload.taskId, transcript)));
      },
    };
    // The driver already carries the run model (makeDriver sets it); complete()
    // without an explicit model falls back to that configured default.
    const complete = (
      messages: Array<{ role: string; content: string }>,
      opts?: { model?: string; maxTokens?: number; temperature?: number },
    ) =>
      driver.complete({
        // LlmRequestOptions.model is required; the driver carries the run model.
        model: opts?.model ?? driver.model,
        messages: messages.map((m) => ({ role: m.role as LlmRole, content: m.content })),
        ...(opts?.maxTokens ? { maxTokens: opts.maxTokens } : {}),
        ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
      });
    const councilTransport: ILLMTransport = {
      async chat(messages, options) {
        const res = await complete(messages, options);
        return {
          content: res.content,
          model: res.model,
          usage: { promptTokens: res.usage.inputTokens, completionTokens: res.usage.outputTokens },
          latencyMs: res.durationMs ?? 0,
        };
      },
    };
    for (const tool of await councilRuntimeToolsFromTransport(councilTransport, { hooks: transcriptHooks })) {
      toolSet.add(tool);
    }
    toolSet.add(
      debateRuntimeTool({
        transport: async (req) => {
          const res = await complete(req.messages as Array<{ role: string; content: string }>, {
            maxTokens: 1024,
            temperature: 0.7,
          });
          return res.content;
        },
        hooks: transcriptHooks,
      }),
    );
  }
  // PTC: let the model batch many tool calls in one script (intermediate
  // results stay out of context). Added last so it advertises every other tool;
  // gated by the same permission gate as direct calls.
  if (!payload.disablePtc) {
    toolSet.add(
      createProgrammaticToolTool({
        toolSet,
        permissionGate,
        ...(payload.ptcSandbox ? { sandbox: true } : {}),
      }),
    );
  }

  const compaction = payload.disableCompaction
    ? undefined
    : {
        summarize: makeSummarizer(llm),
        ...(payload.tokenBudget ? { tokenBudget: payload.tokenBudget } : {}),
      };

  // Resume: load prior conversation when a sessionId is supplied.
  const initialMessages = payload.sessionId ? await loadSessionMessages(payload.sessionId) : [];

  const runtime = new ToolAgentRuntime({
    llm,
    toolSet,
    permissionGate,
    workingDir,
    ...(initialMessages.length ? { initialMessages } : {}),
    ...(compaction ? { compaction } : {}),
    ...(payload.sessionId
      ? { sessionId: payload.sessionId }
      : payload.taskId
        ? { sessionId: payload.taskId }
        : {}),
    ...(payload.systemPrompt ? { systemPrompt: payload.systemPrompt } : {}),
    ...(payload.maxSteps ? { maxSteps: payload.maxSteps } : {}),
    ...(payload.compressToolOutput !== undefined
      ? { compressToolOutput: payload.compressToolOutput }
      : {}),
    onToolCompress: (info: { tool: string; savedTokens: number; applied: string[] }): void => {
      console.log(
        JSON.stringify({
          level: "info",
          event: "agent.tool_compress",
          taskId: payload.taskId,
          ...info,
        }),
      );
      emit("tool_compress", info);
    },
    onCompaction: (info: CompactionResult): void => {
      const data = {
        summarized: info.summarizedCount,
        preTokens: info.preTokens,
        postTokens: info.postTokens,
      };
      console.log(
        JSON.stringify({
          level: "info",
          event: "agent.compaction",
          taskId: payload.taskId,
          ...data,
        }),
      );
      emit("compaction", data);
    },
    onStep: (step: ToolStepRecord): void => {
      const data = {
        stepIndex: step.stepIndex,
        toolCalls: step.toolCalls.map((c) => c.name),
        usage: step.usage,
      };
      console.log(
        JSON.stringify({ level: "info", event: "agent.step", taskId: payload.taskId, ...data }),
      );
      emit("step", data);
    },
  });

  emit("run_started", { instruction: instruction.slice(0, 200), ...(stream ? { stream } : {}) });

  let result;
  try {
    result = await runtime.run(instruction);
  } catch (e) {
    emit("status", { status: "error", error: e instanceof Error ? e.message : String(e) });
    if (payload.sessionId) {
      await saveSession(payload.sessionId, payload, {
        status: "error",
        messages: initialMessages,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    throw e;
  } finally {
    // Tear down the run server (SIGHUP→SIGKILL) on both success and failure.
    if (runHandle) await runner.stop(runHandle.key);
  }

  // Distinguish a context-budget hard stop (§7.1) from a normal completion/abort.
  const sessionStatus = result.stopReason
    ? "rate_limited"
    : result.aborted
      ? "aborted"
      : "completed";
  emit("status", {
    status: sessionStatus,
    steps: result.steps.length,
    usage: result.totalUsage,
    ...(result.stopReason ? { stopReason: result.stopReason } : {}),
  });

  // Forked learning loop (opt-in): a non-blocking post-run review extracts
  // durable learnings and streams them as `agent.learnings`. Best-effort —
  // detached so it never delays or fails the run.
  if (payload.review) {
    const runMessages = result.messages;
    void (async () => {
      try {
        const learnings = await reviewSession(runMessages, llm);
        // Always emit (even []) so streaming clients have a reliable terminal signal.
        emit("learnings", { learnings });
        console.log(
          JSON.stringify({
            level: "info",
            event: "agent.learnings",
            taskId: payload.taskId,
            count: learnings.length,
          }),
        );

        // §7.3 — forked learning loop: propose (never apply) a MEMORY.md / skills
        // diff off the learnings + the warm on-disk copy. Emitted for human review;
        // nothing is written to disk here. Best-effort — a missing MEMORY.md just
        // yields a new-file proposal.
        if (learnings.length > 0) {
          const readIfExists = async (rel: string): Promise<string> => {
            try {
              return await readFile(join(workingDir, rel), "utf8");
            } catch {
              return "";
            }
          };
          const proposals = proposeLearningUpdates(learnings, {
            memory: await readIfExists("MEMORY.md"),
            skills: await readIfExists("SKILLS.md"),
          });
          emit("learning_proposal", { proposals });
          console.log(
            JSON.stringify({
              level: "info",
              event: "agent.learning_proposal",
              taskId: payload.taskId,
              files: proposals.map((p) => p.path),
            }),
          );
        }

        // Persist learnings to the memory vector store so they are
        // retrieved on future runs (best-effort — env-gated, never
        // blocks or fails the review).
        if (learnings.length > 0 && process.env.GROQ_API_KEY && process.env.DATABASE_URL) {
          try {
            const memStore = new PgVectorStore({ databaseUrl: process.env.DATABASE_URL });
            const embedder = (() => {
              try {
                return createBestEmbedder();
              } catch {
                return new FixedEmbedder(768);
              }
            })();
            const memManager = new MemoryManager({ store: memStore, embedder });
            for (const learning of learnings) {
              try {
                await memManager.remember(learning.content, {
                  metadata: {
                    learningType: learning.type,
                    agentId: payload.sessionId ?? payload.taskId ?? "unknown",
                    taskId: payload.taskId ?? null,
                    source: "agent-review",
                  },
                });
              } catch (persistErr) {
                console.error(
                  JSON.stringify({
                    level: "error",
                    event: "agent.learning_persist_failed",
                    taskId: payload.taskId,
                    learningType: learning.type,
                    error: persistErr instanceof Error ? persistErr.message : String(persistErr),
                  }),
                );
              }
            }
          } catch (initErr) {
            console.error(
              JSON.stringify({
                level: "error",
                event: "agent.memory_init_failed",
                taskId: payload.taskId,
                error: initErr instanceof Error ? initErr.message : String(initErr),
              }),
            );
          }
        }
      } catch (e) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "agent.review_failed",
            taskId: payload.taskId,
            error: e instanceof Error ? e.message : String(e),
          }),
        );
      }
    })();
  }

  // Merge-gating "checks" — computed while the worktree still exists (before archive).
  const checks = provisioned ? await collectChecks(provisioned.ws) : undefined;

  // Persist the session so it can be resumed (only when a sessionId is given).
  if (payload.sessionId) {
    await saveSession(payload.sessionId, payload, {
      status: sessionStatus,
      messages: result.messages,
      usage: {
        inputTokens: result.totalUsage.inputTokens,
        outputTokens: result.totalUsage.outputTokens,
        totalTokens: result.totalUsage.totalTokens,
      },
    });
  }

  // Phase 3: archive the workspace (remove dir, keep branch) when requested.
  if (provisioned && payload.worktree?.archiveOnComplete) {
    await provisioned.mgr.archive(provisioned.ws.name).catch((e) =>
      console.error(
        JSON.stringify({
          level: "error",
          event: "agent.workspace_archive_failed",
          ws: provisioned!.ws.name,
          error: e instanceof Error ? e.message : String(e),
        }),
      ),
    );
  }

  return {
    ok: !result.aborted,
    sessionId: payload.sessionId,
    finalContent: result.finalContent,
    steps: result.steps.length,
    aborted: result.aborted,
    usage: result.totalUsage,
    durationMs: result.totalDurationMs,
    ...(provisioned
      ? {
          workspace: {
            name: provisioned.ws.name,
            path: provisioned.ws.path,
            branch: provisioned.ws.branch,
            baseBranch: provisioned.ws.baseBranch,
            ports: provisioned.ws.ports,
            ...(checks ? { checks } : {}),
            ...(runHandle ? { run: { url: runHandle.url, port: runHandle.port } } : {}),
          },
        }
      : {}),
  };
}
