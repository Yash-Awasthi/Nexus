// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/doc-workflows — Document workflow engine.
 *
 * Trigger → condition → action pipeline for ingested documents.
 * On document arrival: evaluate conditions, run matching actions
 * (tag, route, transform, webhook out).
 *
 * Architecture
 * ────────────
 *   WorkflowEngine      — evaluates registered workflows against a document.
 *   WorkflowDefinition  — { id, trigger, conditions[], actions[] }.
 *   TriggerType         — "on_ingest" | "on_tag" | "on_update" | "scheduled".
 *   ConditionFn         — (doc: WorkflowDoc) → boolean (sync or async).
 *   ActionFn            — (doc: WorkflowDoc, ctx) → Promise<ActionResult>.
 *   Built-in actions    — tagAction, routeAction, webhookAction, transformAction.
 *
 * Usage
 * ─────
 * ```ts
 * const engine = new WorkflowEngine();
 *
 * engine.register({
 *   id: "invoice-router",
 *   trigger: "on_ingest",
 *   conditions: [containsText("invoice"), hasMetadata("source", "email")],
 *   actions: [tagAction("finance"), routeAction("finance-queue")],
 * });
 *
 * const results = await engine.process(doc, "on_ingest");
 * ```
 */

// ── Document type ─────────────────────────────────────────────────────────────

export interface WorkflowDoc {
  id: string;
  source?: string;
  content: string;
  format?: string;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: number; // Unix ms
}

// ── Trigger ───────────────────────────────────────────────────────────────────

export type TriggerType = "on_ingest" | "on_tag" | "on_update" | "scheduled";

// ── Condition ─────────────────────────────────────────────────────────────────

export type ConditionFn = (doc: WorkflowDoc) => boolean | Promise<boolean>;

// ── Action ────────────────────────────────────────────────────────────────────

export interface ActionContext {
  workflowId: string;
  triggeredAt: number;
  fetchFn?: typeof fetch;
}

/** Action result interface definition. */
export interface ActionResult {
  action: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/** Action fn type alias. */
export type ActionFn = (doc: WorkflowDoc, ctx: ActionContext) => Promise<ActionResult>;

// ── Workflow definition ───────────────────────────────────────────────────────

export interface WorkflowDefinition {
  id: string;
  trigger: TriggerType;
  /** All conditions must pass (AND logic). */
  conditions: ConditionFn[];
  /** Actions run in order when all conditions pass. */
  actions: ActionFn[];
  /** Whether to continue to next workflow after this one runs (default: true). */
  continueOnMatch?: boolean;
}

// ── Execution result ──────────────────────────────────────────────────────────

export interface WorkflowExecutionResult {
  workflowId: string;
  matched: boolean;
  actionResults: ActionResult[];
  durationMs: number;
  error?: string;
}

/** Process result interface definition. */
export interface ProcessResult {
  docId: string;
  trigger: TriggerType;
  executed: WorkflowExecutionResult[];
  totalDurationMs: number;
}

// ── Engine ────────────────────────────────────────────────────────────────────

export class WorkflowEngine {
  private readonly workflows: WorkflowDefinition[] = [];
  private readonly fetchFn: typeof fetch;

