// SPDX-License-Identifier: Apache-2.0
/** Tool output can hold one very long line; no processor may go superlinear on it. */
import { expect, it } from "vitest";

import { defaultOutputProcessors } from "./token-saver.js";

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
    for (const command of COMMANDS) {
      for (const [i, shape] of SHAPES.entries()) {
        const t = performance.now();
        processor.process(command, input(shape));
        const ms = performance.now() - t;
        if (ms > 100) slow.push(`${command} #${i} ${Math.round(ms)}ms`);
      }
    }
    expect(slow).toEqual([]);
  },
  600_000,
);
