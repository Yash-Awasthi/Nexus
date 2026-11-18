import { z } from 'zod'
import { ExternalEvent, ExternalLocation } from '../contract/external.ts'
import { NewLabels, LabelKey } from '../contract/schemas.ts'

export const EventBase = z.object({
  id: z.string().min(1),
  platform: z.string().min(1),
  key: z.string().min(1),
  ...ExternalLocation.shape,
  raw: z.unknown(),
})

export type EventBase<P extends string = string> = Omit<z.infer<typeof EventBase>, 'platform'> & { platform: P }
export type ProviderEvent = EventBase & ExternalEvent & { type: string }

const eventTypes = {
  message: 'message',
  edited: 'message.edited',
  deleted: 'message.deleted',
  reaction: 'reaction.added',
  lifecycle: 'lifecycle',
} as const

export function envelope(platform: string, key: string, event: ExternalEvent, raw: unknown, id: string) {
  return {
    ...event,
    ...EventBase.parse({ id, platform, key, channel: event.channel, thread: event.thread, subthread: 'subthread' in event ? event.subthread : null, raw }),
    type: event.kind === 'lifecycle' ? event.type : event.kind === 'reaction' && !event.added ? 'reaction.removed' : eventTypes[event.kind],
  }
}

export function eventSchema<P extends string, M extends string>(platform: P, messageType: M) {
  const [message, edited, deleted, reaction, lifecycle] = ExternalEvent.options
  const common = { ...EventBase.shape, platform: z.literal(platform) }
  return z.discriminatedUnion('kind', [
    message.extend({ ...common, type: z.literal(messageType) }),
    edited.extend({ ...common, type: z.literal('message.edited') }),
    deleted.extend({ ...common, type: z.literal('message.deleted') }),
    reaction.extend({ ...common, type: z.enum(['reaction.added', 'reaction.removed']) }),
    lifecycle.extend(common),
  ])
}

export type SyncRoot = { text: string; labels: Record<string, string>; author: import('../contract/external.ts').ExternalAuthor; raw: unknown }
export type RootOverride = (root: Readonly<SyncRoot>) => { text?: string; labels?: Record<string, string> }

export const SyncOverrides = z.object({
  root: z.custom<RootOverride>((value) => typeof value === 'function').optional(),
  text: z.string().optional(),
  labels: NewLabels.optional(),
  unset: z.array(LabelKey).optional(),
  noSync: z.boolean().optional(),
}).strict()

export type SyncOverrides = z.infer<typeof SyncOverrides>
/** What an import made: its thread's root and the message, as IDs clients pass back as they got them. */
export type SyncResult = { root: string | null; message: string | null }

export function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) immutable(item)
    Object.freeze(value)
  }
  return value
}
