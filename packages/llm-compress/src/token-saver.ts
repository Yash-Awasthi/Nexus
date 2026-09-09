// SPDX-License-Identifier: Apache-2.0
/**
 * token-saver processor engine — faithful TypeScript port of the command-
 * dispatched output-compression model from ppgranger/token-saver
 * (inspiration/Nexus/ppgranger_token-saver, src/engine.py + src/processors/).
 *
 * Where {@link compressForTool} maps a tool name to one of five coarse profiles
 * and applies uniform line filters, token-saver's model is a registry of
 * per-command {@link OutputProcessor}s: first `canHandle` match wins, chained
 * secondaries run in declared order, and the always-last generic processor
 * applies a light `clean()` pass after any specialized processor plus a full
 * fallback pass (dedup/truncation) when the specialized one failed to compress
 * enough ("mismatch"). Thresholds gate every call.
 *
 * Ported processors:
 *   • `genericProcessor`   — ANSI strip, progress-bar removal (unicode bars are
 *     always noise; ASCII bars only with %/n-of-m/ETA/rate context so bare
 *     separator rules survive), blank collapse, repeated-line `(xN)` dedup,
 *     numeric-similar-line collapse, trailing-ws strip, middle truncation.
 *   • `testOutputProcessor`— stateful, block-aware test-runner output handling
 *     (pytest state machine with FAILURES/warnings sections; jest, cargo, go,
 *     rspec, dotnet, swift, mix and a generic-test fallback): traceback blocks
 *     are head/tail-truncated with an explicit marker, warnings are collapsed
 *     by type to one line + one example, parameterized-test failures are
 *     grouped into a single summary, coverage reports reduce to TOTAL +
 *     low-coverage files, and pass/fail/summary lines are preserved.
 *   • `lintOutputProcessor` — eslint/ruff/flake8/pylint/mypy/clippy/rubocop/
 *     shellcheck/hadolint/biome/... output grouped per rule id (count + file
 *     tally + up to 2 examples, rules under the group threshold listed raw).
 *   • `structuredLogProcessor` — stern/kubetail JSON-lines log streams reduced
 *     to a level tally + error messages (falls back to head/error/tail
 *     compression below a 50% JSON threshold).
 *   • `packageListProcessor` — pip/npm ls/conda/gem/brew listings collapsed to
 *     counts with top entries (npm keeps its tree issues + top-level deps).
 *   • `fileListingProcessor` — `ls -l` reduced to type/size/name, long ls
 *     grouped by extension, find/fd grouped by directory, tree truncated with
 *     its summary preserved.
 *   • `searchProcessor` — grep/rg/ag output grouped per file with per-file
 *     caps, dir-grouped for very large result sets; fd delegated to listing.
 *
 * Deviations from the Python source (documented for honesty):
 *   • `hook_patterns` auto-discovery / user-processor plugin loading are the
 *     CLI-hook product surface, not engine mechanics — dropped.
 *   • Runner flavors whose python handling is a shared trivial shape (keep
 *     failing lines + drop passing/compile noise + prepend a count) are ported
 *     individually rather than via python's dynamic `_process_<name>` dispatch.
 *   • This engine deliberately does NOT register in {@link ENGINES}: the
 *     registry's `CompressEngine` applies to bare text, while this model needs
 *     the command context to dispatch.
 */

// ── Regexes shared with the python source ───────────────────────────────────────

// Matches any python invocation: python, python3, python3.11, .venv/bin/python3...
const PYTHON_CMD = String.raw`(?:[^\s/]+/)?python[23]?(?:\.\d+)?`;

// eslint-disable-next-line no-control-regex
const ANSI_CLEAN_RE = /\u001b\[[0-9;]*[a-zA-Z]|\u001b\].*?\u0007/g;

// Normalize numbers/percentages for fuzzy matching.
const NUMERIC_RE = /\d+(\.\d+)?/g;
// Unicode block/box characters are unambiguous progress bars.
const PROGRESS_BLOCK_RE = /[━█▓░▒■□●○]{3,}/;
// ASCII runs (####, ====, ---->) are progress bars only in progress context.
const ASCII_BAR_RE = /[#=\->]{5,}/;
const PROGRESS_CONTEXT_RE = /[%[\]]|\b\d+\/\d+\b|ETA|eta|\d+(\.\d+)?\s*[KMGT]?i?B\/s/;

// ── Processor model ─────────────────────────────────────────────────────────────

/** A per-command output compressor (token-saver's Processor). */
export interface OutputProcessor {
  /** Processor name, used for routing observability. */
  readonly name: string;
  /** Lower runs earlier; the highest-priority processor is the generic fallback. */
  readonly priority: number;
  /** Secondary processors (by name) run in order after this one handles. */
  readonly chainTo?: readonly string[];
  /** True when this processor can compress output for `command`. */
  canHandle(command: string): boolean;
  /** Compress `output` for `command`. Returning it unchanged is a deliberate no-op. */
  process(command: string, output: string): string;
  /** Light cleanup (ANSI strip, blank collapse) — engine-applied after a specialized pass. */
  clean?(text: string): string;
}

export interface ProcessorEngineOptions {
  /** Outputs shorter than this are returned untouched (python: min_input_length, default 1). */
  minInputLength?: number;
  /** Minimum required gain (python: min_compression_ratio, default 0). */
  minCompressionRatio?: number;
  /** Max chained secondaries per dispatch (python: max_chain_depth, default 3). */
  maxChainDepth?: number;
  /** Processor names to disable. The fallback processor can never be disabled. */
  disabled?: readonly string[];
}

export interface ProcessorCompressResult {
  /** The compressed (or original) text. */
  output: string;
  /** Name of the processor that produced the result: a processor name, or "none". */
  processor: string;
  wasCompressed: boolean;
  /** True when a specialized processor under-compressed and the fallback took over. */
  isMismatch: boolean;
  originalLength: number;
  compressedLength: number;
  gain: number;
}

function defaultOpts(opts: ProcessorEngineOptions): Required<ProcessorEngineOptions> {
  return {
    minInputLength: opts.minInputLength ?? 1,
    minCompressionRatio: opts.minCompressionRatio ?? 0,
    maxChainDepth: opts.maxChainDepth ?? 3,
    disabled: opts.disabled ?? [],
  };
}

/**
 * Build a first-match-wins processor engine. Processors are sorted by
 * (priority, name); the highest-priority (last) processor is the generic
 * fallback whose `clean()` runs after any specialized processor, and whose full
 * `process()` is tried on the original when a specialized pass under-compresses.
 */
export function createProcessorEngine(
  processors: readonly OutputProcessor[],
  opts: ProcessorEngineOptions = {},
): { compress(command: string, output: string): ProcessorCompressResult; list(): string[] } {
  const o = defaultOpts(opts);
  const disabled = new Set(o.disabled);
  // The fallback is never disabled (python: `disabled.discard("generic")`).
  const sorted = [...processors].sort(
    (a, b) => a.priority - b.priority || a.name.localeCompare(b.name),
  );
  const enabled = sorted.filter((p) => !disabled.has(p.name) || p === sorted[sorted.length - 1]);
  // `enabled` is non-empty when `processors` is (a filter never adds), so this is safe.
  const fallback = enabled[enabled.length - 1]!;
  const byName = new Map(enabled.map((p) => [p.name, p]));

  const compress = (command: string, output: string): ProcessorCompressResult => {
    const originalLength = output.length;
    const none = (processor = "none", mismatch = false): ProcessorCompressResult => ({
      output,
      processor,
      wasCompressed: false,
      isMismatch: mismatch,
      originalLength,
      compressedLength: originalLength,
      gain: 0,
    });
    if (originalLength < o.minInputLength) return none();

    for (const processor of enabled) {
      if (!processor.canHandle(command)) continue;

      let compressed = processor.process(command, output);
      // A deliberately unchanged return means the processor chose not to compress.
      if (compressed === output) return none(processor.name, processor !== fallback);

      // Chain to declared secondary processors.
      if (processor.chainTo) {
        const visited = new Set([processor.name]);
        let depth = 0;
        for (const chainName of processor.chainTo) {
          if (depth >= o.maxChainDepth) break;
          if (visited.has(chainName)) continue;
          const secondary = byName.get(chainName);
          if (!secondary) continue;
          visited.add(chainName);
          const chained = secondary.process(command, compressed);
          if (chained !== compressed) compressed = chained;
          depth += 1;
        }
      }

      // Specialized processors get a light generic cleanup, never truncation.
      if (processor !== fallback && fallback.clean) compressed = fallback.clean(compressed);

      const compressedLength = compressed.length;
      const gain = originalLength > 0 ? (originalLength - compressedLength) / originalLength : 0;
      if (compressedLength < originalLength && gain >= o.minCompressionRatio) {
        return {
          output: compressed,
          processor: processor.name,
          wasCompressed: true,
          isMismatch: false,
          originalLength,
          compressedLength,
          gain,
        };
      }

      // Under-compression ("mismatch"): retry the whole pass with the fallback.
      if (processor !== fallback && fallback) {
        const genericCompressed = fallback.clean
          ? fallback.clean(fallback.process(command, output))
          : fallback.process(command, output);
        const genericLength = genericCompressed.length;
        const genericGain =
          originalLength > 0 ? (originalLength - genericLength) / originalLength : 0;
        if (genericLength < originalLength && genericGain >= o.minCompressionRatio) {
          return {
            output: genericCompressed,
            processor: "generic",
            wasCompressed: true,
            isMismatch: true,
            originalLength,
            compressedLength: genericLength,
            gain: genericGain,
          };
        }
      }

      return none(processor.name, processor !== fallback);
    }
    return none();
  };

  return { compress, list: () => enabled.map((p) => p.name) };
}

// ── Generic fallback processor ──────────────────────────────────────────────────

const SPINNER_LINES = new Set([
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
  "⣾",
  "⣽",
  "⣻",
  "⢿",
  "⡿",
  "⣟",
  "⣯",
  "⣷",
]);

/** Universal compression heuristics; always matches as the fallback. */
export const genericProcessor: OutputProcessor = {
  name: "generic",
  priority: 999,

  canHandle(): boolean {
    return true;
  },

  process(_command: string, output: string): string {
    let lines = output.split("\n");
    lines = stripAnsiLines(lines);
    lines = stripProgressBars(lines);
    lines = collapseBlankLines(lines);
    lines = collapseRepeatedLines(lines);
    lines = collapseSimilarLines(lines);
    lines = lines.map((l) => l.replace(/\s+$/, ""));
    if (lines.length > GENERIC_TRUNCATE_THRESHOLD) lines = truncateMiddle(lines);
    return lines.join("\n");
  },

  /** Light cleanup pass: ANSI + blank collapse + trailing-ws only. */
  clean(text: string): string {
    let lines = stripAnsiLines(text.split("\n"));
    lines = collapseBlankLines(lines);
    return lines.map((l) => l.replace(/\s+$/, "")).join("\n");
  },
};

function stripAnsiLines(lines: string[]): string[] {
  return lines.map((line) => line.replace(ANSI_CLEAN_RE, ""));
}

function stripProgressBars(lines: string[]): string[] {
  const result: string[] = [];
  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped) {
      result.push(line);
      continue;
    }
    const block = stripped.match(PROGRESS_BLOCK_RE);
    if (block && block[0].length > stripped.length * 0.5) continue;
    const asciiBar = stripped.match(ASCII_BAR_RE);
    if (
      asciiBar &&
      asciiBar[0].length > stripped.length * 0.5 &&
      PROGRESS_CONTEXT_RE.test(stripped)
    )
      continue;
    if (SPINNER_LINES.has(stripped)) continue;
    result.push(line);
  }
  return result;
}

function collapseBlankLines(lines: string[]): string[] {
  const result: string[] = [];
  let prevBlank = false;
  for (const line of lines) {
    const isBlank = line.trim() === "";
    if (isBlank && prevBlank) continue;
    result.push(line);
    prevBlank = isBlank;
  }
  return result;
}

function flushRepeat(result: string[], line: string, count: number): void {
  result.push(count > 1 ? `${line} (x${count})` : line);
}

function collapseRepeatedLines(lines: string[]): string[] {
  if (lines.length === 0) return lines;
  const result: string[] = [];
  let current = lines[0]!;
  let count = 1;
  for (const line of lines.slice(1)) {
    if (line === current && current.trim()) count += 1;
    else {
      flushRepeat(result, current, count);
      current = line;
      count = 1;
    }
  }
  flushRepeat(result, current, count);
  return result;
}

function normalizeNumbers(line: string): string {
  return line.trim().replace(NUMERIC_RE, "N");
}

function isNumericHeavyProgress(line: string): boolean {
  const stripped = line.trim();
  if (!stripped) return false;
  if (/\d+(\.\d+)?%/.test(stripped)) return true;
  if (/\d+(\.\d+)?\s*(KB|MB|GB|B|kB|MiB|GiB|k|M|G)\/s/.test(stripped)) return true;
  if (/(ETA|eta)\s+\d+/.test(stripped)) return true;
  const numericChars = stripped.split("").filter((c) => /\d/.test(c)).length;
  return /--:--:--|(\d+:){2}\d+/.test(stripped) && numericChars >= 5;
}

function flushSimilar(result: string[], group: string[]): void {
  if (group.length >= 5) {
    result.push(group[0]!);
    result.push(`  ... (${group.length - 2} similar lines)`);
    result.push(group[group.length - 1]!);
  } else {
    result.push(...group);
  }
}

function collapseSimilarLines(lines: string[]): string[] {
  if (lines.length === 0) return lines;
  const result: string[] = [];
  let current = lines[0]!;
  let currentNormalized = normalizeNumbers(current);
  let group = [current];
  for (const line of lines.slice(1)) {
    const normalized = normalizeNumbers(line);
    if (
      normalized === currentNormalized &&
      current.trim() &&
      current.trim().length > 10 &&
      isNumericHeavyProgress(current)
    ) {
      group.push(line);
    } else {
      flushSimilar(result, group);
      current = line;
      currentNormalized = normalized;
      group = [line];
    }
  }
  flushSimilar(result, group);
  return result;
}

const GENERIC_TRUNCATE_THRESHOLD = 200;
const GENERIC_KEEP_HEAD = 100;
const GENERIC_KEEP_TAIL = 50;

function truncateMiddle(lines: string[]): string[] {
  const total = lines.length;
  const head = GENERIC_KEEP_HEAD > 0 ? lines.slice(0, GENERIC_KEEP_HEAD) : [];
  const tail = GENERIC_KEEP_TAIL > 0 ? lines.slice(-GENERIC_KEEP_TAIL) : [];
  const removed = total - head.length - tail.length;
  if (removed <= 0) return lines;
  return [...head, `... (${removed} lines truncated, ${total} total) ...`, ...tail];
}

// ── Test-output processor ───────────────────────────────────────────────────────

const MAX_TRACEBACK_LINES = 30;

const TEST_COMMAND_RE = new RegExp(
  String.raw`\b(pytest|py\.test|${PYTHON_CMD}\s+-m\s+pytest|jest|mocha|cargo\s+test|go\s+test|rspec|phpunit|vitest|bun\s+test|npm\s+test|yarn\s+test|pnpm\s+test|dotnet\s+test|swift\s+test|mix\s+test|npx\s+(jest|mocha|vitest|playwright)|poetry\s+run\s+(pytest|py\.test)|uv\s+run\s+(pytest|py\.test)|pipx\s+run\s+pytest|bundle\s+exec\s+(rspec|rails\s+test))\b`,
);

function truncateTraceback(block: string[]): string[] {
  if (block.length <= MAX_TRACEBACK_LINES) return block;
  const keepHead = Math.floor(MAX_TRACEBACK_LINES / 2);
  const keepTail = MAX_TRACEBACK_LINES - keepHead;
  const omitted = block.length - keepHead - keepTail;
  return [
    ...block.slice(0, keepHead),
    `    ... (${omitted} traceback lines truncated)`,
    ...block.slice(-keepTail),
  ];
}

/** Stateful, block-aware test-runner output compression (pytest/jest/cargo/go/...). */
export const testOutputProcessor: OutputProcessor = {
  name: "test",
  priority: 21,

  canHandle(command: string): boolean {
    return TEST_COMMAND_RE.test(command);
  },

  process(command: string, output: string): string {
    if (!output || !output.trim()) return output;
    const lines = output.split("\n");
    if (
      /\bpytest\b|py\.test|poetry\s+run\s+pytest|uv\s+run\s+pytest|pipx\s+run\s+pytest/.test(
        command,
      )
    )
      return processPytest(lines);
    if (
      /\bjest\b|\bvitest\b|\bnpm\s+test\b|\byarn\s+test\b|\bpnpm\s+test\b|npx\s+(jest|vitest)\b/.test(
        command,
      )
    )
      return processJest(lines);
    if (/\bcargo\s+test\b/.test(command)) return processCargo(lines);
    if (/\bgo\s+test\b/.test(command)) return processGo(lines);
    if (/\brspec\b|bundle\s+exec\s+rspec\b/.test(command)) return processRspec(lines);
    if (/\bdotnet\s+test\b/.test(command)) return processDotnet(lines);
    if (/\bswift\s+test\b/.test(command)) return processSwift(lines);
    if (/\bmix\s+test\b/.test(command)) return processMix(lines);
    return processGenericTest(lines);
  },
};

