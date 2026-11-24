// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import type { LspCommand, LspConfig } from "./config.ts";
import type { LspLanguage } from "./languages.ts";
import {
  createLspManager,
  type LspAuthorize,
  type LspManager,
  type LspManagerOptions,
  type LspScheduler,
} from "./manager.ts";

const FAKE_SERVER = fileURLToPath(new URL("./testing/fake-server.mjs", import.meta.url));

let dir: string;
let managers: LspManager[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nexus-lsp-manager-"));
  managers = [];
});

afterEach(async () => {
  for (const manager of managers) await manager.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content = "line one\nline two\n"): string {
  const path = join(dir, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function fake(extra: string[] = []): LspCommand {
  return { command: process.execPath, args: [FAKE_SERVER, ...extra] };
}

function allCommands(extra: string[] = []): Record<LspLanguage, LspCommand> {
  return {
    typescript: fake(extra),
    python: fake(extra),
    go: fake(extra),
    rust: fake(extra),
  };
}

function makeManager(
  options: {
    commands?: Record<LspLanguage, LspCommand>;
    config?: Partial<LspConfig>;
    authorize?: LspAuthorize;
    now?: () => number;
    scheduler?: LspScheduler;
    rssBytes?: (pid: number) => number;
    workingDir?: string;
    env?: NodeJS.ProcessEnv;
    onClose?: () => void;
  } = {},
): LspManager {
  const manager = createLspManager({
    workingDir: options.workingDir ?? dir,
    env: options.env ?? {},
    authorize: options.authorize ?? (async () => "allow"),
    now: options.now,
    onClose: options.onClose,
    scheduler: options.scheduler,
    rssBytes: options.rssBytes,
    config: {
      enabled: true,
      commands: options.commands ?? allCommands(),
      ...options.config,
    },
  } satisfies LspManagerOptions);
  managers.push(manager);
  return manager;
}

function makeScheduler(): { api: LspScheduler; run: (ms: number) => Promise<void> } {
  const entries: Array<{ ms: number; handler: () => void | Promise<void> }> = [];
  return {
    api: {
      setInterval(handler, ms) {
        const token = { handler, ms };
        entries.push(token);
        return token;
      },
      clearInterval() {
        // Tests never reuse a disposed manager.
      },
    },
    async run(ms) {
      for (const entry of entries.filter((candidate) => candidate.ms === ms)) {
        await entry.handler();
      }
    },
  };
}

function makeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  const clock = {
    value: start,
    now: () => clock.value,
    advance: (ms: number) => {
      clock.value += ms;
    },
  };
  return clock;
}

function lines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

const at = (path: string, line = 1, column = 1) => ({ path, line, column });

describe("LspManager pool", () => {
  it("starts a third language only after stopping the least recently used server", async () => {
    const starts = join(dir, "starts.log");
    const manager = makeManager({ commands: allCommands(["--start-count", starts]) });
    const ts = write("a.ts");
    const py = write("b.py");
    const go = write("c.go");

    expect((await manager.hover(at(ts))).ok).toBe(true);
    expect((await manager.hover(at(py))).ok).toBe(true);
    expect(lines(starts)).toHaveLength(2);

    expect((await manager.hover(at(go))).ok).toBe(true);
    expect(lines(starts)).toHaveLength(3);
    const languages = manager
      .status()
      .servers.map((server) => server.language)
      .sort();
    expect(languages).toEqual(["go", "python"]);
  });

  it("evicts an idle server against an injected clock", async () => {
    const clock = makeClock();
    const scheduler = makeScheduler();
    const starts = join(dir, "starts.log");
    const manager = makeManager({
      commands: allCommands(["--start-count", starts]),
      config: { idleMs: 1_000 },
      now: clock.now,
      scheduler: scheduler.api,
    });
    const ts = write("a.ts");
    await manager.hover(at(ts));
    expect(manager.status().servers).toHaveLength(1);

    clock.advance(1_001);
    await scheduler.run(1_000);
    expect(manager.status().servers).toHaveLength(0);
    expect(lines(starts)).toHaveLength(1);
  });

  it("stops a server that trips the RSS watchdog and restarts it after the cooldown", async () => {
    const clock = makeClock();
    const scheduler = makeScheduler();
    const starts = join(dir, "starts.log");
    let rss = 0;
    const manager = makeManager({
      commands: allCommands(["--start-count", starts]),
      config: { maxMemoryMb: 1 },
      now: clock.now,
      scheduler: scheduler.api,
      rssBytes: () => rss,
    });
    const ts = write("a.ts");
    await manager.hover(at(ts));

    rss = 2 * 1024 * 1024;
    await scheduler.run(15_000);
    const unhealthy = manager.status().servers[0];
    expect(unhealthy?.health).toBe("unhealthy");
    expect(unhealthy?.reason).toContain("RSS");

    const blocked = await manager.hover(at(ts));
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe("UNHEALTHY");

    clock.advance(60_001);
    rss = 0;
    expect((await manager.hover(at(ts))).ok).toBe(true);
    expect(lines(starts)).toHaveLength(2);
  });

  it("marks a server broken after two crashes inside the window", async () => {
    const manager = makeManager({
      commands: allCommands(["--crash-on", "textDocument/hover"]),
    });
    const ts = write("a.ts");

    const first = await manager.hover(at(ts));
    expect(first.ok).toBe(false);
    const second = await manager.hover(at(ts));
    expect(second.ok).toBe(false);
    const third = await manager.hover(at(ts));
    expect(third).toMatchObject({ ok: false, code: "BROKEN" });
    if (!third.ok) expect(third.reason).toContain("crashed twice");
    expect(manager.status().servers[0]?.health).toBe("broken");
  });
});

describe("LspManager containment", () => {
  it("refuses escapes without authorizing a spawn", async () => {
    let authorizeCalls = 0;
    const root = join(dir, "root");
    mkdirSync(root);
    const manager = makeManager({
      workingDir: root,
      authorize: async () => {
        authorizeCalls += 1;
        return "allow";
      },
      config: { maxFileBytes: 1_000 },
    });
    const outside = write("outside.ts");
    const directory = join(root, "folder.ts");
    mkdirSync(directory);
    const oversized = write("root/big.ts", "x".repeat(4_000));
    const link = join(root, "link.ts");
    try {
      symlinkSync(outside, link, "file");
    } catch {
      // Windows without developer mode cannot create file symlinks.
    }

    for (const path of [join(root, "..", "outside.ts"), outside, directory, oversized, link]) {
      const result = await manager.definition(at(path));
      expect(result.ok).toBe(false);
    }
    expect(authorizeCalls).toBe(0);
  });

  it("refuses a root outside NEXUS_EXEC_ROOTS without authorizing a spawn", async () => {
    let authorizeCalls = 0;
    const other = join(dir, "other-root");
    mkdirSync(other);
    const manager = makeManager({
      workingDir: dir,
      env: { NEXUS_EXEC_ROOTS: other },
      authorize: async () => {
        authorizeCalls += 1;
        return "allow";
      },
    });
    expect(manager.status().available).toBe(false);

    const ts = write("a.ts");
    const result = await manager.definition(at(ts));
    expect(result).toMatchObject({ ok: false, code: "ROOT_OUTSIDE_EXEC_ROOTS" });
    expect(authorizeCalls).toBe(0);
  });
});

describe("LspManager authorization", () => {
  it("surfaces the rule reason on deny", async () => {
    const manager = makeManager({
      authorize: async () => ({ decision: "deny", reason: "rule lsp-server-deny matched" }),
    });
    const ts = write("a.ts");
    const result = await manager.hover(at(ts));
    expect(result).toMatchObject({ ok: false, code: "DENIED" });
    if (!result.ok) expect(result.reason).toContain("rule lsp-server-deny");
  });

  it("surfaces the approval id on ask", async () => {
    const manager = makeManager({
      authorize: async () => ({ decision: "ask", approvalId: "approval-42" }),
    });
    const ts = write("a.ts");
    const result = await manager.hover(at(ts));
    expect(result).toMatchObject({
      ok: false,
      code: "APPROVAL_REQUIRED",
      approvalId: "approval-42",
    });
  });
});

describe("LspManager documents and results", () => {
  it("returns early, late and missing diagnostics with stale only on timeout", async () => {
    const manager = makeManager({
      commands: {
        typescript: fake(),
        python: fake(["--diagnostics-delay", "80"]),
        go: fake(["--no-diagnostics"]),
        rust: fake(),
      },
      config: { diagnosticsWaitMs: 300, maxServers: 3 },
    });
    const early = await manager.diagnostics({ path: write("a.ts") });
    const late = await manager.diagnostics({ path: write("b.py") });
    const missing = await manager.diagnostics({ path: write("c.go") });

    expect(early).toMatchObject({ ok: true, stale: false });
    expect(late).toMatchObject({ ok: true, stale: false });
    expect(missing).toMatchObject({ ok: true, stale: true });
    if (early.ok) expect(early.diagnostics[0]?.message).toBe("fake diagnostic");
  });

  it("serves two documentSymbol reads from one server request", async () => {
    const log = join(dir, "requests.log");
    const manager = makeManager({ commands: allCommands(["--request-log", log]) });
    const ts = write("a.ts");

    const first = await manager.documentSymbols({ path: ts });
    const second = await manager.documentSymbols({ path: ts });
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    const symbolRequests = lines(log).filter((line) => line === "textDocument/documentSymbol");
    expect(symbolRequests).toHaveLength(1);
  });

  it("caps locations at 200 and hover at 8 KB with truncated flags", async () => {
    const manager = makeManager({
      commands: allCommands(["--many-locations", "250", "--big-hover", "9000"]),
    });
    const ts = write("a.ts");
    const definition = await manager.definition(at(ts));
    expect(definition.ok).toBe(true);
    if (definition.ok) {
      expect(definition.locations).toHaveLength(200);
      expect(definition.truncated).toBe(true);
      expect(definition.locations[0]).toMatchObject({ path: ts, line: 1, column: 1 });
    }

    const hover = await manager.hover(at(ts));
    expect(hover.ok).toBe(true);
    if (hover.ok) {
      expect(hover.truncated).toBe(true);
      expect(Buffer.byteLength(hover.contents, "utf8")).toBeLessThanOrEqual(8 * 1024);
    }
  });

  it("returns rename edits without writing files", async () => {
    const manager = makeManager();
    const ts = write("a.ts");
    const result = await manager.rename({ ...at(ts), newName: "renamed" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.edits[0]).toMatchObject({
        path: ts,
        newText: "renamed",
        range: { start: { line: 1, column: 1 } },
      });
    }
    expect(readFileSync(ts, "utf8")).toBe("line one\nline two\n");
  });
});

describe("LspManager shutdown", () => {
  it("stops every pooled server and calls onClose when disposed", async () => {
    const starts = join(dir, "starts.log");
    let closed = 0;
    const manager = makeManager({
      commands: allCommands(["--start-count", starts]),
      onClose: () => {
        closed += 1;
      },
    });
    await manager.hover(at(write("a.ts")));
    await manager.hover(at(write("b.py")));
    expect(manager.status().servers).toHaveLength(2);

    await manager.dispose();
    expect(manager.status().servers).toHaveLength(0);
    expect(closed).toBe(1);
  });
});
