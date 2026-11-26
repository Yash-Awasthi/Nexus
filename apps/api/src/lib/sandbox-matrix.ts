// SPDX-License-Identifier: Apache-2.0
/**
 * What runs, at which version, and what it cost — declared rather than guessed.
 *
 * Two questions come up as soon as someone trusts a sandbox with real work: *which* Python is
 * that (3.11 and 3.13 differ on a dozen things a script can feel), and *what did the run use*.
 * Both are answerable from facts this file already holds, so both are answered here instead of
 * being left to a note in a Dockerfile nobody reads.
 *
 * The image versions are pinned in `infra/sandbox/Dockerfile` as build args. This file repeats
 * them, and `tests/lib/sandbox-matrix.test.ts` fails when the two drift — a matrix that lies is
 * worse than no matrix.
 */
import { createRequire } from "node:module";

/** Versions of the toolchains in `infra/sandbox`. Keep in step with the Dockerfile's ARGs. */
export const IMAGE_VERSIONS = {
  node: "26",
  go: "1.27.4",
  rust: "1.100.0",
  ruby: "3.4.13",
  bash: "5.2",
  typescript: "5",
} as const;

export interface LanguagePin {
  language: string;
  /** The exact version this deployment runs, or null when it cannot be named. */
  version: string | null;
  /** How the code gets there: in-process, the sandbox image, Piston, or the local helper. */
  via: "vm" | "pyodide" | "piston" | "sandbox-image" | "sandbox-helper";
  /** True when this server itself executes the code. */
  serverRuns: boolean;
  /** The thing to depend on: an exact interpreter identity, or why there is not one. */
  pin: string;
}

/**
 * The matrix for this deployment.
 *
 * `nodeVersion` is read from the running process rather than declared, because that is the
 * interpreter that actually executes JavaScript here. Python through Pyodide has a version tied
 * to the `pyodide` package, passed in by the caller that loaded it.
 */
export function languageMatrix(input: {
  nodeVersion: string;
  pyodideVersion: string | null;
  pistonAvailable: boolean;
  dockerAvailable: boolean;
  languages: readonly string[];
}): LanguagePin[] {
  return input.languages.map((language) => {
    switch (language) {
      case "javascript":
        return {
          language,
          version: input.nodeVersion,
          via: "vm" as const,
          serverRuns: true,
          pin: `node ${input.nodeVersion}`,
        };
      case "typescript":
        return {
          language,
          version: input.pistonAvailable ? null : IMAGE_VERSIONS.typescript,
          via: input.pistonAvailable ? ("piston" as const) : ("sandbox-image" as const),
          serverRuns: input.pistonAvailable,
          pin: input.pistonAvailable
            ? "piston"
            : `typescript ${IMAGE_VERSIONS.typescript} in the sandbox image`,
        };
      case "python":
        if (input.pistonAvailable) {
          return { language, version: null, via: "piston" as const, serverRuns: true, pin: "piston" };
        }
        return {
          language,
          version: input.pyodideVersion,
          via: "pyodide" as const,
          serverRuns: true,
          pin: input.pyodideVersion ? `pyodide ${input.pyodideVersion}` : "pyodide (version unreadable)",
        };
      case "bash":
        return {
          language,
          version: input.pistonAvailable ? null : IMAGE_VERSIONS.bash,
          via: input.pistonAvailable ? ("piston" as const) : ("sandbox-image" as const),
          serverRuns: input.pistonAvailable,
          pin: input.pistonAvailable ? "piston" : `bash ${IMAGE_VERSIONS.bash} in the sandbox image`,
        };
      case "go":
        return {
          language,
          version: input.pistonAvailable ? null : IMAGE_VERSIONS.go,
          via: input.pistonAvailable ? ("piston" as const) : ("sandbox-helper" as const),
          serverRuns: input.pistonAvailable,
          pin: input.pistonAvailable ? "piston" : `go ${IMAGE_VERSIONS.go} in the sandbox image`,
        };
      case "rust":
        return {
          language,
          version: input.pistonAvailable ? null : IMAGE_VERSIONS.rust,
          via: input.pistonAvailable ? ("piston" as const) : ("sandbox-helper" as const),
          serverRuns: input.pistonAvailable,
          pin: input.pistonAvailable ? "piston" : `rust ${IMAGE_VERSIONS.rust} in the sandbox image`,
        };
      case "ruby":
        return {
          language,
          version: input.pistonAvailable ? null : IMAGE_VERSIONS.ruby,
          via: input.pistonAvailable ? ("piston" as const) : ("sandbox-helper" as const),
          serverRuns: input.pistonAvailable,
          pin: input.pistonAvailable ? "piston" : `ruby ${IMAGE_VERSIONS.ruby} in the sandbox image`,
        };
      default:
        // A language this file has not been taught: say so rather than invent a version.
        return {
          language,
          version: null,
          via: "piston" as const,
          serverRuns: input.pistonAvailable,
          pin: "unpinned",
        };
    }
  });
}

/**
 * The resource figures a run reports, from what the platform will tell us.
 *
 * `cpuMs` is process CPU consumed by this process across the run, which for the in-process
 * runtimes is the honest number and for the container runtimes is the API's own cost — the
 * field is labelled so a caller can tell. `peakRssBytes` is the difference in resident memory
 * between the start and the high-water mark, sampled during the run; it is an estimate, and
 * saying so is better than a number with a false precision.
 */
export interface ResourceReport {
  cpuMs: number;
  peakRssBytes: number;
  wallMs: number;
  /** How each figure was obtained, because "measured" and "sampled" are different promises. */
  method: "measured" | "sampled";
}

/** A memory sampler for a run: call `stop()` when it ends. */
export function sampleMemory(intervalMs = 50): { stop: () => number } {
  const started = process.memoryUsage().rss;
  let peak = started;
  const timer = setInterval(() => {
    const now = process.memoryUsage().rss;
    if (now > peak) peak = now;
  }, intervalMs);
  // Never hold the process open for a sampler.
  timer.unref?.();
  return {
    stop: () => {
      clearInterval(timer);
      const now = process.memoryUsage().rss;
      return Math.max(0, Math.max(peak, now) - started);
    },
  };
}

/** The report for a run that already knows its wall time and CPU cost. */
export function resourceReport(input: {
  startedAt: number;
  cpu: { user: number; system: number };
  peakRssBytes: number;
  now?: number;
}): ResourceReport {
  return {
    cpuMs: Math.round((input.cpu.user + input.cpu.system) / 1000),
    peakRssBytes: Math.max(0, Math.round(input.peakRssBytes)),
    wallMs: Math.max(0, (input.now ?? Date.now()) - input.startedAt),
    method: "sampled",
  };
}

/**
 * The installed Pyodide's version, read from the package rather than declared, because that is
 * what executes the Python here. Null when it cannot be read — the matrix then says so instead
 * of guessing a number.
 */
export function pyodideVersion(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const manifest = req("pyodide/package.json") as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}