function processPytest(lines: string[]): string {
  const result: string[] = [];
  let inFailure = false;
  let inWarnings = false;
  let failureBlock: string[] = [];
  let warningLines: string[] = [];
  const summaryLines: string[] = [];
  let passedCount = 0;
  const paramTests = new Map<string, { passed: number; failed: string[] }>();

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    const stripped = line.trim();
    // Skip collection + environment preamble.
    if (/^(collecting|collected)\s/.test(stripped)) continue;
    if (/^(platform|rootdir|configfile|plugins|cachedir)[\s:]/.test(stripped)) continue;

    // FAILURES section header.
    if (/^=+ FAILURES =+/.test(line)) {
      inFailure = true;
      inWarnings = false;
      result.push(line);
      continue;
    }
    // warnings summary header.
    if (/^=+ warnings summary =+/.test(line)) {
      inWarnings = true;
      inFailure = false;
      if (failureBlock.length) {
        result.push(...truncateTraceback(failureBlock));
        failureBlock = [];
      }
      continue;
    }

    if (inWarnings) {
      if (/^=+.*=+$/.test(line)) {
        inWarnings = false;
        if (warningLines.length) {
          result.push(...collapseWarnings(warningLines));
          warningLines = [];
        }
        summaryLines.push(line);
      } else if (stripped && !stripped.startsWith("--")) {
        warningLines.push(stripped);
      }
      continue;
    }

    if (inFailure) {
      // New test-failure header within FAILURES: flush previous block.
      if (/^_+ .+ _+$/.test(line)) {
        if (failureBlock.length) {
          result.push(...truncateTraceback(failureBlock));
          failureBlock = [];
        }
        result.push(line);
        continue;
      }
      // End of the failures block.
      if (/^=+ (short test summary|warnings summary|\d+ (failed|passed|error))/.test(line)) {
        inFailure = false;
        if (failureBlock.length) {
          result.push(...truncateTraceback(failureBlock));
          failureBlock = [];
        }
        if (/warnings summary/.test(line)) inWarnings = true;
        else result.push(line);
      } else if (/^=+.*=+$/.test(line) && !/FAILURES/.test(line)) {
        inFailure = false;
        if (failureBlock.length) {
          result.push(...truncateTraceback(failureBlock));
          failureBlock = [];
        }
        result.push(line);
      } else {
        failureBlock.push(line);
      }
      continue;
    }

    // Count passing tests.
    if (/\bPASSED\b/.test(line)) {
      passedCount += 1;
      const m = /^(\S+?)\[(.+)\]\s+PASSED/.exec(stripped);
      if (m) {
        const base = m[1] ?? "";
        const info = paramTests.get(base) ?? { passed: 0, failed: [] };
        info.passed += 1;
        paramTests.set(base, info);
      }
      continue;
    }
    // Keep individual FAILED/ERROR lines; track parameterized failures.
    if (/\bFAILED\b|\bERROR\b/.test(line)) {
      const m = /^(\S+?)\[(.+)\]\s+FAILED/.exec(stripped);
      if (m) {
        const base = m[1] ?? "";
        const info = paramTests.get(base) ?? { passed: 0, failed: [] };
        info.failed.push(m[2] ?? "");
        paramTests.set(base, info);
      } else {
        result.push(line);
      }
      continue;
    }
    // Final summary lines (skip "test session starts" header).
    if (/^=+.*=+$/.test(line) && !/test session starts/.test(line)) {
      summaryLines.push(line);
      continue;
    }
    // Short-test-summary section.
    if (/^(FAILED|ERROR)\s/.test(stripped)) result.push(line);
  }

  // Unclosed sections at EOF.
  if (warningLines.length) result.push(...collapseWarnings(warningLines));
  if (failureBlock.length) result.push(...truncateTraceback(failureBlock));

  // Group parameterized-test summaries.
  for (const [base, info] of paramTests) {
    if (!info.failed.length) continue;
    const total = info.passed + info.failed.length;
    const shown = info.failed.slice(0, 5);
    const extra = info.failed.length > 5 ? `, ... (${info.failed.length - 5} more)` : "";
    result.push(`${base}: ${info.passed}/${total} passed, FAILED: [${shown.join(", ")}${extra}]`);
  }

  if (passedCount > 0) result.unshift(`[${passedCount} tests passed]`);

  // Compress any coverage report present in the original lines.
  const coverage = extractCoverage(lines);
  if (coverage.length) result.push(...compressCoverage(coverage));

  result.push(...summaryLines);
  return result.length ? result.join("\n") : lines.join("\n");
}

function extractCoverage(lines: string[]): string[] {
  let start: number | undefined;
  let end: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const stripped = (lines[i] ?? "").trim();
    if (
      start === undefined &&
      (/^-+ coverage/.test(stripped) || /^Name\s+Stmts\s+Miss/.test(stripped))
    )
      start = i;
    if (start !== undefined && i > start && /^TOTAL\s+/.test(stripped)) {
      end = i;
      break;
    }
  }
  if (start === undefined) return [];
  const last = end !== undefined ? end + 1 : lines.length;
  return lines.slice(start, last);
}

function compressCoverage(lines: string[]): string[] {
  const result: string[] = [];
  let totalLine = "";
  const lowFiles: string[] = [];
  for (const raw of lines) {
    const stripped = raw.trim();
    if (stripped.startsWith("TOTAL")) {
      totalLine = stripped;
      continue;
    }
    if (stripped.startsWith("Name") || stripped.startsWith("-")) continue;
    const m = /^(\S+)\s+\d+\s+\d+\s+(\d+)%/.exec(stripped);
    if (m) {
      if (Number(m[2]) < 80) lowFiles.push(stripped);
    }
  }
  if (totalLine) result.push(totalLine);
  if (lowFiles.length) {
    result.push(`Files below 80% coverage (${lowFiles.length}):`);
    for (const f of lowFiles.slice(0, 10)) result.push(`  ${f}`);
    if (lowFiles.length > 10) result.push(`  ... (${lowFiles.length - 10} more)`);
  }
  return result;
}

function collapseWarnings(warningLines: string[]): string[] {
  const byType = new Map<string, string[]>();
  for (const line of warningLines) {
    const m = /(\w+Warning):\s*(.+)/.exec(line);
    if (m) {
      const wtype = m[1] ?? "other";
      const list = byType.get(wtype) ?? [];
      list.push(line);
      byType.set(wtype, list);
    } else if (/^\s*\//.test(line) || /^\s+\w+/.test(line)) {
      // Source-location continuation lines (path/indented) — no type of their own.
      continue;
    } else {
      const list = byType.get("other") ?? [];
      list.push(line);
      byType.set("other", list);
    }
  }
  if (byType.size === 0) return [];
  const total = [...byType.values()].reduce((acc, v) => acc + v.length, 0);
  const sorted = [...byType.entries()].sort((a, b) => b[1].length - a[1].length);
  const parts: string[] = [];
  for (const [wtype, instances] of sorted) {
    if (wtype === "other") continue;
    parts.push(`${wtype} x${instances.length}`);
  }
  const result: string[] = [];
  if (parts.length) {
    result.push(`Warnings (${total}): ${parts.join(", ")}`);
    const top = sorted[0];
    if (top && top[0] !== "other" && top[1].length > 0) {
      const example = top[1][0];
      if (example) result.push(`  e.g. ${example}`);
    }
  }
  return result;
}

function processJest(lines: string[]): string {
  const result: string[] = [];
  let inFailure = false;
  let passedSuites = 0;
  let failureBuffer: string[] = [];
  let consecutiveBlanks = 0;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    const stripped = line.trim();

    if (/\bFAIL\b/.test(line) && !/^(Tests?|Test Suites?):/.test(stripped)) {
      inFailure = true;
      consecutiveBlanks = 0;
      result.push(line);
      continue;
    }
    if (inFailure) {
      failureBuffer.push(line);
      if (!stripped) {
        consecutiveBlanks += 1;
        if (consecutiveBlanks >= 2) {
          result.push(...truncateTraceback(failureBuffer));
          failureBuffer = [];
          inFailure = false;
          consecutiveBlanks = 0;
        }
      } else {
        consecutiveBlanks = 0;
      }
      continue;
    }
    if (/\bPASS\b/.test(line) && !/^(Tests?|Test Suites?):/.test(stripped)) {
      passedSuites += 1;
      continue;
    }
    if (/^(Tests?|Test Suites?|Snapshots?|Time|Ran all):/.test(stripped)) {
      result.push(line);
    }
  }
  if (failureBuffer.length) result.push(...truncateTraceback(failureBuffer));
  if (passedSuites > 0) result.unshift(`[${passedSuites} suites passed]`);
  return result.length ? result.join("\n") : lines.join("\n");
}

function processCargo(lines: string[]): string {
  const result: string[] = [];
  let inFailure = false;
  let okCount = 0;
  for (const rawLine of lines) {
    const stripped = rawLine.trim();
    if (stripped.startsWith("test ") && stripped.includes("... ok")) {
      okCount += 1;
      continue;
    }
    if (stripped.includes("FAILED")) {
      inFailure = true;
      result.push(rawLine);
      continue;
    }
    if (inFailure) {
      result.push(rawLine);
      if (stripped.startsWith("test result:")) inFailure = false;
      continue;
    }
    if (stripped.startsWith("test result:")) {
      result.push(rawLine);
      continue;
    }
    if (/^\s*(Compiling|Downloading|Running|Doc-tests)/.test(stripped)) continue;
  }
  if (okCount > 0) result.unshift(`[${okCount} tests passed]`);
  return result.length ? result.join("\n") : lines.join("\n");
}

function processGo(lines: string[]): string {
  const result: string[] = [];
  let passed = 0;
  let inFailure = false;
  for (const rawLine of lines) {
    const stripped = rawLine.trim();
    if (stripped.startsWith("--- PASS")) {
      passed += 1;
      continue;
    }
    if (stripped.startsWith("--- FAIL")) {
      inFailure = true;
      result.push(rawLine);
      continue;
    }
    if (inFailure) {
      result.push(rawLine);
      if (/^(FAIL|ok)\s+\S+/.test(stripped)) inFailure = false;
      continue;
    }
    if (/^(ok|FAIL)\s+\S+/.test(stripped)) result.push(rawLine);
  }
  if (passed > 0) result.unshift(`[${passed} tests passed]`);
  return result.length ? result.join("\n") : lines.join("\n");
}

function processRspec(lines: string[]): string {
  const result: string[] = [];
  let passed = 0;
  let inFailure = false;
  for (const rawLine of lines) {
    const stripped = rawLine.trim();
    if (/^\d+ examples?, \d+ failures?/.test(stripped)) {
      result.push(rawLine);
      continue;
    }
    if (stripped.includes("FAILED") || stripped.includes("Failure/Error")) {
      inFailure = true;
      result.push(rawLine);
      continue;
    }
    if (inFailure) {
      result.push(rawLine);
      if (!stripped) inFailure = false;
      continue;
    }
    if (/^[.FE*P]+$/.test(stripped)) {
      passed += stripped.split(".").length - 1;
      continue;
    }
    if (/^\s*(✓|✔)/.test(stripped)) passed += 1;
  }
  if (passed > 0) result.unshift(`[${passed} examples passed]`);
  return result.length ? result.join("\n") : lines.join("\n");
}

function processDotnet(lines: string[]): string {
  const result: string[] = [];
  let passed = 0;
  let inFailure = false;
  for (const rawLine of lines) {
    const stripped = rawLine.trim();
    if (/^\s*(Build|Restore|Determining|Microsoft)/.test(stripped)) continue;
    if (
      (stripped.startsWith("Passed!") || /\bPassed\b/.test(stripped)) &&
      !/test/.test(stripped.toLowerCase())
    ) {
      passed += 1;
      continue;
    }
    if (/\bFailed\b/.test(stripped)) {
      inFailure = true;
      result.push(rawLine);
      continue;
    }
    if (inFailure) {
      result.push(rawLine);
      if (!stripped || /^(Total|Passed|Failed|Skipped)\s/.test(stripped)) inFailure = false;
      continue;
    }
    if (/^(Total tests|Passed|Failed|Skipped|Test Run)/.test(stripped)) result.push(rawLine);
  }
  if (passed > 0) result.unshift(`[${passed} tests passed]`);
  return result.length ? result.join("\n") : lines.join("\n");
}

function processSwift(lines: string[]): string {
  const result: string[] = [];
  let passed = 0;
  for (const rawLine of lines) {
    const stripped = rawLine.trim();
    if (/^\s*(Build|Compile|Link|Fetch|Creating)/.test(stripped)) continue;
    if (stripped.toLowerCase().includes("passed") && !/test/.test(stripped.toLowerCase())) {
      passed += 1;
      continue;
    }
    if (/\bfailed\b|\berror\b/i.test(stripped)) {
      result.push(rawLine);
      continue;
    }
    if (/^Test Suite/.test(stripped) || /^Executed \d+/.test(stripped)) result.push(rawLine);
  }
  if (passed > 0) result.unshift(`[${passed} tests passed]`);
  return result.length ? result.join("\n") : lines.join("\n");
}

function processMix(lines: string[]): string {
  const result: string[] = [];
  let passed = 0;
  let inFailure = false;
  for (const rawLine of lines) {
    const stripped = rawLine.trim();
    if (/^\s*(Compiling|Generated)\s/.test(stripped)) continue;
    if (/^\.+$/.test(stripped)) {
      passed += stripped.length;
      continue;
    }
    if (/\bfailure\b|\bFailed\b/i.test(stripped)) {
      inFailure = true;
      result.push(rawLine);
      continue;
    }
    if (inFailure) {
      result.push(rawLine);
      if (!stripped) inFailure = false;
      continue;
    }
    if (/^\d+\s+(tests?|doctests?)/.test(stripped)) result.push(rawLine);
    if (/^Finished in/.test(stripped)) result.push(rawLine);
  }
  if (passed > 0) result.unshift(`[${passed} tests passed]`);
  return result.length ? result.join("\n") : lines.join("\n");
}

function processGenericTest(lines: string[]): string {
  const result: string[] = [];
  let passed = 0;
  for (const rawLine of lines) {
    const lower = rawLine.toLowerCase();
    if (/fail|error|assert|exception|traceback/.test(lower)) result.push(rawLine);
    else if (/pass|ok |success/.test(lower) || /^\s*(✓|✔)/.test(rawLine)) passed += 1;
    else if (/^\d+\s+(tests?|specs?|examples?)/.test(rawLine.trim())) result.push(rawLine);
  }
  if (passed > 0) result.unshift(`[${passed} tests passed]`);
  return result.length ? result.join("\n") : lines.slice(-10).join("\n");
}

// ── Shared helpers (utils.py port) ──────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const DEFAULT_ERROR_RE =
  /\b(error|Error|ERROR|exception|Exception|EXCEPTION|fatal|Fatal|FATAL|panic|Panic|PANIC|traceback|Traceback)\b/;

/** Keep head/tail plus error lines with context (token-saver utils.compress_log_lines). */
function compressLogLines(
  lines: string[],
  opts: {
    keepHead?: number;
    keepTail?: number;
    errorRe?: RegExp;
    contextLines?: number;
    maxErrorLines?: number;
  } = {},
): string {
  const keepHead = opts.keepHead ?? 10;
  const keepTail = opts.keepTail ?? 20;
  const errRe = opts.errorRe ?? DEFAULT_ERROR_RE;
  const contextLines = opts.contextLines ?? 2;
  const maxErrorLines = opts.maxErrorLines ?? 50;
  if (lines.length <= keepHead + keepTail) return lines.join("\n");

  const head = lines.slice(0, keepHead);
  const tail = lines.slice(-keepTail);
  const middle = lines.slice(keepHead, -keepTail);

  // Error lines with context in the middle section.
  const errorIndices = new Set<number>();
  for (let idx = 0; idx < middle.length; idx++) {
    const line = middle[idx] ?? "";
    if (errRe.test(line)) {
      for (let c = idx - contextLines; c <= idx + contextLines; c++) {
        if (c >= 0 && c < middle.length) errorIndices.add(c);
      }
    }
  }

  const result = [...head];
  if (middle.length > 0) {
    if (errorIndices.size > 0) {
      result.push(`\n... (${lines.length} total lines, showing errors) ...\n`);
      const sorted = [...errorIndices].sort((a, b) => a - b);
      let prev = -2;
      for (const idx of sorted) {
        if (idx > prev + 1 && prev >= 0) {
          const gap = idx - prev - 1;
          result.push(`  ... (${gap} lines skipped)`);
        }
        result.push(middle[idx] ?? "");
        prev = idx;
      }
      if (sorted.length > maxErrorLines) {
        result.length = keepHead + 1 + maxErrorLines;
        result.push(`  ... (${sorted.length - maxErrorLines} more error lines)`);
      }
    } else {
      result.push(`\n... (${lines.length - keepHead - keepTail} lines truncated) ...\n`);
    }
  }
  result.push(...tail);
  return result.join("\n");
}

// ── Lint-output processor ───────────────────────────────────────────────────────

const LINT_EXAMPLE_COUNT = 2;
const LINT_GROUP_THRESHOLD = 3;

const LINT_CAN_HANDLE_RE = new RegExp(
  String.raw`\b(eslint|ruff(\s+check)?|flake8|pylint|clippy|rubocop|golangci-lint|stylelint|prettier\s+--check|biome\s+(check|lint)|${PYTHON_CMD}\s+-m\s+(flake8|pylint|ruff|mypy)|mypy|shellcheck|hadolint|tflint|ktlint|swiftlint|cargo\s+clippy|oxlint|deno\s+lint|npx\s+(eslint|prettier|stylelint|biome)|poetry\s+run\s+(flake8|pylint|ruff|mypy)|uv\s+run\s+(flake8|pylint|ruff|mypy|ruff\s+check)|bundle\s+exec\s+rubocop)\b`,
);

