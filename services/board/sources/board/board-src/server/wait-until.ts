/**
 * Keeps `task` running after the response, where the platform offers it: Vercel's request context, as A2
 * reads it too. Elsewhere it runs on in the process.
 */
export function waitUntil(task: Promise<unknown>): void {
  try {
    const context = Reflect.get(globalThis, Symbol.for('@vercel/request-context')) as
      | { get?(): { waitUntil?(task: Promise<unknown>): void } | undefined }
      | undefined
    context?.get?.()?.waitUntil?.(task)
  } catch {}
}
