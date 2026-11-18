// `@vercel/board` in Node: board() finds the board the environment points at, and can serve it: it
// verifies the OIDC tokens made out to it, and knows its own Vercel project.
import { http } from '../backend-http/index.ts'
import { vercel } from '../backend-vercel/index.ts'
import { sandboxHeaders } from '../client/node.ts'
import { createBoard, type Board, type BoardOptions } from './board.ts'

/**
 * The handle on a board. Without a `backend`, it's Vercel's board for your team, the one `name`
 * names, reached with the credentials the Vercel CLI or the deployment has (or `fetch`'s). With
 * `BOARD_URL` set, it's the board at that URL instead: `vb serve`'s, say.
 */
export function board(options: BoardOptions = {}): Board {
  return createBoard(options, {
    backend: (fetch) => (process.env.BOARD_URL?.trim() ? http() : vercel(fetch ? { fetch } : {})),
    sync: () => import('../sync/engine.ts'),
    serving: () => import('./serving.ts'),
    sandbox: (url, token) => sandboxHeaders(url, url, token),
  })
}

export * from './exports.ts'