/** Extract (ruleId, filepath) from a lint violation line; null when not one. */
function parseViolation(line: string, currentFile: string): { rule: string; file: string } | null {
  let m: RegExpExecArray | null;
  // ESLint indented format:  10:5  error  Unexpected var  no-var
  m = /^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(\S+)\s*$/.exec(line);
  if (m) return { rule: m[5] ?? "", file: currentFile };
  // ESLint inline: /path/file.js:10:5: 'foo' is not defined. (no-undef)
  m = /^(.+?):(\d+):\d+:\s+.+\((\S+)\)\s*$/.exec(line);
  if (m) return { rule: m[3] ?? "", file: m[1] ?? "" };
  // ESLint inline alt: /path/file.js:10:5  error  message  rule-name
  m = /^(.+?):(\d+):\d+\s+(error|warning)\s+.+?\s{2,}(\S+)\s*$/.exec(line);
  if (m) return { rule: m[4] ?? "", file: m[1] ?? "" };
  // Ruff/Flake8: path/file.py:10:5: E501 line too long
  m = /^(.+?):(\d+):\d+:\s+([A-Z]\w?\d+)\s+/.exec(line);
  if (m) return { rule: m[3] ?? "", file: m[1] ?? "" };
  // Pylint: path/file.py:10:0: C0114: message (rule-name)
  m = /^(.+?):(\d+):\d+:\s+\w+:\s+.+\((\S+)\)\s*$/.exec(line);
  if (m) return { rule: m[3] ?? "", file: m[1] ?? "" };
  // mypy: file.py:10: error: message  [error-code]
  m = /^(.+?):(\d+):\s+(error|warning|note):\s+.+\[(\S+)\]\s*$/.exec(line);
  if (m) return { rule: m[4] ?? "", file: m[1] ?? "" };
  // Clippy: warning[rule]: message
  m = /^(warning|error)\[(\S+)\]/.exec(line);
  if (m) return { rule: m[2] ?? "", file: "" };
  // Clippy/Rust fallback: warning: message [rule-name]
  m = /\[([a-z][a-z0-9_-]+)\]\s*$/.exec(line);
  if (m && /^(warning|error):/.test(line)) return { rule: m[1] ?? "", file: "" };
  // shellcheck: In file.sh line N: SC2086 ...
  m = /^In (.+?) line (\d+):/.exec(line);
  if (m) return { rule: "shellcheck", file: m[1] ?? "" };
  m = /^(.+?):(\d+):\d+:\s+(warning|error|info|style)\s*-\s*(SC\d+)/.exec(line);
  if (m) return { rule: m[4] ?? "", file: m[1] ?? "" };
  // hadolint: file:line DL3008 ...
  m = /^(.+?):(\d+)\s+(DL\d+|SC\d+)\s+/.exec(line);
  if (m) return { rule: m[3] ?? "", file: m[1] ?? "" };
  // biome: file.ts:10:5 lint/rule message
  m = /^(.+?):(\d+):\d+\s+(lint\/\S+)\s+/.exec(line);
  if (m) return { rule: m[3] ?? "", file: m[1] ?? "" };
  // golangci-lint: file.go:10:5: message (linter-name)
  m = /^(.+?\.go):(\d+):\d+:\s+.+\(([a-zA-Z][\w-]*)\)\s*$/.exec(line);
  if (m) return { rule: m[3] ?? "", file: m[1] ?? "" };
  // rubocop: file.rb:10:5: C: Rule/Name: message
  m = /^(.+?\.rb):(\d+):\d+:\s+[CWEFR]:\s+(\S+?):\s+/.exec(line);
  if (m) return { rule: m[3] ?? "", file: m[1] ?? "" };
  return null;
}

/** Group lint violations per rule id (eslint/ruff/mypy/clippy/...). */
export const lintOutputProcessor: OutputProcessor = {
  name: "lint",
  priority: 27,

  canHandle(command: string): boolean {
    return LINT_CAN_HANDLE_RE.test(command);
  },

  process(_command: string, output: string): string {
    if (!output || !output.trim()) return output;
    const lines = output.split("\n");

    const violationsByRule = new Map<string, string[]>();
    const filesByRule = new Map<string, Set<string>>();
    const ungrouped: string[] = [];
    const summaryLines: string[] = [];
    let currentFile = ""; // ESLint block format header

    for (const rawLine of lines) {
      const stripped = rawLine.trim();
      if (!stripped) continue;
      // ESLint file header line (path without colon/digits — not a violation).
      if (/^\/?[\w./_-]+\.\w+$/.test(stripped) && !/\:\d+/.test(stripped)) {
        currentFile = stripped;
        continue;
      }
      const parsed = parseViolation(stripped, currentFile);
      if (parsed) {
        const list = violationsByRule.get(parsed.rule) ?? [];
        list.push(stripped);
        violationsByRule.set(parsed.rule, list);
        if (parsed.file) {
          const set = filesByRule.get(parsed.rule) ?? new Set<string>();
          set.add(parsed.file);
          filesByRule.set(parsed.rule, set);
        }
      } else if (
        /^\s*\d+\s+(error|warning|problem)/.test(stripped) ||
        /(Found|Total|All checks)\s+\d+/.test(stripped) ||
        /^(error|warning):/.test(stripped.toLowerCase()) ||
        /^\s*✖\s+\d+\s+problem/.test(stripped)
      ) {
        summaryLines.push(stripped);
      } else {
        ungrouped.push(stripped);
      }
    }

    if (violationsByRule.size === 0) return output;

    const result: string[] = [];
    const totalViolations = [...violationsByRule.values()].reduce((a, v) => a + v.length, 0);
    result.push(`${totalViolations} issues across ${violationsByRule.size} rules:`);

    const sortedRules = [...violationsByRule.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [rule, violations] of sortedRules) {
      const count = violations.length;
      const fileCount = filesByRule.get(rule)?.size ?? 0;
      if (count > LINT_GROUP_THRESHOLD) {
        const loc = fileCount > 1 ? ` in ${fileCount} files` : "";
        result.push(`  ${rule}: ${count} occurrences${loc}`);
        for (const v of violations.slice(0, LINT_EXAMPLE_COUNT)) result.push(`    ${v}`);
        if (count > LINT_EXAMPLE_COUNT) result.push(`    ... (${count - LINT_EXAMPLE_COUNT} more)`);
      } else {
        for (const v of violations) result.push(`  ${v}`);
      }
    }

    if (summaryLines.length) result.push(...summaryLines);
    const important = ungrouped.filter((l) => /\b(error|fatal|cannot|failed)\b/i.test(l));
    if (important.length) result.push(...important.slice(0, 5));
    return result.join("\n");
  },
};

// ── Structured-log processor ────────────────────────────────────────────────────

const STERN_RE = /\b(stern|kubetail)\b/;
const LEVEL_KEYS = ["level", "severity", "log_level", "loglevel", "lvl", "log.level"];
const MESSAGE_KEYS = ["msg", "message", "text", "log", "body"];
const ERROR_LEVELS = new Set([
  "error",
  "fatal",
  "critical",
  "panic",
  "err",
  "crit",
  "emerg",
  "alert",
]);
const LEVEL_ORDER = [
  "error",
  "fatal",
  "critical",
  "panic",
  "warn",
  "warning",
  "info",
  "debug",
  "trace",
];

function extractLogLevel(obj: Record<string, unknown>): string {
  for (const key of LEVEL_KEYS) {
    const v = obj[key];
    if (v !== undefined) return String(v).toLowerCase().trim();
  }
  const msg = extractLogMessage(obj);
  if (msg) {
    if (/\b(ERROR|FATAL|PANIC)\b/.test(msg)) return "error";
    if (/\bWARN(ING)?\b/.test(msg)) return "warn";
  }
  return "unknown";
}

function extractLogMessage(obj: Record<string, unknown>): string {
  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (v !== undefined) {
      const val = String(v);
      return val.length > 200 ? val.slice(0, 197) + "..." : val;
    }
  }
  return "";
}

function processJsonLogLines(
  rawLines: string[],
  parsed: (Record<string, unknown> | null)[],
): string {
  const levelCounts = new Map<string, number>();
  const errorLines: string[] = [];
  let total = 0;
  for (let i = 0; i < parsed.length; i++) {
    const obj = parsed[i];
    if (!obj) continue;
    total += 1;
    const level = extractLogLevel(obj);
    levelCounts.set(level, (levelCounts.get(level) ?? 0) + 1);
    if (ERROR_LEVELS.has(level)) {
      const msg = extractLogMessage(obj);
      if (msg) errorLines.push(`  [${level.toUpperCase()}] ${msg}`);
      else {
        let raw = (rawLines[i] ?? "").trim();
        if (raw.length > 200) raw = raw.slice(0, 197) + "...";
        errorLines.push(`  ${raw}`);
      }
    }
  }

  const result: string[] = [`${total} log entries:`];
  for (const level of LEVEL_ORDER) {
    const count = levelCounts.get(level);
    if (count !== undefined) result.push(`  ${level}: ${count}`);
  }
  const others = [...levelCounts.entries()]
    .filter(([lvl]) => !LEVEL_ORDER.includes(lvl))
    .sort((a, b) => b[1] - a[1]);
  for (const [lvl, count] of others) result.push(`  ${lvl}: ${count}`);

  if (errorLines.length) {
    result.push(`\nErrors (${errorLines.length}):`);
    const maxErrors = 10;
    result.push(...errorLines.slice(0, maxErrors));
    if (errorLines.length > maxErrors) result.push(`  ... (${errorLines.length - maxErrors} more)`);
  }
  return result.join("\n");
}

/** Reduce stern/kubetail JSON-lines streams to a level tally + error messages. */
export const structuredLogProcessor: OutputProcessor = {
  name: "structured_log",
  priority: 45,

  canHandle(command: string): boolean {
    return STERN_RE.test(command);
  },

  process(_command: string, output: string): string {
    if (!output || !output.trim()) return output;
    const lines = output.split("\n");
    if (lines.length < 5) return output;

    const parsed: (Record<string, unknown> | null)[] = [];
    let jsonCount = 0;
    let nonEmpty = 0;
    for (const raw of lines) {
      const stripped = raw.trim();
      if (!stripped) {
        parsed.push(null);
        continue;
      }
      nonEmpty += 1;
      try {
        const obj: unknown = JSON.parse(stripped);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          parsed.push(obj as Record<string, unknown>);
          jsonCount += 1;
        } else parsed.push(null);
      } catch {
        parsed.push(null);
      }
    }
    // Below a 50% JSON threshold, fall back to log compression (keep 5 head / 10 tail).
    if (nonEmpty === 0 || jsonCount / nonEmpty < 0.5) {
      return compressLogLines(lines, { keepHead: 5, keepTail: 10 });
    }
    return processJsonLogLines(lines, parsed);
  },
};

// ── Package-list processor ──────────────────────────────────────────────────────

const PACKAGE_CAN_HANDLE_RE = new RegExp(
  String.raw`\b(pip3?\s+(list|freeze)|npm\s+(ls|list)|conda\s+list|yarn\s+list|pnpm\s+list|gem\s+list|brew\s+list)\b`,
);

function simpleListCompress(output: string, itemType: string, keep = 15): string {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length <= 20) return output;
  const result = [`${lines.length} ${itemType}:`];
  for (const line of lines.slice(0, keep)) result.push(`  ${line}`);
  result.push(`  ... (${lines.length - keep} more)`);
  return result.join("\n");
}

function processPipList(output: string): string {
  const dataLines: string[] = [];
  for (const raw of output.split("\n")) {
    const stripped = raw.trim();
    if (/^-+\s+-+/.test(stripped)) continue;
    if (/^Package\s+Version/.test(stripped)) continue;
    if (stripped) dataLines.push(stripped);
  }
  if (dataLines.length <= 20) return output;
  const result = [`${dataLines.length} packages installed:`];
  for (const line of dataLines.slice(0, 15)) result.push(`  ${line}`);
  result.push(`  ... (${dataLines.length - 15} more)`);
  return result.join("\n");
}

function processNpmLs(output: string): string {
  const lines = output.split("\n");
  if (lines.length <= 20) return output;
  const topLevel: string[] = [];
  const issues: string[] = [];
  let totalDeps = 0;
  for (const rawLine of lines) {
    const stripped = rawLine.trim();
    if (/(UNMET|invalid|missing|ERR!|WARN)/i.test(stripped)) {
      issues.push(stripped);
      continue;
    }
    if (/^[├└]──\s+/.test(rawLine) || /^[+`]-\s+/.test(rawLine)) {
      topLevel.push(stripped);
      totalDeps += 1;
      continue;
    }
    if (/^[│ ]*[├└]/.test(rawLine) || /^[| ]*[+`]/.test(rawLine)) {
      totalDeps += 1;
      continue;
    }
    if (rawLine && !rawLine.startsWith(" ")) topLevel.unshift(stripped);
  }
  const result = [`${totalDeps} total dependencies:`];
  if (issues.length) {
    result.push(`Issues (${issues.length}):`);
    for (const issue of issues.slice(0, 10)) result.push(`  ${issue}`);
    if (issues.length > 10) result.push(`  ... (${issues.length - 10} more)`);
  }
  result.push(`Top-level (${topLevel.length}):`);
  for (const pkg of topLevel.slice(0, 20)) result.push(`  ${pkg}`);
  if (topLevel.length > 20) result.push(`  ... (${topLevel.length - 20} more)`);
  return result.join("\n");
}

function processCondaList(output: string): string {
  const dataLines = output.split("\n").filter((l) => l.trim() && !l.trimStart().startsWith("#"));
  if (dataLines.length <= 20) return output;
  const result = [`${dataLines.length} packages installed:`];
  for (const line of dataLines.slice(0, 15)) result.push(`  ${line.trim()}`);
  result.push(`  ... (${dataLines.length - 15} more)`);
  return result.join("\n");
}

/** Collapse pip/npm/conda/gem/brew listing output to counts + top entries. */
export const packageListProcessor: OutputProcessor = {
  name: "package_list",
  priority: 15,

  canHandle(command: string): boolean {
    return PACKAGE_CAN_HANDLE_RE.test(command);
  },

  process(command: string, output: string): string {
    if (!output || !output.trim()) return output;
    if (/\bnpm\s+(ls|list)\b/.test(command)) return processNpmLs(output);
    if (/\bpip3?\s+freeze\b/.test(command)) return simpleListCompress(output, "packages");
    if (/\bpip3?\s+list\b/.test(command)) return processPipList(output);
    if (/\bconda\s+list\b/.test(command)) return processCondaList(output);
    if (/\b(yarn|pnpm)\s+list\b/.test(command)) return processNpmLs(output);
    if (/\bgem\s+list\b/.test(command)) return simpleListCompress(output, "gems");
    if (/\bbrew\s+list\b/.test(command)) return simpleListCompress(output, "formulae");
    return output;
  },
};

// ── File-listing processor ──────────────────────────────────────────────────────

const LS_COMPACT_THRESHOLD = 15;
const FIND_COMPACT_THRESHOLD = 20;
const TREE_COMPACT_THRESHOLD = 30;

const LS_LONG_RE =
  /^([d\-lbcps])[rwxsStT\-]{9}[@+.]?\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(?:\S+\s+){2,3}(\S.*?)$/;

function formatSize(size: number): string {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)}K`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)}M`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

function splitPath(path: string): { dir: string; file: string } {
  const i = path.lastIndexOf("/");
  if (i === -1) return { dir: ".", file: path };
  return { dir: path.slice(0, i), file: path.slice(i + 1) };
}

function processLsLong(output: string): string {
  const result: string[] = [];
  for (const line of output.split("\n")) {
    if (line.startsWith("total")) continue;
    const m = LS_LONG_RE.exec(line);
    if (!m) {
      result.push(line);
      continue;
    }
    const typeChar = m[1] ?? "";
    const name = m[3] ?? "";
    const size = Number(m[2] ?? 0);
    if (typeChar === "d") result.push(`  ${name}/`);
    else if (typeChar === "l") result.push(`  ${name}`);
    else result.push(`  ${formatSize(size).padStart(6)}  ${name}`);
  }
  if (result.length === 0) return output;
  if (result.length > 60) {
    const kept = result.slice(0, 50);
    kept.push(`... (${result.length - 50} more entries)`);
    return kept.join("\n");
  }
  return result.join("\n");
}

function processLsGrouped(output: string): string {
  const items = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (items.length <= LS_COMPACT_THRESHOLD) return output;
  const byExt = new Map<string, string[]>();
  const dirs: string[] = [];
  for (const item of items) {
    if (item.endsWith("/") || item.endsWith(":")) dirs.push(item);
    else if (item.includes(".")) {
      const ext = item.slice(item.lastIndexOf(".") + 1);
      const list = byExt.get(ext) ?? [];
      list.push(item);
      byExt.set(ext, list);
    } else {
      const list = byExt.get("(no ext)") ?? [];
      list.push(item);
      byExt.set("(no ext)", list);
    }
  }
  const result = [`${items.length} items:`];
  if (dirs.length) {
    if (dirs.length > 10)
      result.push(
        `  dirs (${dirs.length}): ${dirs.slice(0, 8).join(", ")} ... +${dirs.length - 8}`,
      );
    else result.push(`  dirs (${dirs.length}): ${dirs.join(", ")}`);
  }
  const sortedExt = [...byExt.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [ext, files] of sortedExt) {
    if (files.length > 5)
      result.push(`  *.${ext} (${files.length}): ${files.slice(0, 3).join(", ")} ...`);
    else result.push(`  *.${ext}: ${files.join(", ")}`);
  }
  return result.join("\n");
}

function processFind(output: string): string {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length <= FIND_COMPACT_THRESHOLD) return output;
  const byDir = new Map<string, string[]>();
  for (const path of lines) {
    const { dir, file } = splitPath(path);
    const list = byDir.get(dir) ?? [];
    list.push(file);
    byDir.set(dir, list);
  }
  const result = [`${lines.length} files found:`];
  for (const [dirPath, files] of [...byDir.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (files.length > 20) {
      const exts = new Map<string, number>();
      for (const f of files) {
        const ext = f.includes(".") ? f.slice(f.lastIndexOf(".") + 1) : "(none)";
        exts.set(ext, (exts.get(ext) ?? 0) + 1);
      }
      const desc = [...exts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([e, n]) => `*.${e}:${n}`)
        .join(", ");
      result.push(`  ${dirPath}/ (${files.length} files: ${desc})`);
    } else if (files.length > 5) {
      result.push(`  ${dirPath}/ (${files.length} files): ${files.slice(0, 3).join(", ")} ...`);
    } else {
      for (const f of files) result.push(`  ${dirPath}/${f}`);
    }
  }
  return result.join("\n");
}

function processTree(output: string): string {
  const lines = output.split("\n");
  if (lines.length <= TREE_COMPACT_THRESHOLD) return output;
  const keep = TREE_COMPACT_THRESHOLD - 5;
  const result = lines.slice(0, keep);
  let summary = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (/^\d+\s+director(?:ies|y)\b/.test(line)) {
      summary = line;
      break;
    }
  }
  result.push(`\n... (${lines.length - keep} lines truncated)`);
  if (summary) result.push(summary);
  return result.join("\n");
}

