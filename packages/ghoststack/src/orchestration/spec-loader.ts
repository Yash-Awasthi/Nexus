import * as fs from "fs";
import * as path from "path";
import { Task } from "./task-router";
import { IWorkflowDefinition } from "./interfaces/workflow.interface";

export interface WorkflowSpecTask {
  id: string;
  title: string;
  description: string;
  type: string;
  action: string;
  priority: string;
  arguments?: Record<string, unknown>;
  dependencies: string[];
}

export interface WorkflowSpecFile {
  spec_version: string;
  metadata: {
    name: string;
    description?: string;
    author?: string;
    created_at?: string;
  };
  template_id: string;
  variables?: Record<string, unknown>;
  tasks: WorkflowSpecTask[];
}

// Required fields for each task entry
const TASK_REQUIRED_FIELDS: Array<keyof WorkflowSpecTask> = [
  "id", "title", "description", "type", "action", "priority"
];

const VALID_PRIORITIES = new Set(["low", "medium", "high", "critical"]);

export function parseWorkflowSpec(raw: string, sourceLabel: string): WorkflowSpecFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid workflow spec JSON (${sourceLabel}): ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Workflow spec must be a JSON object (${sourceLabel})`);
  }
  const spec = parsed as WorkflowSpecFile;

  // ── Top-level required fields ────────────────────────────────────────
  if (!spec.template_id || typeof spec.template_id !== "string") {
    throw new Error(`Workflow spec missing or invalid template_id (${sourceLabel})`);
  }
  if (!spec.metadata || typeof spec.metadata !== "object") {
    throw new Error(`Workflow spec missing metadata object (${sourceLabel})`);
  }
  if (!spec.metadata.name || typeof spec.metadata.name !== "string") {
    throw new Error(`Workflow spec missing metadata.name (${sourceLabel})`);
  }
  if (!Array.isArray(spec.tasks) || spec.tasks.length === 0) {
    throw new Error(`Workflow spec must have a non-empty tasks array (${sourceLabel})`);
  }

  // ── Per-task validation ──────────────────────────────────────────────
  const seenIds = new Set<string>();
  const errors: string[] = [];

  for (let i = 0; i < spec.tasks.length; i++) {
    const task = spec.tasks[i];
    const label = `tasks[${i}]`;

    // Required fields present and non-empty strings
    for (const field of TASK_REQUIRED_FIELDS) {
      if (!task[field] || typeof task[field] !== "string") {
        errors.push(`${label}: missing or invalid required field "${field}"`);
      }
    }

    // Duplicate IDs
    if (task.id) {
      if (seenIds.has(task.id)) {
        errors.push(`${label}: duplicate task id "${task.id}"`);
      } else {
        seenIds.add(task.id);
      }
    }

    // Priority must be a known value
    if (task.priority && !VALID_PRIORITIES.has(task.priority)) {
      errors.push(`${label} (id: "${task.id}"): invalid priority "${task.priority}" — must be one of: ${[...VALID_PRIORITIES].join(", ")}`);
    }

    // dependencies must be an array if present
    if (task.dependencies !== undefined && !Array.isArray(task.dependencies)) {
      errors.push(`${label} (id: "${task.id}"): dependencies must be an array`);
    }
  }

  // Dangling dependency references — every dependency ID must exist in the spec
  for (const task of spec.tasks) {
    for (const dep of task.dependencies ?? []) {
      if (!seenIds.has(dep)) {
        errors.push(`task "${task.id}" depends on unknown task id "${dep}"`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Workflow spec validation failed (${sourceLabel}):\n  • ${errors.join("\n  • ")}`
    );
  }

  return spec;
}

export function specToWorkflowDefinition(spec: WorkflowSpecFile, workflowId: string): IWorkflowDefinition {
  const tasks: Task[] = spec.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    priority: t.priority,
    status: "pending",
    dependencies: t.dependencies ?? [],
    type: t.type,
    action: t.action,
    arguments: t.arguments
  }));

  return {
    id: workflowId,
    name: spec.metadata.name,
    description: spec.metadata.description ?? "",
    tasks
  };
}

export function loadWorkflowSpecFile(filePath: string): WorkflowSpecFile {
  const raw = fs.readFileSync(filePath, "utf8");
  return parseWorkflowSpec(raw, filePath);
}

/** Recursively load `workflow-spec.json` files under a specs directory. */
export function loadWorkflowSpecsFromDir(specsDir: string): { filePath: string; spec: WorkflowSpecFile }[] {
  if (!fs.existsSync(specsDir)) {
    return [];
  }

  const results: { filePath: string; spec: WorkflowSpecFile }[] = [];

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name === "workflow-spec.json") {
        results.push({ filePath: full, spec: loadWorkflowSpecFile(full) });
      }
    }
  };

  walk(specsDir);
  return results;
}
