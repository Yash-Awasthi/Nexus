/** A2 dead-letters an event after this many failed runs. */
export const A2_TRIES = 10

/**
 * Whether a run comes after a retry from a dead letter. A2 keeps counting
 * `ctx.attempt` across one, and no earlier run sees an attempt past A2_TRIES:
 * the event is dead by then. board gives up early, and records why, only in an
 * event's first tries; a retried one gets A2's fresh tries, and dead-letters
 * again if they all fail.
 */
export const afterRetry = (attempt: number) => attempt > A2_TRIES
