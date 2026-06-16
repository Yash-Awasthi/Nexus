// SPDX-License-Identifier: Apache-2.0
/**
 * doc-workflow — Signal-driven document workflow engine.
 *
 * Executes configurable workflow actions when documents are ingested.
 * Supports email, trash, move-to-path, webhook, and password-removal actions.
 * Uses Jinja-style placeholder templating for dynamic values.
 *
 * Provides:
 *   • WorkflowActionType   — email | trash | move | webhook | remove-password
 *   • WorkflowAction       — typed action definition
 *   • WorkflowDefinition   — named workflow with trigger conditions + actions
 *   • ActionContext        — variables available for Jinja substitution
 *   • JinjaTemplater       — {{variable}} substitution engine
 *   • WorkflowMatcher      — matches documents against workflow trigger conditions
 *   • ActionExecutor       — executes actions (injectable handlers)
 *   • WorkflowEngine       — signal-driven orchestrator
 *   • MockActionBackend    — test double for action side-effects
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type WorkflowActionType = "email" | "trash" | "move" | "webhook" | "remove-password";
/** Trigger field type alias. */
export type TriggerField = "mime_type" | "document_type" | "path_contains" | "tag" | "owner";

/** Trigger condition interface definition. */
export interface TriggerCondition {
  field: TriggerField;
  operator: "equals" | "contains" | "starts_with" | "ends_with";
  value: string;
}

/** Workflow action interface definition. */
export interface WorkflowAction {
  type: WorkflowActionType;
  params: Record<string, string>; // Jinja-templatible values
}

/** Workflow definition interface definition. */
export interface WorkflowDefinition {
  id: string;
  name: string;
  enabled: boolean;
  conditions: TriggerCondition[]; // ALL must match
  actions: WorkflowAction[];
  order?: number;
}

/** Action context interface definition. */
export interface ActionContext {
  documentId: string;
  originalPath: string;
  outputPath: string;
  mimeType: string;
  documentType: string;
  owner?: string;
  tags?: string[];
  ingestedAt: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Action result interface definition. */
export interface ActionResult {
  workflowId: string;
  actionType: WorkflowActionType;
  success: boolean;
  error?: string;
  output?: unknown;
}

/** Workflow run result interface definition. */
export interface WorkflowRunResult {
  workflowId: string;
  matched: boolean;
  actions: ActionResult[];
}

// ── JinjaTemplater ────────────────────────────────────────────────────────────

export class JinjaTemplater {
  /**
   * Substitute {{variable}} placeholders with values from context.
   * Nested access: {{metadata.owner}}
   * Falls back to original placeholder if key not found.
   */
  render(template: string, context: Record<string, unknown>): string {
    if (template.length > 100_000) throw new Error("template too large for rendering");
    return template.replace(/\{\{([^}]+)\}\}/g, (_match, key) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const trimmedKey = key.trim();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      const value = this.resolveKey(trimmedKey, context);
      return value !== undefined ? String(value) : `{{${trimmedKey}}}`;
    });
  }

  private resolveKey(key: string, context: Record<string, unknown>): unknown {
    const parts = key.split(".");
    let current: unknown = context;
    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== "object")
        return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  /** Render all string values in a params object. */
  renderParams(
    params: Record<string, string>,
    context: Record<string, unknown>,
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      result[k] = this.render(v, context);
    }
    return result;
  }
}

// ── WorkflowMatcher ───────────────────────────────────────────────────────────

const FIELD_MAP: Record<string, keyof ActionContext> = {
  mime_type: "mimeType",
  document_type: "documentType",
  path_contains: "originalPath",
  owner: "owner",
  // "tag" intentionally NOT mapped — literal ctx["tag"] lookup (undefined if absent)
};

/** Workflow matcher. */
export class WorkflowMatcher {
  matches(doc: ActionContext, condition: TriggerCondition): boolean {
    const contextKey = FIELD_MAP[condition.field] ?? (condition.field as keyof ActionContext);
    const rawValue = doc[contextKey];
    const docValue = Array.isArray(rawValue)
      ? rawValue.join(",")
      : rawValue !== undefined
        ? String(rawValue)
        : "";
    const cv = condition.value.toLowerCase();
    const dv = docValue.toLowerCase();

    switch (condition.operator) {
      case "equals":
        return dv === cv;
      case "contains":
        return dv.includes(cv);
      case "starts_with":
        return dv.startsWith(cv);
      case "ends_with":
        return dv.endsWith(cv);
      default:
        return false;
    }
  }

