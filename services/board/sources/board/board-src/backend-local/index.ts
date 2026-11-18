// `@vercel/board/backend-local`: a board kept in this process, for development, `vb serve`, tests, and
// working offline. Node only: it keeps its files on this machine's disk, or in memory.
export { local, type LocalBackend, type LocalOptions } from '../server/local.ts'
