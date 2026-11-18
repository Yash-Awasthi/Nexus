// Your team's board in Vercel's API outside Node, internal: board({ fetch })'s backend, through that `fetch`.
import { createVercel, type VercelBackend, type VercelOptions } from '../server/backend-vercel.ts'

/**
 * Your team's board, in Vercel's API. Outside Node there's no environment to find credentials or
 * the team in: pass `team`, and a `fetch` that sends a token Vercel's API takes.
 */
export function vercel(options: VercelOptions = {}): VercelBackend {
  return createVercel(options, null)
}

export type { VercelBackend, VercelOptions }
