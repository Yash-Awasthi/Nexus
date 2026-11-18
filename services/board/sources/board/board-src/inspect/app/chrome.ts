import { useSyncExternalStore } from 'react'

// The page's own state, which no board knows: what it's telling you, and which message you're editing.

function signal<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  return {
    get: () => value,
    set(next: T) {
      value = next
      for (const listener of listeners) listener()
    },
    use: () => useSyncExternalStore(subscribe, () => value),
  }
}

// --- which message you're editing ---------------------------------------------------

const editing = signal<string | null>(null)
export const setEditing = editing.set
export const useEditing = editing.use

// --- what went wrong, said once ----------------------------------------------------

export type Toast = { id: number; text: string }
const toasts = signal<Toast[]>([])
let toastId = 0

export function toast(text: string) {
  const id = ++toastId
  toasts.set([...toasts.get(), { id, text }])
  setTimeout(() => toasts.set(toasts.get().filter((t) => t.id !== id)), 6000)
}

export const useToasts = toasts.use