/** Compress ls/find/tree/exa listing output (long-format strip, ext grouping, dir grouping). */
export const fileListingProcessor: OutputProcessor = {
  name: "file_listing",
  priority: 50,

  canHandle(command: string): boolean {
    return /^\s*(?:[^\s/]+\/)?(ls|find|tree|dir|exa|eza|rsync)\b/.test(command);
  },

  process(command: string, output: string): string {
    if (!output || !output.trim()) return output;
    if (/\bfind\b/.test(command)) return processFind(output);
    if (/\btree\b/.test(command)) return processTree(output);
    if (/\b(ls|exa|eza)\b/.test(command)) {
      if (/\s-\S*l/.test(command)) return processLsLong(output);
      return processLsGrouped(output);
    }
    return output;
  },
};

// ── Search processor ────────────────────────────────────────────────────────────

const SEARCH_MAX_PER_FILE = 3;
const SEARCH_MAX_FILES = 15;

/** Compress grep/rg/ag output: group per file with per-file caps and dir roll-up. */
export const searchProcessor: OutputProcessor = {
  name: "search",
  priority: 35,

  canHandle(command: string): boolean {
    return /^\s*(?:[^\s/]+\/)?(grep|rg|ag|fd|fdfind)\b/.test(command);
  },

  process(command: string, output: string): string {
    if (!output || !output.trim()) return output;
    // fd/fdfind produce file listings — group by directory.
    if (/\b(fd|fdfind)\b/.test(command)) return processFd(output);
    const lines = output.split("\n");
    if (lines.length < 20) return output;

    const byFile = new Map<string, string[]>();
    const plainMatches: string[] = [];
    for (const rawLine of lines) {
      const stripped = rawLine.trim();
      if (!stripped) continue;
      if (/^Binary file .* matches/.test(stripped)) continue;
      // file:line:content or file:content (extension files) / file:NNN:... (extensionless).
      let filepath: string | undefined;
      const m1 = /^((?:[a-zA-Z]:)?[^\s:]+\.(?:[a-zA-Z0-9]+)):(\d+:)?(.*)$/.exec(stripped);
      if (m1) filepath = m1[1];
      else {
        const m2 = /^((?:[a-zA-Z]:)?[^\s:]+):(\d+:)(.*)$/.exec(stripped);
        if (m2) filepath = m2[1];
      }
      if (filepath) {
        const list = byFile.get(filepath) ?? [];
        list.push(stripped);
        byFile.set(filepath, list);
      } else plainMatches.push(stripped);
    }
    if (byFile.size === 0 && plainMatches.length === 0) return output;

    const totalMatches =
      [...byFile.values()].reduce((a, v) => a + v.length, 0) + plainMatches.length;
    const totalFiles = byFile.size;
    if (totalFiles === 0) {
      if (plainMatches.length > 30) {
        const result = plainMatches.slice(0, 25);
        result.push(`... (${plainMatches.length - 25} more matches)`);
        return result.join("\n");
      }
      return output;
    }
    if (totalFiles > 30) return processSearchByDir(byFile, totalMatches, totalFiles);

    const result = [`${totalMatches} matches across ${totalFiles} files:`];
    const sortedFiles = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [filepath, matches] of sortedFiles.slice(0, SEARCH_MAX_FILES)) {
      const count = matches.length;
      if (count > SEARCH_MAX_PER_FILE) {
        result.push(`${filepath}: (${count} matches)`);
        for (const matchLine of matches.slice(0, SEARCH_MAX_PER_FILE)) {
          const display = matchLine.startsWith(filepath + ":")
            ? matchLine.slice(filepath.length + 1)
            : matchLine;
          result.push(`  ${display}`);
        }
        result.push(`  ... (${count - SEARCH_MAX_PER_FILE} more)`);
      } else {
        for (const matchLine of matches) result.push(matchLine);
      }
    }
    if (totalFiles > SEARCH_MAX_FILES)
      result.push(`... (${totalFiles - SEARCH_MAX_FILES} more files)`);
    return result.join("\n");
  },
};

function processSearchByDir(
  byFile: Map<string, string[]>,
  totalMatches: number,
  totalFiles: number,
): string {
  // Group search results by directory for large result sets.
  const byDir = new Map<string, Map<string, string[]>>();
  for (const [filepath, matches] of byFile) {
    const { dir } = splitPath(filepath);
    const dirFiles = byDir.get(dir) ?? new Map<string, string[]>();
    dirFiles.set(filepath, matches);
    byDir.set(dir, dirFiles);
  }
  const result = [
    `${totalMatches} matches across ${totalFiles} files in ${byDir.size} directories:`,
  ];
  let dirsShown = 0;
  const sortedDirs = [...byDir.entries()].sort(
    (a, b) =>
      [...b[1].values()].reduce((s, v) => s + v.length, 0) -
      [...a[1].values()].reduce((s, v) => s + v.length, 0),
  );
  for (const [dirName, files] of sortedDirs) {
    if (dirsShown >= SEARCH_MAX_FILES) break;
    const dirMatches = [...files.values()].reduce((s, v) => s + v.length, 0);
    result.push(`\n${dirName}/ (${dirMatches} matches in ${files.size} files)`);
    const topFiles = [...files.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 3);
    for (const [filepath, matches] of topFiles) {
      const fname = filepath.slice(filepath.lastIndexOf("/") + 1);
      if (matches.length > SEARCH_MAX_PER_FILE) {
        result.push(`  ${fname}: (${matches.length} matches)`);
        for (const m of matches.slice(0, SEARCH_MAX_PER_FILE)) {
          const display = m.startsWith(filepath + ":") ? m.slice(filepath.length + 1) : m;
          result.push(`    ${display}`);
        }
      } else {
        for (const m of matches) result.push(`  ${m}`);
      }
    }
    const remainingFiles = files.size - 3;
    if (remainingFiles > 0) result.push(`  ... (${remainingFiles} more files in this directory)`);
    dirsShown += 1;
  }
  const remainingDirs = byDir.size - dirsShown;
  if (remainingDirs > 0) result.push(`\n... (${remainingDirs} more directories)`);
  return result.join("\n");
}

function processFd(output: string): string {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 20) return output;
  const byDir = new Map<string, string[]>();
  for (const path of lines) {
    const { dir, file } = splitPath(path);
    const list = byDir.get(dir) ?? [];
    list.push(file);
    byDir.set(dir, list);
  }
  const result = [`${lines.length} files found:`];
  const dirs = [...byDir.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [dirPath, files] of dirs.slice(0, SEARCH_MAX_FILES)) {
    if (files.length > 10) {
      const exts = new Map<string, number>();
      for (const f of files) {
        const ext = f.includes(".") ? f.slice(f.lastIndexOf(".") + 1) : "(none)";
        exts.set(ext, (exts.get(ext) ?? 0) + 1);
      }
      const desc = [...exts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([e, n]) => `*.${e}:${n}`)
        .join(", ");
      result.push(`  ${dirPath}/ (${files.length} files: ${desc})`);
    } else if (files.length > 5) {
      result.push(`  ${dirPath}/ (${files.length} files): ${files.slice(0, 3).join(", ")} ...`);
    } else {
      for (const f of files) result.push(`  ${dirPath}/${f}`);
    }
  }
  if (dirs.length > SEARCH_MAX_FILES)
    result.push(`... (${dirs.length - SEARCH_MAX_FILES} more directories)`);
  return result.join("\n");
}

// ── Git-output processor ────────────────────────────────────────────────────────

const MAX_DIFF_HUNK_LINES = 50;
const MAX_DIFF_CONTEXT_LINES = 3;
const MAX_LOG_ENTRIES = 10;
const GIT_BRANCH_THRESHOLD = 15;
const GIT_STASH_THRESHOLD = 5;

const LOCK_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "Pipfile.lock",
  "Cargo.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
  "bun.lockb",
]);

// Optional git global options between 'git' and the subcommand.
const GIT_OPTS = String.raw`(?:-C\s+\S+\s+|--no-pager\s+|-c\s+\S+\s+|--git-dir(?:=|\s+)\S+\s+|--work-tree(?:=|\s+)\S+\s+)*`;
const GIT_SUBCMDS = String.raw`(status|diff|log|show|push|pull|fetch|clone|branch|stash|reflog|remote|blame|cherry-pick|rebase|merge)`;
const GIT_CMD_RE = new RegExp(String.raw`\bgit\s+${GIT_OPTS}${GIT_SUBCMDS}\b`);

/** Compress a unified diff (shared token-saver git/gh util, ported verbatim). */
function compressDiff(lines: string[], maxHunk: number, maxContext: number): string[] {
  const result: string[] = [];
  let hunkLineCount = 0;
  let hunkTruncated = false;
  let statLine = "";
  let leadingBuffer: string[] = [];
  let trailingRemaining = 0;
  // File-header lines (---/+++/index) only appear before a file's first @@; once
  // in a hunk, +/- lines are content and must never be treated as headers.
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      leadingBuffer = [];
      trailingRemaining = 0;
      inHunk = false;
      if (hunkTruncated) result.push(`  ... (truncated after ${maxHunk} lines)`);
      result.push(line);
      hunkLineCount = 0;
      hunkTruncated = false;
    } else if (line.startsWith("@@")) {
      leadingBuffer = [];
      trailingRemaining = 0;
      inHunk = true;
      if (hunkTruncated) result.push(`  ... (truncated after ${maxHunk} lines)`);
      result.push(line);
      hunkLineCount = 0;
      hunkTruncated = false;
    } else if (
      !inHunk &&
      (line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ "))
    ) {
      continue;
    } else if (
      !inHunk &&
      (line.startsWith("Binary files") ||
        line.startsWith("rename ") ||
        line.startsWith("copy ") ||
        line.startsWith("similarity ") ||
        line.startsWith("dissimilarity ") ||
        line.startsWith("new file mode") ||
        line.startsWith("deleted file mode") ||
        line.startsWith("old mode") ||
        line.startsWith("new mode"))
    ) {
      // Preserve metadata for diffs with no hunk body (binary, pure renames,
      // mode-only changes) — otherwise they'd vanish.
      result.push(line);
    } else if (line.startsWith("+") || line.startsWith("-")) {
      hunkLineCount += 1;
      if (hunkLineCount <= maxHunk) {
        if (leadingBuffer.length > 0) {
          result.push(...leadingBuffer.slice(-maxContext));
          leadingBuffer = [];
        }
        result.push(line);
        trailingRemaining = maxContext;
      } else if (!hunkTruncated) {
        hunkTruncated = true;
      }
    } else if (line.startsWith(" ")) {
      hunkLineCount += 1;
      if (hunkLineCount <= maxHunk) {
        if (trailingRemaining > 0) {
          result.push(line);
          trailingRemaining -= 1;
        } else {
          leadingBuffer.push(line);
        }
      } else if (!hunkTruncated) {
        hunkTruncated = true;
      }
    } else if (/^\s*\d+ files? changed/.test(line)) {
      statLine = line;
    }
  }

  if (hunkTruncated) result.push(`  ... (truncated after ${maxHunk} lines)`);
  if (statLine) result.push(statLine);
  return result;
}

/** Compress git diff content: --name-only, --stat, lockfile summary, hunks. */
function processGitDiff(output: string, command: string): string {
  const lines = output.split("\n");
  if (/--name-only\b/.test(command) || /--name-status\b/.test(command))
    return processGitNameList(lines);
  // stat-only format: `git diff --stat` output has no diff --git headers.
  if (lines.length > 0 && !lines.some((l) => l.startsWith("diff --git")))
    return processGitDiffStat(lines);

  // Pre-scan: separate lockfile diffs from normal diffs.
  const nonLockLines: string[] = [];
  const lockfileSummaries: string[] = [];
  let currentFile = "";
  let currentFileLines = 0;
  let inLockfile = false;

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      if (inLockfile && currentFile) {
        lockfileSummaries.push(
          `diff --git ${currentFile}`,
          `  (lockfile changed, ${currentFileLines} lines)`,
        );
      }
      const m = /^diff --git a\/(.+?) b\//.exec(line);
      const filename = m ? ((m[1] ?? "").split("/").pop() ?? "") : "";
      inLockfile = LOCK_FILES.has(filename);
      if (inLockfile) {
        currentFile = filename;
        currentFileLines = 0;
      } else {
        nonLockLines.push(line);
      }
      continue;
    }
    if (inLockfile) {
      currentFileLines += 1;
      continue;
    }
    nonLockLines.push(line);
  }
  if (inLockfile && currentFile) {
    lockfileSummaries.push(
      `diff --git ${currentFile}`,
      `  (lockfile changed, ${currentFileLines} lines)`,
    );
  }

  let maxHunk = MAX_DIFF_HUNK_LINES;
  let maxContext = MAX_DIFF_CONTEXT_LINES;
  // Trim context more aggressively on small diffs (context usually dominates).
  if (nonLockLines.length < 200) maxContext = Math.min(maxContext, 1);
  if (nonLockLines.some((l) => l.startsWith("diff --git"))) {
    const result = compressDiff(nonLockLines, maxHunk, maxContext);
    result.push(...lockfileSummaries);
    return result.join("\n");
  }
  if (lockfileSummaries.length > 0) return lockfileSummaries.join("\n");
  return nonLockLines.join("\n");
}

function processGitNameList(lines: string[]): string {
  if (lines.length <= 20) return lines.join("\n");
  const byDir = new Map<string, string[]>();
  for (const raw of lines) {
    const stripped = raw.trim();
    if (!stripped) continue;
    // --name-status: "M\tpath/file" or "M  path/file"
    let filepath: string | undefined;
    const m = /^([MADRCTU])\d*\s+(.+)$/.exec(stripped);
    if (m) filepath = m[2];
    else filepath = stripped;
    if (filepath) {
      const { dir } = splitPath(filepath);
      const list = byDir.get(dir) ?? [];
      list.push(stripped);
      byDir.set(dir, list);
    }
  }
  const total = lines.filter((l) => l.trim()).length;
  const result = [`${total} files changed:`];
  for (const [dirName, files] of [...byDir.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (files.length > 5) result.push(`  ${dirName}/ (${files.length} files)`);
    else for (const f of files) result.push(`  ${f}`);
  }
  return result.join("\n");
}

function processGitDiffStat(lines: string[]): string {
  const statLines = lines.filter((l) => /^\s*.+?\s+\|\s+\d+/.test(l));
  if (statLines.length > 20) return groupGitStatByDir(lines);
  const result: string[] = [];
  for (const line of lines) {
    const m = /^(\s*.+?\s+\|\s+\d+)\s+[+\-]+\s*$/.exec(line);
    result.push(m ? (m[1] ?? line) : line);
  }
  return result.join("\n");
}

function groupGitStatByDir(lines: string[]): string {
  const byDir = new Map<string, [string, string][]>();
  let summaryLine = "";
  for (const raw of lines) {
    const stripped = raw.trim();
    if (/^\s*\d+ files? changed/.test(stripped)) {
      summaryLine = stripped;
      continue;
    }
    const m = /^\s*(.+?)\s+\|\s+(.+)$/.exec(stripped);
    if (m) {
      const filepath = (m[1] ?? "").trim();
      const stats = (m[2] ?? "").trim();
      const { dir } = splitPath(filepath);
      const list = byDir.get(dir) ?? [];
      list.push([filepath, stats]);
      byDir.set(dir, list);
    }
  }
  if (byDir.size === 0) return lines.join("\n");
  const result: string[] = [];
  for (const [dirName, files] of [...byDir.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (files.length > 5) {
      const totalChanges = files.reduce((acc, [, stats]) => {
        const n = /(\d+)/.exec(stats);
        return acc + (n ? Number(n[1]) : 0);
      }, 0);
      result.push(` ${dirName}/ (${files.length} files, ~${totalChanges} changes)`);
    } else {
      for (const [filepath, stats] of files) {
        const cleanStats = stats.replace(/\s+[+\-]+\s*$/, "");
        result.push(` ${filepath} | ${cleanStats}`);
      }
    }
  }
  if (summaryLine) result.push(summaryLine);
  return result.join("\n");
}

function processGitLog(output: string, command: string): string {
  const lines = output.split("\n");
  const hasGraph =
    /--graph\b/.test(command) ||
    (lines.length > 0 && lines.slice(0, 10).some((l) => /^[|*/\\ ]*[|*/\\]/.test(l)));
  if (hasGraph) {
    if (lines.length > MAX_LOG_ENTRIES * 4) {
      const kept = lines.slice(0, MAX_LOG_ENTRIES * 4);
      kept.push(`... (${lines.length - MAX_LOG_ENTRIES * 4} more lines)`);
      return kept.join("\n");
    }
    return output;
  }
  // Already-compact one-line format: truncate only.
  const first = lines[0] ?? "";
  if (!first.startsWith("commit ")) {
    if (lines.length > MAX_LOG_ENTRIES) {
      return (
        lines.slice(0, MAX_LOG_ENTRIES).join("\n") +
        `\n... (${lines.length - MAX_LOG_ENTRIES} more)`
      );
    }
    return output;
  }
  const entries: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("commit ")) {
      if (current.length > 0) entries.push(current);
      current = [line];
    } else current.push(line);
  }
  if (current.length > 0) entries.push(current);

  const result: string[] = [];
  for (const entry of entries.slice(0, MAX_LOG_ENTRIES)) {
    let commitHash = "";
    let message = "";
    for (const line of entry) {
      if (line.startsWith("commit ")) commitHash = (line.split(/\s+/)[1] ?? "").slice(0, 8);
      else if (
        line.trim() &&
        !line.startsWith("Author:") &&
        !line.startsWith("Merge:") &&
        !line.startsWith("Date:") &&
        !message
      ) {
        message = line.trim();
      }
    }
    result.push(`${commitHash} ${message}`);
  }
  if (entries.length > MAX_LOG_ENTRIES)
    result.push(`... (${entries.length - MAX_LOG_ENTRIES} more commits)`);
  return result.join("\n");
}

