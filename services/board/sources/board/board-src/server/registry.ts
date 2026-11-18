import { createHash } from 'node:crypto'
import { reducer, type ContractEvent } from 'experimental-a2'
import { createServer, type A2Scheduler, type A2Store } from 'experimental-a2/server'
import type { RegistrationView } from '../api/routes.ts'
import { REGISTRY_SESSION, registryContract, type RegistryEvents } from '../contract/contract.ts'
import type { Principal } from './auth.ts'

import { canonicalWatchers, type SyncEntrySpec, type WatcherSpec } from './watchers-hash.ts'

export type { SyncEntrySpec, WatcherSpec }

/** A principal as a registration keeps it. */
export type StoredPrincipal = RegistryPayload['principal']

type RegistryPayload = ContractEvent<RegistryEvents>['payload']

/** A registration as the board holds it: what it shows, and who registered it. */
export type Registration = RegistrationView & { principal: StoredPrincipal }

export type RegistryState = { byOwner: Record<string, Registration> }

/** A principal as a registration keeps it: enough to work out its access again at each match. */
export const storedPrincipal = (principal: Pick<Principal, 'id' | 'kind' | 'handle' | 'facts' | 'scope'>): StoredPrincipal => ({
  id: principal.id,
  kind: principal.kind,
  handle: principal.handle,
  ...(principal.facts ? { facts: principal.facts } : {}),
  ...(principal.scope !== undefined ? { scope: principal.scope } : {}),
})

/** What a registration shows: the principal's token facts stay on the board. */
export const viewOf = ({ principal: _principal, ...view }: Registration): RegistrationView => view

/**
 * The same on both ends: a board on `http()` hashes its watchers, and whether its sync subscribes,
 * and the board it uses hashes what it holds.
 */
export function watchersHash(watch: Record<string, WatcherSpec>, sync: readonly SyncEntrySpec[] = []): string {
  return createHash('sha256').update(canonicalWatchers(watch, sync)).digest('hex').slice(0, 32)
}

function foldRegistry(state: RegistryState, event: ContractEvent<RegistryEvents>): RegistryState {
  if (event.type === 'watchers.registered') {
    const { owner, principal, url, watch, sync, hash } = event.payload
    const copied = Object.fromEntries(Object.entries(watch).map(([id, spec]) => [id, { tail: spec.tail }]))
    state.byOwner[owner] = { owner, principal: structuredClone(principal), url, watch: copied, sync: (sync ?? []).map((entry) => ({ ...entry })), hash }
  }
  return state
}

export const registryReducer = reducer({
  contract: registryContract,
  name: 'board.registry.v1',
  initialState: { byOwner: {} } as RegistryState,
}).fold(foldRegistry)

/** Watchers registered with this board by boards on `http()`. */
export function createRegistry(options: { store?: A2Store | undefined; scheduler?: A2Scheduler | undefined }) {
  const server = createServer({
    contract: registryContract,
    ...(options.store ? { store: options.store } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  })
  const session = server.session(REGISTRY_SESSION)
  const state = async () => (await session.state(registryReducer)).state

  return {
    server,
    state,
    /**
     * Replaces `principal`'s registration. One that changes nothing writes nothing, so asking
     * again is free, unless the principal's token facts changed: those decide what it may read.
     */
    async register(principal: StoredPrincipal, input: { url: string | null; watch: Record<string, WatcherSpec>; sync: SyncEntrySpec[] }): Promise<RegistrationView> {
      const owner = principal.id
      const hash = watchersHash(input.watch, input.sync)
      const current = (await state()).byOwner[owner]
      if (current && current.url === input.url && current.hash === hash && JSON.stringify(current.principal) === JSON.stringify(principal))
        return viewOf(current)
      await session.append({
        type: 'watchers.registered',
        payload: { owner, principal, url: input.url, watch: input.watch, ...(input.sync.length > 0 ? { sync: input.sync } : {}), hash },
      })
      return { owner, url: input.url, watch: input.watch, sync: input.sync, hash }
    },
    async list(): Promise<RegistrationView[]> {
      return Object.values((await state()).byOwner)
        .sort((a, b) => a.owner.localeCompare(b.owner))
        .map(viewOf)
    },
  }
}
