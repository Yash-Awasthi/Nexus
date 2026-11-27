// SPDX-License-Identifier: Apache-2.0
/**
 * `pnpm council:evals` / `pnpm council:evals:check` — keep docs/COUNCIL-EVALS.md generated.
 *
 * Same contract as `scripts/evals.mjs`: the numbers come from `packages/council/src/eval/cli.ts`, the prose
 * lives in the document, and `--check` fails when the committed block no longer matches a fresh run.
 */
import { syncGeneratedDoc } from "./lib/generated-doc.mjs";

syncGeneratedDoc({
  doc: "docs/COUNCIL-EVALS.md",
  cli: "packages/council/src/eval/cli.ts",
  start: "<!-- council-evals:start -->",
  end: "<!-- council-evals:end -->",
  label: "council-evals",
  hint: "node scripts/council-evals.mjs",
});
