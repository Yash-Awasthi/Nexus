import { decodeJwt } from 'jose'

export type ProjectIdentity = { projectId: string | null; teamId: string | null }

let fromDisk: Promise<ProjectIdentity> | undefined

/** `vercel link` writes `.vercel/project.json`; local development reads it. */
function readLinkedProject(): Promise<ProjectIdentity> {
  fromDisk ??= (async () => {
    try {
      const { readFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const raw = await readFile(join(process.cwd(), '.vercel', 'project.json'), 'utf8')
      const { projectId, orgId } = JSON.parse(raw) as { projectId?: string; orgId?: string }
      return { projectId: projectId ?? null, teamId: orgId ?? null }
    } catch {
      return { projectId: null, teamId: null }
    }
  })()
  return fromDisk
}

/**
 * The board's own Vercel project. Verification only trusts the project ID,
 * from the platform's `VERCEL_PROJECT_ID`, or the linked project.
 */
export async function ownProjectId(): Promise<string | null> {
  if (process.env.VERCEL_PROJECT_ID) return process.env.VERCEL_PROJECT_ID
  return (await readLinkedProject()).projectId
}

/**
 * The board's own team, from `VERCEL_ORG_ID`, or the linked project. On Vercel
 * there's usually neither, so verification falls back to the platform's token
 * for the board's project.
 */
export async function ownTeamId(): Promise<string | null> {
  if (process.env.VERCEL_ORG_ID) return process.env.VERCEL_ORG_ID
  return (await readLinkedProject()).teamId
}

/**
 * The team, for discovery only: clients need it to mint tokens. The platform's
 * request token is decoded without trust, since a spoofed header can only
 * mislead the response it's attached to.
 */
export async function discoveryIdentity(headers: Headers | null): Promise<ProjectIdentity> {
  const projectId = await ownProjectId()
  const header = headers?.get('x-vercel-oidc-token')
  if (header) {
    try {
      const claims = decodeJwt(header)
      if (typeof claims.owner_id === 'string') return { projectId, teamId: claims.owner_id }
    } catch {}
  }
  if (process.env.VERCEL_ORG_ID) return { projectId, teamId: process.env.VERCEL_ORG_ID }
  return { projectId, teamId: (await readLinkedProject()).teamId }
}
