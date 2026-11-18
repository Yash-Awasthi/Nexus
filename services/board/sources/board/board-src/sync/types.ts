import type { Author as ChatAuthor } from 'chat'
import type { ExternalAuthor } from '../contract/external.ts'


export function externalAuthor(platform: string, author: ChatAuthor): ExternalAuthor {
  const handle = author.userName || author.userId
  return {
    id: `${platform}:user:${author.userId}`,
    handle,
    name: author.fullName || handle,
    avatar: null,
    isBot: author.isBot === true,
  }
}
