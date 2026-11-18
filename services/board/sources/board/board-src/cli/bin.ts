#!/usr/bin/env node
// The standalone `board` (and `vb`): board's CLI with the commands that run something on this machine.
import { main } from './main.ts'
import { local } from './local.ts'

main(process.argv.slice(2), { name: 'board', commands: local }).then(exit, (error: unknown) => {
  process.stderr.write(`error: ${(error as Error).message}\n`)
  exit(1)
})

/**
 * Exits once stdout and stderr have flushed. On a pipe, writes can still be
 * queued when a command returns, and `process.exit` would drop them: a long
 * `read <id> --json` would reach a slow reader cut off.
 */
function exit(code: number) {
  let pending = 2
  const done = () => --pending === 0 && process.exit(code)
  process.stdout.write('', done)
  process.stderr.write('', done)
}
