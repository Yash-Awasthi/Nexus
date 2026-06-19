// SPDX-License-Identifier: Apache-2.0
import { IExecutionAdapter, IExecutionContext } from "./interfaces/execution.interface";
import {
  FlociClientError,
  FlociHealthStatus,
  flociFetch,
  normalizeFlociEndpoint,
  probeFlociHealth,
  resolveFlociEndpoint,
} from "./floci-client";
import {
  flociCreateLambdaFunction,
  flociDeleteLambdaFunction,
  flociInvokeLambda,
  NormalizedFlociResult,
} from "./floci-lambda";
import { IRuntimePersistence } from "./interfaces/persistence.interface";

export type FlociEventEmitter = (event: string, payload: Record<string, unknown>) => Promise<void>;

export type FlociAdapterOptions = {
  endpoint?: string;
  strict?: boolean;
  /** When false, never return mocked success — only used in tests with explicit opt-in */
  allowMockFallback?: boolean;
  onEvent?: FlociEventEmitter;
  /**
   * Optional persistence backend.  When provided, `filter_content` will
   * attempt to load the upstream task's execution result from persistence
   * (keyed by `sourceTaskId`) and run the regex against its actual output
   * rather than the built-in sample lines.
   */
  persistence?: IRuntimePersistence;
};

function envStrict(): boolean {
  const v = process.env.GHOSTSTACK_FLOCI_STRICT;
  return v === "1" || (v ?? "").toLowerCase() === "true";
}

function envAllowMock(): boolean {
  if (envStrict()) return false;
  const offline =
    process.env.GHOSTSTACK_OFFLINE_MODE === "1" ||
    (process.env.GHOSTSTACK_OFFLINE_MODE ?? "").toLowerCase() === "true" ||
    process.env.GHOSTSTACK_OFFLINE_MODE === undefined;
  const explicit = process.env.GHOSTSTACK_FLOCI_MOCK_FALLBACK;
  if (explicit === "0" || explicit?.toLowerCase() === "false") return false;
  if (explicit === "1" || explicit?.toLowerCase() === "true") return true;
  return offline;
}

export class FlociExecutionAdapter implements IExecutionAdapter {
  private readonly endpoint: string;
  private readonly strict: boolean;
  private readonly allowMockFallback: boolean;
  private readonly onEvent?: FlociEventEmitter;
  private readonly persistence?: IRuntimePersistence;
  private lastHealth: FlociHealthStatus | null = null;
  private healthOkAt = 0;
  private static readonly HEALTH_TTL_MS = 5000;

  /** Last probe result for inspector / diagnostics */
  getLastHealth(): FlociHealthStatus | null {
    return this.lastHealth;
  }

  constructor(options?: FlociAdapterOptions) {
    this.endpoint = normalizeFlociEndpoint(options?.endpoint ?? resolveFlociEndpoint());
    this.strict = options?.strict ?? envStrict();
    this.allowMockFallback = options?.allowMockFallback ?? envAllowMock();
    this.onEvent = options?.onEvent;
    this.persistence = options?.persistence;
  }

  private async emitFlociEvent(event: string, payload: Record<string, unknown>): Promise<void> {
    if (this.onEvent) {
      await this.onEvent(event, { endpoint: this.endpoint, ...payload });
    }
    // Also publish directly to event bus if available as a fallback
    // (the onEvent callback will typically publish + persist)
  }

  canExecute(taskType: string): boolean {
    return taskType === "floci";
  }

  async probeHealth(): Promise<FlociHealthStatus> {
    // Use a short timeout (200ms) when we know we're offline, to avoid
    // blocking startup for 12+ seconds on unreachable health probe paths.
    const offline =
      process.env.GHOSTSTACK_OFFLINE_MODE === "1" ||
      (process.env.GHOSTSTACK_OFFLINE_MODE ?? "").toLowerCase() === "true";
    const timeoutMs = offline ? 200 : 4000;
    this.lastHealth = await probeFlociHealth(this.endpoint, timeoutMs);
    if (this.lastHealth.reachable) {
      this.healthOkAt = Date.now();
    }
    return this.lastHealth;
  }

  private async verifyFlociHealthy(context: IExecutionContext): Promise<FlociHealthStatus> {
    const now = Date.now();
    if (this.lastHealth?.reachable && now - this.healthOkAt < FlociExecutionAdapter.HEALTH_TTL_MS) {
      return this.lastHealth;
    }
    const status = await this.probeHealth();
    if (!status.reachable) {
      if (this.strict) {
        throw new FlociClientError(
          `Floci strict mode: emulator not reachable at ${this.endpoint} (${status.error})`,
          "UNREACHABLE",
        );
      }
      context.logger?.warn?.("Floci health check failed (non-strict)", {
        endpoint: this.endpoint,
        error: status.error,
      });
    } else {
      context.logger?.info?.("Floci health check OK", {
        endpoint: this.endpoint,
        healthPath: status.healthPath,
        latencyMs: status.latencyMs,
      });
    }
    return status;
  }

