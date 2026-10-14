// SPDX-License-Identifier: Apache-2.0
// `nexus security check`: the server's security check as a table, failing the shell on a gap.

import { styleText } from "node:util";

import type { Command } from "commander";

import { api, fail } from "./client.ts";

interface PostureCheck {
  id: string;
  title: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  fix: string;
}

const MARK = { pass: ["green", "✓"], warn: ["yellow", "!"], fail: ["red", "✗"] } as const;

/** Lines to print for a posture report; `all` includes passing checks. */
export function renderPosture(checks: PostureCheck[], all = false): string[] {
  const lines: string[] = [];
  for (const c of checks) {
    if (c.status === "pass" && !all) continue;
    const [color, mark] = MARK[c.status];
    lines.push(`${styleText(color, mark)} ${c.title}`);
    if (c.status !== "pass") {
      lines.push(`    ${c.detail}`);
      lines.push(`    ${styleText("dim", `fix: ${c.fix}`)}`);
    }
  }
  const n = (s: PostureCheck["status"]) => checks.filter((c) => c.status === s).length;
  lines.push(`${n("pass")} passed, ${n("warn")} warnings, ${n("fail")} failed`);
  return lines;
}

export function registerSecurityCommands(program: Command): void {
  const security = program.command("security").description("Deployment security");
  security
    .command("check")
    .description("Report settings that leave this deployment open (admin only)")
    .option("--all", "Also list the checks that pass")
    .action(async (opts: { all?: boolean }) => {
      try {
        const { checks } = await api.get<{ checks: PostureCheck[] }>("/admin/security/posture");
        for (const line of renderPosture(checks, opts.all)) console.log(line);
        if (checks.some((c) => c.status === "fail")) process.exitCode = 1;
      } catch (err) {
        fail(err);
      }
    });
}
