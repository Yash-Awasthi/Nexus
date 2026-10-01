// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/exec-policy — what Nexus is allowed to execute, decided the same way
 * every time.
 *
 * Nexus runs processes and code on several surfaces, and until now each one
 * carried its own ad-hoc guard: a loopback check here, a command-name regex
 * there. None of them could answer "is this specific action allowed" in a way
 * an operator could read, configure, or audit, and none of them could stop and
 * ask a human.
 *
 * This module answers that question and nothing else. It performs no I/O, holds
 * no state, and never executes anything: it takes a described action and
 * returns allow, ask, or deny with the rule that decided it. The surfaces bring
 * their own approval plumbing (see `apps/api/src/lib/exec-approvals.ts`), which
 * is what keeps the decision testable in isolation.
 *
 * Two rules govern the rules themselves:
 *
 *   Deny wins. A denied action is never promoted by an allow rule, however
 *   specific, because the deny list is where the operator writes the things
 *   that must not happen regardless of who asked.
 *
 *   Unknown follows the surface. An action that matches nothing falls back to
 *   that surface's default (SURFACE_DEFAULTS), which is `ask` for anything that
 *   starts a process on the host. The defaults are stated in one table with
 *   their reasoning rather than scattered through the branches, because a
 *   fallback nobody can find is how a gate stops gating.
 */

/** How much the operator trusts this deployment to act without being asked. */
export type PermissionMode =
  /** Nothing executes. Every action is denied, including read-only ones. */
  | "readonly"
  /** Read-only actions run; anything else needs a human. The default. */
  | "ask"
  /** Allowlisted actions run unasked; everything else still asks. */
  | "trusted";

export type Decision = "allow" | "ask" | "deny";

/** The surfaces that can execute something. Named so a rule can target one. */
export type ExecSurface = "pty" | "sandbox" | "repl" | "tool";

/**
 * What an uncovered action does on each surface, and why they differ.
 *
 * `pty` starts a process on the machine the API runs on, with that machine's
 * filesystem, network and credentials: an uncovered command there is the case
 * a human should see.
 *
 * `sandbox` and `repl` run inside an isolated runtime — Pyodide, a child Node
 * under the permission model, a `vm` context, or a remote Piston. Stopping for
 * each cell would make the feature unusable and teach operators to approve
 * without reading. **Node's `vm` is not a security boundary**; what this
 * default says is that the isolation, not a prompt, is the control there.
 * `@nexus/sandbox` is a plain child process with none of that isolation, so
 * its callers (skills, mission shell) gate it as `pty`, never as `sandbox`. An operator who disagrees raises the surface
 * with NEXUS_EXEC_ASK_SURFACES, or shuts it off entirely with readonly mode.
 *
 * `tool` is an in-process call into Nexus's own surface, already behind
 * authentication and the per-route guards; gating every one of them would
 * approve nothing new.
 *
 * Deny rules and readonly mode apply to every surface regardless.
 */
const SURFACE_DEFAULTS: Readonly<Record<ExecSurface, Decision>> = {
  pty: "ask",
  sandbox: "allow",
  repl: "allow",
  tool: "allow",
};

export interface ExecAction {
  surface: ExecSurface;
  /** Program name for a process, tool name for a tool call. */
  command: string;
  args?: readonly string[];
  /** Working directory, when the surface has one. */
  cwd?: string;
}

export interface PolicyRule {
  /** Shown to the operator and recorded with the decision. */
  id: string;
  /** Matches this surface only, or every surface when absent. */
  surface?: ExecSurface;
  /** Command name this rule is about. `*` matches any command. */
  command: string;
  /**
   * Every entry must appear among the action's arguments, as a whole token.
   * Absent means the rule matches on the command alone.
   */
  args?: readonly string[];
  reason: string;
}

