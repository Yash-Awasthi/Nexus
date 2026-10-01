// SPDX-License-Identifier: Apache-2.0
/**
 * Moderation scorers that need no chat model: OpenAI's moderation endpoint, and a keyword
 * heuristic for when nothing is reachable. Scores run 0..1 per configured category name.
 */

// ponytail: short keyword lists catch the blatant cases only; a model scores the rest.
const PATTERNS: Record<string, RegExp[]> = {
  violence: [
    /\b(kill|murder|shoot|stab|behead)\s+(you|him|her|them|everyone)\b/i,
    /\bbomb\s+the\b/i,
  ],
  self_harm: [/\b(kill|hurt|cut)\s+my\s*self\b/i, /\bsuicid(e|al)\b/i, /\bend\s+my\s+life\b/i],
  harassment: [
    /\byou\s+(are|r)\s+(an?\s+)?(idiot|moron|worthless|pathetic|loser)\b/i,
    /\bshut\s+up\b/i,
  ],
  hate: [/\b(all|those)\s+\w+\s+(are|should)\s+(vermin|animals|be\s+exterminated)\b/i],
  sexual: [/\b(porn|nude[sz]?|explicit\s+sex)\b/i],
  spam: [/\b(buy\s+now|click\s+here|free\s+money|limited\s+offer)\b/i, /\${2,}|!{3,}/],
};

export function heuristicScores(text: string, names: string[]): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const name of names) {
    const hits = (PATTERNS[name] ?? []).filter((re) => re.test(text)).length;
    scores[name] = hits === 0 ? 0 : hits === 1 ? 0.85 : 0.95;
  }
  return scores;
}

export async function openaiScores(
  text: string,
  names: string[],
  key: string,
  fetchFn: typeof fetch = fetch,
): Promise<Record<string, number>> {
  const res = await fetchFn("https://api.openai.com/v1/moderations", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "omni-moderation-latest", input: text }),
  });
  if (!res.ok) throw new Error(`OpenAI moderation failed (${res.status})`);
  const data = (await res.json()) as {
    results?: { category_scores?: Record<string, number> }[];
  };
  const got = data.results?.[0]?.category_scores ?? {};
  return Object.fromEntries(names.map((n) => [n, Number(got[n.replace(/_/g, "-")]) || 0]));
}
