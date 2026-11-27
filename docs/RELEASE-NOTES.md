<!-- verified: 8065a84 2026-11-25 -->

# Release notes

What is in the next release, generated from the changesets in this repository. Every change that touches a
published package carries one — `pnpm changeset` writes it, `commitlint` and CI make sure it is not forgotten — and
this page is that set, in order, with the bump each change asks for.

The block below is generated and checked: `pnpm release:notes` rewrites it, `pnpm release:notes:check` fails when
the committed block no longer matches the changesets on disk. Edit the changesets, not this page.

Version numbers and dates are deliberately absent. This is the _pending_ set, so a number here would be wrong after
the next commit; the changelog that ships with a tag is written by `@changesets/cli` at release time.

Releases are cut from `master`:

```bash
pnpm changeset version      # consume the changesets, bump versions, update CHANGELOGs
pnpm install                # lockfile follows the versions
git commit -am "chore(release): version packages"
```

The support matrix for each release — Node versions, operating systems, container base, model backends — is
`docs/SUPPORT-MATRIX.md`, and it is checked against the build in CI rather than maintained by hand.

<!-- release-notes:start -->

**2 changeset(s) pending**, affecting 4 package(s): `@nexus/api` (minor), `@nexus/desktop` (minor), `@nexus/gateway-log` (major), `@nexus/lsp` (minor)

### desktop-updater — minor

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

### fold-gateway-log — major

Remove `@nexus/gateway-log`; the gateway audit log now lives in the API.

The package had one importer (`apps/api/src/routes/gateway.ts`), no runtime
dependencies, and one source file, so the workspace boundary cost a
`package.json`, a tsconfig reference and a build-graph edge for every consumer —
and bought nothing, because nothing else ever needed the code.
`MemoryGatewayLog`, `KVGatewayLog`, `LoggingLLMProvider`, `computeStats` and the
types are now `apps/api/src/lib/gateway-log.ts`, with the same behaviour and the
same tests (`apps/api/tests/lib/gateway-log.test.ts`).

This is a breaking change for anyone importing the package directly: the last
published version stays installable on npm, but no later version will ship.
<!-- release-notes:end -->
