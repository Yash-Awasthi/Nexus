// SPDX-License-Identifier: Apache-2.0
/**
 * Two error envelopes, one writer each.
 *
 * The public OpenAI-compatible surface answers `{ type: "error", error: { type, message } }`
 * because that is what its clients parse, and the Nexus surface answers
 * `{ error: "code", message? }` because that is what the dashboard reads. Both are fine;
 * writing them out at every refusal is not, because the shape then depends on which
 * handler the author copied.
 *
 * These helpers take the status and the fields and write the envelope once, so a new
 * refusal cannot invent a third shape. They are deliberately thin and total: no logging,
 * no side effects, nothing that a handler would rather do itself.
 */

/** Anything with the two methods a Fastify reply always has. */
export interface ReplyLike {
  code(statusCode: number): { send(payload: unknown): unknown } | ReplyLike;
  send(payload: unknown): unknown;
}

/** `{ error: "code", message? }` — the Nexus surface. */
export function fail(
  reply: ReplyLike,
  statusCode: number,
  code: string,
  extra?: Record<string, unknown>,
): unknown {
  const body = extra ? { error: code, ...extra } : { error: code };
  return (reply.code(statusCode) as { send(payload: unknown): unknown }).send(body);
}

/** `{ error: { type, message } }` — what an OpenAI SDK client parses on the /v1 surface. */
export function openaiError(
  reply: ReplyLike,
  statusCode: number,
  type: string,
  message: string,
  extra?: Record<string, unknown>,
): unknown {
  const error = extra ? { type, message, ...extra } : { type, message };
  return (reply.code(statusCode) as { send(payload: unknown): unknown }).send({ error });
}

/**
 * `{ type: "error", error: { type, message } }` — the `/api/v1/gateway` surface, which
 * wrapped its errors in a discriminator before the `/v1` surface existed. Two shapes
 * because there already were two; now there is one writer each.
 */
export function gatewayError(
  reply: ReplyLike,
  statusCode: number,
  type: string,
  message: string,
  extra?: Record<string, unknown>,
): unknown {
  const error = extra ? { type, message, ...extra } : { type, message };
  return (reply.code(statusCode) as { send(payload: unknown): unknown }).send({
    type: "error",
    error,
  });
}
