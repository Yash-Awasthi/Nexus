// How the tasks of one batch wait for each other, worked out from the batch alone: what a board
// checks before it makes any of them, and what orders a plan that takes more than one batch.

/** What a batch's task waits for: a task's ID, or `{ key }` for a task of the same batch. */
export type BatchNeed = string | { key: string }

/** A batch's task, as far as waiting goes: its `key`, the name the batch's others know it by, and what it waits for. */
export type BatchTask = { key?: string | undefined; needs?: readonly BatchNeed[] | undefined }

/**
 * For each task of a batch, the batch's tasks it waits for, by their place in it, and an order to
 * make them in: every task after the ones it waits for, and as the batch has them otherwise. A
 * `problem` instead when two tasks have one `key`, a task waits for a `key` no task has or for
 * itself, or tasks wait for each other: such a batch can't be made.
 */
export function batchPlan(tasks: readonly BatchTask[]): { inside: number[][]; order: number[] } | { problem: string } {
  const named = new Map<string, number>()
  for (const [at, task] of tasks.entries()) {
    if (task.key === undefined) continue
    if (named.has(task.key)) return { problem: `two tasks of the batch have the key ${JSON.stringify(task.key)}` }
    named.set(task.key, at)
  }
  const inside: number[][] = []
  for (const [at, task] of tasks.entries()) {
    const waits = new Set<number>()
    for (const need of task.needs ?? []) {
      if (typeof need === 'string') continue
      const found = named.get(need.key)
      if (found === undefined) return { problem: `no task of the batch has the key ${JSON.stringify(need.key)}` }
      if (found === at) return { problem: `the task with the key ${JSON.stringify(need.key)} waits for itself` }
      waits.add(found)
    }
    inside.push([...waits])
  }
  // Each task after what it waits for, without recursion: a plan can be a long chain.
  const order: number[] = []
  const state = new Uint8Array(tasks.length)
  for (let start = 0; start < tasks.length; start++) {
    if (state[start] !== 0) continue
    const path: { at: number; next: number }[] = [{ at: start, next: 0 }]
    state[start] = 1
    while (path.length > 0) {
      const top = path.at(-1)!
      const need = inside[top.at]![top.next++]
      if (need === undefined) {
        state[top.at] = 2
        order.push(top.at)
        path.pop()
      } else if (state[need] === 1) {
        const loop = path.slice(path.findIndex((step) => step.at === need)).map((step) => JSON.stringify(tasks[step.at]!.key))
        return { problem: `the tasks with the keys ${loop.join(', ')} wait for each other` }
      } else if (state[need] === 0) {
        state[need] = 1
        path.push({ at: need, next: 0 })
      }
    }
  }
  return { inside, order }
}
