---
"@nexus/desktop": minor
"@nexus/lsp": minor
"@nexus/api": minor
---

Ship the desktop installer, signed update feed and rollback, and make the LSP
client report per-language availability from `PATH`.

- `apps/desktop/electron-builder.yml` builds the per-user NSIS installer and the
  hardened-runtime dmg; the release workflow signs them and publishes
  `SHA256SUMS`, an SBOM and a signed update manifest on a `v*` tag.
- `apps/desktop/src/updater.ts` requires an Ed25519 signature over the manifest,
  verifies each artifact's sha256 while streaming, stages it under the app data
  directory, re-hashes it before running on quit, and restores the previous
  verified installer once if the new build fails `/health/ready`.
- `apps/api/src/lib/lsp.ts` resolves each configured server command on `PATH`
  (with `PATHEXT` on Windows) and names the variable to set when it is missing,
  instead of assuming a non-empty command means the binary exists.
