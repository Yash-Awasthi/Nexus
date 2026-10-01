// SPDX-License-Identifier: Apache-2.0
/**
 * The decision table. Each test states one rule of the policy, because the
 * order these are applied in is the whole contract: an allow rule that can
 * overturn a deny, or an unknown action that falls through to allow, is a gate
 * that does not gate.
 */
import { describe, it, expect } from "vitest";

import {
  decide,
  isInside,
  parseRules,
  policyFromEnv,
  ruleMatches,
  type ExecAction,
  type PolicyConfig,
} from "../src/index.js";

const ask: PolicyConfig = { mode: "ask" };

function action(command: string, args: string[] = [], extra: Partial<ExecAction> = {}): ExecAction {
  return { surface: "pty", command, args, ...extra };
}

describe("deny wins", () => {
  it("refuses a built-in denied action in every mode", () => {
    for (const mode of ["ask", "trusted"] as const) {
      const result = decide(action("git", ["push", "--force"]), { mode });

      expect(result.decision).toBe("deny");
      expect(result.rule).toBe("builtin:deny-history-rewrite");
    }
  });

  it("is not overturned by an operator allow rule for the same command", () => {
    const result = decide(action("git", ["push", "--force"]), {
      mode: "trusted",
      allow: [{ id: "op:git", command: "git", reason: "Trusted." }],
    });

    expect(result.decision).toBe("deny");
  });

  it("catches a denied program however its path or extension is spelled", () => {
    for (const cmd of ["/sbin/shutdown", "C:\\Windows\\System32\\SHUTDOWN.exe", "shutdown.cmd"]) {
      const result = decide(action(cmd), {
        mode: "trusted",
        allow: [{ id: "op:any", command: "*", reason: "Trusted." }],
      });
      expect(result.decision, cmd).toBe("deny");
      expect(result.rule).toBe("builtin:deny-shutdown");
    }
    const allowed = decide(action("/usr/local/bin/node"), {
      mode: "trusted",
      allow: [{ id: "op:node", command: "node", reason: "Trusted." }],
    });
    expect(allowed.decision).toBe("allow");
  });

  it("matches whole argument tokens, not substrings", () => {
    // --force-with-lease is the safe form and must not hit the --force rule.
    const result = decide(action("git", ["push", "--force-with-lease"]), ask);

    expect(result.decision).not.toBe("deny");
  });

  it("applies an operator deny rule", () => {
    const result = decide(action("kubectl", ["delete"]), {
      mode: "trusted",
      deny: [{ id: "op:kubectl", command: "kubectl", reason: "Production cluster." }],
      allow: [{ id: "op:any", command: "*", reason: "Trusted." }],
    });

    expect(result.decision).toBe("deny");
    expect(result.rule).toBe("op:kubectl");
  });
});

describe("modes", () => {
  it("readonly refuses even a read-only command", () => {
    const result = decide(action("ls"), { mode: "readonly" });

    expect(result.decision).toBe("deny");
    expect(result.rule).toBe("mode:readonly");
  });

  it("ask runs read-only commands without a human", () => {
    expect(decide(action("ls"), ask).decision).toBe("allow");
    expect(decide(action("git", ["status"]), ask).decision).toBe("allow");
  });

  it("ask stops for anything else, even with an allow rule configured", () => {
    const result = decide(action("npm", ["install"]), {
      mode: "ask",
      allow: [{ id: "op:npm", command: "npm", reason: "Usual build step." }],
    });

    expect(result.decision).toBe("ask");
  });

  it("trusted runs what the operator allowlisted", () => {
    const result = decide(action("npm", ["install"]), {
      mode: "trusted",
      allow: [{ id: "op:npm", command: "npm", args: ["install"], reason: "Usual build step." }],
    });

    expect(result.decision).toBe("allow");
    expect(result.rule).toBe("op:npm");
  });

  it("trusted still asks for what nothing covers", () => {
    const result = decide(action("terraform", ["apply"]), {
      mode: "trusted",
      allow: [{ id: "op:npm", command: "npm", reason: "Usual build step." }],
    });

    expect(result.decision).toBe("ask");
    expect(result.rule).toBe("builtin:unknown");
  });
});

describe("surfaces", () => {
  it("keeps a rule to the surface it names", () => {
    const config: PolicyConfig = {
      mode: "trusted",
      allow: [{ id: "op:node", surface: "sandbox", command: "node", reason: "Sandbox only." }],
    };

    expect(decide({ surface: "sandbox", command: "node" }, config).decision).toBe("allow");
    expect(decide({ surface: "pty", command: "node" }, config).decision).toBe("ask");
  });

  it("applies a rule with no surface everywhere", () => {
    const rule = { id: "op:any", command: "node", reason: "Anywhere." };

    expect(ruleMatches(rule, { surface: "pty", command: "node" })).toBe(true);
    expect(ruleMatches(rule, { surface: "tool", command: "node" })).toBe(true);
  });
});

