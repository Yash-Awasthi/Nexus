// SPDX-License-Identifier: Apache-2.0
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";

import {
  loadWorkflowSpecFile,
  loadWorkflowSpecsFromDir,
  parseWorkflowSpec,
  specToWorkflowDefinition,
  type WorkflowSpecFile,
} from "../src/spec-loader.js";

const VALID_SPEC: WorkflowSpecFile = {
  spec_version: "1.0",
  metadata: { name: "hello", description: "d", author: "a", created_at: "t" },
  template_id: "tpl-1",
  variables: { who: "world" },
  tasks: [
    {
      id: "t1",
      title: "Task 1",
      description: "run a browser",
      type: "floci",
      action: "run",
      priority: "medium",
      arguments: { x: 1 },
      dependencies: [],
    },
    {
      id: "t2",
      title: "Task 2",
      description: "search",
      type: "search",
      action: "query",
      priority: "high",
      dependencies: ["t1"],
    },
  ],
};

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-loader-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("parseWorkflowSpec", () => {
  it("returns a valid spec unchanged", () => {
    const out = parseWorkflowSpec(JSON.stringify(VALID_SPEC), "test.json");
    expect(out).toEqual(VALID_SPEC);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseWorkflowSpec("{nope", "x.json")).toThrow(/Invalid workflow spec JSON/);
  });

  it("rejects non-object payloads", () => {
    expect(() => parseWorkflowSpec("[1,2]", "x.json")).toThrow(/must be a JSON object/);
    expect(() => parseWorkflowSpec('"str"', "x.json")).toThrow(/must be a JSON object/);
  });

  it("rejects a missing template_id", () => {
    const s = { ...VALID_SPEC };
    delete (s as Partial<WorkflowSpecFile>).template_id;
    expect(() => parseWorkflowSpec(JSON.stringify(s), "x.json")).toThrow(/template_id/);
  });

  it("rejects missing metadata or metadata.name", () => {
    const s = { ...VALID_SPEC, metadata: { description: "x" } as WorkflowSpecFile["metadata"] };
    expect(() => parseWorkflowSpec(JSON.stringify(s), "x.json")).toThrow(/metadata\.name/);
    const s2 = { ...VALID_SPEC, metadata: undefined };
    expect(() => parseWorkflowSpec(JSON.stringify(s2), "x.json")).toThrow(/metadata object/);
  });

  it("rejects an empty or non-array tasks list", () => {
    const s = { ...VALID_SPEC, tasks: [] };
    expect(() => parseWorkflowSpec(JSON.stringify(s), "x.json")).toThrow(/non-empty tasks/);
    const s2 = { ...VALID_SPEC, tasks: "nope" };
    expect(() => parseWorkflowSpec(JSON.stringify(s2), "x.json")).toThrow(/non-empty tasks/);
  });

  it("flags per-task missing required fields", () => {
    const s = structuredClone(VALID_SPEC);
    delete s.tasks[0]!.action;
    delete s.tasks[1]!.priority;
    try {
      parseWorkflowSpec(JSON.stringify(s), "x.json");
      expect.unreachable("should throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('tasks[0]: missing or invalid required field "action"');
      expect(msg).toContain('tasks[1]: missing or invalid required field "priority"');
    }
  });

  it("flags duplicate task ids and invalid priority", () => {
    const s = structuredClone(VALID_SPEC);
    s.tasks[1]!.id = "t1";
    s.tasks[1]!.priority = "urgent";
    try {
      parseWorkflowSpec(JSON.stringify(s), "x.json");
      expect.unreachable("should throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('duplicate task id "t1"');
      expect(msg).toContain('invalid priority "urgent"');
    }
  });

  it("flags dependencies that are not an array", () => {
    const s = structuredClone(VALID_SPEC);
    (s.tasks[0] as unknown as { dependencies: unknown }).dependencies = "t2";
    expect(() => parseWorkflowSpec(JSON.stringify(s), "x.json")).toThrow(/dependencies must be an array/);
  });

  it("flags dangling dependency references", () => {
    const s = structuredClone(VALID_SPEC);
    s.tasks[0]!.dependencies = ["ghost"];
    expect(() => parseWorkflowSpec(JSON.stringify(s), "x.json")).toThrow(
      /depends on unknown task id "ghost"/,
    );
  });
});

describe("specToWorkflowDefinition", () => {
  it("maps tasks to router Tasks and defaults description", () => {
    const def = specToWorkflowDefinition(VALID_SPEC, "wf-1");
    expect(def.id).toBe("wf-1");
    expect(def.name).toBe("hello");
    expect(def.description).toBe("d");
    expect(def.tasks).toHaveLength(2);
    expect(def.tasks[0]).toMatchObject({
      id: "t1",
      title: "Task 1",
      status: "pending",
      type: "floci",
      action: "run",
      dependencies: [],
      arguments: { x: 1 },
    });
  });

  it("defaults a missing description to empty string", () => {
    const s = structuredClone(VALID_SPEC);
    delete s.metadata.description;
    const def = specToWorkflowDefinition(s, "wf-2");
    expect(def.description).toBe("");
  });
});

describe("file loading", () => {
  it("loadWorkflowSpecFile reads and parses a file", () => {
    const dir = makeTmpDir();
    const p = path.join(dir, "workflow-spec.json");
    fs.writeFileSync(p, JSON.stringify(VALID_SPEC));
    expect(loadWorkflowSpecFile(p).template_id).toBe("tpl-1");
  });

  it("loadWorkflowSpecFile propagates parse errors with the path as source", () => {
    const dir = makeTmpDir();
    const p = path.join(dir, "workflow-spec.json");
    fs.writeFileSync(p, "{bad");
    expect(() => loadWorkflowSpecFile(p)).toThrow(/workflow-spec\.json/);
  });

  it("loadWorkflowSpecsFromDir returns [] for a missing directory", () => {
    expect(loadWorkflowSpecsFromDir(path.join(os.tmpdir(), "does-not-exist-xyz"))).toEqual([]);
  });

  it("walks nested directories and collects only workflow-spec.json files", () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(dir, "workflow-spec.json"), JSON.stringify(VALID_SPEC));
    fs.writeFileSync(
      path.join(dir, "a", "b", "workflow-spec.json"),
      JSON.stringify({ ...VALID_SPEC, template_id: "tpl-2" }),
    );
    fs.writeFileSync(path.join(dir, "a", "ignored.json"), JSON.stringify(VALID_SPEC));

    const found = loadWorkflowSpecsFromDir(dir);
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.spec.template_id).sort()).toEqual(["tpl-1", "tpl-2"]);
  });
});