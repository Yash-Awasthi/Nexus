// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  compressOutputForCommand,
  createProcessorEngine,
  genericProcessor,
  testOutputProcessor,
  type OutputProcessor,
} from "./token-saver.js";

/** Build a synthetic pytest run with a long traceback failure. */
function pytestFailure(): string {
  const lines = [
    "============================= test session starts =============================",
    "platform linux -- Python 3.12.0",
    "collected 3 items",
    "",
    "tests/test_math.py .F",
    "",
    "=================================== FAILURES =================================",
    "_________________________________ test_div0 __________________________________",
    "",
    "    def test_div0():",
    ">       assert 1 / 0",
    "E       ZeroDivisionError: division by zero",
  ];
  for (let i = 0; i < 60; i++) lines.push(`    frame_${i}  at src/math.py:${i + 100}`);
  lines.push(
    "tests/test_math.py:12: ZeroDivisionError",
    "=========================== short test summary info ===========================",
    "FAILED tests/test_math.py::test_div0 - ZeroDivisionError: division by zero",
    "=============================== 1 failed in 0.05s ============================",
  );
  return lines.join("\n");
}

describe("processor engine dispatch (token-saver model)", () => {
  it("routes a pytest command to the test processor and truncates the traceback", () => {
    const r = compressOutputForCommand("pytest tests/", pytestFailure());
    expect(r.processor).toBe("test");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("... (35 traceback lines truncated)");
    // head and tail of the traceback survive
    expect(r.output).toContain("frame_0");
    expect(r.output).toContain("frame_59");
    // the individual FAILED summary line is preserved
    expect(r.output).toContain("FAILED tests/test_math.py::test_div0");
  });

  it("leaves short output untouched via the min-input gate", () => {
    const r = compressOutputForCommand("pytest x", "ok", { minInputLength: 5 });
    expect(r.processor).toBe("none");
    expect(r.wasCompressed).toBe(false);
    expect(r.output).toBe("ok");
  });

  it("reports a deliberate no-op when the matched processor returns unchanged output", () => {
    const engine = createProcessorEngine([
      {
        name: "pass-through",
        priority: 10,
        canHandle: (cmd) => cmd.includes("anything"),
        process: (_cmd, out) => out,
      },
      genericProcessor,
    ]);
    const r = engine.compress("anything at all", "some long enough text that nothing shrinks");
    expect(r.processor).toBe("pass-through");
    expect(r.wasCompressed).toBe(false);
    expect(r.output).toBe("some long enough text that nothing shrinks");
  });

  it("can disable a specialized processor, letting the fallback handle the command", () => {
    const input = Array.from({ length: 30 }, () => "jest line of output").join("\n");
    const r = compressOutputForCommand("jest x", input, { disabled: ["test"] });
    expect(r.processor).toBe("generic");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("(x30)");
  });

  it("falls back to the generic processor when a specialized pass under-compresses (mismatch)", () => {
    const engine = createProcessorEngine([
      {
        name: "stubborn",
        priority: 10,
        canHandle: (cmd) => cmd.includes("x"),
        // returns something different but not smaller than the original
        process: (_cmd, out) => `${out.trim()}\nnoise`,
      },
      genericProcessor,
    ]);
    // original must be compressible by generic (repeated lines) to win
    const input = Array.from({ length: 5 }, () => "downloading widget v1.2.3  [########] 42%").join(
      "\n",
    );
    const r = engine.compress("tool x", input);
    expect(r.isMismatch).toBe(true);
    expect(r.processor).toBe("generic");
    expect(r.wasCompressed).toBe(true);
  });
});

