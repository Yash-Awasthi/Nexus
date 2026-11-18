// A board that uses another one, outside Node, internal: the inspector's page, through the `fetch` it gives.
import { createHttp, type HttpBackend, type HttpOptions } from '../server/backend-http.ts'

/**
 * The board at `url`, which keeps the log. Outside Node there's no environment to find it or a
 * token in: `fetch` (the global one by default) sends what the board takes, as the inspector's
 * page sends its per-run token to its proxy.
 */
export function http(url?: string, options: HttpOptions = {}): HttpBackend {
  return createHttp(url, options, null)
}

export type { HttpBackend, HttpOptions }
