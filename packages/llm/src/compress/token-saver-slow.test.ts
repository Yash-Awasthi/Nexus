// SPDX-License-Identifier: Apache-2.0
/** Tool output can hold one very long line; no processor may go superlinear on it. */
import { expect, it } from "vite-plus/test";

import { defaultOutputProcessors } from "./token-saver.ts";

// Shared CI runners are several times slower; quadratic work still blows past this.
const BUDGET_MS = process.env["CI"] ? 600 : 100;

const COMMANDS = [
  "pytest",
  "npm test",
  "eslint .",
  "ruff check .",
  "go vet ./...",
  "tsc --noEmit",
  "git diff --stat",
  "git log",
  "git status",
  "git blame a.ts",
  "git push",
  "npm audit",
  "npm run build",
  "cargo clippy",
  "kubectl get pods",
  "docker compose up",
  "docker build .",
  "terraform plan",
  "grep -rn x .",
  "ls -la",
  "cat a.ts",
];
const N = 1500;
const SHAPES = [
  "=".repeat(N) + "x",
  " ".repeat(N) + "x",
  "\t".repeat(N) + "!",
  "1:1 error " + " ".repeat(N) + "\n",
  "a:1:1: " + "(".repeat(N),
  " ".repeat(N) + "| 1" + " ".repeat(N) + "x",
  "a" + " a".repeat(N) + " | x",
  "/".repeat(N) + "!",
  "0".repeat(N) + "x",
  "a".repeat(N) + "!",
  "_a".repeat(N) + "!",
  "1".repeat(N) + " x",
];
const input = (shape: string) => Array.from({ length: 3 }, () => shape).join("\n");

it.each(defaultOutputProcessors.map((p) => [p.name, p] as const))(
  "%s stays fast on long hostile lines",
  (_name, processor) => {
    const slow: string[] = [];
    // Timings on a shared runner are one-sided noisy: another job's CPU steals a
    // slice and a single call reads as a spike. Take the fastest of three passes
    // (after a warm-up, so the first call's JIT cost is not measured as work), and
    // the number reflects the processor rather than the machine's mood. Quadratic
    // work is slow in every pass, so nothing is hidden by this.
    for (const command of COMMANDS) {
      for (const shape of SHAPES) processor.process(command, input(shape));
    }
    for (const command of COMMANDS) {
      for (const [i, shape] of SHAPES.entries()) {
        let best = Number.POSITIVE_INFINITY;
        for (let pass = 0; pass < 3; pass++) {
          const t = performance.now();
          processor.process(command, input(shape));
          best = Math.min(best, performance.now() - t);
        }
        if (best > BUDGET_MS) slow.push(`${command} #${i} ${Math.round(best)}ms`);
      }
    }
    expect(slow).toEqual([]);
  },
  600_000,
);