  matchesAll(doc: ActionContext, conditions: TriggerCondition[]): boolean {
    return conditions.every((c) => this.matches(doc, c));
  }
}

// ── ActionExecutor ────────────────────────────────────────────────────────────

export type ActionHandlerFn = (
  type: WorkflowActionType,
  params: Record<string, string>,
  ctx: ActionContext,
) => Promise<unknown>;

/** Action executor. */
export class ActionExecutor {
  private handler?: ActionHandlerFn;
  private templater = new JinjaTemplater();

  inject(handler: ActionHandlerFn): this {
    this.handler = handler;
    return this;
  }

  async execute(
    action: WorkflowAction,
    ctx: ActionContext,
    workflowId: string,
  ): Promise<ActionResult> {
    const renderedParams = this.templater.renderParams(
      action.params,
      ctx as Record<string, unknown>,
    );

    if (!this.handler) {
      return {
        workflowId,
        actionType: action.type,
        success: false,
        error: "No action handler injected",
      };
    }

    try {
      const output = await this.handler(action.type, renderedParams, ctx);
      return { workflowId, actionType: action.type, success: true, output };
    } catch (err) {
      return {
        workflowId,
        actionType: action.type,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ── MockActionBackend ─────────────────────────────────────────────────────────

export interface MockActionCall {
  type: WorkflowActionType;
  params: Record<string, string>;
  ctx: ActionContext;
}

/** Mock action backend. */
export class MockActionBackend {
  readonly calls: MockActionCall[] = [];
  private throws?: Record<WorkflowActionType, string>;

  setThrows(type: WorkflowActionType, message: string): void {
    if (!this.throws) this.throws = {} as Record<WorkflowActionType, string>;
    this.throws[type] = message;
  }

  asHandler(): ActionHandlerFn {
    return async (type, params, ctx) => {
      if (this.throws?.[type]) throw new Error(this.throws[type]);
      this.calls.push({ type, params, ctx });
      return { executed: true, type };
    };
  }
}

// ── WorkflowEngine ────────────────────────────────────────────────────────────

export class WorkflowEngine {
  private workflows: WorkflowDefinition[] = [];
  private matcher = new WorkflowMatcher();
  private executor: ActionExecutor;

  constructor(executor?: ActionExecutor) {
    this.executor = executor ?? new ActionExecutor();
  }

  registerWorkflow(wf: WorkflowDefinition): this {
    this.workflows.push(wf);
    // Keep sorted by order
    this.workflows.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return this;
  }

  unregisterWorkflow(id: string): boolean {
    const idx = this.workflows.findIndex((w) => w.id === id);
    if (idx === -1) return false;
    this.workflows.splice(idx, 1);
    return true;
  }

  /** Run all matching workflows against a document context. */
  async runForDocument(ctx: ActionContext): Promise<WorkflowRunResult[]> {
    const results: WorkflowRunResult[] = [];

    for (const wf of this.workflows) {
      if (!wf.enabled) continue;
      const matched = this.matcher.matchesAll(ctx, wf.conditions);
      const actionResults: ActionResult[] = [];

      if (matched) {
        for (const action of wf.actions) {
          const result = await this.executor.execute(action, ctx, wf.id);
          actionResults.push(result);
        }
      }

      results.push({ workflowId: wf.id, matched, actions: actionResults });
    }

    return results;
  }

  /** Signal handler: called when document_consumption_finished fires. */
  async onDocumentFinished(ctx: ActionContext): Promise<WorkflowRunResult[]> {
    return this.runForDocument(ctx);
  }

  getWorkflows(): WorkflowDefinition[] {
    return [...this.workflows];
  }
  getExecutor(): ActionExecutor {
    return this.executor;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function buildActionContext(params: {
  documentId: string;
  originalPath: string;
  outputPath: string;
  mimeType: string;
  documentType: string;
  owner?: string;
  tags?: string[];
  ingestedAt?: string;
  metadata?: Record<string, unknown>;
}): ActionContext {
  return {
    ...params,
    ingestedAt: params.ingestedAt ?? new Date().toISOString(),
  };
}
