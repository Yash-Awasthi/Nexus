import { IPlanningEngine, ICognitiveTrace, ITaskSynthesisResult } from "./interfaces/governance.interface.js";
import { ILanguageModel } from "./interfaces/language-model.interface.js";

// ─── Task template & blueprint types ─────────────────────────────────────────

interface TaskTemplate {
  action: string;
  defaultArguments: Record<string, unknown>;
  governanceMetadata: { dangerous: boolean; costEstimate: number; resourceScope: string };
  /** Actions this template depends on (matched by action name within the same blueprint) */
  dependsOnActions: string[];
  /** Executor adapter that handles this task — defaults to "floci" when absent */
  adapterType?: string;
}

interface PlanBlueprint {
  label: string;
  templates: TaskTemplate[];
}

// ─── Blueprint registry ───────────────────────────────────────────────────────

const PLAN_BLUEPRINTS: Record<string, PlanBlueprint> = {
  ingestion: {
    label: "Data Ingestion Pipeline",
    templates: [
      {
        action: "create_s3_bucket",
        defaultArguments: { bucketName: "news-scraper-archive", encrypted: true },
        governanceMetadata: { dangerous: false, costEstimate: 0.02, resourceScope: "aws:s3" },
        dependsOnActions: []
      },
      {
        action: "create_sqs_queue",
        defaultArguments: { queueName: "news-ingestion-jobs" },
        governanceMetadata: { dangerous: false, costEstimate: 0.01, resourceScope: "aws:sqs" },
        dependsOnActions: ["create_s3_bucket"]
      },
      {
        action: "create_dynamodb_table",
        defaultArguments: { tableName: "scraper-headlines", primaryKey: "id" },
        governanceMetadata: { dangerous: false, costEstimate: 0.05, resourceScope: "aws:dynamodb" },
        dependsOnActions: ["create_sqs_queue"]
      }
    ]
  },

  scraper: {
    label: "Web Scraper Deployment",
    templates: [
      {
        action: "create_s3_bucket",
        defaultArguments: { bucketName: "scraper-output", encrypted: true },
        governanceMetadata: { dangerous: false, costEstimate: 0.02, resourceScope: "aws:s3" },
        dependsOnActions: []
      },
      {
        action: "deploy_scraper_lambda",
        defaultArguments: { runtime: "nodejs20.x", memoryMb: 512, timeoutSec: 60 },
        governanceMetadata: { dangerous: false, costEstimate: 0.03, resourceScope: "aws:lambda" },
        dependsOnActions: ["create_s3_bucket"]
      },
      {
        action: "configure_eventbridge_schedule",
        defaultArguments: { scheduleExpression: "rate(1 hour)" },
        governanceMetadata: { dangerous: false, costEstimate: 0.005, resourceScope: "aws:events" },
        dependsOnActions: ["deploy_scraper_lambda"]
      }
    ]
  },

  backup: {
    label: "Secure Backup",
    templates: [
      {
        action: "create_iam_role",
        defaultArguments: { roleName: "BackupAdministrator", permissions: ["s3:*", "glacier:*"] },
        governanceMetadata: { dangerous: true, costEstimate: 0.0, resourceScope: "aws:iam" },
        dependsOnActions: []
      },
      {
        action: "create_s3_bucket",
        defaultArguments: { bucketName: "secure-backups-archive", versioning: true, lifecycle: "glacier-90d" },
        governanceMetadata: { dangerous: false, costEstimate: 0.1, resourceScope: "aws:s3" },
        dependsOnActions: ["create_iam_role"]
      },
      {
        action: "enable_backup_policy",
        defaultArguments: { retentionDays: 90, crossRegion: false },
        governanceMetadata: { dangerous: false, costEstimate: 0.02, resourceScope: "aws:backup" },
        dependsOnActions: ["create_s3_bucket"]
      }
    ]
  },

  etl: {
    label: "ETL Workflow",
    templates: [
      {
        action: "create_glue_job",
        defaultArguments: { jobName: "etl-transform", workerType: "G.1X", numberOfWorkers: 2 },
        governanceMetadata: { dangerous: false, costEstimate: 0.44, resourceScope: "aws:glue" },
        dependsOnActions: []
      },
      {
        action: "create_dynamodb_table",
        defaultArguments: { tableName: "etl-output", primaryKey: "id", billingMode: "PAY_PER_REQUEST" },
        governanceMetadata: { dangerous: false, costEstimate: 0.05, resourceScope: "aws:dynamodb" },
        dependsOnActions: []
      },
      {
        action: "configure_glue_trigger",
        defaultArguments: { triggerType: "SCHEDULED", schedule: "cron(0 2 * * ? *)" },
        governanceMetadata: { dangerous: false, costEstimate: 0.01, resourceScope: "aws:glue" },
        dependsOnActions: ["create_glue_job", "create_dynamodb_table"]
      }
    ]
  },

  research: {
    label: "Research & Aggregation",
    templates: [
      {
        action: "create_s3_bucket",
        defaultArguments: { bucketName: "research-artifacts", encrypted: true },
        governanceMetadata: { dangerous: false, costEstimate: 0.02, resourceScope: "aws:s3" },
        dependsOnActions: []
      },
      {
        action: "deploy_research_agent",
        defaultArguments: { agentType: "web-research", maxDepth: 3, outputFormat: "json" },
        governanceMetadata: { dangerous: false, costEstimate: 0.1, resourceScope: "agent:research" },
        dependsOnActions: ["create_s3_bucket"]
      }
    ]
  },

  dangerous: {
    label: "Privileged / Dangerous Operation",
    templates: [
      {
        action: "request_approval",
        defaultArguments: { reason: "Dangerous operation requires human approval", timeout: 3600 },
        governanceMetadata: { dangerous: false, costEstimate: 0.0, resourceScope: "governance:approval" },
        dependsOnActions: []
      },
      {
        action: "execute_privileged_operation",
        defaultArguments: { scope: "restricted" },
        governanceMetadata: { dangerous: true, costEstimate: 0.0, resourceScope: "system:privileged" },
        dependsOnActions: ["request_approval"]
      }
    ]
  },

  delete: {
    label: "Resource Cleanup / Deletion",
    templates: [
      {
        action: "list_resources_for_deletion",
        defaultArguments: { dryRun: true },
        governanceMetadata: { dangerous: false, costEstimate: 0.0, resourceScope: "aws:all" },
        dependsOnActions: []
      },
      {
        action: "request_approval",
        defaultArguments: { reason: "Deletion requires human approval", timeout: 3600 },
        governanceMetadata: { dangerous: false, costEstimate: 0.0, resourceScope: "governance:approval" },
        dependsOnActions: ["list_resources_for_deletion"]
      },
      {
        action: "delete_resources",
        defaultArguments: { scope: "listed", force: false },
        governanceMetadata: { dangerous: true, costEstimate: 0.0, resourceScope: "system:root" },
        dependsOnActions: ["request_approval"]
      }
    ]
  },

  search: {
    label: "Web Search & Synthesis",
    templates: [
      {
        action: "web_search",
        defaultArguments: { mode: "balanced" },
        governanceMetadata: { dangerous: false, costEstimate: 0.01, resourceScope: "web:search" },
        dependsOnActions: [],
        adapterType: "search"
      }
    ]
  },

  code: {
    label: "Code Generation & Editing",
    templates: [
      {
        action: "code_agent_run",
        defaultArguments: { maxIterations: 5 },
        governanceMetadata: { dangerous: false, costEstimate: 0.05, resourceScope: "agent:code" },
        dependsOnActions: [],
        adapterType: "code"
      }
    ]
  },

  inference: {
    label: "Local Model Inference",
    templates: [
      {
        action: "local_inference",
        defaultArguments: { maxNewTokens: 300 },
        governanceMetadata: { dangerous: false, costEstimate: 0.0, resourceScope: "local:inference" },
        dependsOnActions: [],
        adapterType: "inference"
      }
    ]
  },

  default: {
    label: "Generic Execution",
    templates: [
      {
        action: "generic_execution",
        defaultArguments: {},
        governanceMetadata: { dangerous: false, costEstimate: 0.01, resourceScope: "generic" },
        dependsOnActions: []
      }
    ]
  }
};

