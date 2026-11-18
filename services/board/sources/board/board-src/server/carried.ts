import type { BoardEventView, MessageView } from '../api/routes.ts'
import { own } from '../contract/own.ts'

/**
 * An event of a read of the feed's end, whose `message` is its message as it is now, with nothing that message no
 * longer carries. A label change keeps the values the message still has. An event whose whole point is gone is null,
 * to be left out: a reaction since removed, a delivery's failure since made good, a receipt on a message since
 * deleted, and a task's failure or hold since cleared, each with its reason. A task's result, and the reason it was
 * canceled, are there for good once they are.
 */
export function carried(event: BoardEventView): BoardEventView | null {
  const message = event.message as MessageView | undefined
  if (!message) return event
  const payload = event.payload as Record<string, unknown>
  switch (event.type) {
    case 'reaction.added':
    case 'reaction.removed':
      // By its own keys alone: an emoji from before they were checked can be any text, the name of what every object inherits included.
      return own(message.reactions, payload.emoji as string)?.includes((payload.by as { actor?: string } | undefined)?.actor ?? '') ? event : null
    case 'message.synced':
    case 'message.files_synced':
      return message.deleted ? null : event
    case 'message.sync_failed':
      return own(message.undelivered, payload.target as string) === payload.error ? event : null
    case 'task.failed':
      return message.task?.reason === payload.reason ? event : null
    case 'task.blocked':
      return message.task?.blocked?.reason === payload.reason ? event : null
    case 'labels.changed': {
      const set = Object.fromEntries(Object.entries((payload.set ?? {}) as Record<string, string>).filter(([key, value]) => own(message.labels, key) === value))
      return { ...event, payload: { ...payload, set } } as BoardEventView
    }
    default:
      return event
  }
}
