import { CHANNELS_LIMIT_MAX, type ChannelsPage, type ChannelsQueryInput, type ChannelView } from '../api/routes.ts'

/** Every channel of a board, or every one whose path starts with `prefix`, a page at a time: for what needs them all. */
export async function everyChannel(board: { channels: (query?: ChannelsQueryInput) => Promise<Pick<ChannelsPage, 'channels' | 'next'>> }, prefix?: string): Promise<ChannelView[]> {
  const channels: ChannelView[] = []
  let after: string | undefined
  do {
    const page = await board.channels({ limit: CHANNELS_LIMIT_MAX, ...(prefix !== undefined ? { prefix } : {}), ...(after !== undefined ? { after } : {}) })
    channels.push(...page.channels)
    after = page.next ?? undefined
  } while (after !== undefined)
  return channels
}
