export type WatcherSpec = { tail: string }
/** A registrant's sync entry: what it imports through. */
export type SyncEntrySpec = { key: string; platform: string }

/** By UTF-16 code unit, as `sort()` orders strings: the same in every locale and runtime. */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * What `watchersHash` hashes, the same on both ends: a board on `http()` hashes its watchers, and
 * whether its sync subscribes, and the board it uses hashes what it holds.
 */
export function canonicalWatchers(watch: Record<string, WatcherSpec>, sync: readonly SyncEntrySpec[] = []): string {
  const canonical: unknown[] = Object.keys(watch)
    .sort(byCodeUnit)
    .map((id) => [id, watch[id]!.tail])
  // Older registrations hashed only their watchers: one with no sync hashes as it did.
  if (sync.length > 0) canonical.push(['sync', [...sync].sort((a, b) => byCodeUnit(a.key, b.key)).map((entry) => [entry.key, entry.platform])])
  return JSON.stringify(canonical)
}
