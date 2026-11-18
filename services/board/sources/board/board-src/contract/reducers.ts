// The board's views as A2 reducers: the folds in `folds.ts`, named and seeded for the engine.
// Only the local board's engine loads this module; anything else folds with `folds.ts` directly.
import { reducer } from 'experimental-a2'
import { boardContract } from './contract.ts'
import { foldActors, foldMessages, type ActorsState, type ChannelsState, type MessagesState } from './folds.ts'
import { own, setOwn } from './own.ts'

export const messagesReducer = reducer({
  contract: boardContract,
  name: 'board.messages.v5',
  initialState: { byId: {}, replies: {} } as MessagesState,
}).fold(foldMessages)

/**
 * Each post's event ID → its message: a retried write with the same ID is already on
 * the board, and doesn't go through the middleware again.
 */
export const postedReducer = reducer({
  contract: boardContract,
  name: 'board.posted.v1',
  initialState: {} as Record<string, number>,
}).fold((state, event) => {
  if (event.type === 'message.posted') setOwn(state, event.id, event.index)
  return state
})

const emptyChannel = (path: string) => ({ path, lastIndex: 0, messages: 0, threads: 0 })

export const channelsReducer = reducer({
  contract: boardContract,
  // v2 folds `channel.created`: a v1 snapshot an older deployment made may have passed one by.
  name: 'board.channels.v2',
  initialState: {} as ChannelsState,
}).fold((state, event) => {
  if (event.type === 'channel.created') {
    if (!own(state, event.payload.channel)) setOwn(state, event.payload.channel, emptyChannel(event.payload.channel))
    return state
  }
  if (event.type !== 'message.posted') return state
  const { channel, re } = event.payload
  const entry = own(state, channel) ?? setOwn(state, channel, emptyChannel(channel))
  entry.lastIndex = event.index
  entry.messages += 1
  if (re === null) entry.threads += 1
  return state
})

export const actorsReducer = reducer({
  contract: boardContract,
  name: 'board.actors.v2',
  initialState: { byId: {}, byHandle: {} } as ActorsState,
}).fold(foldActors)
