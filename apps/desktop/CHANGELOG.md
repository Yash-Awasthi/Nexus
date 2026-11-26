# @nexus/desktop

## 0.1.0

First installable release. Windows gets a per-user NSIS installer; macOS gets a
hardened-runtime dmg. The app runs its own API against an embedded database, so
it works with no server and no network.

### Install and update

- `apps/desktop/electron-builder.yml` builds the NSIS installer and the dmg. The
  staged API's production `node_modules` ship beside the bundle; without them the
  packaged app cannot start (`@electric-sql/pglite` is loaded from disk).
- Updates read `manifest.json` and a detached Ed25519 `manifest.json.sig`. An
  unsigned manifest, a non-Ed25519 key, a non-https feed (loopback excepted), an
  oversized body, a sha256 mismatch, or a path outside the update directory are
  refusals. The downloaded installer is re-hashed immediately before it runs on
  quit.
- A new build that never reaches `/health/ready` is replaced once by the last
  confirmed installer and the app relaunches. The check starts after the window
  is shown: a feed that accepts and never answers added 0 ms to launch.
- The feed URL and public key are baked into `dist/update-config.json` at package
  time, because a shortcut launch has no environment. Environment variables still
  override the file for development.
- The NSIS uninstaller keeps the app data directory. A silent install, two
  launches and an uninstall were exercised on Windows; the installer is 314 MiB
  and the unpacked tree 1.4 GB.

### Local runtime

- The embedded API serves the built UI on a loopback port and authenticates the
  renderer with a per-profile key that is stored mode 600.
- The window, the API and the database share one data directory, and the window
  position plus the sealed session survive a restart.
- LSP is enabled for the desktop profile. Server availability is resolved from
  `PATH` per language, and a missing binary names the variable to set instead of
  failing the other tools.

### Known limits

- Signed installers and notarisation need the release secrets; a local build is
  unsigned. A policy-free live `/health/ready` rollback has not been produced
  from a published feed.
- There is no updater on Linux yet; the AppImage target exists but is not built
  by the release workflow.