// Priority-ordered blueprint keys — first whole-word match wins.
// "search" is intentionally listed before "research" so a standalone "search"
// objective does not accidentally match the research blueprint via substring.
const PRIORITY_ORDER = ["ingestion", "scraper", "backup", "etl", "search", "research", "code", "inference", "dangerous", "delete"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extracts `key=value` overrides from the objective string.
 * Example: "deploy scraper bucketName=my-bucket memoryMb=256" → { bucketName: "my-bucket", memoryMb: "256" }
 */
function extractArgumentOverrides(objective: string): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  const kvPattern = /(\w+)=([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = kvPattern.exec(objective)) !== null) {
    const key = match[1];
    const raw = match[2];
    if (!key || !raw) continue;
    // Coerce numeric strings; leave the rest as strings
    const asNumber = Number(raw);
    overrides[key] = Number.isNaN(asNumber) ? raw : asNumber;
  }
  return overrides;
}

/** Returns the best-matching blueprint for the given normalised objective string. */
// Pre-compiled whole-word regexes for each blueprint key
const BLUEPRINT_WORD_REGEXES: Record<string, RegExp> = Object.fromEntries(
  PRIORITY_ORDER.map((key) => [key, new RegExp(`\\b${key}\\b`)])
);

function selectBlueprint(normObjective: string): PlanBlueprint {
  for (const key of PRIORITY_ORDER) {
    const regex = BLUEPRINT_WORD_REGEXES[key];
    const bp = PLAN_BLUEPRINTS[key];
    if (regex && bp && regex.test(normObjective)) {
      return bp;
    }
  }
  const fallbackKey = PRIORITY_ORDER[0] ?? "default";
  return (PLAN_BLUEPRINTS.default ?? PLAN_BLUEPRINTS[fallbackKey]) as PlanBlueprint;
}