  async execute(task: any, context: IExecutionContext): Promise<any> {
    const payload = task.payload || {};
    const action = payload.action;
    const started = Date.now();

    context.logger?.info?.(`Floci adapter dispatching action: ${action}`, {
      taskId: context.taskId,
      endpoint: this.endpoint,
      strict: this.strict,
    });

    if (this.strict || action === "health") {
      await this.verifyFlociHealthy(context);
    }

    if (action === "health") {
      return {
        status: "success",
        service: "floci",
        endpoint: this.endpoint,
        strict: this.strict,
        health: this.lastHealth,
        latencyMs: Date.now() - started,
      };
    }

    let result: Record<string, unknown>;
    switch (action) {
      case "create_s3_bucket":
        result = await this.runS3CreateBucket(payload, context);
        break;
      case "create_sqs_queue":
        result = await this.runSqsCreateQueue(payload, context);
        break;
      case "create_dynamodb_table":
        result = await this.runDynamoCreateTable(payload, context);
        break;
      case "filter_content":
        result = await this.runFilterContent(payload, context);
        break;
      case "create_lambda":
        result = await this.runCreateLambda(payload, context);
        break;
      case "invoke_lambda":
        result = await this.runInvokeLambda(payload, context);
        break;
      case "delete_lambda":
        result = await this.runDeleteLambda(payload, context);
        break;
      default:
        throw new FlociClientError(`Unsupported Floci action: ${action}`, "UNKNOWN_ACTION");
    }

    result.flociLatencyMs = Date.now() - started;
    result.flociReachable = this.lastHealth?.reachable ?? false;
    await this.emitFlociEvent("floci_action_completed", {
      taskId: context.taskId,
      action,
      status: result.status,
      service: result.service,
      mocked: result.mocked,
    });
    return result;
  }

  /** Execute a Floci action directly (HTTP API / MCP bridge). */
  async executeAction(
    action: string,
    payload: Record<string, unknown>,
    context: IExecutionContext,
  ): Promise<Record<string, unknown>> {
    return this.execute({ type: "floci", payload: { action, ...payload } }, context);
  }

  private fromNormalized(norm: NormalizedFlociResult): Record<string, unknown> {
    return {
      status: norm.status,
      service: norm.service,
      action: norm.action,
      mocked: norm.mocked,
      httpStatus: norm.httpStatus,
      flociRequestMs: norm.flociRequestMs,
      data: norm.data,
    };
  }

  private mockOrThrow(
    context: IExecutionContext,
    service: string,
    mockBody: Record<string, unknown>,
    err?: unknown,
  ): Record<string, unknown> {
    if (this.strict) {
      throw err instanceof FlociClientError
        ? err
        : new FlociClientError(String(err), "UNREACHABLE");
    }
    if (!this.allowMockFallback) {
      throw new Error(
        `Floci unavailable and mock fallback disabled (set GHOSTSTACK_OFFLINE_MODE=true or GHOSTSTACK_FLOCI_MOCK_FALLBACK=true): ${err}`,
      );
    }
    context.logger?.warn?.(`Floci ${service}: using offline mock`, { error: err });
    return { status: "success", service, mocked: true, ...mockBody };
  }

  private async runS3CreateBucket(payload: Record<string, unknown>, context: IExecutionContext) {
    const bucketName = payload.bucketName as string;
    if (!bucketName) throw new Error("Missing bucketName in create_s3_bucket payload");

    try {
      const res = await flociFetch(this.endpoint, {
        requestUrl: `${this.endpoint}/${bucketName}`,
        method: "PUT",
        timeoutMs: 15000,
      });
      if (res.ok) {
        // Emit S3 object created event for pipeline triggering
        await this.emitFlociEvent("floci_s3_object_created", {
          bucketName,
          key: "", // bucket creation doesn't create an object, but signals availability
          action: "create_s3_bucket",
        });
        return {
          status: "success",
          service: "s3",
          bucketName,
          bucketUrl: `${this.endpoint}/${bucketName}`,
          mocked: false,
          httpStatus: res.status,
          flociRequestMs: res.latencyMs,
        };
      }
      if (this.strict) {
        throw new FlociClientError(
          `Floci S3 create bucket failed: HTTP ${res.status}`,
          "HTTP_ERROR",
          res.status,
          res.bodyText.slice(0, 500),
        );
      }
    } catch (err) {
      return this.mockOrThrow(
        context,
        "s3",
        { bucketName, bucketUrl: `${this.endpoint}/${bucketName}` },
        err,
      );
    }

    return this.mockOrThrow(context, "s3", {
      bucketName,
      bucketUrl: `${this.endpoint}/${bucketName}`,
    });
  }

