// SPDX-License-Identifier: Apache-2.0
/**
 * Write or check the release-notes block from the changesets on disk.
 *
 *   node scripts/sync-release-notes.mjs --write
 *   node scripts/sync-release-notes.mjs --check
 */
import { syncGeneratedDoc } from "./lib/generated-doc.mjs";

syncGeneratedDoc({
  doc: "docs/RELEASE-NOTES.md",
  cli: "scripts/release-notes.mjs",
  start: "<!-- release-notes:start -->",
  end: "<!-- release-notes:end -->",
  label: "release-notes",
  hint: "pnpm release:notes",
});
