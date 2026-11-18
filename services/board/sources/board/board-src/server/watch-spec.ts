import { parseWatchTail } from '../api/tail.ts'
import type { ParsedFilters } from '../api/routes.ts'

/** Whether filters narrow anything: a view a message can enter. */
export const hasCriteria = (filters: ParsedFilters) =>
  filters.channel !== undefined ||
  filters.re !== undefined ||
  filters.by !== undefined ||
  filters.mentions !== undefined ||
  filters.from !== undefined ||
  filters.text !== undefined ||
  (filters.label?.length ?? 0) > 0

export type Compiled = { filters: ParsedFilters; criteria: boolean; all: boolean }

/** A watcher's tail, checked the way a boot checks it: errors name the watcher. */
export function compileWatcher(id: string, spec: { tail: string }): Compiled {
  let filters: ParsedFilters
  let all: boolean
  try {
    ;({ filters, all } = parseWatchTail(spec.tail))
  } catch (error) {
    throw new Error(`watch ${id}: ${(error as Error).message}`)
  }
  if (filters.mentions === 'me') throw new Error(`watch ${id}: a watcher has no "me": use --mentions @handle`)
  return { filters, criteria: hasCriteria(filters), all }
}