  private async runSqsCreateQueue(payload: Record<string, unknown>, context: IExecutionContext) {
    const queueName = payload.queueName as string;
    if (!queueName) throw new Error("Missing queueName in create_sqs_queue payload");

    try {
      const params = new URLSearchParams({
        Action: "CreateQueue",
        QueueName: queueName,
        Version: "2012-11-05",
      });
      const res = await flociFetch(this.endpoint, {
        requestUrl: `${this.endpoint}/`,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
        timeoutMs: 15000,
      });
      if (res.ok) {
        return {
          status: "success",
          service: "sqs",
          queueName,
          queueUrl: `${this.endpoint}/000000000000/${queueName}`,
          mocked: false,
          httpStatus: res.status,
          flociRequestMs: res.latencyMs,
        };
      }
      if (this.strict) {
        throw new FlociClientError(
          `Floci SQS failed: HTTP ${res.status}`,
          "HTTP_ERROR",
          res.status,
          res.bodyText,
        );
      }
    } catch (err) {
      return this.mockOrThrow(
        context,
        "sqs",
        { queueName, queueUrl: `${this.endpoint}/000000000000/${queueName}` },
        err,
      );
    }

    return this.mockOrThrow(context, "sqs", {
      queueName,
      queueUrl: `${this.endpoint}/000000000000/${queueName}`,
    });
  }

  private async runDynamoCreateTable(payload: Record<string, unknown>, context: IExecutionContext) {
    const tableName = payload.tableName as string;
    if (!tableName) throw new Error("Missing tableName in create_dynamodb_table payload");

    try {
      const ddbPayload = {
        TableName: tableName,
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
        AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
      };
      const res = await flociFetch(this.endpoint, {
        requestUrl: `${this.endpoint}/`,
        method: "POST",
        headers: {
          "Content-Type": "application/x-amz-json-1.0",
          "X-Amz-Target": "DynamoDB_20120810.CreateTable",
        },
        body: JSON.stringify(ddbPayload),
        timeoutMs: 15000,
      });
      if (res.ok) {
        return {
          status: "success",
          service: "dynamodb",
          tableName,
          mocked: false,
          httpStatus: res.status,
          flociRequestMs: res.latencyMs,
        };
      }
      if (this.strict) {
        throw new FlociClientError(
          `Floci DynamoDB failed: HTTP ${res.status}`,
          "HTTP_ERROR",
          res.status,
          res.bodyText,
        );
      }
    } catch (err) {
      return this.mockOrThrow(context, "dynamodb", { tableName }, err);
    }

    return this.mockOrThrow(context, "dynamodb", { tableName });
  }

  private async runCreateLambda(payload: Record<string, unknown>, context: IExecutionContext) {
    const functionName = payload.functionName as string;
    if (!functionName) throw new Error("Missing functionName for create_lambda");

    try {
      const norm = await flociCreateLambdaFunction(this.endpoint, functionName, {
        handlerBody: payload.handlerBody as string | undefined,
        runtime: payload.runtime as string | undefined,
        timeout: payload.timeout as number | undefined,
      });
      return this.fromNormalized(norm);
    } catch (err) {
      return this.mockOrThrow(
        context,
        "lambda",
        { functionName, action: "create_lambda", data: { FunctionName: functionName } },
        err,
      );
    }
  }

  private async runInvokeLambda(payload: Record<string, unknown>, context: IExecutionContext) {
    const functionName = payload.functionName as string;
    if (!functionName) throw new Error("Missing functionName for invoke_lambda");

    try {
      const norm = await flociInvokeLambda(this.endpoint, {
        functionName,
        payload: payload.event ?? payload.payload ?? {},
        invocationType: (payload.invocationType as "RequestResponse") ?? "RequestResponse",
        qualifier: payload.qualifier as string | undefined,
      });
      return this.fromNormalized(norm);
    } catch (err) {
      return this.mockOrThrow(
        context,
        "lambda",
        {
          functionName,
          action: "invoke_lambda",
          data: { statusCode: 200, body: "mocked-invoke", mocked: true },
        },
        err,
      );
    }
  }

  private async runDeleteLambda(payload: Record<string, unknown>, context: IExecutionContext) {
    const functionName = payload.functionName as string;
    if (!functionName) throw new Error("Missing functionName for delete_lambda");

    try {
      const norm = await flociDeleteLambdaFunction(this.endpoint, functionName);
      return this.fromNormalized(norm);
    } catch (err) {
      return this.mockOrThrow(
        context,
        "lambda",
        { functionName, action: "delete_lambda", data: { deleted: true } },
        err,
      );
    }
  }

