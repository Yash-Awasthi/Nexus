// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/council — discussion mode.
 *
 * The third shape a council runs in, beside the structured vote
 * (`DeliberationEngine`) and the round-based debate (`runCouncilDebate`). Both
 * of those advance through a `Promise.allSettled` barrier, so every participant
 * waits for the slowest one before anyone speaks again: a flash model finishes
 * in two seconds and then idles for ninety.
 *
 * Discussion removes the barrier. The shared state is an append-only ledger
 * whose entries carry a monotonic line number, so "what is new since line N" is
 * an exact question. Each participant runs its own loop — read the delta since
 * its own watermark, contribute, advance the watermark — and never waits on a
 * named peer. A supervisor folds contributions into a digest and is the only
 * judge of whether a result has been reached; it holds no opinion of its own.
 *
 * The one piece of synchronisation kept is the settle pause: a short quiet
 * window after each contribution so a slow participant's answer lands before
 * the fast ones have talked past it. It is a pause, not a barrier — nobody is
 * blocked on a specific peer.
 *
 * Transport is injected (`IStreamingTransport`, shared with the debate path),
 * so this package still knows nothing about provider drivers.
 */

import type { DebateMember, IStreamingTransport } from "./debate.js";
import type { ILLMMessage } from "./engine.js";

export interface LedgerEntry {
  /** Monotonic, 1-based. A reader's watermark is a line number. */
  line: number;
  at: string;
  /** Participant label, or the supervisor's label for a digest. */
  author: string;
  kind: "contribution" | "digest";
  text: string;
}

/** Append-only record of one discussion. Readable as a standalone document. */
class Ledger {
  private readonly entries: LedgerEntry[] = [];

  constructor(readonly topic: string) {}

  get length(): number {
    return this.entries.length;
  }

  append(author: string, kind: LedgerEntry["kind"], text: string): LedgerEntry {
    const entry: LedgerEntry = {
      line: this.entries.length + 1,
      at: new Date().toISOString(),
      author,
      kind,
      text: text.trim(),
    };
    this.entries.push(entry);
    return entry;
  }

  /** Everything appended after `line`. An empty array means nothing is new. */
  since(line: number): LedgerEntry[] {
    return this.entries.slice(Math.max(0, line));
  }

  all(): LedgerEntry[] {
    return [...this.entries];
  }

  /** The `notes.md` body: line number, timestamp and author per entry. */
  toMarkdown(): string {
    const head = `# Discussion — ${this.topic}\n`;
    const body = this.entries
      .map(
        (e) =>
          `\n## L${e.line} · ${e.at} · ${e.author}${e.kind === "digest" ? " (record)" : ""}\n\n${e.text}\n`,
      )
      .join("");
    return `${head}${body}`;
  }
}

/**
 * The supervisor's whole brief. It keeps the record and judges arrival at a
 * result; it does not answer the question, argue, or rank participants.
 */
export const SUPERVISOR_PROMPT =
  "You keep the written record for a discussion between several participants. " +
  "You have no opinion. Never answer the question under discussion, never argue " +
  "for or against a position, never praise or rank participants, and never use " +
  "the first person. Fold the new contributions into one clean, minimal, " +
  "deduplicated record under exactly these headings: Positions, Open questions, " +
  "Settled. State each point once, attributing it to the participants holding " +
  "it. End with a single line reading `STATUS: SETTLED` when the discussion has " +
  "reached a result that answers the topic, or `STATUS: CONTINUE` when it has " +
  "not. That judgement is the only one you make.";

const STATUS_LINE = /^[ \t>*_-]*status\s*[:：]\s*(settled|continue)\b.*$/im;

/** Strips the control line so the stored digest is the record alone. */
function splitStatus(text: string): { digest: string; settled: boolean } {
  const match = STATUS_LINE.exec(text);
  return {
    digest: text.replace(STATUS_LINE, "").trim(),
    settled: match?.[1]?.toLowerCase() === "settled",
  };
}

