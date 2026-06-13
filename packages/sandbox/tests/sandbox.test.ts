// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from "events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IExecutionContext } from "@nexus/plugin-sdk";

import {
  executeCode,
  prepareExecution,
  buildSafeEnv,
  defaultRunner,
  sandboxAdapter,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  SAFE_ENV_KEYS,
  type SandboxTask,
  type Runner,
  type RunnerResult,
} from "../src/index.js";

// ── Mock fs/promises so no real temp files are touched ───────────────────────

vi.mock("fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock child_process for defaultRunner tests ────────────────────────────────

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("child_process", () => ({ spawn: spawnMock }));

// ── Runner factory helpers ────────────────────────────────────────────────────

function makeRunner(result: Partial<RunnerResult>): Runner {
  return vi.fn().mockResolvedValue({
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    ...result,
  } satisfies RunnerResult);
}

function makeTimedOutRunner(): Runner {
  return vi.fn().mockResolvedValue({
    stdout: "partial",
    stderr: "",
    exitCode: null,
    timedOut: true,
  } satisfies RunnerResult);
}

function makeErrorRunner(msg: string): Runner {
  return vi.fn().mockRejectedValue(new Error(msg));
}

// ── Task helpers ──────────────────────────────────────────────────────────────

function task(overrides: Partial<SandboxTask> = {}): SandboxTask {
  return {
    taskType: "sandbox.execute",
    code: 'console.log("hello")',
    language: "javascript",
    ...overrides,
  };
}

// ── prepareExecution ──────────────────────────────────────────────────────────

describe("prepareExecution", () => {
  it("routes javascript to node -e", () => {
    const prep = prepareExecution("javascript", "console.log(1)");
    expect(prep.cmd).toBe("node");
    expect(prep.args).toContain("-e");
    expect(prep.args).toContain("console.log(1)");
    expect(prep.tempFilePath).toBeUndefined();
  });

  it("routes python to python3 -c", () => {
    const prep = prepareExecution("python", "print(42)");
    expect(prep.cmd).toBe("python3");
    expect(prep.args).toContain("-c");
    expect(prep.args).toContain("print(42)");
  });

  it("routes bash to bash -c", () => {
    const prep = prepareExecution("bash", "echo hello");
    expect(prep.cmd).toBe("bash");
    expect(prep.args).toContain("-c");
    expect(prep.args).toContain("echo hello");
  });

  it("routes typescript to tsx with a temp file path", () => {
    const prep = prepareExecution("typescript", "const x: number = 1;");
    expect(prep.cmd).toBe("tsx");
    expect(prep.tempFilePath).toBeDefined();
    expect(prep.tempFilePath).toMatch(/nexus-sandbox-.+\.ts$/);
    // tsx receives the file path as an arg
    expect(prep.args).toContain(prep.tempFilePath!);
  });

  it("typescript temp file paths are unique per call", () => {
    const p1 = prepareExecution("typescript", "x");
    const p2 = prepareExecution("typescript", "x");
    expect(p1.tempFilePath).not.toBe(p2.tempFilePath);
  });

  it("javascript uses no-addons flag for security", () => {
    const prep = prepareExecution("javascript", "x");
    expect(prep.args).toContain("--no-addons");
  });
});

// ── buildSafeEnv ──────────────────────────────────────────────────────────────

describe("buildSafeEnv", () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...origEnv,
      PATH: "/usr/bin:/bin",
      HOME: "/home/user",
      GROQ_API_KEY: "gsk_supersecret",
      OPENAI_API_KEY: "sk-supersecret",
      DATABASE_URL: "postgres://secret",
      MY_TOKEN: "tok_abc",
      MY_PASSWORD: "hunter2",
    };
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it("includes PATH and HOME from process.env", () => {
    const env = buildSafeEnv();
    expect(env["PATH"]).toBe("/usr/bin:/bin");
    expect(env["HOME"]).toBe("/home/user");
  });

  it("strips credential-like env vars", () => {
    const env = buildSafeEnv();
    expect(env["GROQ_API_KEY"]).toBeUndefined();
    expect(env["OPENAI_API_KEY"]).toBeUndefined();
    expect(env["DATABASE_URL"]).toBeUndefined();
    expect(env["MY_TOKEN"]).toBeUndefined();
    expect(env["MY_PASSWORD"]).toBeUndefined();
  });

  it("only includes SAFE_ENV_KEYS keys from process.env", () => {
    const env = buildSafeEnv();
    const keys = Object.keys(env);
    for (const key of keys) {
      if (!SAFE_ENV_KEYS.has(key)) {
        // key must have come from extraEnv — there's none here
        expect.fail(`Unexpected env key leaked: ${key}`);
      }
    }
  });

  it("allows safe extra env vars", () => {
    const env = buildSafeEnv({ MY_VAR: "hello", NODE_ENV: "test" });
    expect(env["MY_VAR"]).toBe("hello");
    expect(env["NODE_ENV"]).toBe("test");
  });

  it("blocks extra env vars with credential-like names", () => {
    const env = buildSafeEnv({ SECRET_KEY: "oops", API_TOKEN: "oops" });
    expect(env["SECRET_KEY"]).toBeUndefined();
    expect(env["API_TOKEN"]).toBeUndefined();
  });

  it("blocks extra env vars with non-alphanumeric keys", () => {
    const env = buildSafeEnv({ "my-var": "x", "MY VAR": "y" });
    expect(env["my-var"]).toBeUndefined();
    expect(env["MY VAR"]).toBeUndefined();
  });
});

