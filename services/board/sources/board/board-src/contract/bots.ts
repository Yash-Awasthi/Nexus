/**
 * Known bot messages, shown in a form people can read. The board keeps what the
 * bot wrote (`--json` and the API return it as is); `displayText` is what a
 * person sees in `vb read`, inspect, and the copies on other platforms.
 */

export type VercelDeployment = {
  project: string
  projectUrl: string | null
  status: string
  deploymentUrl: string | null
  previewUrl: string | null
  /** As Vercel wrote it, e.g. `Oct 6, 2026 8:30pm UTC`. */
  updated: string | null
  /** The same as a time, e.g. `2026-10-06T20:30:32.400Z`, when Vercel's comment carries one. */
  updatedAt: string | null
  skipped: boolean
}

/** Vercel for GitHub's bot account (`vercel[bot]`), as the board names it. */
export const VERCEL_BOT = 'github:user:35613825'

// `[vc]: #<hash>:<base64 JSON>`, the first line of every comment Vercel for GitHub writes.
const VERCEL_MARKER = /^\[vc\]: #\S*\r?\n/
const LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g
const STATUS = /!\[([^\]]+)\]\(https:\/\/vercel\.com\/static\/status\/[^)]+\)\s*(?:\[[^\]]*\]\((https?:\/\/[^)\s]+)\))?/

/** The deployments in a Vercel for GitHub comment, or null when it isn't one. */
export function vercelDeployments(text: string): VercelDeployment[] | null {
  if (!VERCEL_MARKER.test(text)) return null
  const skippedAt = text.search(/<details><summary>\d+ Skipped Deployments?<\/summary>/)
  const deployments: VercelDeployment[] = []
  let offset = 0
  for (const line of text.split(/\r?\n/)) {
    const at = offset
    offset = text.indexOf('\n', offset) + 1 || text.length
    if (!line.startsWith('|') || /^\|\s*(Project|Name)\s*\|/.test(line) || /^\|\s*:?-/.test(line)) continue
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
    if (cells.length < 2) continue
    const status = STATUS.exec(cells[1]!)
    if (!status) continue
    // The project cell starts with an avatar wrapped in HTML; the name is its markdown link.
    const projectLink = [...cells[0]!.matchAll(LINK)].at(-1)
    const project = projectLink?.[1] ?? cells[0]!.replace(/<[^>]*>/g, '').trim()
    if (!project) continue
    const preview = cells[2] ? [...cells[2].matchAll(LINK)].find((link) => /preview/i.test(link[1]!)) : undefined
    const updated = cells[3]?.match(/<relative-time[^>]*>([^<]+)<\/relative-time>/)?.[1]?.trim() ?? (cells[3]?.replace(/<[^>]*>/g, '').trim() || null)
    const time = cells[3]?.match(/<relative-time[^>]*\sdatetime="([^"]+)"/)?.[1] ?? null
    deployments.push({
      project,
      projectUrl: projectLink?.[2] ?? null,
      status: status[1]!.trim(),
      deploymentUrl: status[2] ?? null,
      previewUrl: preview?.[2] ?? null,
      updated,
      updatedAt: time !== null && !Number.isNaN(Date.parse(time)) ? time : null,
      skipped: skippedAt !== -1 && at > skippedAt,
    })
  }
  return deployments.length > 0 ? deployments : null
}

const ICONS: Record<string, string> = {
  ready: '✅',
  building: '⏳',
  queued: '⏳',
  initializing: '⏳',
  error: '❌',
  failed: '❌',
  canceled: '⚪',
  ignored: '⚪',
}

const link = (label: string, url: string | null) => (url ? `[${label}](${url})` : label)

/** One line per deployment: `✅ **board** · [Ready](…) · [Preview](…) · Oct 6, 2026 8:30pm UTC`. */
export function formatVercelDeployments(deployments: VercelDeployment[]): string {
  return deployments
    .map((d) => {
      const parts = [
        `${ICONS[d.status.toLowerCase()] ?? '▲'} **${link(d.project, d.projectUrl)}**`,
        `${link(d.status, d.deploymentUrl)}${d.skipped ? ' (skipped)' : ''}`,
        ...(d.previewUrl ? [link('Preview', d.previewUrl)] : []),
        ...(d.updated ? [d.updated] : []),
      ]
      return `- ${parts.join(' · ')}`
    })
    .join('\n')
}

/**
 * Whether Vercel for GitHub's bot wrote it: the bot itself, where its platform ID is its actor, or,
 * on a board where an import is by a profile of the syncing principal
 * (`<principal>+github:user:35613825`), that principal's import of it from GitHub, which the board
 * checked (`verified`). A profile that only carries the bot's name, or one that isn't an import, isn't.
 */
export function byVercelBot(
  written: { by: { actor: string; profile: string | null }; from?: string | null },
  author: { kind: string; platform?: string | undefined; verified?: true | undefined } | null | undefined,
): boolean {
  if (written.by.actor === VERCEL_BOT) return true
  return written.by.profile === VERCEL_BOT && !!written.from && author?.kind === 'external' && author.verified === true && author.platform === 'github'
}

/**
 * A message's text as people should see it: known bot messages in their
 * readable form, anything else as is. Only the bot itself gets that form
 * (`byVercelBot`), so no one can hide a message's text behind a look-alike table.
 */
export function displayText(text: string, bot: boolean): string {
  const deployments = bot ? vercelDeployments(text) : null
  return deployments ? `**▲ Vercel**\n${formatVercelDeployments(deployments)}` : text
}
