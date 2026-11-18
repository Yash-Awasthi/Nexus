// `@vercel/board` outside Node (a browser, say): board() with nothing that needs Node. It finds no
// credentials, team, or project in the environment, and verifies no tokens by itself, so pass `fetch`
// or a backend (and to serve requests, `authenticate` and `project`); everything else runs as it
// does in Node.
import { vercel } from '../backend-vercel/index.default.ts'
import { createBoard, type Board, type BoardOptions } from './board.ts'

/**
 * The handle on a board. Without a `backend`, it's Vercel's board for the team, the one `name`
 * names: outside Node there's no environment to find credentials in, so pass a `fetch` that sends
 * them. Or pass the backend: `board({ backend: http(url) })`, whose `fetch` sends the page's own
 * session.
 */
export function board(options: BoardOptions = {}): Board {
  return createBoard(options, {
    backend: (fetch) => {
      if (!fetch) throw new Error("board: pass a fetch that sends credentials Vercel's API takes, or a backend: outside Node there's no environment to find them in")
      return vercel({ fetch })
    },
    sync: () => import('../sync/engine.ts'),
    serving: null,
    sandbox: null,
  })
}

export * from './exports.ts'
