import { LOGOS } from '../contract/logos.ts'

type Style = { background: string; mark: { path: string; transform?: string } | { glyph: string } }

/** fx's app icon (https://fx.sh/icon.svg): its mark, drawn on a 180×180 tile. */
const FX_MARK = 'M237.892 0C243.178 8.73262e-05 249.383 1.41857 253.025 3.07422L255.093 4.01367L250.076 18.6299L247.677 17.7461C244.901 16.7234 241.938 15.7998 238.491 15.7998C234.984 15.7998 232.787 16.5601 231.08 18.3213C229.231 20.2297 227.629 23.6395 226.229 29.7578L226.227 29.7617L226.228 29.7627L225.136 34.8506H241.669L260.432 34.9502L260.694 34.9512L260.842 35.1689L278.854 61.6328L296.736 34.9502H320.866L291.676 76.7402L322.102 119.75H299.331L299.182 119.546L241.144 40.4775L239.35 49.4004H222.069L205.688 127.208C203.927 135.709 201.185 142.838 196.777 147.866C192.27 153.008 186.201 155.75 178.342 155.75C174.181 155.75 170.746 155.109 167.909 154.107L166.241 153.519V137.182L166.899 137.4L169.531 138.278C172.182 139.162 174.414 139.8 177.142 139.8C178.528 139.8 179.703 139.526 180.732 138.98C181.764 138.434 182.677 137.6 183.52 136.442C185.304 133.989 186.716 130.135 187.897 124.672L203.76 49.4004H189.874L191.759 39.4375L192.039 39.3457L206.818 34.4668L208.154 28.6416C210.516 18.2065 213.772 10.9381 218.708 6.31836C223.737 1.61217 230.127 3.08752e-05 237.892 0ZM273.987 99.084L260.073 120.25H234.541L261.003 82.0215L273.987 99.084Z'

/** Each known agent's mark on its color. */
const STYLES: Record<string, Style> = {
  fx: { background: '#000000', mark: { path: FX_MARK, transform: 'scale(0.71111) translate(34 33.95) scale(0.7186) translate(-166.241 0)' } },
  claude: { background: '#D97757', mark: { path: LOGOS.claude } },
  codex: { background: '#000000', mark: { path: LOGOS.openai } },
  grok: { background: '#000000', mark: { path: LOGOS.x } },
  pi: { background: '#1f1f1f', mark: { glyph: 'π' } },
}

/** A known agent's mark, for a caller to pass as its avatar; other names get their initial. */
export function avatarSvg(name: string): string {
  const style = STYLES[name] ?? { background: '#666666', mark: { glyph: name.slice(0, 1).toUpperCase() } }
  const mark =
    'path' in style.mark
      ? `<path transform="${style.mark.transform ?? 'translate(30 30) scale(2.8333)'}" fill="#ffffff" d="${style.mark.path}"/>`
      : `<text x="64" y="86" font-family="ui-sans-serif,system-ui,sans-serif" font-size="66" font-weight="600" text-anchor="middle" fill="#ffffff">${style.mark.glyph}</text>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="${style.background}"/>${mark}</svg>`
}
