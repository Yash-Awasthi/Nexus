// SPDX-License-Identifier: Apache-2.0
/**
 * The workspace folder: the directory the language servers and the sandbox treat as the project.
 *
 * The API reads it from `NEXUS_WORKSPACE_DIR`. Asking a desktop user to edit an environment
 * variable to point at their own project is asking them to configure the product before they can
 * use it, so the app asks the operating system for the folder and passes it to the API it starts.
 *
 * What is stored is a path, not a permission: nothing here grants access, it only names the
 * folder the API should use. A path that no longer exists (a drive unplugged, a folder renamed)
 * reads as "not set" rather than as an error the user cannot act on.
 */
import fs from "node:fs";
import path from "node:path";

export const WORKSPACE_FILE = "workspace.json";
/** Long enough for a deep path on every platform, short enough to reject a pasted blob. */
export const MAX_WORKSPACE_PATH = 1_024;
const ENV_NAME = "NEXUS_WORKSPACE_DIR";

export interface WorkspaceRecord {
  dir: string;
  chosenAt: string;
}

/**
 * Why a folder cannot be the workspace, or `null` when it can.
 *
 * Exported because the picker must refuse the same things the loader refuses: an accepting
 * dialog followed by a silently ignored folder is worse than a dialog that says no.
 */
export function workspaceProblem(folder: string): string | null {
  if (!folder.trim()) return "Pick a folder first.";
  if (folder.length > MAX_WORKSPACE_PATH) return "That path is too long to store.";
  if (!path.isAbsolute(folder)) return "The workspace must be an absolute path.";
  if (folder.includes("\0")) return "That path contains a NUL byte.";
  let stat: fs.Stats;
  try {
    stat = fs.statSync(folder);
  } catch {
    return "That folder does not exist (or is not readable).";
  }
  if (!stat.isDirectory()) return "That path is a file, not a folder.";
  return null;
}

/** The stored workspace, or `null` when unset, unreadable, or gone. */
export function readWorkspace(dir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(dir, WORKSPACE_FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const folder = (parsed as Partial<WorkspaceRecord>)?.dir;
    if (typeof folder !== "string") return null;
    return workspaceProblem(folder) === null ? folder : null;
  } catch {
    return null;
  }
}

/** Store a folder, refusing anything `workspaceProblem` rejects. */
export function saveWorkspace(dir: string, folder: string): WorkspaceRecord {
  const problem = workspaceProblem(folder);
  if (problem) throw new Error(problem);
  const record: WorkspaceRecord = { dir: path.resolve(folder), chosenAt: new Date().toISOString() };
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, WORKSPACE_FILE);
  fs.writeFileSync(`${target}.tmp`, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(`${target}.tmp`, target);
  return record;
}

/** Forget the workspace. Returns whether there was one. */
export function clearWorkspace(dir: string): boolean {
  const had = readWorkspace(dir) !== null;
  try {
    fs.rmSync(path.join(dir, WORKSPACE_FILE), { force: true });
  } catch {
    /* an unremovable file is still "not set" for the next read, if the path is gone */
  }
  return had;
}

/**
 * The environment the local API needs for this workspace.
 *
 * An empty object when nothing is chosen, so the API falls back to its own default rather than
 * to an empty string that would read as "the workspace is the filesystem root".
 */
export function workspaceEnv(folder: string | null): Record<string, string> {
  if (!folder) return {};
  return workspaceProblem(folder) === null ? { [ENV_NAME]: folder } : {};
}

/** One line for the tray menu. */
export function describeWorkspace(folder: string | null): string {
  if (!folder) return "Workspace: not set — choose a folder";
  const name = path.basename(folder) || folder;
  return `Workspace: ${name}`;
}