/**
 * Converts a blueprint into concrete ITaskSynthesisResult items with a computed DAG.
 * Dependency IDs are resolved by matching dependsOnActions names to task IDs within
 * the same plan, so the output is always a valid topological graph.
 */
function synthesisFromBlueprint(
  planId: string,
  blueprint: PlanBlueprint,
  argumentOverrides: Record<string, unknown>,
  objective: string
): ITaskSynthesisResult[] {
  // Build action → taskId index first so dependency resolution is O(n)
  const actionToTaskId = new Map<string, string>();
  const taskIds = blueprint.templates.map((t, i) => {
    const taskId = `${planId}-${t.action.replace(/_/g, "-")}-${i}`;
    actionToTaskId.set(t.action, taskId);
    return taskId;
  });

  return blueprint.templates.map((template, i) => {
    const taskId = taskIds[i];
    const mergedArgs: Record<string, unknown> =
      template.action === "generic_execution"
        ? { objective, ...template.defaultArguments, ...argumentOverrides }
        : { ...template.defaultArguments, ...argumentOverrides };

    const dependencies = template.dependsOnActions
      .map((a) => actionToTaskId.get(a))
      .filter((id): id is string => id !== undefined);

    return {
      taskId,
      action: template.action,
      arguments: mergedArgs,
      dependencies,
      priority: i === 0 ? "high" : "medium",
      adapterType: template.adapterType ?? "floci",
      governanceMetadata: { ...template.governanceMetadata }
    } satisfies ITaskSynthesisResult;
  });
}

// ─── PlanningEngine ───────────────────────────────────────────────────────────

const BLUEPRINT_KEYS = Object.keys(PLAN_BLUEPRINTS) as Array<keyof typeof PLAN_BLUEPRINTS>;

export class PlanningEngine implements IPlanningEngine {
  private readonly llm?: ILanguageModel;

  /**
   * @param llm Optional language model for LLM-backed blueprint selection.
   *            When omitted the engine falls back to keyword matching.
   */
  constructor(llm?: ILanguageModel) {
    this.llm = llm;
  }

  async generatePlan(objective: string, _context?: any): Promise<ICognitiveTrace> {
    const planId = `plan-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16)}`;
    const normObj = objective.toLowerCase().trim();
    const argumentOverrides = extractArgumentOverrides(normObj);

    const blueprint = this.llm
      ? await this._llmSelectBlueprint(objective, normObj)
      : selectBlueprint(normObj);

    const synthesisResults = synthesisFromBlueprint(planId, blueprint, argumentOverrides, objective);

    return {
      planId,
      objective,
      synthesisResults,
      timestamp: new Date()
    };
  }

  /**
   * Uses the language model to classify an objective into a blueprint key.
   * Falls back to keyword matching when the model returns an unrecognised key
   * or throws.
   */
  private async _llmSelectBlueprint(objective: string, normObj: string): Promise<PlanBlueprint> {
    try {
      const result = await this.llm!.generateObject<{ blueprintKey: string }>({
        schema: {
          type: "object",
          properties: {
            blueprintKey: { type: "string", enum: BLUEPRINT_KEYS }
          },
          required: ["blueprintKey"]
        },
        messages: [
          {
            role: "system",
            content: `You are an AI workflow planner. Given a user objective, select the most appropriate execution blueprint.
Available blueprints: ${BLUEPRINT_KEYS.map((k) => `"${k}" (${PLAN_BLUEPRINTS[k]?.label ?? ""})`).join(", ")}.
Respond with a JSON object: { "blueprintKey": "<chosen key>" }.`
          },
          {
            role: "user",
            content: `Objective: ${objective}`
          }
        ]
      });

      const chosen = result?.blueprintKey as keyof typeof PLAN_BLUEPRINTS;
      if (chosen && PLAN_BLUEPRINTS[chosen]) {
        return PLAN_BLUEPRINTS[chosen];
      }
    } catch {
      // Model unavailable or returned unusable response — fall through to keyword matching
    }
    return selectBlueprint(normObj);
  }
}
