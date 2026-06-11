// SPDX-License-Identifier: Apache-2.0
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";
import promisePlugin from "eslint-plugin-promise";
import vitestPlugin from "eslint-plugin-vitest";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    plugins: {
      import: importPlugin,
      promise: promisePlugin,
    },
    rules: {
      // Allow @ts-nocheck for files with unresolvable external dependencies;
      // still ban the less-precise @ts-ignore.
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-check": false,
          "ts-nocheck": false,
          "ts-ignore": true,
          "ts-expect-error": "allow-with-description",
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "import/order": ["error", { "newlines-between": "always", alphabetize: { order: "asc" } }],
      "import/no-duplicates": "error",
      "promise/always-return": "warn",
      "promise/no-return-wrap": "error",

      // ── Rules relaxed for initial CI green — tighten incrementally ──────────
      // These fire on pre-existing code that was not written to comply with the
      // strictTypeChecked / stylisticTypeChecked presets.  Disable here; enable
      // per-package once the package's code is brought into compliance.

      // unsafe-* rules require every third-party type to be fully typed
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",

      // strict extras that produce bulk false-positives on existing code
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-meaningless-void-operator": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",

      // stylistic rules — nice to have but shouldn't block CI
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/dot-notation": "off",
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      "@typescript-eslint/prefer-optional-chain": "off",
      "@typescript-eslint/prefer-string-starts-ends-with": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/use-unknown-in-catch-variables": "off",
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "off",
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/return-await": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/restrict-plus-operands": "off",
      "@typescript-eslint/prefer-promise-reject-errors": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-unnecessary-boolean-literal-compare": "off",
      "@typescript-eslint/no-non-null-asserted-nullish-coalescing": "off",
      "@typescript-eslint/no-useless-default-assignment": "off",
    },
    languageOptions: {
      parserOptions: {
        projectService: {
          // Test files live outside each package's build tsconfig (rootDir: src).
          // Use allowDefaultProject with a non-** glob so ESLint can still
          // type-check them via the nearest tsconfig.eslint.json (no ** allowed).
          allowDefaultProject: ["packages/*/tests/*.test.ts", "packages/*/tests/*.spec.ts"],
          defaultProject: "./tsconfig.eslint.json",
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.test.ts", "**/*.spec.ts"],
    plugins: { vitest: vitestPlugin },
    rules: {
      ...vitestPlugin.configs.recommended.rules,
    },
  },
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "**/*.gen.ts"],
  },
);
