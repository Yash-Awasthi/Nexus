// SPDX-License-Identifier: Apache-2.0
/**
 * `nexus run` — run a stored workflow from a script, and re-run it while a file changes.
 *
 * The watch mode exists for the loop everyone actually has when editing a prompt: change a line,
 * run the workflow, read the output, change the line. Without it the loop is copy the id, paste
 * it, wait — which is why people stop running the workflow and start guessing.
 *
 * The printing is deliberately boring: one line per step, then the result. `--json` gives the
 * machine-readable form for CI, and `--out` writes it to a file, because a workflow's verdict
 * that only exists in a terminal scrollback is a workflow nobody audits.
 */
import fs from "node:fs";
import path from "node:path";
import { styleText } from "node:util";

import type { Command } from "commander";

import { api, fail } from "./client.ts";

export interface RunResult {
  status?: string;
  result?: unknown;
  error?: string;
  message?: string;
  events?: { type: string; stepId?: string; timestamp: string }[];
}

/** One run's output as the lines a person reads. */
export function formatRun(workflowId: string, data: RunResult): string[] {
  const lines: string[] = [];
  const steps = (data.events ?? []).filter((event) => event.type.startsWith("step:"));
  for (const event of steps) {
    const name = event.stepId ?? "(unnamed)";
    lines.push(`  ${event.type.replace("step:", "").padEnd(9)} ${name}`);
  }
  const result =
    typeof data.result === "string" ? data.result : JSON.stringify(data.result ?? null, null, 2);
  lines.push("", `Workflow ${workflowId}: ${data.status ?? "unknown"}`, result ?? "");
  return lines;
}

/** The minimum the watch loop needs from the filesystem, so a test can drive it. */
export interface Watcher {
  close(): void;
}

export interface WatchOptions {
  workflowId: string;
  /** Files or directories to watch. A directory is watched non-recursively. */
  paths: string[];
  /** Milliseconds to let a burst of editor writes settle. */
  debounceMs?: number;
  run: () => Promise<void>;
  /** fs.watch, or a stub in the test. */
  watch?: (file: string, listener: () => void) => Watcher;
  /** Where progress goes; defaults to stdout. */
  log?: (line: string) => void;
}

/**
 * Run once, then again on every change under `paths`, debounced.
 *
 * Runs are serialised: a change that arrives mid-run queues exactly one more run, because two
 * concurrent runs of the same workflow interleave their output and neither is trustworthy.
 */
export async function watchAndRun(options: WatchOptions): Promise<Watcher> {
  const { workflowId, paths, run, log = (line: string) => console.log(line) } = options;
  const debounceMs = options.debounceMs ?? 400;
  const watch = options.watch ?? ((file, listener) => fs.watch(file, listener));

  let running = false;
  let queued = false;
  let timer: NodeJS.Timeout | undefined;

  const trigger = async () => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      log(styleText("cyan", `▶ ${workflowId}`));
      await run();
    } catch (err) {
      // A failed run must not stop the watch: the next save is the fix.
      log(styleText("red", `✗ ${err instanceof Error ? err.message : String(err)}`));
    } finally {
      running = false;
      if (queued) {
        queued = false;
        await trigger();
      }
    }
  };

  const onChange = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void trigger(), debounceMs);
  };

  const watchers: Watcher[] = [];
  for (const target of paths) {
    if (!fs.existsSync(target)) {
      throw new Error(`Nothing to watch at ${target}`);
    }
    watchers.push(watch(target, onChange));
  }

  await trigger();
  log(styleText("dim", `watching ${paths.join(", ")} — Ctrl-C to stop`));

  return {
    close: () => {
      if (timer) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    },
  };
}

/** Register `nexus run`. */
export function registerRunCommand(program: Command): void {
  program
    .command("run <workflowId>")
    .description("Run a stored workflow; --watch re-runs it when a file changes")
    .option("--watch", "Re-run on file change")
    .option(
      "--file <path>",
      "File or directory to watch (repeatable with commas); defaults to the working directory",
    )
    .option("--input <json>", "Run input as JSON")
    .option("--json", "Print the raw result as JSON, for CI")
    .option("--out <path>", "Write the JSON result to a file")
    .action(async (workflowId: string, opts: Record<string, unknown>) => {
      const paths = String(opts["file"] ?? ".")
        .split(",")
        .map((entry) => path.resolve(entry.trim()))
        .filter((entry) => entry.length > 0);
      const input = (() => {
        const raw = opts["input"];
        if (typeof raw !== "string" || !raw.trim()) return undefined;
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          throw new Error("--input must be valid JSON");
        }
      })();

      const once = async (): Promise<RunResult> => {
        // Workflows live on the unversioned bridge (/api/workflows), not /api/v1.
        const data = await api.unversioned<RunResult>("POST", `/api/workflows/${workflowId}/run`, {
          ...(input === undefined ? {} : { input }),
        });
        if (typeof opts["out"] === "string") {
          fs.writeFileSync(path.resolve(opts["out"]), `${JSON.stringify(data, null, 2)}\n`);
        }
        if (opts["json"] === true) console.log(JSON.stringify(data, null, 2));
        else for (const line of formatRun(workflowId, data)) console.log(line);
        return data;
      };

      try {
        if (opts["watch"] !== true) {
          const data = await once();
          if (data.status === "error") process.exitCode = 1;
          return;
        }
        const watcher = await watchAndRun({
          workflowId,
          paths,
          run: async () => void (await once()),
        });
        // Ctrl-C is the documented way out; release the handles so the process can exit.
        process.once("SIGINT", () => {
          watcher.close();
          process.exitCode = 0;
        });
      } catch (err) {
        fail(err);
      }
    });
}
