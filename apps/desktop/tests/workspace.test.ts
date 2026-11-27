// SPDX-License-Identifier: Apache-2.0
/**
 * The workspace folder chosen in the app instead of in an environment variable.
 *
 * The properties that matter are the refusals: a path that does not exist, a file instead of a
 * folder, a relative path, and a path that was valid when chosen but has since gone away. A
 * loader that silently accepted any of those would launch language servers against the wrong
 * directory and look like a language-server bug.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  MAX_WORKSPACE_PATH,
  WORKSPACE_FILE,
  clearWorkspace,
  describeWorkspace,
  readWorkspace,
  saveWorkspace,
  workspaceEnv,
  workspaceProblem,
} from "../src/workspace";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "nexus-workspace-"));

describe("workspaceProblem", () => {
  it("accepts a real folder and refuses everything else with a reason a person can act on", () => {
    const dir = tmp();
    const file = path.join(dir, "notes.md");
    fs.writeFileSync(file, "x");

    expect(workspaceProblem(dir)).toBeNull();
    expect(workspaceProblem("")).toMatch(/Pick a folder/);
    expect(workspaceProblem("relative/project")).toMatch(/absolute/);
    expect(workspaceProblem(path.join(dir, "missing"))).toMatch(/does not exist/);
    expect(workspaceProblem(file)).toMatch(/is a file/);
    expect(workspaceProblem(`/${"a".repeat(MAX_WORKSPACE_PATH)}`)).toMatch(/too long/);
    expect(workspaceProblem(`/tmp/${"a"}\0b`)).toMatch(/NUL/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("save, read, clear", () => {
  it("stores the chosen folder and reads it back", () => {
    const dir = tmp();
    const project = path.join(dir, "project");
    fs.mkdirSync(project);
    const record = saveWorkspace(dir, project);
    expect(record.dir).toBe(path.resolve(project));
    expect(new Date(record.chosenAt).getTime()).not.toBeNaN();
    expect(readWorkspace(dir)).toBe(path.resolve(project));
    // The file names the folder and nothing else; there is no token or permission in it.
    const stored = JSON.parse(fs.readFileSync(path.join(dir, WORKSPACE_FILE), "utf8")) as object;
    expect(Object.keys(stored).sort()).toEqual(["chosenAt", "dir"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses to store an invalid folder instead of storing it and failing later", () => {
    const dir = tmp();
    expect(() => saveWorkspace(dir, path.join(dir, "nope"))).toThrow(/does not exist/);
    expect(readWorkspace(dir)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads 'not set' when the folder was deleted after it was chosen", () => {
    const dir = tmp();
    const project = path.join(dir, "project");
    fs.mkdirSync(project);
    saveWorkspace(dir, project);
    fs.rmSync(project, { recursive: true, force: true });
    expect(readWorkspace(dir)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("treats an unreadable or hand-edited file as not set", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, WORKSPACE_FILE), "{oops");
    expect(readWorkspace(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, WORKSPACE_FILE), JSON.stringify({ dir: 42 }));
    expect(readWorkspace(dir)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("clears, and says whether there was something to clear", () => {
    const dir = tmp();
    const project = path.join(dir, "project");
    fs.mkdirSync(project);
    expect(clearWorkspace(dir)).toBe(false);
    saveWorkspace(dir, project);
    expect(clearWorkspace(dir)).toBe(true);
    expect(readWorkspace(dir)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("workspaceEnv", () => {
  it("passes the folder as NEXUS_WORKSPACE_DIR, and nothing at all when unset", () => {
    const dir = tmp();
    expect(workspaceEnv(null)).toEqual({});
    expect(workspaceEnv(dir)).toEqual({ NEXUS_WORKSPACE_DIR: dir });
    // A folder that has gone away must not become an empty string, which would read as "root".
    expect(workspaceEnv(path.join(dir, "gone"))).toEqual({});
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("describeWorkspace", () => {
  it("names the folder, not the whole path, and says when there is none", () => {
    expect(describeWorkspace(null)).toMatch(/not set/);
    expect(describeWorkspace("/home/yash/projects/nexus")).toBe("Workspace: nexus");
  });
});
