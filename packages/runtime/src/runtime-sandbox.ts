import * as fs from "fs";
import * as path from "path";

import { assertPathDescendsFrom } from "./path-boundary.js";

export interface RuntimeSandboxLayout {
  root: string;
  dataDir: string;
  workspacesDir: string;
  specsDir: string;
  tempDir: string;
  backupsDir: string;
}

/**
 * Canonical filesystem layout under the repo root (or configured data root).
 * All paths are validated to stay inside {@link layout.root}.
 */
export function createRuntimeSandbox(repoRoot: string, dataDirRelative?: string): RuntimeSandboxLayout {
  const dataDirConfigured = dataDirRelative?.trim() || process.env.GHOSTSTACK_DATA_DIR?.trim();
  const dataDir = dataDirConfigured
    ? path.isAbsolute(dataDirConfigured)
      ? path.resolve(dataDirConfigured)
      : path.resolve(repoRoot, dataDirConfigured)
    : path.join(repoRoot, "data-runtime");

  assertPathDescendsFrom(repoRoot, dataDir);

  const layout: RuntimeSandboxLayout = {
    root: path.resolve(repoRoot),
    dataDir,
    workspacesDir: path.join(dataDir, "workspaces"),
    specsDir: path.join(repoRoot, "specs"),
    tempDir: path.join(dataDir, "tmp"),
    backupsDir: path.join(dataDir, "backups")
  };

  for (const dir of [layout.dataDir, layout.workspacesDir, layout.tempDir, layout.backupsDir]) {
    assertPathDescendsFrom(layout.root, dir);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  return layout;
}

/** Resolve a user-supplied path segment into a path inside {@link sandboxDir}. */
export function resolveSandboxPath(sandboxRoot: string, repoRoot: string, userPath: string): string {
  const resolved = path.isAbsolute(userPath) ? path.resolve(userPath) : path.resolve(sandboxRoot, userPath);
  assertPathDescendsFrom(repoRoot, resolved);
  return resolved;
}
