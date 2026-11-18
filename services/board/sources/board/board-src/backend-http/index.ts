// A board that uses another one, over its HTTP protocol, internal: board()'s backend with `BOARD_URL`
// set, and the CLI's for `--url`. In Node, it finds that board, and credentials for it, the way `vb` does.
import { boardUrl, connect, environmentProfile, sandboxHeaders } from '../client/node.ts'
import { createHttp, type Environment, type HttpBackend, type HttpOptions } from '../server/backend-http.ts'

const environment: Environment = {
  url: boardUrl,
  fetch: (url) => connect(url).fetch,
  profile: environmentProfile,
  sandbox: (url, token) => sandboxHeaders(url, url, token),
}

/**
 * The board at `url`, which keeps the log: this board uses it as this deployment. Without a
 * `url`, the one the environment points at: `BOARD_URL`.
 * Without a `fetch`, it sends the credentials `vb` would.
 */
export function http(url?: string, options: HttpOptions = {}): HttpBackend {
  return createHttp(url, options, environment)
}

export type { HttpBackend, HttpOptions }