// ── executeCode — result shape ────────────────────────────────────────────────

describe("executeCode — result shape", () => {
  it("returns ok:true on exit code 0", async () => {
    const result = await executeCode(task(), makeRunner({ exitCode: 0, stdout: "hello\n" }));
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("hello\n");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("returns ok:false on non-zero exit code", async () => {
    const result = await executeCode(task(), makeRunner({ exitCode: 1, stderr: "ReferenceError" }));
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ReferenceError");
  });

  it("returns language field matching the task", async () => {
    const result = await executeCode(
      task({ language: "python", code: "print(1)" }),
      makeRunner({}),
    );
    expect(result.language).toBe("python");
  });

  it("durationMs is a non-negative number", async () => {
    const result = await executeCode(task(), makeRunner({}));
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ── executeCode — timeout ─────────────────────────────────────────────────────

describe("executeCode — timeout", () => {
  it("marks result timedOut:true when runner returns timedOut", async () => {
    const result = await executeCode(task(), makeTimedOutRunner());
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toBe("partial");
  });

  it("caps timeoutMs at MAX_TIMEOUT_MS", async () => {
    const runner = makeRunner({});
    await executeCode(task({ timeoutMs: 999_999 }), runner);
    // Runner should be called with timeoutMs ≤ MAX_TIMEOUT_MS
    const opts = (runner as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as { timeoutMs: number };
    expect(opts.timeoutMs).toBe(MAX_TIMEOUT_MS);
  });

  it("uses DEFAULT_TIMEOUT_MS when timeoutMs not set", async () => {
    const runner = makeRunner({});
    await executeCode(task(), runner);
    const opts = (runner as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as { timeoutMs: number };
    expect(opts.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("accepts custom timeoutMs below the cap", async () => {
    const runner = makeRunner({});
    await executeCode(task({ timeoutMs: 5000 }), runner);
    const opts = (runner as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as { timeoutMs: number };
    expect(opts.timeoutMs).toBe(5000);
  });
});

// ── executeCode — language routing ────────────────────────────────────────────

describe("executeCode — language routing", () => {
  it("calls runner with node for javascript", async () => {
    const runner = makeRunner({});
    await executeCode(task({ language: "javascript" }), runner);
    const cmd = (runner as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(cmd).toBe("node");
  });

  it("calls runner with python3 for python", async () => {
    const runner = makeRunner({});
    await executeCode(task({ language: "python", code: "print(1)" }), runner);
    const cmd = (runner as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(cmd).toBe("python3");
  });

  it("calls runner with bash for bash", async () => {
    const runner = makeRunner({});
    await executeCode(task({ language: "bash", code: "echo hi" }), runner);
    const cmd = (runner as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(cmd).toBe("bash");
  });

  it("calls runner with tsx for typescript", async () => {
    const runner = makeRunner({});
    await executeCode(task({ language: "typescript", code: "const x: number = 1" }), runner);
    const cmd = (runner as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(cmd).toBe("tsx");
  });

  it("typescript: writes temp file before running and deletes after", async () => {
    const { writeFile, unlink } = await import("fs/promises");
    vi.clearAllMocks();

    const runner = makeRunner({});
    await executeCode(task({ language: "typescript", code: "const x = 1" }), runner);

    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(unlink).toHaveBeenCalledTimes(1);

    // Unlink path matches writeFile path
    const writePath = (writeFile as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    const unlinkPath = (unlink as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(writePath).toBe(unlinkPath);
  });

  it("typescript: temp file is cleaned up even when runner throws", async () => {
    const { writeFile, unlink } = await import("fs/promises");
    vi.clearAllMocks();

    await executeCode(
      task({ language: "typescript", code: "const x = 1" }),
      makeErrorRunner("tsx crashed"),
    );

    expect(unlink).toHaveBeenCalledTimes(1);
  });
});

// ── executeCode — stdin ───────────────────────────────────────────────────────

describe("executeCode — stdin", () => {
  it("passes task.stdin to runner options for javascript", async () => {
    const runner = makeRunner({});
    await executeCode(task({ stdin: "hello from stdin" }), runner);
    const opts = (runner as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as { stdin?: string };
    expect(opts.stdin).toBe("hello from stdin");
  });
});

// ── executeCode — error recovery ──────────────────────────────────────────────

describe("executeCode — error recovery", () => {
  it("catches runner rejection and returns ok:false with error field", async () => {
    const result = await executeCode(task(), makeErrorRunner("ENOENT node not found"));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ENOENT node not found");
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
  });

  it("always populates durationMs even on error", async () => {
    const result = await executeCode(task(), makeErrorRunner("crash"));
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ── executeCode — environment ─────────────────────────────────────────────────

describe("executeCode — safe environment", () => {
  it("passes a sanitised env to the runner", async () => {
    const origPath = process.env["PATH"];
    const runner = makeRunner({});
    await executeCode(task({ extraEnv: { MY_DATA: "42" } }), runner);

    const opts = (runner as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as {
      env: NodeJS.ProcessEnv;
    };
    expect(opts.env["PATH"]).toBe(origPath);
    expect(opts.env["MY_DATA"]).toBe("42");
    // No credential leakage
    expect(opts.env["GROQ_API_KEY"]).toBeUndefined();
  });
});

// ── Constants ─────────────────────────────────────────────────────────────────

describe("constants", () => {
  it("DEFAULT_TIMEOUT_MS is 10 000", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(10_000);
  });

  it("MAX_TIMEOUT_MS is 30 000", () => {
    expect(MAX_TIMEOUT_MS).toBe(30_000);
  });

  it("MAX_OUTPUT_BYTES is 64 KiB", () => {
    expect(MAX_OUTPUT_BYTES).toBe(65_536);
  });

  it("SAFE_ENV_KEYS includes PATH and HOME", () => {
    expect(SAFE_ENV_KEYS.has("PATH")).toBe(true);
    expect(SAFE_ENV_KEYS.has("HOME")).toBe(true);
  });
});

// ── defaultRunner — child_process integration ─────────────────────────────────

/** Build a fake ChildProcess that emits events after a microtask delay */
function makeFakeProc(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: Error;
  stdinCheck?: boolean;
}) {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: { end: ReturnType<typeof vi.fn> };
    stdout: EventEmitter;
    stderr: EventEmitter;
  };

  proc.stdin = { end: vi.fn() };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();

  // Emit asynchronously so listeners can be attached first
  setImmediate(() => {
    if (opts.error) {
      proc.emit("error", opts.error);
    } else {
      if (opts.stdout) proc.stdout.emit("data", Buffer.from(opts.stdout));
      if (opts.stderr) proc.stderr.emit("data", Buffer.from(opts.stderr));
      proc.emit("close", opts.exitCode ?? 0);
    }
  });

  return proc;
}

describe("defaultRunner — success paths", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("resolves with stdout from child process", async () => {
    spawnMock.mockReturnValue(makeFakeProc({ stdout: "hello world\n", exitCode: 0 }));
    const result = await defaultRunner("node", ["-e", "console.log('hello world')"], {
      timeoutMs: 5000,
      env: { PATH: process.env["PATH"] ?? "" },
    });
    expect(result.stdout).toBe("hello world\n");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("captures stderr separately", async () => {
    spawnMock.mockReturnValue(
      makeFakeProc({ stderr: "Warning: deprecated", exitCode: 0 }),
    );
    const result = await defaultRunner("node", ["-e", "x"], {
      timeoutMs: 5000,
      env: {},
    });
    expect(result.stderr).toContain("Warning: deprecated");
  });

  it("returns exitCode from child process", async () => {
    spawnMock.mockReturnValue(makeFakeProc({ exitCode: 42 }));
    const result = await defaultRunner("node", ["-e", "process.exit(42)"], {
      timeoutMs: 5000,
      env: {},
    });
    expect(result.exitCode).toBe(42);
  });

  it("writes stdin to process when provided", async () => {
    const fakeProc = makeFakeProc({ stdout: "hi", exitCode: 0 });
    spawnMock.mockReturnValue(fakeProc);
    await defaultRunner("cat", [], { timeoutMs: 5000, env: {}, stdin: "hello input" });
    expect(fakeProc.stdin.end).toHaveBeenCalledWith("hello input");
  });

  it("calls stdin.end() with no args when no stdin provided", async () => {
    const fakeProc = makeFakeProc({ exitCode: 0 });
    spawnMock.mockReturnValue(fakeProc);
    await defaultRunner("echo", ["hi"], { timeoutMs: 5000, env: {} });
    expect(fakeProc.stdin.end).toHaveBeenCalledWith();
  });
});

describe("defaultRunner — error paths", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("resolves timedOut:true on AbortError", async () => {
    const fakeProc = makeFakeProc({
      error: Object.assign(new Error("aborted"), { code: "ABORT_ERR" }),
    });
    spawnMock.mockReturnValue(fakeProc);
    const result = await defaultRunner("sleep", ["100"], { timeoutMs: 5000, env: {} });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it("resolves timedOut:true when error name is AbortError", async () => {
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    const fakeProc = makeFakeProc({ error: abortErr });
    spawnMock.mockReturnValue(fakeProc);
    const result = await defaultRunner("sleep", ["100"], { timeoutMs: 5000, env: {} });
    expect(result.timedOut).toBe(true);
  });

  it("resolves with exitCode:1 and spawn error message on non-abort error", async () => {
    const fakeProc = makeFakeProc({ error: new Error("ENOENT") });
    spawnMock.mockReturnValue(fakeProc);
    const result = await defaultRunner("doesnotexist", [], { timeoutMs: 5000, env: {} });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ENOENT");
    expect(result.timedOut).toBe(false);
  });
});

// ── Adapter execute function ──────────────────────────────────────────────────

const makeCtx = (): IExecutionContext =>
  ({
    taskId: "test-task",
    startTime: new Date(),
    attempt: 1,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    environment: {},
  }) as unknown as IExecutionContext;

describe("sandboxAdapter.execute", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("calls logger.info with language and codeLength", async () => {
    spawnMock.mockReturnValue(makeFakeProc({ stdout: "42\n", exitCode: 0 }));
    const ctx = makeCtx();
    await sandboxAdapter.execute(
      { taskType: "sandbox.execute", language: "javascript", code: "console.log(42)" },
      ctx,
    );
    expect(ctx.logger.info).toHaveBeenCalledWith(
      "sandbox.execute",
      expect.objectContaining({ language: "javascript" }),
    );
  });

  it("returns a SandboxResult from the adapter", async () => {
    spawnMock.mockReturnValue(makeFakeProc({ stdout: "done\n", exitCode: 0 }));
    const result = await sandboxAdapter.execute(
      { taskType: "sandbox.execute", language: "javascript", code: 'console.log("done")' },
      makeCtx(),
    );
    expect(result).toHaveProperty("ok");
    expect(result).toHaveProperty("stdout");
    expect(result).toHaveProperty("language", "javascript");
  });

  it("adapter has correct name and taskTypes", () => {
    expect(sandboxAdapter.name).toBe("nexus-adapter-sandbox");
    expect(sandboxAdapter.canExecute("sandbox.execute")).toBe(true);
    expect(sandboxAdapter.canExecute("other.task")).toBe(false);
  });
});
