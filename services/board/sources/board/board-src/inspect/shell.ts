import type { ProfileOption } from '../client/client.ts'
import { VERSION } from '../version.ts'
import { CSS } from './style.ts'

// What every inspector serves alike, on this machine (`server.ts`) or in your app (`handler.ts`):
// the page's HTML, its policy, and which proxied paths it refuses.

const attribute = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

/**
 * The page, with what only it is told: its credential for the proxy, the profile it starts as, and
 * the path it's served under (`''` at a server's root), which its bundle, its proxy, and its links
 * are under too.
 */
export const shell = ({ token, profile, base, named = false }: { token: string; profile: ProfileOption; base: string; named?: boolean }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="inspect-token" content="${attribute(token)}">
<meta name="inspect-profile" content="${attribute(JSON.stringify(profile))}">
<meta name="inspect-base" content="${attribute(base)}">
${named ? '<meta name="inspect-named" content="1">\n' : ''}<title>board</title>
<style>${CSS}</style>
</head>
<body>
<div id="root"></div>
<script type="module" src="${attribute(base)}/app.js?v=${attribute(VERSION)}"></script>
</body>
</html>`

export const CSP = [
  "default-src 'none'",
  // Attachments arrive as `blob:` URLs: the page fetches them through the proxy, with its token.
  'img-src https: http://localhost:* http://127.0.0.1:* data: blob:',
  'media-src blob:',
  "style-src 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

/** Whether a proxied path, as sent, climbs out of the board's API: `..`, `.`, or a backslash, encoded or not. */
export function relative(path: string): boolean {
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return true
  }
  return /(^|\/)\.\.?(\/|$)|\\/.test(decoded)
}