export interface PolicyConfig {
  mode: PermissionMode;
  /** Surfaces raised to `ask`, whatever their default. */
  askSurfaces?: readonly ExecSurface[];
  /** Operator additions, evaluated after the built-ins. */
  allow?: readonly PolicyRule[];
  deny?: readonly PolicyRule[];
  /**
   * Absolute paths an action may run in. An action with a `cwd` outside all of
   * them is denied. Empty means the working directory is not constrained.
   */
  workspaceRoots?: readonly string[];
}

export interface PolicyDecision {
  decision: Decision;
  /** The rule that decided, or a built-in reason such as `mode:readonly`. */
  rule: string;
  reason: string;
}

/**
 * Commands that read and do not change anything. These are the actions a
 * deployment in `ask` mode still runs without a human, because stopping for
 * them trains an operator to approve without reading.
 */
const READ_ONLY_COMMANDS: readonly PolicyRule[] = [
  { id: "builtin:ls", command: "ls", reason: "Lists a directory." },
  { id: "builtin:pwd", command: "pwd", reason: "Prints the working directory." },
  { id: "builtin:cat", command: "cat", reason: "Prints a file." },
  { id: "builtin:head", command: "head", reason: "Prints the start of a file." },
  { id: "builtin:tail", command: "tail", reason: "Prints the end of a file." },
  { id: "builtin:grep", command: "grep", reason: "Searches file contents." },
  { id: "builtin:rg", command: "rg", reason: "Searches file contents." },
  { id: "builtin:find", command: "find", reason: "Lists matching paths." },
  { id: "builtin:wc", command: "wc", reason: "Counts lines and words." },
  { id: "builtin:git-status", command: "git", args: ["status"], reason: "Reads repository state." },
  { id: "builtin:git-log", command: "git", args: ["log"], reason: "Reads repository history." },
  { id: "builtin:git-diff", command: "git", args: ["diff"], reason: "Reads uncommitted changes." },
];

/**
 * Actions that are refused in every mode.
 *
 * The list is deliberately short and specific. A long list of guesses reads as
 * safety and is not: what it produces is a false sense that anything absent
 * from it is fine, when the real backstop is that unknown actions ask.
 */
const DENIED_ACTIONS: readonly PolicyRule[] = [
  {
    id: "builtin:deny-history-rewrite",
    command: "git",
    args: ["push", "--force"],
    reason: "Force-pushing rewrites history that other people already have.",
  },
  {
    id: "builtin:deny-hard-reset",
    command: "git",
    args: ["reset", "--hard"],
    reason: "Discards uncommitted work with no copy kept anywhere.",
  },
  {
    id: "builtin:deny-clean",
    command: "git",
    args: ["clean", "-fdx"],
    reason: "Deletes untracked and ignored files, including local environment files.",
  },
  {
    id: "builtin:deny-shutdown",
    command: "shutdown",
    reason: "Stops the machine the API runs on.",
  },
  { id: "builtin:deny-reboot", command: "reboot", reason: "Restarts the machine." },
  {
    id: "builtin:deny-mkfs",
    command: "mkfs",
    reason: "Formats a filesystem.",
  },
  {
    id: "builtin:deny-dd",
    command: "dd",
    reason: "Writes raw blocks; a wrong argument destroys a disk.",
  },
];

/**
 * The program a command names, however it was spelled: `/sbin/shutdown`,
 * `C:\Windows\System32\shutdown.EXE` and `shutdown` are one program, so a rule
 * written for one must catch the others.
 */
function programName(command: string): string {
  const base = command.split(/[\\/]/).pop() ?? command;
  return base.replace(/\.(exe|cmd|bat|com)$/i, "").toLowerCase();
}

/** A rule matches when its surface, its command and every listed argument do. */
export function ruleMatches(rule: PolicyRule, action: ExecAction): boolean {
  if (rule.surface && rule.surface !== action.surface) return false;
  if (rule.command !== "*" && programName(rule.command) !== programName(action.command))
    return false;
  if (!rule.args || rule.args.length === 0) return true;
  // Whole tokens, never substrings: `--force-with-lease` must not satisfy a
  // rule written for `--force`.
  const args = action.args ?? [];
  return rule.args.every((needle) => args.includes(needle));
}

