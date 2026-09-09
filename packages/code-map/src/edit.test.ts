// SPDX-License-Identifier: Apache-2.0
// Structural import editing (ts-morph parity slice) — focused tests.
import { describe, it, expect } from "vitest";
import { addImportDeclaration, removeImportDeclaration } from "./edit.js";

describe("addImportDeclaration", () => {
  it("appends a new import after the last import line", () => {
    const src = "import { a } from './x';\nimport { b } from './y';\n\nexport const c = a + b;\n";
    const out = addImportDeclaration(src, { namedImports: ["z"], from: "./z" });
    expect(out).toBe(
      "import { a } from './x';\nimport { b } from './y';\nimport { z } from './z';\n\nexport const c = a + b;\n",
    );
  });

  it("merges named specifiers into an existing same-module import", () => {
    const src = "import { login } from './auth';\nexport const x = login;\n";
    const out = addImportDeclaration(src, { namedImports: ["logout", "token"], from: "./auth" });
    expect(out).toBe("import { login, logout, token } from './auth';\nexport const x = login;\n");
  });

  it("merges a default import into an existing named import", () => {
    const src = "import { helper } from './util';\n";
    const out = addImportDeclaration(src, {
      defaultImport: "u",
      namedImports: ["extra"],
      from: "./util",
    });
    expect(out).toBe("import u, { extra, helper } from './util';\n");
  });

  it("returns the input unchanged when everything is already imported", () => {
    const src = "import { a, b } from './x';\n";
    expect(addImportDeclaration(src, { namedImports: ["a"], from: "./x" })).toBe(src);
    expect(
      addImportDeclaration(src, { defaultImport: "d", namedImports: ["a", "b"], from: "./x" }),
    ).toBe("import d, { a, b } from './x';\n");
  });

  it("keeps import type in its own declaration family", () => {
    const src = "import { login } from './auth';\n";
    const out = addImportDeclaration(src, {
      namedImports: ["User"],
      from: "./auth",
      typeOnly: true,
    });
    expect(out).toBe("import { login } from './auth';\nimport type { User } from './auth';\n");
  });

  it("inserts a separate declaration rather than merging into a namespace import", () => {
    const src = "import * as auth from './auth';\n";
    const out = addImportDeclaration(src, { namedImports: ["login"], from: "./auth" });
    expect(out).toBe("import * as auth from './auth';\nimport { login } from './auth';\n");
  });

  it("inserts before the first body statement when the file has no imports", () => {
    const src = "// header comment\n\nconst x = 1;\nexport default x;\n";
    const out = addImportDeclaration(src, { namedImports: ["f"], from: "./f" });
    expect(out).toBe(
      "// header comment\n\nimport { f } from './f';\nconst x = 1;\nexport default x;\n",
    );
  });

  it("matches the file's no-semicolon style for fresh imports", () => {
    const src = "import { a } from './x'\nexport const c = a\n";
    const out = addImportDeclaration(src, { namedImports: ["b"], from: "./y" });
    expect(out).toBe("import { a } from './x'\nimport { b } from './y'\nexport const c = a\n");
  });

  it("throws on a conflicting default binding", () => {
    const src = "import oldName from './x';\n";
    expect(() => addImportDeclaration(src, { defaultImport: "newName", from: "./x" })).toThrow(
      /already has default import 'oldName'/,
    );
  });

  it("throws on empty specs", () => {
    expect(() => addImportDeclaration("", { from: "./x" })).toThrow(/nothing to import/);
    expect(() => addImportDeclaration("", { namedImports: ["a"], from: "" })).toThrow(
      /from.*required/,
    );
  });
});

describe("removeImportDeclaration", () => {
  it("removes the whole declaration when no names are given", () => {
    const src = "import { a } from './x';\nimport { b } from './y';\n";
    const out = removeImportDeclaration(src, "./x");
    expect(out).toBe("import { b } from './y';\n");
  });

  it("removes only the named specifiers and drops the line when the braces empty", () => {
    const src = "import { a, b, c } from './x';\n";
    expect(removeImportDeclaration(src, "./x", ["a", "c"])).toBe("import { b } from './x';\n");
    expect(removeImportDeclaration(src, "./x", ["a", "b", "c"])).toBe("");
  });

  it("removes a default binding and keeps named specifiers", () => {
    const src = "import d, { a } from './x';\n";
    expect(removeImportDeclaration(src, "./x", ["d"])).toBe("import { a } from './x';\n");
  });

  it("is idempotent for a module that is not imported", () => {
    const src = "import { a } from './x';\n";
    expect(removeImportDeclaration(src, "./nope")).toBe(src);
  });

  it("throws when removing named specifiers from a namespace import", () => {
    const src = "import * as ns from './x';\n";
    expect(() => removeImportDeclaration(src, "./x", ["ns"])).toThrow(/namespace import/);
  });
});
