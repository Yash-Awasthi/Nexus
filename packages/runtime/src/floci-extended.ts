// SPDX-License-Identifier: Apache-2.0
/**
 * Floci extended actions — non-standard AWS operations supported by the
 * Floci emulator beyond the core LocalStack API surface.
 */

export const EXTENDED_FLOCI_ACTIONS: readonly string[] = [
  "create_s3_bucket",
  "delete_s3_bucket",
  "put_s3_object",
  "get_s3_object",
  "create_sqs_queue",
  "send_sqs_message",
  "receive_sqs_messages",
  "create_dynamodb_table",
  "put_dynamodb_item",
  "get_dynamodb_item",
  "create_lambda",
  "invoke_lambda",
  "delete_lambda",
  "create_sns_topic",
  "publish_sns_message",
  "list_s3_buckets",
];

/**
 * Dispatch an extended Floci action via HTTP to the Floci emulator.
 *
 * Supports two call signatures:
 *  - 3-arg: dispatchExtendedAction(action, payload, context?)
 *  - 4-arg: dispatchExtendedAction(endpoint, action, payload, onEvent?)
 */
export async function dispatchExtendedAction(
  endpointOrAction: string,
  actionOrPayload: string | Record<string, unknown>,
  payloadOrContext?:
    | Record<string, unknown>
    | ((event: string, payload: Record<string, unknown>) => Promise<void>),
  onEvent?: (event: string, payload: Record<string, unknown>) => Promise<void>,
): Promise<Record<string, unknown>> {
  let endpoint: string;
  let action: string;
  let payload: Record<string, unknown>;
  let eventCb: ((event: string, payload: Record<string, unknown>) => Promise<void>) | undefined;

  if (typeof actionOrPayload === "string") {
    endpoint = endpointOrAction;
    action = actionOrPayload;
    payload = (payloadOrContext as Record<string, unknown>) ?? {};
    eventCb = onEvent;
  } else {
    endpoint = process.env.FLOCI_ENDPOINT ?? "http://localhost:4566";
    action = endpointOrAction;
    payload = actionOrPayload;
    eventCb = undefined;
  }

  const url = `${endpoint}/_floci/extended/${encodeURIComponent(action)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Floci extended action '${action}' failed: HTTP ${res.status}`);
  }

  const result = (await res.json()) as Record<string, unknown>;

  if (eventCb) {
    await eventCb(`floci_extended_${action}`, { action, payload, result });
  }

  return result;
}
