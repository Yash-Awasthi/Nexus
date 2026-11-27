// SPDX-License-Identifier: Apache-2.0
/**
 * `pnpm evals` / `pnpm evals:check` — keep docs/EVALS.md generated.
 *
 * The numbers live in `packages/search/src/eval/cli.ts` and the prose lives in the document. `--check`
 * fails when the block between the markers no longer matches a fresh run, so a change to ranking
 * behaviour cannot land with a doc that still describes the old one.
 */
import { syncGeneratedDoc } from "./lib/generated-doc.mjs";

syncGeneratedDoc({
  doc: "docs/EVALS.md",
  cli: "packages/search/src/eval/cli.ts",
  start: "<!-- evals:start -->",
  end: "<!-- evals:end -->",
  label: "evals",
  hint: "node scripts/evals.mjs",
});