describe("workspace boundary", () => {
  it("refuses a working directory outside every root", () => {
    const result = decide(action("ls", [], { cwd: "/etc" }), {
      mode: "trusted",
      workspaceRoots: ["/home/user/project"],
    });

    expect(result.decision).toBe("deny");
    expect(result.rule).toBe("builtin:workspace-boundary");
  });

  it("allows a directory inside a root", () => {
    const result = decide(action("ls", [], { cwd: "/home/user/project/src" }), {
      mode: "ask",
      workspaceRoots: ["/home/user/project"],
    });

    expect(result.decision).toBe("allow");
  });

  it("compares whole path segments", () => {
    expect(isInside("/home/user/project", "/home/user/project-secrets")).toBe(false);
    expect(isInside("/home/user/project", "/home/user/project")).toBe(true);
    expect(isInside("C:\\work\\repo", "C:/work/repo/src")).toBe(true);
  });

  it("leaves the directory unconstrained when no root is configured", () => {
    const result = decide(action("ls", [], { cwd: "/etc" }), ask);

    expect(result.decision).toBe("allow");
  });
});

describe("policy from the environment", () => {
  it("falls back to ask on an unset or misspelled mode", () => {
    expect(policyFromEnv({}).mode).toBe("ask");
    expect(policyFromEnv({ NEXUS_EXEC_MODE: "trustd" }).mode).toBe("ask");
  });

  it("reads the three modes", () => {
    expect(policyFromEnv({ NEXUS_EXEC_MODE: "readonly" }).mode).toBe("readonly");
    expect(policyFromEnv({ NEXUS_EXEC_MODE: " Trusted " }).mode).toBe("trusted");
  });

  it("parses command and command-with-arguments entries", () => {
    const rules = parseRules("npm:install ci, pnpm, git:status", "allow");

    expect(rules).toHaveLength(3);
    expect(rules[0]?.command).toBe("npm");
    expect(rules[0]?.args).toEqual(["install", "ci"]);
    expect(rules[1]?.args).toBeUndefined();
    expect(rules[2]?.command).toBe("git");
  });

  it("builds a usable policy end to end", () => {
    const config = policyFromEnv({
      NEXUS_EXEC_MODE: "trusted",
      NEXUS_EXEC_ALLOW: "pnpm:install",
      NEXUS_EXEC_DENY: "curl",
      NEXUS_EXEC_ROOTS: "/srv/nexus",
    });

    expect(decide(action("pnpm", ["install"], { cwd: "/srv/nexus" }), config).decision).toBe(
      "allow",
    );
    expect(decide(action("curl", ["http://example.test"]), config).decision).toBe("deny");
    expect(decide(action("pnpm", ["install"], { cwd: "/tmp" }), config).decision).toBe("deny");
  });
});

describe("surface defaults", () => {
  it("asks for an uncovered command on the host", () => {
    expect(decide({ surface: "pty", command: "npm" }, ask).decision).toBe("ask");
  });

  it("runs an uncovered action inside an isolated runtime", () => {
    expect(decide({ surface: "sandbox", command: "python" }, ask).decision).toBe("allow");
    expect(decide({ surface: "repl", command: "python" }, ask).decision).toBe("allow");
    expect(decide({ surface: "tool", command: "council_deliberate" }, ask).decision).toBe("allow");
  });

  it("lets an operator raise a surface to ask", () => {
    const config: PolicyConfig = { mode: "ask", askSurfaces: ["sandbox"] };

    expect(decide({ surface: "sandbox", command: "python" }, config).decision).toBe("ask");
    expect(decide({ surface: "repl", command: "python" }, config).decision).toBe("allow");
  });

  it("reads the raised surfaces from the environment, ignoring unknown names", () => {
    const config = policyFromEnv({ NEXUS_EXEC_ASK_SURFACES: "sandbox, nonsense , tool" });

    expect(config.askSurfaces).toEqual(["sandbox", "tool"]);
  });

  it("keeps readonly and deny rules above every surface default", () => {
    expect(decide({ surface: "sandbox", command: "python" }, { mode: "readonly" }).decision).toBe(
      "deny",
    );
    expect(
      decide(
        { surface: "tool", command: "delete_everything" },
        { mode: "trusted", deny: [{ id: "op:no", command: "delete_everything", reason: "No." }] },
      ).decision,
    ).toBe("deny");
  });
});
