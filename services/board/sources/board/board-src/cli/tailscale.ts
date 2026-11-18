// Who's calling a board behind `tailscale serve`, as Tailscale says. Only `vb serve` has it: a
// board anywhere else has no proxy of Tailscale's in front to say it.
import { HttpError } from '../server/errors.ts'
import { LOGIN, LOGINS, type Authenticate } from '../server/auth.ts'

/**
 * The login Tailscale says a request is from, as its `Tailscale-User-Login` header gives it, in
 * lowercase: `ada@example.com`. Null when it names none, as for a tagged device or a request
 * through Funnel, or one a principal's ID can't hold (a `+`, or what Tailscale had to encode).
 */
export function tailscaleLogin(header: string | string[] | null | undefined): string | null {
  const login = typeof header === 'string' ? header.trim().toLowerCase() : ''
  return LOGIN.test(login) ? login : null
}

/**
 * `tokens`, and where `at` says Tailscale serves the board, the people Tailscale says are calling:
 * a request there with no token is `tailscale:user:<login>`, a person, with the handle before the
 * login's `@`. `tailscale serve` drops any `Tailscale-User-Login` its caller sent and sets its own,
 * so the header is Tailscale's word wherever only its proxy and this machine reach the board; it's
 * read nowhere else, since any other sender writes its own.
 *
 * A browser sends a page's requests from its user's place on the tailnet, whatever site the page is
 * from, so a request a browser marks as another site's is no one's: only the board's own origin
 * acts as its visitor.
 */
export function tailscale(tokens: Authenticate, at: (audience: string) => boolean): Authenticate {
  const authenticate: Authenticate = (request) => {
    if (request.credential !== null || !at(request.audience)) return tokens(request)
    const login = tailscaleLogin(request.headers.get('tailscale-user-login'))
    if (login === null) return null
    const site = request.headers.get('sec-fetch-site')
    const origin = request.headers.get('origin')
    if ((site !== null && site !== 'same-origin' && site !== 'none') || (origin !== null && origin !== new URL(request.audience).origin))
      throw new HttpError(403, 'forbidden', "a page on another site can't act as you on this board")
    return { id: `tailscale:user:${login}`, kind: 'person', handle: login.slice(0, login.indexOf('@')) }
  }
  return Object.assign(authenticate, { [LOGINS]: true })
}