  constructor(opts: { fetchFn?: typeof fetch } = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  /** Register a workflow. Later registrations run after earlier ones. */
  register(workflow: WorkflowDefinition): void {
    this.workflows.push(workflow);
  }

  /** Unregister by ID. */
  unregister(id: string): void {
    const idx = this.workflows.findIndex((w) => w.id === id);
    if (idx >= 0) this.workflows.splice(idx, 1);
  }

  /** List registered workflow IDs. */
  listWorkflows(): string[] {
    return this.workflows.map((w) => w.id);
  }

  /**
   * Process a document against all matching-trigger workflows.
   * Mutations to doc.tags and doc.metadata from actions are NOT auto-applied
   * here — actions return result objects; callers must persist changes.
   */
  async process(doc: WorkflowDoc, trigger: TriggerType): Promise<ProcessResult> {
    const t0 = Date.now();
    const executed: WorkflowExecutionResult[] = [];

    for (const workflow of this.workflows) {
      if (workflow.trigger !== trigger) continue;

      const wt0 = Date.now();
      try {
        // Evaluate all conditions (AND)
        let matched = true;
        for (const cond of workflow.conditions) {
          const result = await Promise.resolve(cond(doc));
          if (!result) {
            matched = false;
            break;
          }
        }

        if (!matched) {
          executed.push({
            workflowId: workflow.id,
            matched: false,
            actionResults: [],
            durationMs: Date.now() - wt0,
          });
          continue;
        }

        // Run actions in order
        const actionResults: ActionResult[] = [];
        const ctx: ActionContext = {
          workflowId: workflow.id,
          triggeredAt: Date.now(),
          fetchFn: this.fetchFn,
        };

        for (const action of workflow.actions) {
          try {
            const result = await action(doc, ctx);
            actionResults.push(result);
          } catch (err) {
            actionResults.push({
              action: "unknown",
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        executed.push({
          workflowId: workflow.id,
          matched: true,
          actionResults,
          durationMs: Date.now() - wt0,
        });

        if (workflow.continueOnMatch === false) break;
      } catch (err) {
        executed.push({
          workflowId: workflow.id,
          matched: false,
          actionResults: [],
          durationMs: Date.now() - wt0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { docId: doc.id, trigger, executed, totalDurationMs: Date.now() - t0 };
  }
}

// ── Built-in conditions ───────────────────────────────────────────────────────

/** Passes if the document content contains the given text (case-insensitive by default). */
export function containsText(text: string, opts: { caseSensitive?: boolean } = {}): ConditionFn {
  return (doc) => {
    const content = opts.caseSensitive ? doc.content : doc.content.toLowerCase();
    const needle = opts.caseSensitive ? text : text.toLowerCase();
    return content.includes(needle);
  };
}

/** Passes if the document already has the given tag. */
export function hasTag(tag: string): ConditionFn {
  return (doc) => doc.tags.includes(tag);
}

/** Passes if doc.metadata[key] equals value (uses deep equality for objects). */
export function hasMetadata(key: string, value: unknown): ConditionFn {
  return (doc) => {
    const v = doc.metadata[key];
    return JSON.stringify(v) === JSON.stringify(value);
  };
}

/** Passes if document content matches the given regex. */
export function matchesRegex(re: RegExp): ConditionFn {
  return (doc) => re.test(doc.content);
}

/** Passes if document format matches. */
export function hasFormat(format: string): ConditionFn {
  return (doc) => doc.format === format;
}

/** Passes if document source matches the given string or regex. */
export function fromSource(sourceOrPattern: string | RegExp): ConditionFn {
  return (doc) => {
    if (!doc.source) return false;
    if (typeof sourceOrPattern === "string") return doc.source === sourceOrPattern;
    return sourceOrPattern.test(doc.source);
  };
}

// ── Built-in actions ──────────────────────────────────────────────────────────

/** Add a tag to doc.tags (mutates the doc in-place). */
export function tagAction(tag: string): ActionFn {
  return async (doc) => {
    if (!doc.tags.includes(tag)) doc.tags.push(tag);
    return { action: "tag", success: true, data: { tag } };
  };
}

/** Set a metadata field. */
export function setMetadataAction(key: string, value: unknown): ActionFn {
  return async (doc) => {
    doc.metadata[key] = value;
    return { action: "set_metadata", success: true, data: { key, value } };
  };
}

/** Route document to a named queue by setting metadata["route"]. */
export function routeAction(queue: string): ActionFn {
  return async (doc) => {
    doc.metadata["route"] = queue;
    return { action: "route", success: true, data: { queue } };
  };
}

/** Send a webhook POST with the document payload. */
export function webhookAction(
  url: string,
  opts: { headers?: Record<string, string> } = {},
): ActionFn {
  return async (doc, ctx) => {
    const fetchFn = ctx.fetchFn ?? fetch;
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
        body: JSON.stringify({
          docId: doc.id,
          source: doc.source,
          tags: doc.tags,
          metadata: doc.metadata,
        }),
      });
      return { action: "webhook", success: res.ok, data: { status: res.status, url } };
    } catch (err) {
      return {
        action: "webhook",
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

/** Transform content: apply a function and store result in metadata["transformed"]. */
export function transformAction(
  transform: (content: string) => string,
  key = "transformed",
): ActionFn {
  return async (doc) => {
    try {
      const result = transform(doc.content);
      doc.metadata[key] = result;
      return { action: "transform", success: true, data: { key, length: result.length } };
    } catch (err) {
      return {
        action: "transform",
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}
