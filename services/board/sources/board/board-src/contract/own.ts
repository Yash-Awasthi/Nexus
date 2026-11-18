// The board keeps maps keyed by names callers and platforms choose (emoji, handles,
// channels, thread keys, targets) as plain objects, so they stay JSON through A2's
// snapshots and the tables. On a plain object, `constructor` and `__proto__` read what
// every object inherits, and assigning `__proto__` replaces the prototype: these read
// and write only a map's own entries. (A null-prototype object wouldn't hold: A2
// clones state with structuredClone, which gives it a prototype back.)

/** `map[key]` if it's an entry of the map's own, never what the map inherits. */
export const own = <T>(map: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(map, key) ? map[key] : undefined

/** Sets `map[key]` as an entry of its own, even for `__proto__`, and returns `value`. */
export function setOwn<T>(map: Record<string, T>, key: string, value: T): T {
  Object.defineProperty(map, key, { value, writable: true, enumerable: true, configurable: true })
  return value
}