describe("testOutputProcessor block-aware mechanics", () => {
  it("collapses repeated pytest warnings by type with one example", () => {
    const warning = "src/dep.py:3: DeprecationWarning: use foo() instead";
    const warnBlock = Array.from({ length: 12 }, () => warning).join("\n");
    const out = [
      "============================= warnings summary =============================",
      warnBlock,
      "=============================== 1 passed in 0.02s ==========================",
    ].join("\n");
    const r = compressOutputForCommand("pytest -q", out);
    expect(r.processor).toBe("test");
    expect(r.output).toContain("Warnings (12): DeprecationWarning x12");
    expect(r.output).toContain("e.g. " + warning);
  });

  it("reduces coverage reports to TOTAL plus low-coverage files", () => {
    const rows = [
      "----------- coverage: platform linux, python 3.12.0 -----------",
      "Name                  Stmts   Miss  Cover",
      "-------------------------------------------",
      "src/math.py              40     20    50%",
      "src/util.py              80      0   100%",
      "src/net.py              200    120    40%",
      "TOTAL                   320    140    56%",
    ].join("\n");
    const r = compressOutputForCommand("pytest --cov=src", rows);
    expect(r.output).toContain("TOTAL                   320    140    56%");
    expect(r.output).toContain("Files below 80% coverage (2):");
    expect(r.output).toContain("src/math.py");
    expect(r.output).not.toContain("src/util.py");
  });

  it("groups parameterized-test failures into one summary line", () => {
    const out = [
      "tests/test_api.py::test_retry[case-1] FAILED",
      "tests/test_api.py::test_retry[case-2] FAILED",
      "tests/test_api.py::test_retry[case-3] PASSED",
      "tests/test_api.py::test_retry[case-4] FAILED",
    ].join("\n");
    const r = compressOutputForCommand("pytest -q", out);
    expect(r.output).toContain("[1 tests passed]");
    expect(r.output).toContain(
      "tests/test_api.py::test_retry: 1/4 passed, FAILED: [case-1, case-2, case-4]",
    );
  });

  it("handles jest output: counts suites and truncates failure blocks", () => {
    const lines = [
      "PASS tests/util.test.ts (12 tests)",
      "FAIL tests/net.test.ts (5 tests)",
      "  ● connect › rejects bad host",
      "    expect(received).rejects.toThrow()",
    ];
    for (let i = 0; i < 50; i++) lines.push(`    at stack frame ${i} (src/net.ts:${i + 10})`);
    lines.push("", "", "Test Suites: 1 failed, 1 passed, 2 total");
    const r = compressOutputForCommand("npx jest", lines.join("\n"));
    expect(r.output).toContain("[1 suites passed]");
    expect(r.output).toContain("... (24 traceback lines truncated)");
    expect(r.output).toContain("Test Suites: 1 failed, 1 passed, 2 total");
  });

  it("keeps failing lines for a flavor without a dedicated path", () => {
    // mocha matches canHandle but has no dedicated flavor branch — the python
    // source routes it to the generic-test fallback of the test processor,
    // which keeps fail/error/assert lines and drops the rest ("ok:" is not a
    // pass marker in the python source either — it looks for "ok " with space).
    const out = [
      "RUN  suite A: 5 passing, 1 failing",
      "FAIL  check_balance: expected 10 to equal 9",
      "assert 10 === 9",
      "ok: 3 cases verified",
    ].join("\n");
    const r = compressOutputForCommand("mocha --reporter spec", out);
    expect(r.processor).toBe("test");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toBe(
      "RUN  suite A: 5 passing, 1 failing\nFAIL  check_balance: expected 10 to equal 9\nassert 10 === 9",
    );
  });
});

describe("genericProcessor fallback mechanics", () => {
  it("strips ANSI escapes and unicode progress bars", () => {
    const out = [
      "\u001b[31mred\u001b[0m line",
      "██████████████████ 100%",
      "━━━━━━━━ 42%",
      "real data row",
    ].join("\n");
    const r = compressOutputForCommand("curl x", out);
    expect(r.processor).toBe("generic");
    expect(r.output).not.toContain("\u001b[");
    expect(r.output).not.toContain("████");
    expect(r.output).toContain("red line");
    expect(r.output).toContain("real data row");
  });

  it("preserves bare separator rules while dropping heavy contextual bars", () => {
    const out = [
      "==========================================",
      "########################## 45% 12/34 ETA 00:01",
      "section under it",
    ].join("\n");
    const r = compressOutputForCommand("tool", out);
    // The pure = run has no progress context (no %/n-of-m/ETA) — it is a rule.
    expect(r.output).toContain("==========================================");
    expect(r.output).not.toContain("ETA");
    expect(r.output).not.toContain("####");
    expect(r.output).toContain("section under it");
  });

  it("dedups consecutive identical lines into (xN)", () => {
    const out = Array.from({ length: 4 }, () => "compiling crate").join("\n");
    const r = compressOutputForCommand("build", out);
    expect(r.output).toContain("compiling crate (x4)");
  });

  it("collapses numeric-progress line runs with a similar-lines marker", () => {
    const lines: string[] = [];
    for (let i = 0; i < 8; i++) lines.push(`Copying file ${i + 1}/8 ... 12.5% done`);
    lines.push("All copied.");
    const r = compressOutputForCommand("cp -r", lines.join("\n"));
    expect(r.output).toContain("... (6 similar lines)");
    expect(r.output).toContain("All copied.");
  });

  it("truncates the middle of very long output with a marker", () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i}`);
    const r = compressOutputForCommand("log", lines.join("\n"));
    expect(r.processor).toBe("generic");
    expect(r.output).toContain("... (100 lines truncated, 250 total) ...");
    expect(r.output).toContain("line 0");
    expect(r.output).toContain("line 249");
    expect(r.output.split("\n").length).toBe(151);
  });
});

describe("engine composition and listing", () => {
  it("sorts processors by (priority, name) and exposes enabled names", () => {
    const engine = createProcessorEngine([genericProcessor, testOutputProcessor]);
    expect(engine.list()).toEqual(["test", "generic"]);
  });

  it("can chain a secondary processor after the primary match", () => {
    const secondary: OutputProcessor = {
      name: "uppercaser",
      priority: 999,
      canHandle: () => false,
      process: (_c, out) => out.toUpperCase(),
    };
    const engine = createProcessorEngine([
      {
        name: "primary",
        priority: 1,
        chainTo: ["uppercaser"],
        canHandle: () => true,
        process: (_c, out) => out.slice(0, 10), // compresses; the chain then refines it
      },
      secondary,
    ]);
    const r = engine.compress("anything", "lowercase words to keep");
    expect(r.processor).toBe("primary");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toBe("LOWERCASE ");
  });
});
