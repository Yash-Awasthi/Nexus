import { formatVercelDeployments, type VercelDeployment } from '../contract/bots.ts'

/** One of Slack's layout blocks, as its API takes it. */
export type SlackBlock = { type: string } & Record<string, unknown>

/** How Slack is given text: the text around the table as the markdown it posts, and the notification's as its older mrkdwn. Each as written without one. */
export type SlackText = { markdown?: (markdown: string) => string; mrkdwn?: (markdown: string) => string }

/** The most text Slack takes across a message's `markdown` blocks. */
const MARKDOWN_MAX = 12_000
/** The most notification text Slack takes: an edit over 4,000 characters is refused. */
const TEXT_MAX = 3900
/** The most rows Slack shows on a table's page, which is all of ours. */
const ROWS_MAX = 100

const raw = (text: string) => ({ type: 'raw_text', text: text || ' ' })
/** A cell of formatted text: an emoji, a link, a date. */
const rich = (...elements: Record<string, unknown>[]) => ({ type: 'rich_text', elements: [{ type: 'rich_text_section', elements }] })
const link = (text: string, url: string) => ({ type: 'link', text, url })
/** The dot Vercel shows beside a deployment's status, as the emoji Slack has for it. One it doesn't know is white. */
const DOT: Record<string, string> = {
  ready: 'large_green_circle',
  building: 'large_yellow_circle',
  initializing: 'large_yellow_circle',
  error: 'red_circle',
  failed: 'red_circle',
  canceled: 'black_circle',
}
const dot = (status: string) => DOT[status.toLowerCase()] ?? 'white_circle'
/** A deployment Vercel didn't build: its comment folds those away under the table. */
const skippedBy = (deployment: VercelDeployment) => deployment.skipped || deployment.status.toLowerCase() === 'ignored'
const markdownLink = (text: string, url: string | null) => (url ? `[${text}](${url})` : text)

/**
 * A message that lists Vercel's deployments, for Slack, with the list as the table Vercel posts
 * on a pull request: Project, Deployment (its status beside its color, linking to its page),
 * Actions (its preview), and Updated (how long ago). The text around the list stays markdown in
 * its place, the deployments Vercel skipped are a line under the table, and `text` says it all in
 * plain words, which is what a notification shows.
 *
 * Null when the markdown doesn't have the list as board writes it (a renderer wrote its own), when
 * Vercel built none of them, or when it's more than Slack takes: it goes out as that markdown.
 */
export function deploymentsLayout(markdown: string, deployments: VercelDeployment[], as: SlackText = {}): { text: string; blocks: SlackBlock[] } | null {
  const list = formatVercelDeployments(deployments)
  const at = markdown.indexOf(list)
  const built = deployments.filter((deployment) => !skippedBy(deployment))
  const skipped = deployments.filter(skippedBy)
  if (at === -1 || built.length === 0 || built.length > ROWS_MAX) return null
  // Updated only where Vercel says when: the other columns always have something to show.
  const dated = built.some((deployment) => deployment.updatedAt || deployment.updated)
  const rows = [
    [raw('Project'), raw('Deployment'), raw('Actions'), ...(dated ? [raw('Updated')] : [])],
    ...built.map((deployment) => [
      deployment.projectUrl ? rich(link(deployment.project, deployment.projectUrl)) : raw(deployment.project),
      rich({ type: 'emoji', name: dot(deployment.status) }, { type: 'text', text: ' ' }, deployment.deploymentUrl ? link(deployment.status, deployment.deploymentUrl) : { type: 'text', text: deployment.status }),
      deployment.previewUrl ? rich(link('Preview', deployment.previewUrl)) : raw(''),
      // How long ago, which Slack keeps current, or Vercel's own words where its comment has no time.
      ...(dated ? [deployment.updatedAt ? rich({ type: 'date', timestamp: Math.floor(Date.parse(deployment.updatedAt) / 1000), format: '{ago}', fallback: deployment.updated ?? deployment.updatedAt }) : raw(deployment.updated ?? '')] : []),
    ]),
  ]
  const before = markdown.slice(0, at).trim()
  const after = [skipped.length ? `${skipped.length} skipped: ${skipped.map((deployment) => markdownLink(deployment.project, deployment.projectUrl)).join(', ')}` : '', markdown.slice(at + list.length).trim()].filter(Boolean).join('\n\n')
  if (before.length + after.length > MARKDOWN_MAX) return null
  const prose = (text: string) => (text ? [{ type: 'markdown', text: as.markdown?.(text) ?? text }] : [])
  const said = Array.from(
    [before && (as.mrkdwn?.(before) ?? before), built.map((deployment) => `${deployment.project}: ${deployment.status}`).join(', '), after && (as.mrkdwn?.(after) ?? after)].filter(Boolean).join('\n'),
  )
  return {
    text: said.length > TEXT_MAX ? `${said.slice(0, TEXT_MAX - 1).join('')}…` : said.join(''),
    // Every row on one page: Slack shows five and pages the rest otherwise.
    blocks: [...prose(before), { type: 'data_table', caption: 'Vercel deployments', page_size: built.length, rows }, ...prose(after)],
  }
}
