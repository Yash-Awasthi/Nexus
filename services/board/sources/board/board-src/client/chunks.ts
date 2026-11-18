// A plan of tasks longer than one batch holds, made with the handle's own `tasks.createMany`, a
// batch at a time. Nothing here is a board's: it composes what any handle has.
import type { MessageView } from '../api/routes.ts'
import { TASK_BATCH_MAX } from '../contract/schemas.ts'
import { batchPlan } from '../contract/task-batch.ts'
import { BoardError, type TaskInBatch } from './client.ts'

/** What `createTasksInChunks` makes tasks with: a handle, or anything with its `tasks.createMany`. */
export type TaskBatches = { tasks: { createMany(channel: string, tasks: TaskInBatch[], opts?: { id?: string }): Promise<MessageView[]> } }

/**
 * A chunk failed, with the chunks before it made: `code`, `status`, and `message` are the failure's
 * own, and `created` holds the tasks that were made, each at its task's place in the `tasks` given,
 * with `undefined` for the ones that weren't.
 */
export class TasksInChunksError extends BoardError {
  readonly created: (MessageView | undefined)[]
  constructor(cause: unknown, created: (MessageView | undefined)[]) {
    const failed = cause instanceof BoardError ? cause : null
    super(failed?.code ?? 'chunk_failed', cause instanceof Error ? cause.message : String(cause), failed?.status ?? 0, {
      ...(failed?.hint !== undefined ? { hint: failed.hint } : {}),
      origin: failed?.origin ?? 'handle',
    })
    this.name = 'TasksInChunksError'
    this.cause = cause
    this.created = created
  }
}

/**
 * Makes `tasks` in `channel` with as many `tasks.createMany` calls as it takes, and answers their
 * roots in the order given. It makes each task after the ones it waits for by `key`, names a task
 * an earlier chunk made by the ID it got, and sends fewer when a board answers `batch_too_large`:
 * 50, then 25, down to one. With `id`, each chunk goes under an ID made from it and where the
 * chunk starts, and the plan's last task says the plan ends with it. So calling again with the
 * same `id` and tasks answers the chunks that landed and makes the rest. What landed can't change
 * and a plan that finished takes no more, wherever its chunks ended: both are a 409
 * `duplicate_id`, with nothing new made. What a call that stopped midway didn't make can still
 * change.
 *
 * It isn't one write. Each chunk is all or nothing, and the chunks land one after another: a task
 * of an earlier chunk that's ready can be claimed before a later chunk lands. When a chunk fails
 * it stops and throws a `TasksInChunksError`, whose `created` has what the chunks before it made.
 * A plan that must not start early waits for a task of the caller's own, which it completes once
 * this returns.
 */
export async function createTasksInChunks(board: TaskBatches, channel: string, tasks: TaskInBatch[], options: { id?: string } = {}): Promise<MessageView[]> {
  const plan = batchPlan(tasks)
  // Tasks that can't be put in an order can't be made in parts: nothing is sent.
  if ('problem' in plan) throw new BoardError('invalid_needs', `needs: ${plan.problem}`, 400)
  const { order } = plan
  const places = new Map(tasks.flatMap((task, at) => (task.key !== undefined ? [[task.key, at] as const] : [])))
  const created: (MessageView | undefined)[] = tasks.map(() => undefined)
  let size = TASK_BATCH_MAX
  for (let from = 0; from < order.length; ) {
    const picked = order.slice(from, from + size)
    // A key lasts no longer than a call, so a chunk's are this function's own: each task by its place in the chunk,
    // and the plan's last task `end`. A board compares them with the rest of what a chunk's ID was sent with, so the
    // last chunk of a plan is no chunk of a longer one, and no key of the caller's can read as either.
    const names = new Map(picked.map((at, n) => [at, from + n === order.length - 1 ? 'end' : String(n)]))
    const chunk = picked.map((at): TaskInBatch => {
      const { needs, ...task } = tasks[at]!
      // A task an earlier chunk made is there now, so it's named by its ID. One still to make is in this chunk, and is named by its key there.
      const waits = needs?.map((need) => (typeof need === 'string' ? need : (created[places.get(need.key)!]?.id ?? { key: names.get(places.get(need.key)!)! })))
      return { ...task, key: names.get(at)!, ...(waits ? { needs: waits } : {}) }
    })
    try {
      const made = await board.tasks.createMany(channel, chunk, options.id !== undefined ? { id: `${options.id}/${from}` } : {})
      for (const [n, at] of picked.entries()) created[at] = made[n]
      from += picked.length
    } catch (error) {
      // More than this board holds in one write, and nothing was made: fewer, from the same place. A chunk's ID
      // names where it starts, so one an earlier call halved is found the same way: the ID is taken by fewer tasks,
      // until this call asks for as many. Tasks that were never those are refused down to the last one. The sizes
      // are halves of what a batch holds, whatever the plan's length: a plan that goes on differently after what
      // landed comes to the same chunks.
      const split = error instanceof BoardError && (error.code === 'batch_too_large' || (error.code === 'duplicate_id' && options.id !== undefined))
      if (!split || picked.length === 1) throw new TasksInChunksError(error, created)
      do size = Math.ceil(size / 2)
      while (size >= picked.length)
    }
  }
  return created as MessageView[]
}