function processGitTransfer(output: string): string {
  const lines = output.split("\n");
  const important: string[] = [];
  for (const raw of lines) {
    const stripped = raw.trim();
    if (!stripped) continue;
    if (
      /^(Receiving|Resolving|Counting|Compressing|remote:\s*(Counting|Compressing|Total|Enumerating))/.test(
        stripped,
      )
    )
      continue;
    if (/\d+%/.test(stripped)) continue;
    important.push(stripped);
  }
  if (important.length > 0) return important.join("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if ((lines[i] ?? "").trim()) return (lines[i] ?? "").trim();
  }
  return output;
}

function processGitBranch(output: string): string {
  const lines = output.trim().split("\n");
  if (lines.length <= GIT_BRANCH_THRESHOLD) return output;
  let current = "";
  const branches: string[] = [];
  for (const raw of lines) {
    const stripped = raw.trim();
    if (stripped.startsWith("* ")) current = stripped;
    else branches.push(stripped);
  }
  const result: string[] = current ? [current] : [];
  result.push(`(${branches.length} other branches)`);
  for (const b of branches.slice(0, 5)) result.push(`  ${b}`);
  if (branches.length > 5) result.push(`  ... (${branches.length - 5} more)`);
  return result.join("\n");
}

function processGitStatus(output: string): string {
  const lines = output.trim().split("\n");
  const counts = new Map<string, number>();
  const filesByDir = new Map<string, string[]>();
  const headerLines: string[] = [];
  let inUntracked = false;

  for (const raw of lines) {
    const stripped = raw.trim();
    if (!stripped) continue;
    if (stripped.startsWith("## ")) {
      const branch = stripped.slice(3).split("...")[0];
      headerLines.push(`On branch ${branch}`);
      continue;
    }
    if (
      stripped.startsWith("On branch") ||
      stripped.startsWith("Your branch") ||
      stripped.startsWith("HEAD detached")
    ) {
      headerLines.push(stripped);
      inUntracked = false;
      continue;
    }
    if (stripped.startsWith("nothing to commit") || stripped.startsWith("no changes added")) {
      headerLines.push(stripped);
      inUntracked = false;
      continue;
    }
    if (stripped.startsWith("Untracked files:")) {
      inUntracked = true;
      continue;
    }
    if (stripped.startsWith("Changes") || stripped.startsWith("Unmerged")) {
      inUntracked = false;
      continue;
    }
    if (stripped.startsWith("(")) continue;

    let code: string;
    let filepath: string;
    const prefixes: [string, string][] = [
      ["modified:", "M"],
      ["new file:", "A"],
      ["deleted:", "D"],
      ["renamed:", "R"],
      ["copied:", "C"],
      ["typechange:", "T"],
      ["both modified:", "UU"],
      ["both added:", "AA"],
      ["both deleted:", "DD"],
      ["added by us:", "AU"],
      ["added by them:", "UA"],
      ["deleted by us:", "DU"],
      ["deleted by them:", "UD"],
    ];
    const pref = prefixes.find(([p]) => stripped.startsWith(p));
    if (pref) {
      code = pref[1];
      filepath = stripped.slice(stripped.indexOf(":") + 1).trim();
    } else {
      const sm = /^([MADRCTU?! ]{1,2})\s+(.+)$/.exec(stripped);
      if (sm) {
        const codeRaw = (sm[1] ?? "").trim();
        filepath = (sm[2] ?? "").trim().replace(/^"|"$/g, "");
        // codeRaw holds 1-2 status chars, so these indices always exist.
        code = codeRaw.startsWith(" ") ? (codeRaw[codeRaw.length - 1] ?? "") : (codeRaw[0] ?? "");
      } else if (inUntracked && !stripped.startsWith("(")) {
        code = "?";
        filepath = stripped;
      } else continue;
    }

    counts.set(code, (counts.get(code) ?? 0) + 1);
    const { dir, file } = splitPath(filepath);
    const list = filesByDir.get(dir) ?? [];
    list.push(`${code} ${file}`);
    filesByDir.set(dir, list);
  }

  const result: string[] = [];
  if (headerLines.length > 0) result.push(headerLines.join(" | "));
  const summaryParts = [...counts.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}:${v}`);
  if (summaryParts.length > 0) {
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    result.push(`Files: ${total} (${summaryParts.join(", ")})`);
  }
  for (const [dirName, files] of [...filesByDir.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    if (files.length > 8) {
      const codes = new Map<string, number>();
      for (const f of files) {
        const c = f.split(" ", 1)[0] ?? "";
        codes.set(c, (codes.get(c) ?? 0) + 1);
      }
      const desc = [...codes.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([c, n]) => `${c}:${n}`)
        .join(", ");
      result.push(`  ${dirName}/ (${files.length} files: ${desc})`);
    } else {
      for (const f of files) result.push(`  ${dirName}/${f}`);
    }
  }
  return result.length > 0 ? result.join("\n") : output;
}

/** Compress git status/diff/log/show/push/branch/stash/reflog/remote/blame output. */
export const gitOutputProcessor: OutputProcessor = {
  name: "git",
  priority: 20,

  canHandle(command: string): boolean {
    return GIT_CMD_RE.test(command);
  },

  process(command: string, output: string): string {
    if (!output || !output.trim()) return output;
    const m = GIT_CMD_RE.exec(command);
    const subcmd = m ? (m[1] ?? "") : "";
    if (subcmd === "status") return processGitStatus(output);
    if (subcmd === "diff") return processGitDiff(output, command);
    if (subcmd === "log") return processGitLog(output, command);
    if (subcmd === "show") return processGitShow(output);
    if (subcmd === "branch") return processGitBranch(output);
    if (subcmd === "stash")
      return /\bstash\s+list\b/.test(command) ? processGitStashList(output) : output;
    if (subcmd === "reflog") return processGitReflog(output);
    if (subcmd === "blame") return processGitBlame(output);
    if (subcmd === "remote") return processGitRemote(output);
    if (
      subcmd === "push" ||
      subcmd === "pull" ||
      subcmd === "fetch" ||
      subcmd === "clone" ||
      subcmd === "cherry-pick" ||
      subcmd === "rebase" ||
      subcmd === "merge"
    ) {
      return processGitTransfer(output);
    }
    return output;
  },
};

function processGitShow(output: string): string {
  const lines = output.split("\n");
  const header: string[] = [];
  let diffStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("diff --git")) {
      diffStart = i;
      break;
    }
    header.push(line);
  }
  if (diffStart === -1) return output;
  const compressedDiff = processGitDiff(lines.slice(diffStart).join("\n"), "git diff");
  const compactHeader: string[] = [];
  for (const line of header) {
    const stripped = line.trim();
    if (
      stripped &&
      !stripped.startsWith("Merge:") &&
      !stripped.startsWith("Author:") &&
      !stripped.startsWith("Date:")
    )
      compactHeader.push(line);
  }
  return compactHeader.join("\n") + "\n" + compressedDiff;
}

function processGitStashList(output: string): string {
  const lines = output.trim().split("\n");
  if (lines.length <= GIT_STASH_THRESHOLD) return output;
  return (
    lines.slice(0, GIT_STASH_THRESHOLD).join("\n") +
    `\n... (${lines.length - GIT_STASH_THRESHOLD} more stashes)`
  );
}

function processGitReflog(output: string): string {
  const lines = output.trim().split("\n");
  if (lines.length <= MAX_LOG_ENTRIES) return output;
  return (
    lines.slice(0, MAX_LOG_ENTRIES).join("\n") +
    `\n... (${lines.length - MAX_LOG_ENTRIES} more entries)`
  );
}

function processGitRemote(output: string): string {
  const lines = output.trim().split("\n");
  if (lines.length <= 10) return output;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of lines) {
    const stripped = raw.trim();
    const key = stripped.replace(/\s+\((fetch|push)\)\s*$/, "");
    if (!seen.has(key)) {
      seen.add(key);
      result.push(stripped);
    }
  }
  if (result.length < lines.length)
    result.push(`(${lines.length} total lines, fetch/push deduplicated)`);
  return result.join("\n");
}

function processGitBlame(output: string): string {
  const lines = output.trim().split("\n");
  if (lines.length <= 20) return output;
  const byAuthor = new Map<string, number>();
  for (const line of lines) {
    const m = /^[0-9a-f]+\s+\((.+?)\s+\d{4}-\d{2}-\d{2}\s+/.exec(line);
    if (m) {
      const author = (m[1] ?? "").trim();
      byAuthor.set(author, (byAuthor.get(author) ?? 0) + 1);
    } else {
      const m2 = /^\^?[0-9a-f]+\s+\((.+?)\s+\d{4}/.exec(line);
      if (/^\^?[0-9a-f]+\s+\(/.test(line) && m2) {
        const author = (m2[1] ?? "").trim();
        byAuthor.set(author, (byAuthor.get(author) ?? 0) + 1);
      }
    }
  }
  if (byAuthor.size === 0) {
    if (lines.length > 50)
      return lines.slice(0, 40).join("\n") + `\n... (${lines.length - 40} more lines)`;
    return output;
  }
  const result = [`${lines.length} lines, ${byAuthor.size} authors:`];
  for (const [author, count] of [...byAuthor.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = Math.floor((count * 100) / lines.length);
    result.push(`  ${author}: ${count} lines (${pct}%)`);
  }
  result.push("", "Last 10 lines:", ...lines.slice(-10));
  return result.join("\n");
}

// ── Build-output processor ──────────────────────────────────────────────────────

const BUILD_EXCLUDE_LIST_RE = /\b(pip3?\s+(list|freeze)|npm\s+(ls|list)|conda\s+list)\b/;
const BUILD_EXCLUDE_INSTALL_RE =
  /\b(pip3?\s+install|poetry\s+(install|update|add)|uv\s+(pip\s+install|sync))\b/;
const BUILD_EXCLUDE_MAVEN_RE = /\b(mvn|mvnw|gradle|gradlew)\b/;
const BUILD_CAN_HANDLE_RE = new RegExp(
  String.raw`\b(npm\s+(run|install|ci|build|audit)|yarn\s+(run|install|build|add|audit)|pnpm\s+(run|install|build|add|audit)|make\b|cmake\b|ant\b|tsc\b|webpack\b|vite(\s+build)?|esbuild\b|rollup\b|next\s+build|nuxt\s+build|docker\s+(build|compose\s+build)|turbo\s+(run|build)|nx\s+(run|build)|bazel\s+build|sbt\b|mix\s+compile|bun\s+(install|build|run)|npx\s+(webpack|vite|esbuild|tsc|next\s+build|nuxt\s+build|turbo\s+run))\b`,
);

const SPINNER_SET = new Set([
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
  "⣾",
  "⣽",
  "⣻",
  "⢿",
  "⡿",
  "⣟",
  "⣯",
  "⣷",
]);

/** token-saver build_output._is_progress_line — all python patterns ported. */
function isBuildProgressLine(line: string): boolean {
  if (!line) return false;
  return [
    /^\s*(Downloading|Installing|Fetching|Resolving|Unpacking|Linking|Extracting)/,
    /^\s*added \d+ packages?/,
    /^\s*\d+ packages? are looking/,
    /^\s*(GET|fetch)\s+http/,
    /^\s*npm\s+(WARN|notice|warn)\b/,
    /^\s*\d+(\.\d+)?\s*%/,
    /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/,
    /^\s*\[\d+\/\d+\]/,
    /^\s*(Compiling|Updating|Preparing)\s+\S+/,
    /^\s*Already up to date/,
    /^\s*Using\s+(cached|version)\b/,
    /^\s*Collecting\s+\S+/,
    /^\s*━/,
    /^\s*\u27a4?\s*YN\d+:.*\b(Resolution|Fetch|Link)\s+step\b/,
    /^\s*Progress:\s+resolved\s+\d+/,
    /^\s*[Pp]ackages?\s+(are|is)\s+hard linked/,
  ].some((re) => re.test(line));
}

function buildExtractErrors(lines: string[]): string {
  const result: string[] = [];
  let inErrorBlock = false;
  let blankCount = 0;
  for (const line of lines) {
    const stripped = line.trim();
    if (isBuildProgressLine(stripped)) continue;
    // Error start.
    if (/\b(error|Error|ERROR)\b/.test(stripped) && !/\b0 errors?\b/.test(stripped)) {
      inErrorBlock = true;
      blankCount = 0;
      result.push(line);
      continue;
    }
    if (inErrorBlock) {
      if (!stripped) {
        blankCount += 1;
        // tsc/multi-file errors tolerate single blank lines; end after 2+.
        if (blankCount >= 2) inErrorBlock = false;
        else result.push(line);
        continue;
      }
      blankCount = 0;
      if (
        stripped.startsWith("at ") ||
        stripped.startsWith("-->") ||
        stripped.startsWith("  |") ||
        stripped.startsWith("   |") ||
        stripped.startsWith(">") ||
        stripped.startsWith("~~") ||
        stripped.startsWith("^^") ||
        /^\d+\s*\|/.test(stripped) ||
        /^\s+\d+:\d+/.test(stripped)
      ) {
        result.push(line);
      } else if (/\b(warning|Warning|note|Note|help|Help)\b/.test(stripped)) {
        result.push(line);
        inErrorBlock = false;
      } else {
        result.push(line);
      }
      continue;
    }
    // Outside blocks: keep summary lines.
    if (/\d+\s+(errors?|warnings?|problems?)/.test(stripped.toLowerCase())) result.push(line);
  }
  if (result.length === 0) return lines.slice(-30).join("\n");
  return result.join("\n");
}

function buildSummarizeSuccess(lines: string[]): string {
  const result: string[] = [];
  let warningCount = 0;
  const warningSamples: string[] = [];
  const outputLines: string[] = [];
  for (const raw of lines) {
    const stripped = raw.trim();
    if (isBuildProgressLine(stripped)) continue;
    if (/\bwarn(ing)?\b/i.test(stripped)) {
      warningCount += 1;
      if (warningSamples.length < 5) warningSamples.push(stripped);
      continue;
    }
    if (
      [
        "built",
        "compiled",
        "success",
        "done",
        "complete",
        "finish",
        "written",
        "created",
        "generated",
        "output",
        "bundle",
        "size",
        "gzip",
        "chunk",
        "cached",
        "remote:",
        "tasks",
      ].some((kw) => stripped.toLowerCase().includes(kw))
    ) {
      outputLines.push(stripped);
    }
  }
  let summary = "Build succeeded.";
  if (warningCount > 0) summary += ` (${warningCount} warnings)`;
  result.push(summary);
  for (const sample of warningSamples) result.push(`  ${sample}`);
  if (outputLines.length > 0) result.push(...outputLines.slice(-3));
  return result.join("\n");
}

function buildProcessAudit(lines: string[]): string {
  const severities = new Map<string, number>();
  const packages = new Map<string, string[]>();
  const summaryLines: string[] = [];
  let currentPackage = "";
  for (const raw of lines) {
    const stripped = raw.trim();
    const sevMatch = /\b(critical|high|moderate|low)\b/i.exec(stripped);
    let pkgMatch = /^(\S+)\s+[<>=]/.exec(stripped);
    if (!pkgMatch) pkgMatch = /^Package\s+(\S+)/.exec(stripped);
    if (pkgMatch) currentPackage = pkgMatch[1] ?? "";
    if (sevMatch) {
      const sev = (sevMatch[1] ?? "").toLowerCase();
      severities.set(sev, (severities.get(sev) ?? 0) + 1);
      if (currentPackage) {
        const list = packages.get(sev) ?? [];
        if (!list.includes(currentPackage)) list.push(currentPackage);
        packages.set(sev, list);
      }
    }
    if (/\d+\s+(vulnerabilit|package)/i.test(stripped)) summaryLines.push(stripped);
    if (/(npm audit fix|run .* to fix|breaking change)/i.test(stripped))
      summaryLines.push(stripped);
  }
  if (severities.size === 0) return lines.join("\n");
  const total = [...severities.values()].reduce((a, b) => a + b, 0);
  const result = [`${total} vulnerabilities found:`];
  for (const sev of ["critical", "high", "moderate", "low"]) {
    const count = severities.get(sev);
    if (count === undefined) continue;
    const pkgs = packages.get(sev) ?? [];
    let pkgStr = pkgs.length > 0 ? ` (${pkgs.slice(0, 5).join(", ")})` : "";
    if (pkgs.length > 5) pkgStr = ` (${pkgs.slice(0, 5).join(", ")} +${pkgs.length - 5} more)`;
    result.push(`  ${sev}: ${count}${pkgStr}`);
  }
  const seen = new Set<string>();
  for (const line of summaryLines) {
    if (!seen.has(line)) {
      result.push(line);
      seen.add(line);
    }
  }
  return result.join("\n");
}

function buildProcessDocker(lines: string[]): string {
  const result: string[] = [];
  let stepCount = 0;
  for (const raw of lines) {
    const stripped = raw.trim();
    if (/^(Step \d+\/\d+|#\d+\s|\[\d+\/\d+\])/.test(stripped)) {
      stepCount += 1;
      result.push(stripped);
      continue;
    }
    if (/\b(error|Error|ERROR|failed|FAILED)\b/.test(stripped)) {
      result.push(stripped);
      continue;
    }
    if (/(Successfully (built|tagged)|naming to |writing image|DONE)/i.test(stripped)) {
      result.push(stripped);
      continue;
    }
    if (/^(Running in |Removing intermediate| ---> |sha256:)/.test(stripped)) continue;
    if (/^(Sending build context|Downloading|Extracting|Pulling)/.test(stripped)) continue;
    if (/\d+(\.\d+)?%/.test(stripped)) continue;
  }
  if (result.length === 0) return lines.slice(-10).join("\n");
  return result.join("\n");
}

function buildProcessTscTypecheck(lines: string[]): string {
  const byCode = new Map<string, string[]>();
  let summaryLine = "";
  for (const raw of lines) {
    const stripped = raw.trim();
    let m = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/.exec(stripped);
    if (!m) m = /^(.+?):\d+:\d+\s+-\s+error\s+(TS\d+):\s+(.+)$/.exec(stripped);
    if (m) {
      const code = m[4] ?? m[2] ?? "";
      const list = byCode.get(code) ?? [];
      list.push(stripped);
      byCode.set(code, list);
      continue;
    }
    if (/^Found \d+ error/.test(stripped)) summaryLine = stripped;
  }
  if (byCode.size === 0) return lines.join("\n");
  const total = [...byCode.values()].reduce((a, v) => a + v.length, 0);
  const result = [`${total} type errors across ${byCode.size} codes:`];
  for (const [code, violations] of [...byCode.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    const count = violations.length;
    if (count > 3) {
      result.push(`  ${code}: ${count} occurrences`);
      for (const v of violations.slice(0, 2)) result.push(`    ${v}`);
      result.push(`    ... (${count - 2} more)`);
    } else {
      for (const v of violations) result.push(`  ${v}`);
    }
  }
  if (summaryLine) result.push(summaryLine);
  return result.join("\n");
}

/** Compress npm/yarn/pnpm install & build logs: keep errors, drop progress noise. */
export const buildOutputProcessor: OutputProcessor = {
  name: "build",
  priority: 25,

  canHandle(command: string): boolean {
    if (BUILD_EXCLUDE_LIST_RE.test(command)) return false;
    if (BUILD_EXCLUDE_INSTALL_RE.test(command)) return false;
    if (BUILD_EXCLUDE_MAVEN_RE.test(command)) return false;
    return BUILD_CAN_HANDLE_RE.test(command);
  },

  process(command: string, output: string): string {
    if (!output || !output.trim()) return output;
    // tsc --noEmit is a type-check (lint), not a build — group errors by code.
    if (/\btsc\b.*--noEmit/.test(command)) return buildProcessTscTypecheck(output.split("\n"));
    // Piped output may be partial — avoid claiming success when errors were piped away.
    if (command.includes("|")) return output;
    if (/\b(npm|yarn|pnpm)\s+audit\b/.test(command)) return buildProcessAudit(output.split("\n"));
    if (/\bdocker\s+(build|compose\s+build)\b/.test(command))
      return buildProcessDocker(output.split("\n"));

    const lines = output.split("\n");
    const hasError = lines.some((line) => {
      const stripped = line.trim();
      return (
        /\b(error|Error|ERROR)\b/.test(line) &&
        !/\b0 errors?\b/.test(line) &&
        !isBuildProgressLine(stripped)
      );
    });
    if (hasError) return buildExtractErrors(lines);
    return buildSummarizeSuccess(lines);
  },
};

// ── Cargo-clippy processor ──────────────────────────────────────────────────────

const CARGO_CLIPPY_RE = /\bcargo\s+clippy\b/;
const CLIPPY_CHECKING_RE = /^\s*Checking\s+\S+\s+v/;
const RUST_COMPILING_RE = /^\s*Compiling\s+\S+\s+v/;
const RUST_WARNING_START_RE = /^warning(?:\[(\S+)\])?:\s+(.+)/;
const RUST_ERROR_START_RE = /^error(?:\[(\S+)\])?:\s+(.+)/;
const RUST_WARNING_SUMMARY_RE = /^warning:\s+.+generated\s+\d+\s+warning/;
const RUST_FINISHED_RE = /^\s*Finished\s+/;

const CLIPPY_CATEGORIES: Record<string, string> = {
  needless_return: "style",
  redundant_closure: "style",
  len_zero: "style",
  manual_map: "style",
  single_match: "style",
  match_bool: "style",
  collapsible_if: "style",
  unused_imports: "correctness",
  unused_variables: "correctness",
  dead_code: "correctness",
  unreachable_code: "correctness",
  needless_borrow: "complexity",
  unnecessary_unwrap: "complexity",
  map_unwrap_or: "complexity",
  clone_on_copy: "perf",
  large_enum_variant: "perf",
  box_collection: "perf",
};

const CLIPPY_WARNING_EXAMPLE_COUNT = 2;
const CLIPPY_WARNING_GROUP_THRESHOLD = 3;

function categorizeClippyLint(rule: string): string {
  const short = rule.replace("clippy::", "");
  return CLIPPY_CATEGORIES[short] ?? "other";
}

/** Deduplicate rustc/clippy warning blocks per rule with category + counts. */
export const cargoClippyProcessor: OutputProcessor = {
  name: "cargo_clippy",
  priority: 26,
  chainTo: ["lint"],

  canHandle(command: string): boolean {
    return CARGO_CLIPPY_RE.test(command);
  },

  process(_command: string, output: string): string {
    if (!output || !output.trim()) return output;
    const lines = output.split("\n");
    const result: string[] = [];
    let checkingCount = 0;
    let compilingCount = 0;

    const warningsByRule = new Map<string, string[][]>();
    const errorBlocks: string[][] = [];
    let currentBlock: string[] = [];
    let currentRule: string | undefined;
    let inError = false;
    let currentError: string[] = [];
    const finishedLines: string[] = [];
    const summaryLines: string[] = [];

    const flushWarnings = (): void => {
      if (currentRule && currentBlock.length > 0) {
        const list = warningsByRule.get(currentRule) ?? [];
        list.push(currentBlock);
        warningsByRule.set(currentRule, list);
      }
      currentBlock = [];
      currentRule = undefined;
    };
    const flushError = (): void => {
      if (inError && currentError.length > 0) errorBlocks.push(currentError);
      inError = false;
      currentError = [];
    };

    for (const rawLine of lines) {
      const stripped = rawLine.trim();
      if (CLIPPY_CHECKING_RE.test(stripped)) {
        checkingCount += 1;
        continue;
      }
      if (RUST_COMPILING_RE.test(stripped)) {
        compilingCount += 1;
        continue;
      }
      // Error start.
      if (RUST_ERROR_START_RE.test(stripped)) {
        flushWarnings();
        if (inError && currentError.length > 0) errorBlocks.push(currentError);
        inError = true;
        currentError = [rawLine];
        continue;
      }
      // Warning start.
      const wm = RUST_WARNING_START_RE.exec(stripped);
      if (wm && !RUST_WARNING_SUMMARY_RE.test(stripped)) {
        flushError();
        flushWarnings();
        currentRule = wm[1] ?? "other";
        currentBlock = [rawLine];
        continue;
      }
      if (RUST_WARNING_SUMMARY_RE.test(stripped)) {
        flushWarnings();
        flushError();
        summaryLines.push(rawLine);
        continue;
      }
      if (RUST_FINISHED_RE.test(stripped)) {
        flushWarnings();
        flushError();
        finishedLines.push(rawLine);
        continue;
      }
      // Context lines (spans, code, help annotations).
      if (inError) currentError.push(rawLine);
      else if (currentRule) currentBlock.push(rawLine);
    }
    flushError();
    flushWarnings();

    const prep: string[] = [];
    if (checkingCount > 0) prep.push(`${checkingCount} checked`);
    if (compilingCount > 0) prep.push(`${compilingCount} compiled`);
    if (prep.length > 0) result.push(`[${prep.join(", ")}]`);

    for (const block of errorBlocks) result.push(...block);
    for (const [rule, blocks] of [...warningsByRule.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    )) {
      const count = blocks.length;
      const category = categorizeClippyLint(rule);
      if (count >= CLIPPY_WARNING_GROUP_THRESHOLD) {
        result.push(`warning[${rule}] (${category}): ${count} occurrences`);
        for (const block of blocks.slice(0, CLIPPY_WARNING_EXAMPLE_COUNT)) {
          for (const bline of block) result.push(`  ${bline}`);
        }
        if (count > CLIPPY_WARNING_EXAMPLE_COUNT)
          result.push(`  ... (${count - CLIPPY_WARNING_EXAMPLE_COUNT} more)`);
      } else {
        for (const block of blocks) result.push(...block);
      }
    }
    result.push(...summaryLines);
    result.push(...finishedLines);
    return result.length > 0 ? result.join("\n") : output;
  },
};

// ── Kubectl processor ───────────────────────────────────────────────────────────

// Optional kubectl global options before the subcommand (-n/-A/--context/...).
const KUBECTL_OPTS = String.raw`(?:-n\s+\S+\s+|--namespace(?:=|\s+)\S+\s+|--context(?:=|\s+)\S+\s+|--kubeconfig(?:=|\s+)\S+\s+|-A\s+|--all-namespaces\s+)*`;
const KUBECTL_SUBCMDS = String.raw`(get|describe|logs|top|apply|delete|create)`;
const KUBECTL_CMD_RE = new RegExp(String.raw`\b(kubectl|oc)\s+${KUBECTL_OPTS}${KUBECTL_SUBCMDS}\b`);
const READY_RE = /\b(\d+)\/(\d+)\b/;

function kubectlStripColumn(
  header: string,
  lines: string[],
  colName: string,
): { header: string; lines: string[] } {
  const m = new RegExp(`\\b${colName}\\b`).exec(header);
  if (!m) return { header, lines };
  const colStart = m.index;
  const rest = header.slice(m.index + m[0].length);
  const nextCol = /\S/.exec(rest);
  const colEnd = nextCol ? m.index + m[0].length + (nextCol.index ?? 0) : header.length;
  const newHeader = header.slice(0, colStart) + header.slice(colEnd);
  const newLines = lines.map((line) => {
    if (line.length >= colEnd) return line.slice(0, colStart) + line.slice(colEnd);
    if (line.length > colStart) return line.slice(0, colStart);
    return line;
  });
  return { header: newHeader, lines: newLines };
}

function kubectlGet(output: string): string {
  const lines = output.split("\n");
  if (lines.length <= 10) return output;
  let header = lines[0] ?? "";
  let entries = lines.slice(1);
  if (/\bAGE\b/.test(header))
    ({ header, lines: entries } = kubectlStripColumn(header, entries, "AGE"));
  const isPods = /STATUS/.test(header) && /READY/.test(header);
  if (!isPods) {
    if (entries.length > 50) {
      const result = [
        header,
        ...entries.slice(0, 40),
        `... (${entries.length - 40} more resources)`,
      ];
      return result.join("\n");
    }
    return [header, ...entries].join("\n");
  }
  const healthy: string[] = [];
  const unhealthy: string[] = [];
  for (const raw of entries) {
    const stripped = raw.trim();
    if (!stripped) continue;
    const isRunning = /\bRunning\b/.test(raw);
    const isCompleted = /\bCompleted\b/.test(raw);
    const rm = READY_RE.exec(raw);
    const allReady = rm ? rm[1] === rm[2] : false;
    if ((isRunning && allReady) || isCompleted) healthy.push(raw);
    else unhealthy.push(raw);
  }
  const result = [header];
  if (unhealthy.length > 0) result.push(...unhealthy);
  if (healthy.length > 5) result.push(`... (${healthy.length} pods Running/Ready)`);
  else result.push(...healthy);
  return result.join("\n");
}

function kubectlDescribe(output: string): string {
  const lines = output.split("\n");
  if (lines.length <= 15) return output;
  const result: string[] = [];
  let skipSection = false;
  let currentSection = "";
  const noiseKeys = new Set([
    "tolerations",
    "volumes",
    "qos class",
    "node-selectors",
    "annotations",
    "managed fields",
  ]);
  const keepKeys = new Set([
    "name",
    "namespace",
    "status",
    "state",
    "containers",
    "events",
    "conditions",
    "type",
    "reason",
    "message",
    "last state",
    "restart count",
    "port",
    "image",
    "node",
    "labels",
  ]);

  for (const line of lines) {
    const stripped = line.trim();
    // Top-level key-value lines (no leading whitespace).
    if (/^[A-Z][\w\s-]+:/.test(line) && !line.startsWith(" ") && !line.startsWith("\t")) {
      const key = line.split(":")[0]?.trim().toLowerCase() ?? "";
      if (noiseKeys.has(key)) {
        skipSection = true;
        currentSection = key;
        continue;
      }
      skipSection = false;
      currentSection = key;
      if (keepKeys.has(key)) result.push(line);
      continue;
    }
    if (skipSection) continue;
    if (currentSection === "events") {
      if (/Warning|Error|Failed/.test(line)) result.push(line);
      else if (/^\s*Type\s+Reason/.test(stripped)) result.push(line);
      else if (/Normal/.test(line)) continue;
      else result.push(line);
      continue;
    }
    if (/(State|Last State|Restart Count|Exit Code|Reason|Ready|Image):/.test(stripped)) {
      result.push(line);
      continue;
    }
    if (line.startsWith("  ") || line.startsWith("\t")) result.push(line);
  }
  return result.join("\n");
}

function kubectlLogs(output: string): string {
  const lines = output.split("\n");
  if (lines.length <= 5 + 10) return output;
  return compressLogLines(lines, { keepHead: 5, keepTail: 10, contextLines: 1 });
}

function kubectlMutate(output: string): string {
  const lines = output.split("\n");
  if (lines.length <= 20) return output;
  const result: string[] = [];
  for (const raw of lines) {
    const stripped = raw.trim();
    if (
      /\b(created|configured|unchanged|deleted|patched)\b/.test(stripped) ||
      /\b(error|Error|ERROR|warning|Warning)\b/.test(stripped) ||
      /\d+\s+resource/.test(stripped)
    ) {
      result.push(stripped);
    }
  }
  if (result.length === 0) return output;
  return result.join("\n");
}

/** Compress kubectl/oc get/describe/logs/apply output (pod roll-ups, log tails). */
export const kubectlOutputProcessor: OutputProcessor = {
  name: "kubectl",
  priority: 32,

  canHandle(command: string): boolean {
    return KUBECTL_CMD_RE.test(command);
  },

  process(command: string, output: string): string {
    if (!output || !output.trim()) return output;
    const m = KUBECTL_CMD_RE.exec(command);
    const subcmd = m ? (m[2] ?? "") : "";
    if (subcmd === "describe") return kubectlDescribe(output);
    if (subcmd === "logs") return kubectlLogs(output);
    if (subcmd === "get" || subcmd === "top") return kubectlGet(output);
    if (subcmd === "apply" || subcmd === "delete" || subcmd === "create")
      return kubectlMutate(output);
    return output;
  },
};

// ── Docker processor ────────────────────────────────────────────────────────────

// Optional docker global options before the subcommand (--context/-H/--host).
const DOCKER_OPTS = String.raw`(?:--context(?:=|\s+)\S+\s+|-H\s+\S+\s+|--host(?:=|\s+)\S+\s+)*`;
const DOCKER_CMD_RE = new RegExp(
  String.raw`\bdocker\s+${DOCKER_OPTS}(ps|images|logs|pull|push|inspect|stats|run|exec|compose\s+(?:ps|logs|up|down|build|run|exec))\b`,
);

/** Parse column start positions from a tabular header (python: runs of tokens). */
function parseColumns(header: string): Map<string, number> {
  const columns = new Map<string, number>();
  const re = /(\S+(?:\s\S+)*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header)) !== null) {
    columns.set(m[1] ?? "", m.index);
  }
  return columns;
}

function extractFields(line: string, colPositions: Map<string, number>): Map<string, string> {
  const sorted = [...colPositions.entries()].sort((a, b) => a[1] - b[1]);
  const fields = new Map<string, string>();
  for (let i = 0; i < sorted.length; i++) {
    const col = sorted[i];
    if (!col) continue;
    const [name, start] = col;
    const next = sorted[i + 1];
    const end = next ? next[1] : line.length;
    fields.set(name, start < line.length ? line.slice(start, end) : "");
  }
  return fields;
}

function dockerPs(output: string): string {
  const lines = output.split("\n");
  if (lines.length <= 2) return output;
  const header = lines[0] ?? "";
  const entries = lines.slice(1);
  const cols = parseColumns(header);
  if (cols.size === 0 || !cols.has("NAMES")) return output;
  const resultEntries: string[] = [];
  for (const line of entries) {
    if (!line.trim()) continue;
    const f = extractFields(line, cols);
    const name = (f.get("NAMES") ?? "").trim();
    const image = (f.get("IMAGE") ?? "").trim();
    const status = (f.get("STATUS") ?? "").trim();
    const ports = (f.get("PORTS") ?? "").trim();
    let entry = `  ${name}`;
    if (image) entry += `  (${image})`;
    if (status) entry += `  ${status}`;
    if (ports) entry += `  ${ports}`;
    resultEntries.push(entry);
  }
  const running = resultEntries.filter((e) => e.includes("Up "));
  const stopped = resultEntries.filter((e) => /\b(Exited|Created|Dead)\b/.test(e));
  const other = resultEntries.filter((e) => !running.includes(e) && !stopped.includes(e));
  const result = [`${entries.filter((l) => l.trim()).length} containers:`];
  if (running.length > 0) {
    result.push(`Running (${running.length}):`);
    result.push(...running);
  }
  if (stopped.length > 0) {
    if (stopped.length > 10) {
      const names = stopped
        .slice(0, 5)
        .map((s) => s.trim().split(/\s+/)[0] ?? "")
        .join(", ");
      result.push(`Stopped (${stopped.length}): ${names} ... +${stopped.length - 5} more`);
    } else {
      result.push(`Stopped (${stopped.length}):`);
      result.push(...stopped);
    }
  }
  if (other.length > 0) result.push(...other);
  return result.join("\n");
}

function dockerImages(output: string): string {
  const lines = output.split("\n");
  if (lines.length <= 2) return output;
  const header = lines[0] ?? "";
  const entries = lines.slice(1);
  const cols = parseColumns(header);
  if (cols.size === 0) return output;
  const realImages: string[] = [];
  let danglingCount = 0;
  for (const line of entries) {
    if (!line.trim()) continue;
    const f = extractFields(line, cols);
    const repo = (f.get("REPOSITORY") ?? "").trim();
    const tag = (f.get("TAG") ?? "").trim();
    const size = (f.get("SIZE") ?? "").trim();
    if (repo === "<none>" || tag === "<none>") {
      danglingCount += 1;
      continue;
    }
    realImages.push(`  ${repo}:${tag}  ${size}`);
  }
  const result = [`${entries.filter((l) => l.trim()).length} images:`];
  if (realImages.length > 30) {
    result.push(...realImages.slice(0, 20));
    result.push(`  ... (${realImages.length - 20} more)`);
  } else {
    result.push(...realImages);
  }
  if (danglingCount > 0) result.push(`  (${danglingCount} dangling images)`);
  return result.join("\n");
}

function dockerComposeLogs(lines: string[], composeRe: RegExp): string {
  const serviceLines = new Map<string, string[]>();
  for (const line of lines) {
    const m = composeRe.exec(line);
    if (m) {
      const service = m[1] ?? "";
      const list = serviceLines.get(service) ?? [];
      list.push(line);
      serviceLines.set(service, list);
    } else {
      const list = serviceLines.get("_other") ?? [];
      list.push(line);
      serviceLines.set("_other", list);
    }
  }
  const result = [`${lines.length} log lines across ${serviceLines.size} services:`];
  for (const [service, svcLines] of [...serviceLines.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    if (service === "_other") continue;
    const errorCount = svcLines.filter((ln) =>
      /\b(error|ERROR|exception|fatal|FATAL|panic)\b/i.test(ln),
    ).length;
    result.push(`\n--- ${service} (${svcLines.length} lines, ${errorCount} errors) ---`);
    const errorsShown: string[] = [];
    for (let i = 0; i < svcLines.length; i++) {
      const line = svcLines[i] ?? "";
      if (/\b(error|ERROR|exception|fatal|FATAL|panic)\b/i.test(line)) {
        const start = Math.max(0, i - 1);
        const end = Math.min(svcLines.length, i + 2);
        for (const el of svcLines.slice(start, end)) {
          if (!errorsShown.includes(el)) errorsShown.push(el);
        }
      }
    }
    if (errorsShown.length > 0) result.push(...errorsShown.slice(0, 20));
    for (const line of svcLines.slice(-3)) {
      if (!errorsShown.includes(line)) result.push(line);
    }
  }
  return result.join("\n");
}

function dockerLogs(output: string): string {
  const lines = output.split("\n");
  if (lines.length <= 5 + 10) return output;
  const composeRe = /^(\S+)\s+\|\s+(.*)$/;
  const isCompose = lines.slice(0, 20).some((l) => composeRe.test(l));
  if (isCompose) return dockerComposeLogs(lines, composeRe);
  return compressLogLines(lines, { keepHead: 5, keepTail: 10, contextLines: 2 });
}

function dockerPull(output: string): string {
  const lines = output.split("\n");
  const result: string[] = [];
  for (const raw of lines) {
    const stripped = raw.trim();
    if (
      /^[0-9a-f]+:\s*(Downloading|Extracting|Pulling|Waiting|Verifying|Download complete|Pull complete|Already exists)/.test(
        stripped,
      )
    )
      continue;
    if (/\d+(\.\d+)?%/.test(stripped) && /\[=*>?\s*\]/.test(stripped)) continue;
    result.push(stripped);
  }
  return result.length > 0 ? result.join("\n") : output;
}

function dockerInspect(output: string): string {
  const lines = output.split("\n");
  const raw = lines.join("\n");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    if (lines.length > 50)
      return lines.slice(0, 40).join("\n") + `\n... (${lines.length - 40} more lines)`;
    return output;
  }
  if (Array.isArray(data) && data.length === 1) data = data[0];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    if (lines.length > 50)
      return lines.slice(0, 40).join("\n") + `\n... (${lines.length - 40} more lines)`;
    return output;
  }
  const obj = data as Record<string, unknown>;
  const result: string[] = [];
  const importantKeys = [
    "Id",
    "Name",
    "State",
    "Config",
    "NetworkSettings",
    "Image",
    "Created",
    "Platform",
    "Status",
  ];
  for (const key of importantKeys) {
    const val = obj[key];
    if (val === undefined) continue;
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const nested = val as Record<string, unknown>;
      const subKeys = Object.keys(nested);
      if (key === "State") {
        result.push(`${key}:`);
        for (const [sk, sv] of Object.entries(nested)) {
          if (typeof sv === "string" || typeof sv === "number" || typeof sv === "boolean")
            result.push(`  ${sk}: ${sv}`);
        }
      } else if (key === "Config") {
        result.push(`${key}:`);
        for (const sk of ["Image", "Cmd", "Env", "ExposedPorts", "Labels"]) {
          const sv = nested[sk];
          if (sv === undefined) continue;
          if (Array.isArray(sv) && sv.length > 5) result.push(`  ${sk}: [${sv.length} items]`);
          else if (
            sv &&
            typeof sv === "object" &&
            !Array.isArray(sv) &&
            Object.keys(sv as object).length > 5
          ) {
            result.push(`  ${sk}: {${Object.keys(sv as object).length} keys}`);
          } else {
            const svStr = String(sv);
            result.push(`  ${sk}: ${svStr.length > 120 ? svStr.slice(0, 100) + "..." : svStr}`);
          }
        }
      } else if (key === "NetworkSettings") {
        result.push(`${key}:`);
        if (nested.Ports !== undefined) result.push(`  Ports: ${String(nested.Ports)}`);
        if (
          nested.Networks &&
          typeof nested.Networks === "object" &&
          !Array.isArray(nested.Networks)
        ) {
          for (const [netName, netInfo] of Object.entries(
            nested.Networks as Record<string, Record<string, unknown>>,
          )) {
            const ip = netInfo?.IPAddress ?? "";
            result.push(`  ${netName}: ${String(ip)}`);
          }
        }
      } else {
        result.push(`${key}: {${subKeys.length} keys}`);
      }
    } else if (typeof val === "string") {
      result.push(`${key}: ${val.length > 100 ? val.slice(0, 80) + "..." : val}`);
    } else {
      result.push(`${key}: ${String(val)}`);
    }
  }
  if (result.length === 0) {
    const topKeys = Object.keys(obj);
    result.push(`docker inspect: ${topKeys.length} top-level keys`);
    for (const k of topKeys.slice(0, 15)) {
      const v = obj[k];
      if (v && typeof v === "object" && !Array.isArray(v))
        result.push(`  ${k}: {${Object.keys(v as object).length} keys}`);
      else if (Array.isArray(v)) result.push(`  ${k}: [${v.length} items]`);
      else {
        const sv = String(v);
        result.push(`  ${k}: ${sv.length > 80 ? sv.slice(0, 60) + "..." : sv}`);
      }
    }
  }
  result.push(`\n(${lines.length} total lines)`);
  return result.join("\n");
}

function dockerStats(output: string): string {
  const lines = output.split("\n");
  if (lines.length <= 15) return output;
  let lastHeader = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.includes("CONTAINER") && line.includes("CPU")) lastHeader = i;
  }
  if (lastHeader >= 0) return lines.slice(lastHeader).join("\n");
  return output;
}

function dockerComposeUp(output: string): string {
  const lines = output.split("\n");
  if (lines.length <= 20) return output;
  const result: string[] = [];
  for (const raw of lines) {
    const stripped = raw.trim();
    if (
      /(Created|Started|Running|Healthy|Error|error|failed)/i.test(stripped) ||
      /(Network|Volume)\s+\S+\s+(Created|Found)/.test(stripped) ||
      (/(Pulling|Building|Creating|Starting)/.test(stripped) && !/\d+%/.test(stripped))
    ) {
      result.push(stripped);
    }
  }
  if (result.length === 0) return lines.slice(-10).join("\n");
  return result.join("\n");
}

function dockerComposeDown(output: string): string {
  const lines = output.split("\n");
  if (lines.length <= 15) return output;
  const result: string[] = [];
  for (const raw of lines) {
    const stripped = raw.trim();
    if (
      /(Stopped|Removed|Removing|removed)/i.test(stripped) ||
      /(Network|Volume)\s+\S+\s+(Removed|removed)/.test(stripped)
    ) {
      result.push(stripped);
    }
  }
  if (result.length === 0) return lines.slice(-10).join("\n");
  return result.join("\n");
}

/** Compress docker ps/images/logs/pull/inspect/stats/compose output. */
export const dockerProcessor: OutputProcessor = {
  name: "docker",
  priority: 31,

  canHandle(command: string): boolean {
    return DOCKER_CMD_RE.test(command);
  },

  process(command: string, output: string): string {
    if (!output || !output.trim()) return output;
    const m = DOCKER_CMD_RE.exec(command);
    const subcmd = m ? (m[1] ?? "") : "";
    if (subcmd.startsWith("compose")) {
      if (subcmd.includes("ps")) return dockerPs(output);
      if (subcmd.includes("logs")) return dockerLogs(output);
      if (subcmd.includes("up")) return dockerComposeUp(output);
      if (subcmd.includes("down")) return dockerComposeDown(output);
      // "compose run/exec" and (in python's own priority order) compose build is
      // shadowed by the build processor — run/exec outputs are app logs.
      return dockerLogs(output);
    }
    if (subcmd === "ps") return dockerPs(output);
    if (subcmd === "images") return dockerImages(output);
    if (subcmd === "logs") return dockerLogs(output);
    if (subcmd === "pull" || subcmd === "push") return dockerPull(output);
    if (subcmd === "inspect") return dockerInspect(output);
    if (subcmd === "stats") return dockerStats(output);
    if (subcmd === "run" || subcmd === "exec") return dockerLogs(output);
    return output;
  },
};

// ── Terraform processor ─────────────────────────────────────────────────────────

const TF_CMD_RE = new RegExp(
  String.raw`\b(terraform|tofu)\s+(plan|apply|destroy|init|output|validate|fmt|state\s+(?:list|show))\b`,
);

function tfPlanApply(lines: string[]): string {
  const result: string[] = [];
  let inResourceBlock = false;
  let resourceAction = "";
  for (const line of lines) {
    const stripped = line.trim();
    if (/^(Initializing|Acquiring|Installing|Reusing)\s+/.test(stripped)) continue;
    if (/^-\s+Installed\s+/.test(stripped)) continue;
    if (/^(Initializing the backend|Successfully configured)/.test(stripped)) continue;

    // Resource change header: # resource.name will be created/destroyed/updated.
    if (/^#\s+\S+/.test(stripped)) {
      inResourceBlock = true;
      resourceAction = "";
      result.push(line);
      if (stripped.includes("will be created")) resourceAction = "+";
      else if (stripped.includes("will be destroyed")) resourceAction = "-";
      else if (stripped.includes("will be updated") || stripped.includes("must be replaced"))
        resourceAction = "~";
      continue;
    }
    // Resource block boundary.
    if (inResourceBlock && /^\s*[+~-]\s+resource\s+/.test(stripped)) {
      result.push(line);
      continue;
    }
    if (inResourceBlock && stripped === "}") {
      inResourceBlock = false;
      result.push(line);
      continue;
    }
    // Inside a resource block — filter attributes.
    if (inResourceBlock) {
      if (stripped.includes("->") || /^\s*[~+-]/.test(stripped)) {
        result.push(line);
        continue;
      }
      if (stripped.includes("(known after apply)")) {
        result.push(line);
        continue;
      }
      if (stripped.includes("forces replacement")) {
        result.push(line);
        continue;
      }
      if (resourceAction === "+") {
        result.push(line);
        continue;
      }
      // Destroy (-) needs just its header; update (~) drops unchanged attrs.
      continue;
    }
    if (/^Plan:/.test(stripped)) {
      result.push(line);
      continue;
    }
    if (/^(Apply complete|Destroy complete|No changes)/.test(stripped)) {
      result.push(line);
      continue;
    }
    if (/^Changes to Outputs:/.test(stripped)) {
      result.push(line);
      continue;
    }
    if (/^\s*[+~-]\s+\w+\s*=/.test(stripped)) {
      result.push(line);
      continue;
    }
    if (/\b(Error|Warning|error|warning)\b/.test(stripped)) {
      result.push(line);
      continue;
    }
    if (/^Note:/.test(stripped)) {
      result.push(line);
      continue;
    }
    if (
      !stripped &&
      !inResourceBlock &&
      result.length > 0 &&
      (result[result.length - 1] ?? "").trim()
    ) {
      result.push(line);
    }
  }
  return result.length > 0 ? result.join("\n") : lines.join("\n");
}

function tfInit(lines: string[]): string {
  const result: string[] = [];
  for (const raw of lines) {
    const stripped = raw.trim();
    if (/\bv\d+\.\d+/.test(stripped) && /^-\s+/.test(stripped)) {
      result.push(stripped);
      continue;
    }
    if (/(successfully initialized|has been successfully|Terraform has been)/i.test(stripped)) {
      result.push(stripped);
      continue;
    }
    if (/\b(Error|Warning|error|warning)\b/.test(stripped)) {
      result.push(stripped);
      continue;
    }
    if (/(upgrade available|new version|rerun with -upgrade)/i.test(stripped)) {
      result.push(stripped);
      continue;
    }
    if (/^(Initializing|Acquiring|Installing|Reusing|Finding|Using)\s+/.test(stripped)) continue;
  }
  return result.length > 0 ? result.join("\n") : lines.join("\n");
}

function truncateLongLines(lines: string[], keyRe: RegExp): string[] {
  return lines.map((line) => {
    if (line.length <= 200) return line;
    const m = keyRe.exec(line);
    if (m && m[1]) return `${m[1]}... (${line.length} chars)`;
    return line.slice(0, 150) + `... (${line.length} chars)`;
  });
}

function tfState(lines: string[]): string {
  // state list: plain resource names per line.
  const onlyNames = lines.every((l) => !l.trim() || /^\S/.test(l));
  if (onlyNames) {
    const byType = new Map<string, number>();
    for (const raw of lines) {
      const stripped = raw.trim();
      if (!stripped) continue;
      const parts = stripped.split(".");
      let classified = false;
      for (const part of parts) {
        if (/^[a-z]+_/.test(part)) {
          byType.set(part, (byType.get(part) ?? 0) + 1);
          classified = true;
          break;
        }
      }
      if (!classified) byType.set(stripped, (byType.get(stripped) ?? 0) + 1);
    }
    const result = [`${lines.filter((l) => l.trim()).length} resources in state:`];
    for (const [rtype, count] of [...byType.entries()].sort((a, b) => b[1] - a[1]))
      result.push(`  ${rtype}: ${count}`);
    return result.join("\n");
  }
  // state show: truncate long attribute values.
  const result = truncateLongLines(lines, /^(\s*\S+\s*=\s*)/);
  if (result.length > 80)
    return result.slice(0, 60).join("\n") + `\n... (${result.length - 60} more lines)`;
  return result.join("\n");
}

/** Compress terraform/tofu plan/apply/init/output/state output. */
export const terraformProcessor: OutputProcessor = {
  name: "terraform",
  priority: 33,

  canHandle(command: string): boolean {
    return TF_CMD_RE.test(command);
  },

  process(command: string, output: string): string {
    if (!output || !output.trim()) return output;
    const m = TF_CMD_RE.exec(command);
    const subcmd = m ? (m[2] ?? "") : "";
    // splitlines semantics: drop the single trailing empty line before counting,
    // so the line-count gates below match python's splitlines() exactly.
    const lines = output.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (subcmd === "init") {
      if (lines.length <= 20) return output;
      return tfInit(lines);
    }
    if (subcmd === "output") {
      if (lines.length <= 30) return output;
      return truncateLongLines(lines, /^(\S+\s*=\s*)/).join("\n");
    }
    if (subcmd.startsWith("state")) {
      if (lines.length <= 30) return output;
      return tfState(lines);
    }
    if (lines.length <= 30) return output;
    return tfPlanApply(lines);
  },
};

// ── File-content processor (token-saver file_content.py port) ───────────────────
//
// Strict two-category dispatch: source code and sensitive config files are NEVER
// compressed (the model patches them — one missing line means a wrong patch);
// data/structured files (JSON/YAML/TOML/XML/logs/CSV/lock files/docs/unknown)
// are compressed structure-preserving when long enough. python's max_file_lines
// gate (100) applies after the source/sensitive pass-throughs.

const FC_MAX_FILE_LINES = 100;
const FC_KEEP_HEAD = 80;
const FC_KEEP_TAIL = 30;
const FC_LOG_KEEP_HEAD = 5;
const FC_LOG_KEEP_TAIL = 5;
const FC_LOG_CONTEXT = 2;
const FC_CSV_HEAD_ROWS = 3;
const FC_CSV_TAIL_ROWS = 2;

const FC_SOURCE_CODE_EXTENSIONS = new Set([
  ".py",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".scala",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".ex",
  ".exs",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".lua",
  ".r",
  ".m",
  ".vb",
  ".pl",
  ".pm",
  ".hs",
  ".ml",
  ".vue",
  ".svelte",
  ".dart",
  ".zig",
  ".nim",
  ".v",
  ".groovy",
  ".sql",
  ".tf",
  ".hcl",
]);

const FC_SENSITIVE_CONFIG_EXTENSIONS = new Set([".env", ".ini", ".cfg", ".conf"]);

const FC_MINIFIABLE_SOURCE_EXTENSIONS = new Set([".js", ".ts", ".jsx", ".tsx", ".css", ".html"]);

const FC_LOCK_FILENAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "Pipfile.lock",
  "Cargo.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
  "bun.lockb",
]);

const FC_STRUCTURED_EXTENSIONS: Record<string, string> = {
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
};

const FC_LOG_EXTENSIONS = new Set([".log"]);
const FC_CSV_EXTENSIONS = new Set([".csv", ".tsv"]);
const FC_DOC_EXTENSIONS = new Set([".md", ".rst"]);

const FC_LOG_LEVEL_RE =
  /(\d{4}[-/]\d{2}[-/]\d{2}|^\d{2}:\d{2}:\d{2}|\[(INFO|DEBUG|WARN|WARNING|ERROR|FATAL|CRITICAL|TRACE)\]|\b(INFO|DEBUG|WARN|WARNING|ERROR|FATAL|CRITICAL|TRACE)\s|^\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})/i;

const FC_LOG_ERROR_RE =
  /\b(ERROR|FATAL|CRITICAL|PANIC|EXCEPTION)\b|\bWARN(ING)?\b|\[(ERROR|FATAL|CRITICAL|WARN|WARNING)\]/i;

const FC_SENSITIVE_PATTERNS = new RegExp(
  String.raw`SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|PRIVATE|ENCRYPT|CERTIFICATE|APIKEY|API_KEY|ACCESS_KEY|AWS_SECRET|DATABASE_URL|DATABASE_PASSWORD|MONGODB_URI|REDIS_URL|CONNECTION_STRING|STRIPE_|TWILIO_|SENDGRID_|GITHUB_TOKEN|NPM_TOKEN|WEBHOOK|BEARER|(?<![A-Za-z])(?:KEY|KEYS|TOKEN|AUTH|PAT|DSN|PASS|PWD|PEM|CERT)(?![A-Za-z])`,
  "i",
);

const FC_FILE_CMD_RE = /^\s*(?:\S+\/)?(cat|head|tail|less|more|bat)\b/;

/** Flags that consume the next token only when it is numeric (head -n 50). */
function fcFileArgs(command: string): string[] {
  const parts = command.split(/\s+/);
  const args: string[] = [];
  const valueFlags = new Set(["-n", "-c", "--lines", "--bytes"]);
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.startsWith("-")) {
      const nxt = parts[i + 1] ?? "";
      if (valueFlags.has(part) && /^[+-]?\d+$/.test(nxt)) i += 1;
      continue;
    }
    args.push(part);
  }
  return args;
}

function fcBasename(part: string): string {
  const slash = part.lastIndexOf("/");
  const back = part.lastIndexOf("\\");
  return part.slice(Math.max(slash, back) + 1);
}

function fcExtractExtension(command: string): string {
  for (const part of fcFileArgs(command)) {
    const basename = fcBasename(part);
    if (basename.startsWith(".") && !basename.slice(1).includes(".")) {
      return "." + basename.slice(1).toLowerCase();
    }
    const dotPos = basename.lastIndexOf(".");
    if (dotPos > 0) return "." + basename.slice(dotPos + 1).toLowerCase();
  }
  return "";
}

function fcExtractFilename(command: string): string {
  for (const part of fcFileArgs(command)) {
    return fcBasename(part);
  }
  return "";
}

function fcIsMinified(ext: string, filename: string, output: string): boolean {
  if (/\.min\.(js|css|html)$/i.test(filename)) return true;
  if (/\.bundle\.(js|css)$/i.test(filename)) return true;
  const protectedSource =
    (FC_SOURCE_CODE_EXTENSIONS.has(ext) || FC_SENSITIVE_CONFIG_EXTENSIONS.has(ext)) &&
    !FC_MINIFIABLE_SOURCE_EXTENSIONS.has(ext);
  if (protectedSource) return false;
  const lines = output.split("\n");
  if (lines.length <= 3 && output.length > 5000) return true;
  return lines.length > 0 && output.length / lines.length > 500;
}

function fcIsEnvFileToRedact(filename: string): boolean {
  if (filename === ".env" || filename === ".env.example" || filename === ".env.template")
    return false;
  return /^\.env\..+$/i.test(filename);
}

function fcCompressEnvFile(lines: string[]): string {
  const result: string[] = [];
  let redacted = 0;
  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) {
      result.push(line);
      continue;
    }
    const eq = stripped.indexOf("=");
    if (eq >= 0) {
      const key = stripped.slice(0, eq);
      if (FC_SENSITIVE_PATTERNS.test(key)) {
        result.push(`${key}=***`);
        redacted += 1;
      } else {
        result.push(line);
      }
    } else {
      result.push(line);
    }
  }
  if (redacted > 0) result.push(`\n(${redacted} sensitive values redacted)`);
  return result.join("\n");
}

function fcOutputStart(lines: string[]): string {
  for (const line of lines) {
    const stripped = line.trim();
    if (stripped) return stripped[0]!;
  }
  return "";
}

function fcLooksLikeCsv(sample: string[]): boolean {
  if (sample.length < 3) return false;
  for (const sep of [",", "\t"]) {
    const counts: number[] = [];
    for (const line of sample) {
      if (line.trim()) counts.push(line.split(sep).length - 1);
    }
    if (counts.length >= 3 && counts[0]! >= 2 && counts.slice(0, 5).every((c) => c === counts[0]))
      return true;
  }
  return false;
}

/** Recursively compress a parsed JSON value (utils.compress_json_value port). */
function fcCompressJsonValue(
  value: unknown,
  depth: number,
  maxDepth: number,
  importantKeyRe: RegExp | null,
): unknown {
  if (depth >= maxDepth) {
    if (Array.isArray(value)) return `[... ${value.length} items]`;
    if (value !== null && typeof value === "object") {
      return `{... ${Object.keys(value as object).length} keys}`;
    }
    if (typeof value === "string" && value.length > 200) return value.slice(0, 197) + "...";
    return value;
  }
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) {
      if (value.length === 0) return value;
      if (value.length <= 5) {
        return value.map((item) => fcCompressJsonValue(item, depth, maxDepth, importantKeyRe));
      }
      const compressed = value
        .slice(0, 3)
        .map((item) => fcCompressJsonValue(item, depth, maxDepth, importantKeyRe));
      compressed.push(`... (${value.length - 3} more items)`);
      return compressed;
    }
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (importantKeyRe !== null && importantKeyRe.test(k)) {
        result[k] = fcCompressJsonValue(v, depth, maxDepth + 1, importantKeyRe);
      } else {
        result[k] = fcCompressJsonValue(v, depth + 1, maxDepth, importantKeyRe);
      }
    }
    return result;
  }
  if (typeof value === "string" && value.length > 200) return value.slice(0, 197) + "...";
  return value;
}

function fcCompressLockFile(lines: string[], ext: string, filename: string): string {
  const total = lines.length;
  const raw = lines.join("\n");
  if (filename === "package-lock.json") return fcCompressNpmLock(raw, total);
  if (filename === "yarn.lock" || filename === "Gemfile.lock")
    return fcCompressYarnLock(lines, total);
  if (filename === "poetry.lock") return fcCompressTomlLock(lines, total, "poetry.lock");
  if (filename === "Cargo.lock") return fcCompressTomlLock(lines, total, "Cargo.lock");
  if (filename === "composer.lock" || filename === "Pipfile.lock")
    return fcCompressJsonLock(raw, total);
  if (filename === "go.sum") return fcCompressGoSum(lines, total);
  return fcTruncateDefault(lines);
}

function fcCompressNpmLock(raw: string, total: number): string {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return fcTruncateDefault(raw.split("\n"));
  }
  const deps = new Map<string, string>();
  const packages = (data["packages"] ?? null) as Record<string, { version?: string }> | null;
  if (packages) {
    for (const [path, info] of Object.entries(packages)) {
      if (!path) continue;
      const name = path.split("node_modules/").pop()!;
      const version = info?.version ?? "?";
      if (!name.includes("node_modules/")) deps.set(name, version);
    }
  } else {
    const dependencies = (data["dependencies"] ?? {}) as Record<
      string,
      { version?: string } | string
    >;
    for (const [name, info] of Object.entries(dependencies)) {
      deps.set(name, typeof info === "object" && info !== null ? (info.version ?? "?") : "?");
    }
  }
  const result = [`package-lock.json (${deps.size} dependencies, ${total} lines):`];
  for (const [name, version] of [...deps.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    result.push(`  ${name}@${version}`);
  }
  return result.join("\n");
}

function fcCompressYarnLock(lines: string[], total: number): string {
  const deps: string[] = [];
  for (const line of lines) {
    const stripped = line.trim();
    if (stripped && !stripped.startsWith("#") && stripped.endsWith(":")) {
      deps.push(stripped.slice(0, -1).replace(/"/g, ""));
    }
    if (stripped.startsWith("version ")) {
      const version = stripped.includes('"')
        ? stripped.split('"')[1]!
        : stripped.split(/\s+/).pop()!;
      if (deps.length > 0) {
        const last = deps[deps.length - 1]!;
        if (!last.split(",")[0]!.split("@").pop()!.includes("@")) {
          deps[deps.length - 1] = `${last} -> ${version}`;
        }
      }
    }
  }
  const result = [`lock file (${deps.length} entries, ${total} lines):`];
  for (const d of deps.slice(0, 50)) result.push(`  ${d}`);
  if (deps.length > 50) result.push(`  ... (${deps.length - 50} more)`);
  return result.join("\n");
}

function fcCompressTomlLock(lines: string[], total: number, label: string): string {
  const deps: string[] = [];
  let currentName: string | null = null;
  for (const line of lines) {
    const stripped = line.trim();
    if (stripped === "[[package]]") {
      currentName = null;
    } else if (stripped.startsWith("name = ")) {
      currentName = stripped.includes('"')
        ? stripped.split('"')[1]!
        : stripped.split("=")[1]!.trim();
    } else if (stripped.startsWith("version = ") && currentName) {
      const val = stripped.includes('"') ? stripped.split('"')[1]! : stripped.split("=")[1]!.trim();
      deps.push(`${currentName}@${val}`);
      currentName = null;
    }
  }
  const result = [`${label} (${deps.length} packages, ${total} lines):`];
  for (const d of deps.slice(0, 50)) result.push(`  ${d}`);
  if (deps.length > 50) result.push(`  ... (${deps.length - 50} more)`);
  return result.join("\n");
}

function fcCompressJsonLock(raw: string, total: number): string {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return fcTruncateDefault(raw.split("\n"));
  }
  const deps: string[] = [];
  for (const pkg of (data["packages"] ?? []) as unknown[]) {
    if (pkg !== null && typeof pkg === "object") {
      const p = pkg as Record<string, unknown>;
      deps.push(`${String(p["name"] ?? "?")}@${String(p["version"] ?? "?")}`);
    }
  }
  for (const section of ["default", "develop"]) {
    const sec = (data[section] ?? {}) as Record<string, unknown>;
    for (const [name, info] of Object.entries(sec)) {
      const version =
        info !== null && typeof info === "object"
          ? ((info as Record<string, unknown>)["version"] ?? "?")
          : "?";
      deps.push(`${name}@${String(version)}`);
    }
  }
  const result = [`lock file (${deps.length} packages, ${total} lines):`];
  for (const d of deps.slice(0, 50)) result.push(`  ${d}`);
  if (deps.length > 50) result.push(`  ... (${deps.length - 50} more)`);
  return result.join("\n");
}

function fcCompressGoSum(lines: string[], total: number): string {
  const modules = new Set<string>();
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) {
      modules.add(`${parts[0]}@${parts[1]!.split("/")[0]}`);
    }
  }
  const sortedMods = [...modules].sort();
  const result = [`go.sum (${sortedMods.length} modules, ${total} lines):`];
  for (const m of sortedMods.slice(0, 50)) result.push(`  ${m}`);
  if (sortedMods.length > 50) result.push(`  ... (${sortedMods.length - 50} more)`);
  return result.join("\n");
}

function fcCompressStructured(lines: string[], fmt: string): string {
  const total = lines.length;
  const raw = lines.join("\n");
  if (fmt === "json") return fcCompressJson(raw, total);
  if (fmt === "yaml") return fcCompressYaml(lines, total);
  if (fmt === "toml") return fcCompressToml(lines, total);
  if (fmt === "xml") return fcCompressXml(lines, total);
  return fcTruncateDefault(lines);
}

function fcCompressJson(raw: string, total: number): string {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return fcTruncateDefault(raw.split("\n"));
  }
  const compressed = fcCompressJsonValue(data, 0, 2, null);
  const result = JSON.stringify(compressed, null, 2);
  return `${result}\n\n(${total} total lines)`;
}

function fcCompressYaml(lines: string[], total: number): string {
  const result: string[] = [];
  let nestedCount = 0;
  for (const line of lines) {
    const stripped = line.trimStart();
    const indent = line.length - stripped.length;
    if (indent <= 2 && stripped && !stripped.startsWith("#")) {
      if (stripped.includes(": ") && stripped.length > 120) {
        const keyPart = stripped.split(": ", 1)[0]!;
        result.push(`${line.slice(0, indent)}${keyPart}: ... (truncated)`);
      } else {
        result.push(line);
      }
    } else {
      nestedCount += 1;
    }
  }
  if (nestedCount > 0) result.push(`\n  ... (${nestedCount} nested lines omitted)`);
  result.push(`\n(${total} total lines)`);
  return result.join("\n");
}

function fcCompressToml(lines: string[], total: number): string {
  const result: string[] = [];
  let nestedCount = 0;
  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    if (stripped.startsWith("[")) {
      result.push(line);
    } else if (stripped.includes("=") && !line.startsWith(" ") && !line.startsWith("\t")) {
      if (stripped.length > 120) {
        const keyPart = stripped.split("=", 1)[0]!.trim();
        result.push(`${keyPart} = ... (truncated)`);
      } else {
        result.push(line);
      }
    } else {
      nestedCount += 1;
    }
  }
  if (nestedCount > 0) result.push(`  ... (${nestedCount} additional lines omitted)`);
  result.push(`\n(${total} total lines)`);
  return result.join("\n");
}

function fcCompressXml(lines: string[], total: number): string {
  const result: string[] = [];
  let nestedCount = 0;
  for (const line of lines) {
    const stripped = line.trimStart();
    const indent = line.length - stripped.length;
    if (indent <= 4 || stripped.startsWith("<?") || stripped.startsWith("<!")) {
      result.push(line);
    } else {
      nestedCount += 1;
    }
  }
  if (nestedCount > 0) result.push(`  ... (${nestedCount} nested lines omitted)`);
  result.push(`\n(${total} total lines)`);
  return result.join("\n");
}

function fcCompressLog(lines: string[]): string {
  return compressLogLines(lines, {
    keepHead: FC_LOG_KEEP_HEAD,
    keepTail: FC_LOG_KEEP_TAIL,
    errorRe: FC_LOG_ERROR_RE,
    contextLines: FC_LOG_CONTEXT,
  });
}

function fcCompressCsv(lines: string[]): string {
  const total = lines.length;
  const header = lines[0] ?? "";
  const sep = header.includes("\t") ? "\t" : ",";
  const colCount = header.split(sep).length;
  const dataLines = lines.slice(1);
  if (dataLines.length <= FC_CSV_HEAD_ROWS + FC_CSV_TAIL_ROWS) return lines.join("\n");
  const result = [lines[0]!];
  result.push(...dataLines.slice(0, FC_CSV_HEAD_ROWS));
  const omitted = dataLines.length - FC_CSV_HEAD_ROWS - FC_CSV_TAIL_ROWS;
  result.push(`... (${omitted} rows omitted)`);
  result.push(...dataLines.slice(-FC_CSV_TAIL_ROWS));
  result.push(`\n(${total - 1} data rows, ${colCount} columns)`);
  return result.join("\n");
}

function fcTruncateDefault(lines: string[]): string {
  const total = lines.length;
  const head = lines.slice(0, FC_KEEP_HEAD);
  const tail = lines.slice(-FC_KEEP_TAIL);
  const truncated = total - head.length - tail.length;
  if (truncated <= 0) return lines.join("\n");
  return [
    ...head,
    `\n... (${truncated} lines truncated, ${total} total lines) ...\n`,
    ...tail,
  ].join("\n");
}

function fcDetectHeuristic(lines: string[]): string {
  const sample = lines.slice(0, 200);
  const logMatches = sample.filter((line) => FC_LOG_LEVEL_RE.test(line)).length;
  if (logMatches > sample.length * 0.3) return "log";
  const firstChar = fcOutputStart(lines);
  if (firstChar === "{" || firstChar === "[") return "json";
  if (fcLooksLikeCsv(lines.slice(0, 10))) return "csv";
  return "unknown";
}

/** Compress file-viewing output: cat/head/tail/less/more/bat (file_content.py). */
export const fileContentProcessor: OutputProcessor = {
  name: "file_content",
  priority: 51,

  canHandle(command: string): boolean {
    return FC_FILE_CMD_RE.test(command);
  },

  process(command: string, output: string): string {
    if (!output || !output.trim()) return output;
    const ext = fcExtractExtension(command);
    const filename = fcExtractFilename(command);

    if (fcIsMinified(ext, filename, output)) {
      const lines = output.split("\n");
      const totalChars = output.length;
      const totalLines = lines.length;
      const preview = output.slice(0, 200).replace(/\n/g, " ");
      return `[minified file: ${filename || "unknown"}, ${totalChars.toLocaleString("en-US")} chars, ${totalLines} lines]\nPreview: ${preview}...`;
    }

    if (fcIsEnvFileToRedact(filename)) return fcCompressEnvFile(output.split("\n"));

    if (FC_SOURCE_CODE_EXTENSIONS.has(ext)) return output;
    if (FC_SENSITIVE_CONFIG_EXTENSIONS.has(ext)) return output;

    const lines = output.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length <= FC_MAX_FILE_LINES) return output;

    if (FC_LOCK_FILENAMES.has(filename)) return fcCompressLockFile(lines, ext, filename);
    const structuredType = FC_STRUCTURED_EXTENSIONS[ext];
    if (structuredType) return fcCompressStructured(lines, structuredType);
    if (FC_LOG_EXTENSIONS.has(ext)) return fcCompressLog(lines);
    if (FC_CSV_EXTENSIONS.has(ext)) return fcCompressCsv(lines);
    if (FC_DOC_EXTENSIONS.has(ext)) return fcTruncateDefault(lines);

    const detected = fcDetectHeuristic(lines);
    if (detected === "log") return fcCompressLog(lines);
    if (detected === "json") return fcCompressStructured(lines, "json");
    if (detected === "csv") return fcCompressCsv(lines);

    return fcTruncateDefault(lines);
  },
};

// ── Convenience composition ─────────────────────────────────────────────────────

/** The campaign-shipped processor set, ordered by priority inside the engine. */
export const defaultOutputProcessors: readonly OutputProcessor[] = [
  packageListProcessor,
  gitOutputProcessor,
  buildOutputProcessor,
  testOutputProcessor,
  cargoClippyProcessor,
  lintOutputProcessor,
  dockerProcessor,
  kubectlOutputProcessor,
  terraformProcessor,
  searchProcessor,
  structuredLogProcessor,
  fileListingProcessor,
  fileContentProcessor,
  genericProcessor,
];

/**
 * Compress command output through the default processor set. Mirrors
 * token-saver's `CompressionEngine().compress(command, output)` entry point.
 */
export function compressOutputForCommand(
  command: string,
  output: string,
  opts: ProcessorEngineOptions = {},
): ProcessorCompressResult {
  return createProcessorEngine(defaultOutputProcessors, opts).compress(command, output);
}
