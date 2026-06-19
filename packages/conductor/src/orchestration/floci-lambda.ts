// SPDX-License-Identifier: Apache-2.0
import { flociFetch, normalizeFlociEndpoint } from "./floci-client";
import { FlociClientError } from "./floci-client";
import { buildNodeLambdaHandlerZip } from "./floci-zip";

const LAMBDA_ROLE = "arn:aws:iam::000000000000:role/lambda-role";

export type LambdaInvokePayload = {
  functionName: string;
  payload?: unknown;
  invocationType?: "RequestResponse" | "Event" | "DryRun";
  qualifier?: string;
};

export type NormalizedFlociResult = {
  status: "success" | "error";
  service: string;
  action: string;
  mocked: boolean;
  httpStatus?: number;
  flociRequestMs?: number;
  data?: unknown;
  error?: string;
  errorCode?: string;
};

export function mapFlociHttpError(
  action: string,
  service: string,
  status: number,
  bodyText: string,
): FlociClientError {
  return new FlociClientError(
    `Floci ${action} failed: HTTP ${status} ${bodyText.slice(0, 500)}`,
    status >= 500 ? "HTTP_ERROR" : "HTTP_ERROR",
    status,
    bodyText,
  );
}

export function normalizeLambdaInvokeBody(bodyText: string): unknown {
  const trimmed = bodyText.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

export async function flociCreateLambdaFunction(
  endpoint: string,
  functionName: string,
  options?: { handlerBody?: string; runtime?: string; timeout?: number },
): Promise<NormalizedFlociResult> {
  const base = normalizeFlociEndpoint(endpoint);
  const zip = buildNodeLambdaHandlerZip(options?.handlerBody ?? "JSON.stringify(event)");
  const body = {
    FunctionName: functionName,
    Runtime: options?.runtime ?? "nodejs20.x",
    Role: LAMBDA_ROLE,
    Handler: "index.handler",
    Timeout: options?.timeout ?? 30,
    Code: { ZipFile: zip.toString("base64") },
  };

  const res = await flociFetch(base, {
    requestUrl: `${base}/2015-03-31/functions`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 60000,
  });

  if (res.ok || res.status === 201) {
    let data: unknown;
    try {
      data = JSON.parse(res.bodyText);
    } catch {
      data = res.bodyText;
    }
    return {
      status: "success",
      service: "lambda",
      action: "create_lambda",
      mocked: false,
      httpStatus: res.status,
      flociRequestMs: res.latencyMs,
      data,
    };
  }

  throw mapFlociHttpError("create_lambda", "lambda", res.status, res.bodyText);
}

export async function flociInvokeLambda(
  endpoint: string,
  input: LambdaInvokePayload,
): Promise<NormalizedFlociResult> {
  const base = normalizeFlociEndpoint(endpoint);
  const fn = input.functionName;
  if (!fn) {
    throw new Error("functionName is required for invoke_lambda");
  }

  const qualifier = input.qualifier ? `:${input.qualifier}` : "";
  const invocationType = input.invocationType ?? "RequestResponse";
  const payloadStr =
    input.payload === undefined || input.payload === null
      ? "{}"
      : typeof input.payload === "string"
        ? input.payload
        : JSON.stringify(input.payload);

  const res = await flociFetch(base, {
    requestUrl: `${base}/2015-03-31/functions/${fn}${qualifier}/invocations`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Amz-Invocation-Type": invocationType,
    },
    body: payloadStr,
    timeoutMs: 120000,
  });

  const parsed = normalizeLambdaInvokeBody(res.bodyText);

  if (res.ok) {
    return {
      status: "success",
      service: "lambda",
      action: "invoke_lambda",
      mocked: false,
      httpStatus: res.status,
      flociRequestMs: res.latencyMs,
      data: parsed,
    };
  }

  throw mapFlociHttpError("invoke_lambda", "lambda", res.status, res.bodyText);
}

export async function flociDeleteLambdaFunction(
  endpoint: string,
  functionName: string,
): Promise<NormalizedFlociResult> {
  const base = normalizeFlociEndpoint(endpoint);
  const res = await flociFetch(base, {
    requestUrl: `${base}/2015-03-31/functions/${functionName}`,
    method: "DELETE",
    timeoutMs: 30000,
  });

  if (res.ok || res.status === 204) {
    return {
      status: "success",
      service: "lambda",
      action: "delete_lambda",
      mocked: false,
      httpStatus: res.status,
      flociRequestMs: res.latencyMs,
      data: { functionName, deleted: true },
    };
  }

  throw mapFlociHttpError("delete_lambda", "lambda", res.status, res.bodyText);
}
