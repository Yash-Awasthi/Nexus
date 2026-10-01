// SPDX-License-Identifier: Apache-2.0
const ROUND_MARK = /\n*――― round \d+ \(sees other members' answers\) ―――\n*/;

/** A member's stream split at each debate round, with its stated final answer pulled out. */
export function opinionParts(text: string): { body: string; final?: string }[] {
  return text.split(ROUND_MARK).map((seg) => {
    const at = seg.search(/(^|\n)\s*\**FINAL\**:?\**/);
    if (at < 0) return { body: seg.trim() };
    const final = seg
      .slice(at)
      .replace(/^\s*\**FINAL\**:?\**\s*/, "")
      .trim();
    return { body: seg.slice(0, at).trim(), final };
  });
}

/** The agreement line the server leads a verdict with, and the chair's synthesis after it. */
export function verdictParts(text: string): { status?: string; body: string } {
  const m = /^Debate complete \([^)]*\): ([^\n]*)/.exec(text);
  if (!m) return { body: text };
  const status = (m[1] ?? "")
    .replace(/ — .*$/, "")
    .replace(/^(\d+)\/(\d+) members converged/, "$1 of $2 members converged")
    .replace(/^no majority position$/, "No majority — the members did not converge")
    .replace(/^no majority position \(/, "No majority (");
  return { status, body: text.slice(m[0].length).trim() };
}