function renderDelta(delta: readonly LedgerEntry[]): string {
  if (delta.length === 0) return "Nothing has been added since your last contribution.";
  return delta
    .map((e) => `L${e.line} — ${e.author}${e.kind === "digest" ? " (record)" : ""}:\n${e.text}`)
    .join("\n\n");
}

function contributionPrompt(topic: string, delta: readonly LedgerEntry[]): string {
  return (
    `Topic under discussion:\n${topic}\n\n` +
    `New in the shared record since you last read it:\n${renderDelta(delta)}\n\n` +
    "Add one contribution of your own: state or revise your position, or take up " +
    "a point someone else made. Do not summarise the discussion — the record is " +
    "kept for you. Keep it under 150 words and raise at most one open question."
  );
}

export interface DiscussionOptions {
  topic: string;
  participants: readonly DebateMember[];
  /** Folds contributions into the record and decides when the result arrived. */
  supervisor: DebateMember;
  /** Quiet window after each contribution, and the supervisor's poll interval. */
  settlePauseMs?: number;
  maxContributions?: number;
  maxWallMs?: number;
  /** Prompt plus completion tokens across every turn, when usage is reported. */
  maxTotalTokens?: number;
  /** Standing user instructions, prepended to every participant. */
  systemPreamble?: string;
}

export interface DiscussionEvents {
  /** A contribution or a digest landed in the ledger. */
  onEntry?: (entry: LedgerEntry) => void;
  /** A chunk of a participant's contribution, before it is committed. */
  onDelta?: (member: DebateMember, text: string) => void;
  /** One turn failed. The discussion continues without it. */
  onError?: (member: DebateMember, error: unknown) => void;
  onUsage?: (
    member: DebateMember,
    usage: { promptTokens: number; completionTokens: number },
  ) => void;
}

export type DiscussionStopReason =
  "settled" | "contribution-cap" | "time-cap" | "token-cap" | "participants-failed";

export interface DiscussionOutcome {
  entries: LedgerEntry[];
  /** The supervisor's latest record, or "" if it never produced one. */
  digest: string;
  settled: boolean;
  reason: DiscussionStopReason;
  contributions: number;
  totalTokens: number;
  markdown: string;
}

const DISCUSSION_DEFAULTS = {
  settlePauseMs: 1_200,
  maxContributions: 18,
  maxWallMs: 180_000,
  maxTotalTokens: 120_000,
} as const;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * Run a discussion until the supervisor judges a result reached or a cap is
 * hit. Every cap is part of the loop condition, so an unproductive discussion
 * ends on its own.
 */
