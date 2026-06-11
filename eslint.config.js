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
      "@typescript-eslint/ban-ts-comment": ["error", {
        "ts-check": false,
        "ts-nocheck": false,
        "ts-ignore": true,
        "ts-expect-error": "allow-with-description",
      }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "import/order": ["error", { "newlines-between": "always", alphabetize: { order: "asc" } }],
      "import/no-duplicates": "error",
      "promise/always-return": "error",
      "promise/no-return-wrap": "error",
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
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
  }
);
