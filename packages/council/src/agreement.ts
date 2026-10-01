// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/council — final-answer extraction and agreement scoring.
 *
 * The debate path used to compute its majority by counting identical completion
 * strings. Two language models never emit byte-identical prose, so the winning
 * count was always 1 and the verdict line read "1/N members" however much the
 * council actually agreed — an overconfident claim that was also always wrong.
 *
 * This module replaces that with two explicit steps: pull each member's stated
 * final answer out of its prose, then cluster those answers by content overlap.
 * When no two members land in the same cluster there is no majority to report,
 * and `scoreAgreement` says so by returning null rather than inventing one.
 */

/** Appended to the last debate round so every member states a comparable answer. */
export const FINAL_ANSWER_INSTRUCTION =
  "End your reply with a single line beginning `FINAL:` containing your answer " +
  "in one sentence, with no hedging and no restatement of the question.";

const FINAL_LINE = /^[ \t>*_-]*final\s*(?:answer)?\s*[:：-]\s*(.+)$/im;

/**
 * A member's stated answer. Prefers the explicit `FINAL:` line the debate
 * prompt asks for; falls back to the last substantial paragraph, which is where
 * a model that ignored the instruction almost always puts its conclusion.
 */
/** Whether a reply states its position on a `FINAL:` line, as the debate prompt asks. */
export function statesFinal(text: string): boolean {
  return FINAL_LINE.test(text);
}

export function extractFinalAnswer(text: string): string {
  const marked = FINAL_LINE.exec(text);
  // The closing half of `**Final:**` sits after the colon, so it lands in the
  // capture rather than in the leading-emphasis class.
  if (marked?.[1]) return marked[1].replace(/^[*_\s]+/, "").trim();

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^[#>*\s-]+/, "").trim())
    .filter((p) => p.length > 0);
  const last = paragraphs.at(-1);
  return (last ?? text).trim();
}

// Words carrying no positional meaning for an answer comparison. Kept short on
// purpose: an aggressive list makes short answers collide with each other.
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "for",
  "from",
  "has",
  "have",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "should",
  "that",
  "the",
  "their",
  "there",
  "these",
  "they",
  "this",
  "to",
  "was",
  "were",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w)),
  );
}

/** Jaccard overlap of two answers' content words, 0 (disjoint) to 1 (same set). */
export function answerSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return ta.size === tb.size ? 1 : 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

/** Two answers count as the same position at or above this overlap. */
export const AGREEMENT_THRESHOLD = 0.6;

export interface AgreementResult {
  /** Labels of the members holding the largest shared position. */
  agreeing: string[];
  /** Members who produced an answer at all. */
  total: number;
  /** `agreeing.length / total`, rounded to two decimals. */
  agreement: number;
  /** The cluster's first answer, used as the position's wording. */
  representative: string;
}

/**
 * Cluster members by how much their final answers overlap and return the
 * largest cluster. Returns null when every member stands alone — there is no
 * majority position to report, and printing one anyway is the defect this
 * replaces.
 */
export function scoreAgreement(
  entries: readonly { label: string; text: string }[],
  threshold = AGREEMENT_THRESHOLD,
): AgreementResult | null {
  return overlapJudgement(entries, threshold).agreement;
}

/** Members sharing one position, in the words of whoever grouped them. */
export interface PositionGroup {
  members: string[];
  position: string;
}

export interface AgreementJudgement {
  /** The largest shared position, or null when nobody shares one. */
  agreement: AgreementResult | null;
  /** Every position taken, largest first, each member in exactly one. */
  groups: PositionGroup[];
  method: "model" | "overlap";
}

const finalAnswers = (entries: readonly { label: string; text: string }[]) =>
  entries
    .map((e) => ({ label: e.label, answer: extractFinalAnswer(e.text) }))
    .filter((e) => e.answer.length > 0);

function judgementOf(
  groups: PositionGroup[],
  total: number,
  method: AgreementJudgement["method"],
): AgreementJudgement {
  const sorted = [...groups].sort((a, b) => b.members.length - a.members.length);
  const largest = sorted[0];
  const agreement =
    largest && largest.members.length >= 2
      ? {
          agreeing: largest.members,
          total,
          agreement: Math.round((largest.members.length / total) * 100) / 100,
          representative: largest.position,
        }
      : null;
  return { agreement, groups: sorted, method };
}

/** Group members by word overlap between their final answers. Blind to "yes" versus "no". */
export function overlapJudgement(
  entries: readonly { label: string; text: string }[],
  threshold = AGREEMENT_THRESHOLD,
): AgreementJudgement {
  const answers = finalAnswers(entries);
  const groups: PositionGroup[] = [];
  for (const { label, answer } of answers) {
    const hit = groups.find((g) => answerSimilarity(g.position, answer) >= threshold);
    if (hit) hit.members.push(label);
    else groups.push({ members: [label], position: answer });
  }
  return answers.length < 2
    ? { agreement: null, groups, method: "overlap" }
    : judgementOf(groups, answers.length, "overlap");
}

/**
 * Ask a model which members share a position. Throws when the reply cannot be
 * read, so the caller can fall back to {@link overlapJudgement}.
 */
export async function judgeAgreement(
  ask: (prompt: string) => Promise<string>,
  question: string,
  entries: readonly { label: string; text: string }[],
): Promise<AgreementJudgement> {
  const answers = finalAnswers(entries);
  if (answers.length < 2) return overlapJudgement(entries);
  const prompt =
    `Question: ${question.slice(0, 2000)}\n\nEach council member's final answer:\n` +
    answers.map((a) => `- ${a.label}: ${a.answer.slice(0, 600)}`).join("\n") +
    "\n\nGroup the members by the position they take on the question. Members who give the same " +
    "answer in different words share a position. Opposite answers (yes and no, adopt and do not " +
    "adopt) are different positions even when worded alike. Reply with JSON only, no prose: " +
    '{"groups":[{"members":["<member>"],"position":"<the position in a few words>"}]}';
  const raw = await ask(prompt);
  const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as {
    groups?: { members?: unknown; position?: unknown }[];
  };
  const known = new Map(answers.map((a) => [a.label, a.answer]));
  const placed = new Set<string>();
  const groups: PositionGroup[] = [];
  for (const g of parsed.groups ?? []) {
    const members = (Array.isArray(g.members) ? g.members : [])
      .map(String)
      .filter((m) => known.has(m) && !placed.has(m));
    members.forEach((m) => placed.add(m));
    if (members.length) groups.push({ members, position: String(g.position ?? "").slice(0, 300) });
  }
  if (groups.length === 0) throw new Error("The judge named none of the members.");
  for (const [label, answer] of known)
    if (!placed.has(label)) groups.push({ members: [label], position: answer });
  return judgementOf(groups, answers.length, "model");
}
