// SPDX-License-Identifier: Apache-2.0
/**
 * Served council — the full council protocol set as MCP tools.
 *
 * llmcouncil ships the same protocol family as an MCP server
 * (council_deliberate / council_vote / council_debate / council_critique /
 * council_verify). Every one of those protocols now exists as a real
 * primitive in the @nexus stack (DeliberativeCouncil.run, rankedReview +
 * Borda, debate-engine runMultiAgentDebate with convergence, runCritique with
 * red-team framing, runMavVerification) — this module is the thin served
 * surface that composes them behind the batch-30 {@link McpHttpServer}
 * without duplicating any protocol logic. A host (Claude Desktop, an agent
 * runtime, a curl) can deliberate, vote, debate, critique, and verify through
 * plain MCP JSON-RPC over HTTP.
 *
 * One injected {@link ILLMTransport} drives every tool: the council protocols
 * call it directly, and the debate tool adapts it to debate-engine's plain
 * transport shape. Transport injection keeps the whole server deterministic
 * to test and provider-agnostic.
 *
 * Tools
 * ─────
 *   council_deliberate {question, context?} — convene → anonymized peer review → chairman verdict.
 *   council_vote      {question, context?} — convene → anonymous rankings → Borda tally.
 *   council_debate    {question, agents?, rounds?, convergence?, context?} —
 *                     parallel multi-round debate; rounds is a budget when convergence is on.
 *   council_critique  {question, mode?, context?} — positions → peer critique
 *                     ("critique" reviewer framing | "redteam" adversary framing).
 *   council_verify    {question, context?} — positions as candidates → MAV
 *                     cross-check (every advisor verifies every answer) → majority verdict.
 */

import { McpHttpServer, type McpCallResult, type McpToolDefinition } from "@nexus/mcp-client";
import { majorityFinalAnswer, runMultiAgentDebate } from "@nexus/debate-engine";
import type { Archetype } from "./archetypes.js";
import { runCritique } from "./critique.js";
import { DeliberativeCouncil } from "./deliberative.js";
import type { ILLMMessage, ILLMTransport } from "./engine.js";
import { runMavVerification } from "./verify.js";

/** Which protocol tools to expose. Default: all five. */
export type CouncilProtocolTool = "deliberate" | "vote" | "debate" | "critique" | "verify";

export interface CouncilMcpServerOptions {
  /** The single LLM transport driving every protocol. */
  llm: ILLMTransport;
  /** Advisor panel. Defaults to summonArchetypes("default", 5). */
  advisors?: Archetype[];
  /** Passed through to council protocol calls. */
  model?: string;
  /** Server identity reported by `initialize`. */
  name?: string;
  version?: string;
  /** Subset of protocol tools to expose (default: all). */
  tools?: readonly CouncilProtocolTool[];
}

const ALL_TOOLS: readonly CouncilProtocolTool[] = [
  "deliberate",
  "vote",
  "debate",
  "critique",
  "verify",
];

const str = (v: unknown, dflt = ""): string => (typeof v === "string" ? v : dflt);
const num = (v: unknown, dflt: number): number =>
  typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : dflt;
const bool = (v: unknown, dflt = false): boolean => (typeof v === "boolean" ? v : dflt);

const inputSchema = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object" as const,
  properties,
  required,
});

const text = (value: unknown): McpCallResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  text: JSON.stringify(value),
});

/**
 * Build an MCP server exposing the council protocol set. Each tool's `execute`
 * dispatches to the corresponding real primitive over the injected transport.
 */