  private async runFilterContent(payload: Record<string, unknown>, context: IExecutionContext) {
    const pattern = (payload.pattern as string) || ".*";
    const sourceTaskId = payload.sourceTaskId as string | undefined;
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "i");
    } catch (err) {
      throw new Error(`Invalid filter pattern: ${(err as Error).message}`);
    }

    // ── Resolve source content ────────────────────────────────────────────────
    // If sourceTaskId is given and persistence is wired in, try to read the
    // actual execution result of the upstream task and extract text lines from it.
    // This enables real ETL data flow: extract → filter_content → load.
    let resolvedLines: string[] | undefined;
    if (sourceTaskId && this.persistence) {
      try {
        const sourceState = await this.persistence.getState<{
          status: string;
          result?: Record<string, unknown>;
        }>(sourceTaskId);
        if (sourceState?.status === "success" && sourceState.result) {
          const r = sourceState.result;
          if (Array.isArray(r.lines)) {
            resolvedLines = (r.lines as unknown[]).map(String);
          } else if (typeof r.content === "string") {
            resolvedLines = r.content.split(/\r?\n/).filter(Boolean);
          } else if (r.data && typeof r.data === "object" && !Array.isArray(r.data)) {
            resolvedLines = Object.values(r.data as Record<string, unknown>).map(String);
          } else if (Array.isArray(r.matches)) {
            resolvedLines = (r.matches as unknown[]).map(String);
          }
          if (resolvedLines && resolvedLines.length > 0) {
            context.logger?.info?.("filter_content: resolved source from persistence", {
              sourceTaskId,
              lineCount: resolvedLines.length,
            });
          } else {
            resolvedLines = undefined;
          }
        }
      } catch {
        // Persistence unavailable or key not found — fall through to sample data
      }
    }

    // Fall back to built-in sample lines when no live pipeline data is available
    const sampleLines = [
      "OpenAI releases GPT-5 with improved reasoning capabilities spanning mathematics and coding benchmarks across multiple domains",
      "Anthropic introduces Claude 3 Opus for enterprise AI deployments with enhanced safety guardrails and compliance certifications",
      "Google DeepMind achieves breakthrough in protein folding prediction accuracy with AlphaFold 3.0 release",
      "Meta launches open-source LLM framework for researchers enabling fine-tuning on custom datasets with minimal infrastructure",
      "AWS announces new Graviton4 instances optimized for machine learning inference workloads at 40% lower cost",
      "Microsoft Azure AI deployed across 54 new regions expanding cognitive services API availability worldwide",
      "Conductor v1.1 introduces governed workflow orchestration with deterministic replay and checkpoint-based recovery",
      "Local-first autonomous cloud engine reduces latency by 80% through in-process MCP bridge avoiding network hops",
      "Floci emulator reaches v0.9 with full S3, DynamoDB, SQS, and Lambda API coverage for offline AWS development",
      "Distributed tracing integration enables end-to-end visibility across workflow execution spans from ingestion to completion",
      "PostgreSQL 17 released with enhanced JSON query performance and improved vector similarity search capabilities",
      "Redis 8.0 introduces native probabilistic data structures including Bloom filters and HyperLogLog for real-time analytics",
      "Kubernetes 1.30 ships with enhanced sidecar container lifecycle management and improved storage capacity tracking",
      "Terraform 2.0 previews provider-agnostic state management with pluggable backends for multi-cloud deployments",
      "Data processing pipeline throughput improved by 300% using columnar storage format with predicate pushdown optimization",
      "Event-driven architecture patterns for serverless workflows using SQS, SNS, and Lambda function composition",
      "Machine learning model deployment pipeline achieves 99.95% uptime through automated rollback and canary testing",
      "Real-time data ingestion framework processes 500K events/second with exactly-once semantics and automatic retry logic",
      "Observability platform correlates metrics, traces, and logs in unified dashboard reducing MTTR by 65%",
      "Security compliance automation ensures SOC2 and HIPAA requirements through continuous policy enforcement and audit logging",
    ];
    const linesToFilter = resolvedLines ?? sampleLines;
    const matches = linesToFilter.filter((line) => regex.test(line));
    const usedLiveData = resolvedLines !== undefined;

    context.logger?.info?.("Floci filter_content completed", {
      sourceTaskId,
      usedLiveData,
      matchCount: matches.length,
      totalLines: linesToFilter.length,
    });

    return {
      status: "success",
      service: "filter",
      sourceTaskId,
      pattern,
      matches,
      totalLines: linesToFilter.length,
      matchCount: matches.length,
      usedLiveData,
      mocked: !usedLiveData,
    };
  }
}
