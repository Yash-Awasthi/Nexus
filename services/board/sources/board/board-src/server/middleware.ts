import type { Board } from './board.ts'
import type { Actor } from '../contract/folds.ts'
import { z } from 'zod'
import { NewLabels, MESSAGE_TEXT_MAX, type Labels, type Attachment } from '../contract/schemas.ts'
import { HttpError } from './errors.ts'

/** Where a write came from, as the middleware sees it. */
export type WriteSource =
  /** The HTTP API: the CLI, the SDK, scripts, CI. */
  | { kind: 'api' }
  /** A synced platform's event, or a sync callback's own writes. `thread` is the platform thread. */
  | { kind: 'sync'; key: string; platform: string; channel: string; thread: string }
  /** The board's handle in this deployment: `team.post(…)`, or `team.as(name).post(…)`. `name` is null for the handle itself. */
  | { kind: 'client'; name: string | null }
  /** A watcher's in-process client. */
  | { kind: 'watcher'; id: string }
  /** A scheduled message's send. */
  | { kind: 'schedule'; id: number }

/** The message a write would put on the board. `re` is its thread's root, and IDs are as clients see them. */
export type Write =
  | { kind: 'post'; channel: string; re: string | null; text: string; labels: Labels; attachments: readonly Attachment[] }
  | { kind: 'edit'; id: string; channel: string; re: string | null; text: string }

/** What `next` may change before the write lands. Labels apply to posts only. */
export type WritePatch = { text?: string; labels?: Labels }

export type MiddlewareContext = {
  write: Readonly<Write>
  /** Who's writing. */
  author: Readonly<Actor>
  source: Readonly<WriteSource>
  /**
   * What to tell whoever wrote it when the write is dropped, where they wrote it from: a reply in
   * their platform thread for sync, the error the API answers with otherwise.
   */
  respond(text: string): Promise<void>
  /** The board, acting as `board:middleware`. Its writes skip the middleware. */
  board: Board
  /**
   * Hands the write to the next middleware, and after the last one, to the board.
   * Not calling it drops the write, and so does emptying a write that has no files.
   */
  next(patch?: WritePatch): Promise<void>
}

export type Middleware = (context: MiddlewareContext) => unknown

/** A write the middleware didn't let through: the API answers 422 with what it responded. */
export class DroppedError extends HttpError {
  /** What the middleware responded, in order: none when it dropped the write without a word. */
  readonly responses: readonly string[]
  constructor(responses: readonly string[]) {
    super(422, 'dropped', responses.join('\n') || 'the board dropped this message')
    this.responses = responses
  }
}

const Patch = z.object({ text: z.string().max(MESSAGE_TEXT_MAX).optional(), labels: NewLabels.optional() }).strict()

export const MIDDLEWARE_ACTOR = 'board:middleware'

/**
 * Runs `write` through `middleware` in order, then `commit`s what the last one
 * passed on. Throws `DroppedError` when one doesn't call `next`.
 */
export async function runMiddleware<W extends Write, T>(
  middleware: readonly Middleware[],
  input: { write: W; author: Actor; source: WriteSource; board: () => Board },
  commit: (write: W) => Promise<T>,
): Promise<T> {
  const responses: string[] = []
  let committed: { value: T } | null = null
  const step = async (i: number, write: W): Promise<void> => {
    if (i === middleware.length) {
      // Emptied on the way, like a redaction that left nothing: there's nothing to post.
      if (write.text.trim() === '' && (write.kind === 'edit' || write.attachments.length === 0)) return
      committed = { value: await commit(write) }
      return
    }
    let next: Promise<void> | null = null
    await middleware[i]!({
      write: Object.freeze({ ...write }),
      author: Object.freeze({ ...input.author }),
      source: Object.freeze({ ...input.source }),
      board: input.board(),
      respond: async (text) => {
        responses.push(text)
      },
      next: (patch = {}) => {
        if (next) throw new Error('next() was already called')
        const { text, labels } = Patch.parse(patch)
        next = step(i + 1, {
          ...write,
          ...(text !== undefined ? { text } : {}),
          ...(write.kind === 'post' && labels ? { labels: { ...write.labels, ...labels } } : {}),
        })
        return next
      },
    })
    // A middleware that called `next` without awaiting it still lets the write through.
    if (next) await next
  }
  await step(0, input.write)
  if (!committed) throw new DroppedError(responses)
  return (committed as { value: T }).value
}
