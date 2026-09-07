// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { IMPORT_RE, splitSkillCodeImports } from "../../src/lib/skill-imports.js";

const collect = (codes: string[]) => {
  const imports: string[] = [];
  const seen = new Set<string>();
  const bodies = codes.map((c) => splitSkillCodeImports(c, imports, seen));
  return { imports, bodies };
};

describe("skill-imports parse/dedupe helper", () => {
  it("classifies the import shapes the three call sites relied on", () => {
    const hits = [
      "import os",
      "from pathlib import Path",
      "  import pandas as pd", // leading whitespace still an import
      "#include <stdio.h>",
      "#import <Foundation/Foundation.h>",
      "using namespace std;",
      "const x = require('y')",
      "let fs = require('fs')",
      "var http = require('http')",
      "require('z')",
    ];
    for (const line of hits) expect(IMPORT_RE.test(line)).toBe(true);
    for (const line of ["print('hello')", "export const a = 1", "const x = 1", "// import commented out", "def f():", "# using a directive in a comment"]) {
      expect(IMPORT_RE.test(line)).toBe(false);
    }
  });

  it("partitions imports (deduped) from body lines, preserving order and whitespace", () => {
    const { imports, bodies } = collect([
      "import os\nprint('a')\n  import sys",
    ]);
    expect(imports).toEqual(["import os", "  import sys"]); // original text, incl. leading ws
    expect(bodies[0]).toEqual(["print('a')"]);
  });

  it("dedupes across skills on the trimmed key (first-seen wins)", () => {
    const { imports, bodies } = collect([
      "import os\n  import sys",
      "import sys\n  import os\nimport re",
    ]);
    expect(imports).toEqual(["import os", "  import sys", "import re"]);
    // duplicates are imports for the later skill too — they just don't re-add
    expect(bodies[1]).toEqual([]);
  });

  it("keeps body lines verbatim when no imports are present", () => {
    const { imports, bodies } = collect(["def main():\n    return 1\n"]);
    expect(imports).toEqual([]);
    expect(bodies[0]).toEqual(["def main():", "    return 1", ""]);
  });

  it("an empty code string contributes nothing", () => {
    const { imports, bodies } = collect(["", "import os"]);
    expect(imports).toEqual(["import os"]);
    expect(bodies[0]).toEqual([""]);
    expect(bodies[1]).toEqual([]);
  });

  it("separate collect() runs start with fresh dedupe state", () => {
    const first = collect(["import os"]);
    const second = collect(["import os"]);
    expect(first.imports).toEqual(["import os"]);
    expect(second.imports).toEqual(["import os"]);
  });
});
