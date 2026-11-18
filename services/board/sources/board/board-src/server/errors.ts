import { ZodError } from 'zod'
import { handleErrors, type ErrorOrigin } from '../client/client.ts'
import { MESSAGE_TEXT_MAX } from '../contract/schemas.ts'

export class HttpError extends Error {
  readonly status: number
  readonly code: string
  /** What fixes it, when there's one (`BoardError`'s `hint`). */
  readonly hint: string | undefined
  /** `handle` for a handle's own error on its way through: everything else is the board's. */
  readonly origin: ErrorOrigin
  /** For a 429, how many seconds until it's worth sending again, when that's known: the response's `Retry-After`. */
  readonly retryAfter: number | undefined
  constructor(status: number, code: string, message: string, options: { hint?: string; origin?: ErrorOrigin; retryAfter?: number } = {}) {
    super(message)
    this.status = status
    this.code = code
    this.hint = options.hint
    this.origin = options.origin ?? 'board'
    this.retryAfter = options.retryAfter
  }
}

/** A request a host's own verifier rejected with `response`, which the board answers with as it is. */
export class RejectedError extends HttpError {
  readonly response: Response
  constructor(response: Response) {
    super(response.status, 'rejected', `rejected with ${response.status}`)
    this.response = response
  }
}

export const badRequest = (message: string, code = 'invalid_request') =>
  new HttpError(400, code, message)
export const unauthorized = (message: string) =>
  new HttpError(401, 'unauthorized', message)
export const forbidden = (message: string) =>
  new HttpError(403, 'forbidden', message)
export const notFound = (message: string, code = 'not_found') =>
  new HttpError(404, code, message)
export const textTooLong = () =>
  new HttpError(400, 'text_too_long', `A message's text is at most ${MESSAGE_TEXT_MAX.toLocaleString('en-US')} characters.`, {
    hint: 'Put the long part in a file and attach it to a message, with a short summary as the text.',
  })
export const duplicateId = () =>
  new HttpError(409, 'duplicate_id', 'that id was already used for a different write')
/** More tasks than a board makes in one batch: `most` is how many it does. Nothing was made, and its sender splits it. */
export const batchTooLarge = (tasks: number, most: number) =>
  new HttpError(400, 'batch_too_large', `a batch makes ${most} tasks at most, and this one has ${tasks}: send it in parts`)

export const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

/**
 * The issue a request is told about. A union that matched no option says only "Invalid input", so
 * it's the first issue of the option that came closest, the one with the fewest, at its own path.
 */
function reported(issue: ZodError['issues'][number]): ZodError['issues'][number] {
  // A record's key that its schema refused says only "Invalid key in record": what the key's schema said is the reason, at the record.
  if (issue.code === 'invalid_key' && issue.issues[0]) return reported({ ...issue.issues[0], path: issue.path.slice(0, -1) })
  if (issue.code !== 'invalid_union' || issue.errors.length === 0) return issue
  const closest = issue.errors.reduce((best, option) => (option.length < best.length ? option : best))
  const first = closest[0]
  return first ? reported({ ...first, path: [...issue.path, ...first.path] }) : issue
}

/** Every failure becomes `{ error: { code, message, hint? } }` with a matching status. */
export function toErrorResponse(error: unknown): Response {
  if (error instanceof RejectedError) return error.response
  if (error instanceof HttpError) {
    const response = json(
      { error: { code: error.code, message: error.message, ...(error.hint !== undefined ? { hint: error.hint } : {}) } },
      error.status,
      error.retryAfter !== undefined ? { 'retry-after': String(error.retryAfter) } : undefined,
    )
    // The handle's own stays the handle's for the handle in this process that reads it back.
    if (error.origin === 'handle') handleErrors.add(response)
    return response
  }
  if (error instanceof ZodError) {
    const issue = error.issues[0] && reported(error.issues[0])
    // A message's own text over the limit (not a field inside one, like a link's preview) says what to do instead.
    if (issue?.code === 'too_big' && issue.origin === 'string' && issue.maximum === MESSAGE_TEXT_MAX && issue.path.length === 1 && issue.path[0] === 'text')
      return toErrorResponse(textTooLong())
    const path = issue?.path.length ? `${issue.path.join('.')}: ` : ''
    return json(
      { error: { code: 'invalid_request', message: `${path}${issue?.message ?? 'invalid request'}` } },
      400,
    )
  }
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'INVALID_PAYLOAD')
    return json({ error: { code: 'invalid_request', message: (error as Error).message } }, 400)
  if (code === 'PARTIAL_DUPLICATE_BATCH' || code === 'DUPLICATE_EVENT_ID') return toErrorResponse(duplicateId())
  if (code === 'STORE_UNAVAILABLE' || code === 'STORE_NOT_CONFIGURED')
    return json({ error: { code: 'unavailable', message: (error as Error).message } }, 503)
  console.error('[board]', error)
  return json({ error: { code: 'internal', message: 'internal error' } }, 500)
}