export async function runDiscussion(
  transport: IStreamingTransport,
  options: DiscussionOptions,
  events: DiscussionEvents = {},
): Promise<DiscussionOutcome> {
  const {
    topic,
    participants,
    supervisor,
    settlePauseMs = DISCUSSION_DEFAULTS.settlePauseMs,
    maxContributions = DISCUSSION_DEFAULTS.maxContributions,
    maxWallMs = DISCUSSION_DEFAULTS.maxWallMs,
    maxTotalTokens = DISCUSSION_DEFAULTS.maxTotalTokens,
    systemPreamble,
  } = options;

  const ledger = new Ledger(topic);
  const deadline = Date.now() + maxWallMs;
  let contributions = 0;
  let totalTokens = 0;
  let digest = "";
  let settled = false;
  let reason: DiscussionStopReason | null = null;

  const stop = (why: DiscussionStopReason): void => {
    reason ??= why;
  };
  const stopped = (): boolean => {
    if (reason) return true;
    if (Date.now() >= deadline) stop("time-cap");
    else if (totalTokens >= maxTotalTokens) stop("token-cap");
    else if (contributions >= maxContributions) stop("contribution-cap");
    return reason !== null;
  };

  /**
   * Take a contribution slot, or refuse when a cap is reached. Nothing awaits
   * between the check and the increment, so a participant that reads the last
   * free slot is the one that takes it.
   */
  const claimSlot = (): boolean => {
    if (stopped()) return false;
    contributions += 1;
    return true;
  };

  const speak = async (member: DebateMember, messages: ILLMMessage[]): Promise<string | null> => {
    let text = "";
    try {
      const res = await transport.streamMember(member, messages, (delta) => {
        text += delta;
        events.onDelta?.(member, delta);
      });
      if (!text) text = res.text;
      if (res.usage) {
        totalTokens += res.usage.promptTokens + res.usage.completionTokens;
        events.onUsage?.(member, res.usage);
      }
      return text.trim() ? text : null;
    } catch (err) {
      events.onError?.(member, err);
      return null;
    }
  };

  const system = (member: DebateMember): ILLMMessage[] => {
    const head: ILLMMessage[] = [];
    if (member.systemPrompt) head.push({ role: "system", content: member.systemPrompt });
    if (systemPreamble) head.push({ role: "system", content: systemPreamble });
    return head;
  };

  /** A participant that fails this many turns in a row leaves the discussion. */
  const MAX_FAILED_TURNS = 2;
  let active = participants.length;

  const participantLoop = async (member: DebateMember): Promise<void> => {
    let watermark = 0;
    let failed = 0;
    while (failed < MAX_FAILED_TURNS && claimSlot()) {
      // Entries landing while this turn runs stay in the next delta.
      const readAt = ledger.length;
      const delta = ledger.since(watermark).filter((e) => e.author !== member.label);
      const text = await speak(member, [
        ...system(member),
        { role: "user", content: contributionPrompt(topic, delta) },
      ]);
      watermark = readAt;
      if (text) {
        failed = 0;
        const entry = ledger.append(member.label, "contribution", text);
        events.onEntry?.(entry);
      } else {
        // A turn that produced nothing gives its slot back.
        failed += 1;
        contributions -= 1;
      }
      await sleep(settlePauseMs);
    }
    active -= 1;
    if (active === 0) stop("participants-failed");
  };

  const fold = async (delta: readonly LedgerEntry[]): Promise<void> => {
    const text = await speak(supervisor, [
      { role: "system", content: SUPERVISOR_PROMPT },
      {
        role: "user",
        content:
          `Topic:\n${topic}\n\nThe record so far:\n${digest || "(empty)"}\n\n` +
          `New contributions:\n${renderDelta(delta)}`,
      },
    ]);
    if (!text) return;
    const split = splitStatus(text);
    digest = split.digest;
    settled = split.settled;
    const entry = ledger.append(supervisor.label, "digest", digest);
    events.onEntry?.(entry);
    if (settled) stop("settled");
  };

  const supervisorLoop = async (): Promise<void> => {
    let watermark = 0;
    while (!stopped()) {
      await sleep(settlePauseMs);
      const readAt = ledger.length;
      const delta = ledger.since(watermark).filter((e) => e.kind === "contribution");
      watermark = readAt;
      if (delta.length === 0) continue;
      await fold(delta);
    }
  };

  await Promise.all([...participants.map(participantLoop), supervisorLoop()]);

  // Contributions that landed after the supervisor's last read would otherwise
  // never reach the record, so a capped discussion would end mid-sentence.
  const tail = ledger
    .all()
    .filter((e) => e.kind === "contribution" && e.line > lastDigestLine(ledger));
  if (tail.length > 0) await fold(tail);

  return {
    entries: ledger.all(),
    digest,
    settled,
    reason: reason ?? "settled",
    contributions,
    totalTokens,
    markdown: ledger.toMarkdown(),
  };
}

function lastDigestLine(ledger: Ledger): number {
  return ledger.all().reduce((line, e) => (e.kind === "digest" ? e.line : line), 0);
}
