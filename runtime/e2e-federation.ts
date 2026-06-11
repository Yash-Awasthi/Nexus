import { GhostStackRuntimeContext } from "./runtime-context";
import { IWorkflowDefinition } from "../orchestration/interfaces/workflow.interface";
import { Task } from "../orchestration/task-router";
import { flociDeleteLambdaFunction } from "../orchestration/floci-lambda";
import { resolveFlociEndpoint } from "../orchestration/floci-client";

export type FederationE2eResult = {
  status: string;
  workflowId: string;
  executionId: string;
  error?: string;
  taskResults?: Record<string, unknown>;
  cleanup?: { lambdaDeleted?: boolean; errors?: string[] };
};

export type FederationE2eOptions = {
  strict?: boolean;
  cleanup?: boolean;
};

/**
 * End-to-end federation flow: S3 bucket → Lambda create → Lambda invoke.
 * Requires live Floci when strict=true (default for this runner).
 */
export async function runFederationE2e(
  ctx: GhostStackRuntimeContext,
  options: FederationE2eOptions = {}
): Promise<FederationE2eResult> {
  const strict = options.strict ?? true;
  const cleanup = options.cleanup ?? true;
  const suffix = Date.now();
  const workflowId = `federation-e2e-${suffix}`;
  const executionId = `e2e-run-${suffix}`;
  const bucketName = `ghoststack-e2e-${suffix}`;
  const functionName = `ghoststack-e2e-fn-${suffix}`;

  if (strict) {
    process.env.GHOSTSTACK_FLOCI_STRICT = "true";
    process.env.GHOSTSTACK_OFFLINE_MODE = "false";
    process.env.GHOSTSTACK_FLOCI_MOCK_FALLBACK = "false";
  }

  const tasks: Task[] = [
    {
      id: "e2e-s3",
      title: "Create E2E bucket",
      description: "floci s3",
      priority: "high",
      status: "pending",
      dependencies: [],
      type: "floci",
      action: "create_s3_bucket",
      arguments: { bucketName }
    },
    {
      id: "e2e-lambda-create",
      title: "Deploy E2E Lambda",
      description: "floci lambda",
      priority: "high",
      status: "pending",
      dependencies: ["e2e-s3"],
      type: "floci",
      action: "create_lambda",
      arguments: {
        functionName,
        handlerBody: "JSON.stringify({ ok: true, source: 'ghoststack-e2e', event })"
      }
    },
    {
      id: "e2e-lambda-invoke",
      title: "Invoke E2E Lambda",
      description: "floci invoke",
      priority: "high",
      status: "pending",
      dependencies: ["e2e-lambda-create"],
      type: "floci",
      action: "invoke_lambda",
      arguments: {
        functionName,
        payload: { test: "ghoststack-e2e" }
      }
    }
  ];

  const definition: IWorkflowDefinition = {
    id: workflowId,
    name: "Federation E2E Pipeline",
    description: "S3 → Lambda deploy → Lambda invoke",
    tasks
  };

  ctx.registry.registerWorkflow(definition);
  ctx.logger.info("Starting federation E2E workflow", { workflowId, executionId, strict });

  const exec = await ctx.workflowEngine.executeWorkflow(workflowId, executionId);

  const result: FederationE2eResult = {
    status: exec.status,
    workflowId,
    executionId,
    error: exec.error,
    taskResults: exec.taskResults
  };

  if (cleanup && strict) {
    const cleanupErrors: string[] = [];
    try {
      await flociDeleteLambdaFunction(resolveFlociEndpoint(), functionName);
      result.cleanup = { lambdaDeleted: true };
    } catch (err) {
      cleanupErrors.push((err as Error).message);
      result.cleanup = { lambdaDeleted: false, errors: cleanupErrors };
    }
  }

  return result;
}
