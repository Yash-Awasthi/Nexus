// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/agent-runtime — conversational group chat (AutoGen AgentChat parity).
 *
 * AutoGen (row 48, microsoft/autogen — now in maintenance mode behind
 * Microsoft Agent Framework) is built on two primitives neither existing
 * module covered: **conversable agents** that talk to each other, and a
 * **group chat** that decides who speaks next. `spawn_agents` fans work out
 * (parallel delegation); this module lets named agents converse (turn-taking).
 *
 *   ConversableAgent — a named participant with its own system persona.
 *   GroupChat        — agents converse until a message contains TERMINATE or
 *                      `maxRounds` is reached. Speaker order follows
 *                      `round_robin` (default), an injected picker function,
 *                      or the exported `llmSpeakerPicker` (AutoGen's auto /
 *                      GroupChatManager mode: the LLM picks the next speaker).
 *
 * The generation LLM is the same `LlmToolFn` the rest of agent-runtime uses
 * (any LlmToolDriver adapts via `llmDriverToToolFn`), so group chat runs on
 * the existing driver stack. The transcript is carried in the messages array
 * — each assistant entry's content is prefixed `"<Speaker>: "` so the next
 * speaker always sees who said what without new wire types.
 */

import type { LlmToolFn } from "./index.js";

// ── Public types ─────────────────────────────────────────────────────────────

/** A named participant with its own system persona (AutoGen ConversableAgent). */
export interface ConversableAgent {
  /** Unique participant name, e.g. "Alice". */
  name: string;
  /** System persona: role, instructions, style. */
  systemPrompt: string;
}

/** One message in the shared conversation. */
export interface ChatMessage {
  speaker: string;
  content: string;
}

export interface GroupChatContext {
  question: string;
  agents: ConversableAgent[];
  transcript: ChatMessage[];
}

/** Who speaks next. Return a participant name from the configured agents. */
export type SpeakerPicker = (ctx: GroupChatContext) => string | Promise<string>;

export type SpeakerSelection = "round_robin" | "auto" | SpeakerPicker;

export interface GroupChatConfig {
  /** Unique participants (minimum 1). */
  agents: ConversableAgent[];
  /** Shared generation LLM (per-agent persona comes from systemPrompt). */
  llm: LlmToolFn;
  /**
   * How the next speaker is chosen: "round_robin" (default, cycles the agent
   * list in order), "auto" (LLM picks — see llmSpeakerPicker), or a custom
   * function.
   */
  speakerSelection?: SpeakerSelection;
  /** Maximum conversation rounds (speaker turns); default 10. */
  maxRounds?: number;
  /**
   * A message containing this string ends the chat (AutoGen TERMINATE
   * convention). The token itself is stripped from the final transcript.
   */
  terminationKeyword?: string;
}

export interface GroupChatResult {
  /** All messages except the stripped termination marker. */
  transcript: ChatMessage[];
  /** Number of speaker turns taken. */
  turns: number;
  /** Why the chat ended. */
  endedBy: "terminate" | "max_rounds" | "max_speakers_exhausted";
}

export class GroupChatError extends Error {}

// ── Speaker selection ────────────────────────────────────────────────────────

function assertValidAgents(agents: ConversableAgent[]): void {
  if (agents.length === 0) throw new GroupChatError("group-chat: at least one agent is required");
  const names = new Set<string>();
  for (const a of agents) {
    if (names.has(a.name)) throw new GroupChatError(`group-chat: duplicate agent name "${a.name}"`);
    names.add(a.name);
  }
}

/** AutoGen round-robin: cycle the configured agent order. */
export function roundRobinPicker(indexRef: { i: number }): SpeakerPicker {
  return (ctx) => ctx.agents[indexRef.i++ % ctx.agents.length]!.name;
}

/**
 * AutoGen auto / GroupChatManager mode: an LLM call chooses the next speaker
 * from the running transcript. The picker asks for a bare agent name and
 * tolerates surrounding punctuation/markdown.
 */
export function llmSpeakerPicker(llm: LlmToolFn): SpeakerPicker {
  return async (ctx) => {
    const roster = ctx.agents.map((a) => a.name).join(", ");
    const recent = ctx.transcript
      .slice(-6)
      .map((m) => `${m.speaker}: ${m.content.slice(0, 200)}`)
      .join("\n");
    const turn = await llm(
      [
        { role: "user", content: `Agents: ${roster}\n\nQuestion: ${ctx.question}\n${recent ? `\nRecent conversation:\n${recent}` : ""}` },
      ],
      { systemPrompt: "You are the group-chat coordinator. Decide which agent should speak next. Reply with only the agent's name." },
    );
    const pick = turn.content.trim().replace(/^["'*#\s]+|["'\s]+$/g, "");
    return ctx.agents.find((a) => a.name.toLowerCase() === pick.toLowerCase())?.name ?? pick;
  };
}

// ── GroupChat ────────────────────────────────────────────────────────────────

/**
 * Runs a conversation among the named agents. Each turn selects the next
 * speaker, gives them the running transcript plus their own persona, and
 * appends their reply. Ends when a message contains the termination keyword
 * (stripped from the transcript) or the round budget is exhausted.
 */
export class GroupChat {
  private readonly config: Required<Pick<GroupChatConfig, "maxRounds" | "terminationKeyword">> &
    GroupChatConfig;
  private readonly selection: SpeakerPicker;
  private readonly agents: ConversableAgent[];

  constructor(config: GroupChatConfig) {
    assertValidAgents(config.agents);
    this.config = {
      maxRounds: 10,
      terminationKeyword: "TERMINATE",
      ...config,
    };
    this.agents = config.agents;
    if (typeof config.speakerSelection === "function") {
      this.selection = config.speakerSelection;
    } else if (config.speakerSelection === "auto") {
      this.selection = llmSpeakerPicker(config.llm);
    } else {
      this.selection = roundRobinPicker({ i: 0 });
    }
  }

  /** One speaker's full prompt: persona + question + conversation so far. */
  private async ask(
    speaker: ConversableAgent,
    question: string,
    transcript: ChatMessage[],
  ): Promise<string> {
    const history: { role: "user" | "assistant"; content: string }[] = [
      { role: "user", content: question },
      ...transcript.map((m) => ({
        role: "assistant" as const,
        content: `${m.speaker}: ${m.content}`,
      })),
    ];
    const turn = await this.config.llm(history, { systemPrompt: speaker.systemPrompt });
    return turn.content.trim();
  }

  /** Run the chat. Resolves when TERMINATE is said, rounds run out, or the picker stops returning valid names. */
  async chat(question: string): Promise<GroupChatResult> {
    const transcript: ChatMessage[] = [];
    const { terminationKeyword } = this.config;
    let turns = 0;

    for (let round = 0; round < this.config.maxRounds; round++) {
      const speakerName = await this.selection({ question, agents: this.agents, transcript });
      const speaker = this.agents.find((a) => a.name === speakerName);
      // Unknown picker output (or a conversation that fell off the roster)
      // ends the chat rather than looping forever.
      if (!speaker) {
        return { transcript, turns, endedBy: "max_speakers_exhausted" };
      }
      turns += 1;
      const content = await this.ask(speaker, question, transcript);
      if (content.includes(terminationKeyword)) {
        // AutoGen convention: the marker ends the chat and is not part of the result.
        transcript.push({
          speaker: speaker.name,
          content: content.replaceAll(terminationKeyword, "").trim(),
        });
        return { transcript, turns, endedBy: "terminate" };
      }
      transcript.push({ speaker: speaker.name, content });
    }

    return { transcript, turns, endedBy: "max_rounds" };
  }
}
