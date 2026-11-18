// The standalone `board` CLI's own commands, which run something on this machine: `inspect`, the
// board in your browser, and `serve`, a `local()` board. An app that embeds board's CLI leaves them
// out, so it never loads the inspector or a local board.
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { projectDir } from '../client/node.ts'
import { createInspector } from '../inspect/server.ts'
import { option } from './commands.ts'
import { allowedHosts, stopped } from './inspect.ts'
import type { Command, CommandContext } from './main.ts'

/** Keeps the local board's log (`.board/`) out of the project's Git. */
async function ignoreLog(root: string) {
  const path = join(root, '.gitignore')
  const ignore = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  if (!ignore.split(/\r?\n/).some((line) => /^\/?\.board\/?$/.test(line)))
    await appendFile(path, `${ignore && !ignore.endsWith('\n') ? '\n' : ''}.board/\n`)
}

const inspect: Command = {
  spec: {
    name: 'inspect',
    description: 'the board in your browser, as you: read, post, react (local only)',
    arguments: [],
    options: [option('port', 'the port to listen on (default: a free one)'), option('no-open'), option('allow-host')],
    examples: [
      { name: 'open the board in your browser', value: 'inspect' },
      { name: 'serve it behind a proxy on another name', value: 'inspect --allow-host box.tailnet.ts.net' },
    ],
  },
  async run(args, context: CommandContext) {
    if (args.length > 0) throw context.usage('inspect takes no arguments: pass its port with --port.')
    // Loaded only now: the page comes with it.
    return (await import('./inspect.ts')).inspect(context)
  },
}

const serve: Command = {
  spec: {
    name: 'serve',
    description:
      "run a board on this machine (127.0.0.1:4100, no sync) and open the inspector: other commands reach it with --url or BOARD_URL. Its log lives in .board/, and you're local:user:<your OS user>",
    arguments: [],
    options: [
      option('port', 'the port to listen on (default: 4100)'),
      option('dir'),
      option('no-inspect'),
      option('no-open'),
      option('allow-host', 'also answer requests for this host, from a proxy in front: the board is at its URL there, and whoever reaches the inspector there acts as you'),
      option('tailscale'),
    ],
    examples: [
      { name: 'run a board here, and open it', value: 'serve' },
      { name: 'share it on your tailnet, behind tailscale serve', value: 'serve --tailscale box.tailnet.ts.net' },
      { name: 'serve it behind another proxy, on another name', value: 'serve --allow-host box.example.com' },
    ],
  },
  async run(args, { flags, out, usage, portFlag, connection, openBrowser }: CommandContext) {
    if (args.length > 0) throw usage('serve takes no arguments: pass its port with --port, and its directory with --dir.')
    const port = portFlag()
    const hosts = allowedHosts({ flags, usage })
    const tailscale = allowedHosts({ flags, usage }, 'tailscale')
    // Another proxy to the same port could carry a caller's own Tailscale-User-Login, at Tailscale's host.
    if (tailscale.length > 0 && hosts.length > 0)
      throw usage("--tailscale takes Tailscale's word for who's calling, which another proxy in front could forge: it doesn't go with --allow-host.")
    const root = projectDir()
    const { serveLocal } = await import('./serve.ts')
    const local = await serveLocal({
      dir: flags.dir ?? join(root, '.board'),
      hosts,
      tailscale,
      ...(port !== undefined ? { port } : {}),
    })
    let inspector: { close(): void } | null = null
    try {
      if (!flags.dir) await ignoreLog(root)
      out(`serving a local board at ${local.url} as ${local.principal}, its log in ${local.dir}  (Ctrl-C to stop)`)
      out(`reach it with --url ${local.url}, or BOARD_URL=${local.url}`)
      // What to hand the people on it, and the one command that puts Tailscale in front.
      for (const host of new Set(tailscale.map((named) => new URL(`https://${named}`).host)))
        out(`on your tailnet, behind tailscale serve --bg ${local.port}: BOARD_URL=https://${host}/api/board`)
      if (!flags['no-inspect']) {
        // With this board's token, whatever BOARD_TOKEN says, and on the board's own server: one port to open, or to proxy.
        const { board } = connection(local.url, { token: local.token })
        const page = (await createInspector({ client: board.as(null), hosts: [...hosts, ...tailscale], visitor: local.visitor })).at(local.port)
        inspector = page
        local.page(page.handle)
        const at = new URL(local.url).origin
        out(`inspector at ${at}`)
        if (!flags['no-open']) openBrowser(at)
      }
      await stopped()
    } finally {
      inspector?.close()
      await local.close()
    }
    return 0
  },
}

/** The commands only the standalone `board` has, in the order its help lists them. */
export const local: Record<string, Command> = { inspect, serve }