export function createCouncilMcpServer(options: CouncilMcpServerOptions): McpHttpServer {
  const { llm, advisors, model } = options;
  const tools: readonly CouncilProtocolTool[] = options.tools ?? ALL_TOOLS;
  const enabled = new Set(tools);
  const council = new DeliberativeCouncil({ llm, advisors, ...(model ? { model } : {}) });
  const panel: readonly Archetype[] = council.panel;

  const definitions: McpToolDefinition[] = [];
  if (enabled.has("deliberate")) {
    definitions.push({
      name: "council_deliberate",
      description:
        "Run the deliberative council on a question: advisors convene independently, review each other anonymously, and a chairman issues a verdict.",
      inputSchema: inputSchema(
        {
          question: { type: "string", description: "The question to deliberate." },
          context: { type: "string", description: "Optional background context." },
        },
        ["question"],
      ),
    });
  }
  if (enabled.has("vote")) {
    definitions.push({
      name: "council_vote",
      description:
        "Quick voting: advisors answer, then anonymously rank each other; standings are tallied with the Borda count.",
      inputSchema: inputSchema(
        {
          question: { type: "string" },
          context: { type: "string" },
        },
        ["question"],
      ),
    });
  }
  if (enabled.has("debate")) {
    definitions.push({
      name: "council_debate",
      description:
        "Structured multi-round debate: agents answer, see each other's answers, and refine. With convergence enabled, rounds become a budget and the debate stops when positions stabilise.",
      inputSchema: inputSchema(
        {
          question: { type: "string" },
          context: { type: "string" },
          agents: {
            type: "array",
            description: "Agent names (default: the advisor panel).",
          },
          rounds: { type: "number", description: "Round budget (default 2)." },
          convergence: {
            type: "boolean",
            description: "Stop early once positions stop changing (default false).",
          },
        },
        ["question"],
      ),
    });
  }
  if (enabled.has("critique")) {
    definitions.push({
      name: "council_critique",
      description:
        "Peer critique of the advisors' answers: reviewer framing (strengths/weaknesses/errors/confidence) or red-team adversary framing (flaws/edge cases/adversarial inputs/failure modes).",
      inputSchema: inputSchema(
        {
          question: { type: "string" },
          context: { type: "string" },
          mode: {
            type: "string",
            description: '"critique" (default) or "redteam".',
          },
        },
        ["question"],
      ),
    });
  }
  if (enabled.has("verify")) {
    definitions.push({
      name: "council_verify",
      description:
        "Model-as-Verifier cross-check: every advisor independently verifies every answer (structured boolean verdicts); the most-approved answer is the verified output.",
      inputSchema: inputSchema(
        {
          question: { type: "string" },
          context: { type: "string" },
        },
        ["question"],
      ),
    });
  }

  // The debate loop calls the council transport with its own message shape.
  const debateTransport = async (req: {
    agent: string;
    round: number;
    messages: readonly { role: "system" | "user" | "assistant"; content: string }[];
  }): Promise<string> => {
    const res = await llm.chat(req.messages as ILLMMessage[], {
      ...(model ? { model } : {}),
      temperature: 0.7,
      maxTokens: 1024,
    });
    return res.content;
  };

  return new McpHttpServer({
    name: options.name ?? "council",
    version: options.version ?? "1.0.0",
    tools: definitions,
    execute: async (name, args): Promise<McpCallResult> => {
      const question = str(args.question);
      const context = str(args.context);
      switch (name) {
        case "council_deliberate": {
          const outcome = await council.run(question, context);
          return text({
            verdict: outcome.verdict,
            advisors: outcome.positions.map((p) => p.advisor),
          });
        }
        case "council_vote": {
          const outcome = await council.runRanked(question, context);
          const winnerAdvisor = outcome.anonymization[outcome.tally.winner] ?? outcome.tally.winner;
          return text({
            winner: winnerAdvisor,
            tally: outcome.tally,
            advisors: outcome.positions.map((p) => p.advisor),
          });
        }
        case "council_debate": {
          const agents = Array.isArray(args.agents)
            ? args.agents.filter((a): a is string => typeof a === "string")
            : panel.map((p) => p.name);
          const result = await runMultiAgentDebate({
            question,
            agents: agents.length > 0 ? agents : panel.map((p) => p.name),
            rounds: num(args.rounds, 2),
            ...(bool(args.convergence) ? { convergence: true } : {}),
            systemPrompt: context ? `Context: ${context}` : undefined,
            transport: debateTransport,
          });
          return text({
            converged: result.converged,
            roundsRun: result.roundsRun,
            majority: majorityFinalAnswer(result),
            finalAnswers: result.finalAnswers,
          });
        }
        case "council_critique": {
          const positions = await council.convene(question, context);
          const mode = str(args.mode, "critique") === "redteam" ? "redteam" : "critique";
          const result = await runCritique({
            question,
            targets: positions.map((p) => ({ label: p.advisor, content: p.content })),
            critics: panel.map((p) => p.name),
            transport: llm,
            mode,
          });
          return text({ mode: result.mode, critiques: result.critiques });
        }
        case "council_verify": {
          const positions = await council.convene(question, context);
          const result = await runMavVerification({
            question,
            candidates: positions.map((p) => ({ label: p.advisor, content: p.content })),
            verifiers: panel.map((p) => p.name),
            transport: llm,
          });
          return text({
            verified: result.verified,
            scores: result.scores,
            approvals: result.verdicts.filter((v) => v.verdict.verdict).length,
          });
        }
        default:
          throw new Error(`unknown tool ${name}`);
      }
    },
  });
}