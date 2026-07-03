// SPDX-License-Identifier: Apache-2.0
/**
 * Governance-backed permission gate for the coding agent (§7.1).
 *
 * The runtime auto-allows read-only tools (`AUTO_ALLOWED_TOOLS`) and only consults
 * the gate for MUTATING tools. This gate layers two checks for those:
 *   1. the run's static policy (allow | deny | allowlist), then
 *   2. @nexus/governance `GovernanceEngine.evaluateTask` — a shared safety net that
 *      blocks dangerous/over-scoped operations and flags ones needing approval.
 * A tool runs only if BOTH pass. Denials are surfaced back to the model as a tool
 * error so the loop adapts instead of crashing. Kept dependency-light (no db) so
 * it is unit-testable in isolation.
 */
import type { PermissionDecision, PermissionGate, PermissionRequest } from "@nexus/agent-runtime";
import { GovernanceEngine, type ITaskSynthesisResult } from "@nexus/governance";

/** Shell fragments that make a command destructive/exfiltrating enough to gate. */
const DANGEROUS_CMD =
  /\b(rm\s+-rf|sudo\b|mkfs|dd\s+if=|shutdown\b|reboot\b|:\(\)\s*\{|chmod\s+-R\s+777)\b|(curl|wget)\b[^|]*\|\s*(sh|bash)|git\s+push\b[^\n]*--force/i;

/** Heuristic: does this mutating tool call look dangerous enough to require approval? */
export function isDangerousToolCall(req: PermissionRequest): boolean {
  const name = req.toolName.toLowerCase();
  if (name.includes("delete") || name === "rm") return true;
  if (
    name.includes("command") ||
    name.includes("shell") ||
    name.includes("bash") ||
    name === "run_command"
  ) {
    const cmd = String(req.args.command ?? req.args.cmd ?? req.args.script ?? "");
    return DANGEROUS_CMD.test(cmd);
  }
  return false;
}

/** Map a tool-permission request onto the governance engine's task shape. */
export function toGovernanceTask(req: PermissionRequest): ITaskSynthesisResult {
  return {
    taskId: req.toolCallId ?? `tool:${req.toolName}`,
    toolName: req.toolName,
    action: req.toolName,
    arguments: req.args,
    dependencies: [],
    priority: "medium",
    governanceMetadata: { dangerous: isDangerousToolCall(req) },
  };
}

export interface GovernanceGateOptions {
  /** Static policy applied before governance. Default "allow". */
  policy?: "allow" | "deny" | "allowlist";
  /** Tools permitted when policy is "allowlist". */
  allowedTools?: string[];
  /** Governance engine; when omitted, only the static policy is enforced. */
  engine?: GovernanceEngine;
  /** Notified on every denial (telemetry/audit). */
  onDeny?: (info: { tool: string; reason: string; layer: "policy" | "governance" }) => void;
}

/**
 * Build the permission gate. The returned gate is async because governance
 * evaluation is; the runtime already awaits gate decisions.
 */
export function makeGovernanceGate(opts: GovernanceGateOptions = {}): PermissionGate {
  const policy = opts.policy ?? "allow";
  const allowed = new Set(opts.allowedTools ?? []);

  return async (req: PermissionRequest): Promise<PermissionDecision> => {
    // 1. Static policy.
    const policyAllows =
      policy === "deny" ? false : policy === "allowlist" ? allowed.has(req.toolName) : true;
    if (!policyAllows) {
      const reason = `policy '${policy}' blocked tool '${req.toolName}'`;
      opts.onDeny?.({ tool: req.toolName, reason, layer: "policy" });
      return { allowed: false, reason };
    }

    // 2. Governance safety net (when an engine is supplied).
    if (opts.engine) {
      const verdict = await opts.engine.evaluateTask(toGovernanceTask(req));
      if (!verdict.allowed) {
        const reason = verdict.reason ?? "blocked by governance";
        opts.onDeny?.({ tool: req.toolName, reason, layer: "governance" });
        return { allowed: false, reason };
      }
      if (verdict.requiresApproval) {
        // No interactive approver in the worker → a run that needs approval is denied.
        const reason = `tool '${req.toolName}' requires approval (dangerous operation)`;
        opts.onDeny?.({ tool: req.toolName, reason, layer: "governance" });
        return { allowed: false, reason };
      }
    }

    return { allowed: true };
  };
}

/** Default governance engine for agent runs (unless disabled per-run). */
export function defaultAgentGovernanceEngine(): GovernanceEngine {
  return GovernanceEngine.withDefaults();
}