function firstMatch(
  rules: readonly PolicyRule[] | undefined,
  action: ExecAction,
): PolicyRule | undefined {
  return rules?.find((rule) => ruleMatches(rule, action));
}

/** True when `child` is `root` or sits inside it, comparing whole segments. */
export function isInside(root: string, child: string): boolean {
  const normalise = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const r = normalise(root);
  const c = normalise(child);
  return c === r || c.startsWith(`${r}/`);
}

/**
 * Decide one action. Order is fixed and not configurable: deny rules, then the
 * workspace boundary, then the mode, then allow rules, then ask.
 */
export function decide(action: ExecAction, config: PolicyConfig): PolicyDecision {
  const denied = firstMatch(DENIED_ACTIONS, action) ?? firstMatch(config.deny, action);
  if (denied) {
    return { decision: "deny", rule: denied.id, reason: denied.reason };
  }

  const roots = config.workspaceRoots ?? [];
  if (action.cwd && roots.length > 0 && !roots.some((root) => isInside(root, action.cwd!))) {
    return {
      decision: "deny",
      rule: "builtin:workspace-boundary",
      reason: `Working directory ${action.cwd} is outside every configured workspace root.`,
    };
  }

  if (config.mode === "readonly") {
    return {
      decision: "deny",
      rule: "mode:readonly",
      reason: "This deployment runs in readonly mode: nothing executes.",
    };
  }

  const readOnly = firstMatch(READ_ONLY_COMMANDS, action);
  if (readOnly) {
    return { decision: "allow", rule: readOnly.id, reason: readOnly.reason };
  }

  if (config.mode === "trusted") {
    const allowed = firstMatch(config.allow, action);
    if (allowed) return { decision: "allow", rule: allowed.id, reason: allowed.reason };
  }

  const raised = config.askSurfaces?.includes(action.surface) ?? false;
  const fallback = raised ? "ask" : SURFACE_DEFAULTS[action.surface];
  if (fallback === "allow") {
    return {
      decision: "allow",
      rule: `builtin:surface-default:${action.surface}`,
      reason: `The ${action.surface} surface runs uncovered actions by default (see SURFACE_DEFAULTS).`,
    };
  }

  return {
    decision: "ask",
    rule: "builtin:unknown",
    reason: `Nothing in the policy covers ${action.command} on the ${action.surface} surface.`,
  };
}

/** Parse `name` or `name:arg1,arg2` entries from an environment variable. */
export function parseRules(raw: string | undefined, prefix: string): PolicyRule[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, index) => {
      const [command = "", argPart] = entry.split(":");
      const args = argPart
        ? argPart
            .split(/\s+/)
            .map((a) => a.trim())
            .filter(Boolean)
        : [];
      return {
        id: `${prefix}:${index}:${command}`,
        command,
        ...(args.length > 0 ? { args } : {}),
        reason: `Configured by the operator (${prefix}).`,
      };
    });
}

const MODES: readonly PermissionMode[] = ["readonly", "ask", "trusted"];

/**
 * Build the policy from the environment. An unset or unrecognised mode is
 * `ask`: a typo must not silently widen what a deployment will run.
 */
export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): PolicyConfig {
  const raw = env.NEXUS_EXEC_MODE?.trim().toLowerCase();
  const mode = MODES.find((m) => m === raw) ?? "ask";
  const surfaces: readonly ExecSurface[] = ["pty", "sandbox", "repl", "tool"];
  return {
    mode,
    askSurfaces: (env.NEXUS_EXEC_ASK_SURFACES ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s): s is ExecSurface => surfaces.includes(s as ExecSurface)),
    allow: parseRules(env.NEXUS_EXEC_ALLOW, "allow"),
    deny: parseRules(env.NEXUS_EXEC_DENY, "deny"),
    workspaceRoots: (env.NEXUS_EXEC_ROOTS ?? "")
      .split(/[;,]/)
      .map((p) => p.trim())
      .filter(Boolean),
  };
}
