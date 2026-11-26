// SPDX-License-Identifier: Apache-2.0
// `vp lint --type-aware` is the type-aware pass and owns every rule except one. ESLint is
// here for import ordering only, which needs no type information — keeping it to a single
// rule is what stops a second rule engine growing in parallel with the first.
import importX from "eslint-plugin-import-x";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/.react-router/**",
      "**/*.gen.ts",
      // openapi-typescript output, byte-compared against a fresh run by
      // `pnpm types:check` — style fixes here would fail that comparison.
      "**/src/generated/**",
      // vi.mock() calls between imports cause ordering false-positives.
      "**/*.test.ts",
      "**/*.spec.ts",
    ],
  },
  {
    files: ["**/*.{ts,tsx,js,mjs}"],
    languageOptions: { parser: tseslint.parser },
    plugins: { "import-x": importX },
    rules: {
      "import-x/order": ["error", { "newlines-between": "always", alphabetize: { order: "asc" } }],
    },
  },
);
