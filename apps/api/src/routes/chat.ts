// SPDX-License-Identifier: Apache-2.0
/**
 * Chat multi-model stream OWNER — extracted from api-bridge.ts.
 *
 * POST /api/chat/stream runs the streamed council debate: independent answers,
 * optional rounds where members see each other, peer ranking, a chair's
 * synthesis, a cold validator, cited sources and per-member error events.
 *
 * Bridge-owned state (preferences, negation rules, moderation, SSE tees, the
 * archetype seat and the memory/embedder singletons) arrives through deps so
 * this module never imports the bridge.
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 */

import type { ServerResponse } from "node:http";

import {
  COUNCIL_TEMPLATES,
  detectTaskCategory,
  extractFinalAnswer,
  MAX_DEBATE_ROUNDS,
  rankPeers,
  runCouncilDebate,
  summarizeRatings,
  type DebateMember,
  type IStreamingTransport,
} from "@nexus/council";
import { globalFlags } from "@nexus/feature-flags";
import { type DriverRegistry, type LlmDriver, type LlmRole } from "@nexus/llm/drivers";
import type { IEmbedder, MemoryManager } from "@nexus/memory";
import type { FastifyInstance } from "fastify";

import { ANON_OWNER, loadArchetypeStore, seatCouncil } from "../lib/archetype-store.ts";
import { closeChannel, createChannel } from "../lib/channels.ts";
import { findPii, maskProfanity, redactPii } from "../lib/chat-safety.ts";
import {
  citedNumbers,
  sourcesFooter,
  sourcesPrompt,
  supportingNumbers,
  type SourceSet,
} from "../lib/citations.ts";
import { trackCost } from "../lib/cost-log.ts";
import { screenForPrompt } from "../lib/injection-classifier.ts";
import { cachedDriver } from "../lib/llm-cache-driver.ts";
import type { PersistentStore } from "../lib/persistent-store.ts";
import { recordCouncilRun } from "../lib/routing-data.ts";
import { requireAuthWithTier } from "../middleware/auth.ts";

/** A council member the client asked to answer. */
interface ChatMember {
  label: string;
  provider: string;
  model: string;
  archetypeId?: string;
}

/** Bridge-owned state and helpers the stream reads. */
interface ChatRoutesDeps {
  buildChatRegistry(
    userId: string | undefined,
    providers: string[],
  ): Promise<{ registry: DriverRegistry; sources: Map<string, string> }>;
  defaultCouncil(): ChatMember[];
  sse: {
    headers: Record<string, string>;
    write(raw: ServerResponse, ev: unknown): void;
    liveChannels: WeakMap<ServerResponse, string>;
  };
  prefsStore: PersistentStore<Record<string, unknown>>;
  prefsDefaults: Record<string, unknown>;
  runModeration(text: string, only?: string[]): Promise<{ flagged?: boolean } | null>;
  stdPreamble(req: { nexusUserId?: string }, message: string): string;
  dissentPreamble(level: unknown): string;
  specialisationPreamble(req: { nexusUserId?: string }, threadId: unknown): string;
  negRulesFor(req: { nexusUserId?: string }, threadId: string): unknown;
  negBlock(rules: unknown): string;
  mentionContext(
    raw: unknown,
    userId: string | undefined,
    message: string,
    skip?: readonly string[],
  ): Promise<string>;
  citationSources(raw: unknown, userId: string | undefined, message: string): Promise<SourceSet>;
  getMemory(): MemoryManager;
  getEmbedder(): IEmbedder;
}

/** Register POST /chat/stream. */
export async function chatRoutes(app: FastifyInstance, deps: ChatRoutesDeps): Promise<void> {
  app.post<{
    Body: {
      message: string;
      members: { label: string; provider: string; model: string; archetypeId?: string }[];
      round: number;
      rounds?: number;
      threadId: string;
      /** Prompt modifiers the client has switched on (STM modules). */
      preamble?: string;
      /** @-mentions from the composer: { type: file | symbol | web, value }. */
      mentions?: unknown;
      /** Tee the stream into a channel and send its read ref first. */
      live?: boolean;
      /** A COUNCIL_TEMPLATES id: member roles, the chair's brief, optional ratings. */
      templateId?: string;
    };
  }>("/chat/stream", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const { round, rounds } = request.body;
    let { members } = request.body;
    let message = request.body.message;
    const preamble =
      typeof request.body.preamble === "string" ? request.body.preamble.slice(0, 4000).trim() : "";
    const negations =
      typeof request.body.threadId === "string"
        ? deps.negBlock(deps.negRulesFor(request, request.body.threadId))
        : "";
    // Validate BEFORE reply.hijack() — after the hijack a thrown error leaves
    // the client holding an open 200 with zero bytes forever (playtest: a
    // body without `members` hung the stream instead of answering 400).
    if (typeof message !== "string" || !message.trim()) {
      return reply
        .status(400)
        .send({ error: "message_required", message: "body.message must be a non-empty string" });
    }
    if (!Array.isArray(members) || members.length === 0) {
      return reply
        .status(400)
        .send({ error: "members_required", message: "body.members must be a non-empty array" });
    }
    // BYOK: resolve each member's key per-user (saved key first, env fallback).
    let { registry: reg, sources } = await deps.buildChatRegistry(
      request.nexusUserId,
      members.map((m) => m.provider),
    );
    // A browser that never chose a council asks for the UI's built-in members; when this server
    // holds none of their keys, NEXUS_DEFAULT_COUNCIL answers instead of an error.
    const fallback = members.some((m) => reg.get(m.provider)) ? [] : deps.defaultCouncil();
    if (fallback.length) {
      members = fallback;
      ({ registry: reg, sources } = await deps.buildChatRegistry(
        request.nexusUserId,
        members.map((m) => m.provider),
      ));
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, deps.sse.headers);
    if (fallback.length)
      deps.sse.write(raw, {
        type: "notice",
        message: `None of the chosen members has a key here, so the server's default council answers (${fallback.map((m) => m.label).join(", ")}). Add your own keys under Settings → Provider Keys.`,
      });
    if (request.body.live === true) {
      const { writerRef, readerRef } = createChannel();
      deps.sse.write(raw, { type: "live", reader: readerRef });
      deps.sse.liveChannels.set(raw, writerRef.channel_id);
      raw.on("close", () => closeChannel(writerRef.channel_id));
    }

    // Settings → Council Behaviour, Chat Preferences, Privacy & Safety, Content Filters.
    const prefs = {
      ...deps.prefsDefaults,
      ...(deps.prefsStore.get(request.nexusUserId ?? "") as Record<string, unknown> | undefined),
    };
    if (prefs.blockAdultContent === true) {
      const verdict = await deps.runModeration(message, ["sexual"]).catch(() => null);
      if (verdict?.flagged) {
        deps.sse.write(raw, {
          type: "error",
          message: "Blocked by your content filter: the message looks sexually explicit.",
        });
        raw.end();
        return;
      }
    }
    const pii = prefs.piiDetection === true || prefs.autoAnonymize === true ? findPii(message) : [];
    if (pii.length) {
      const kinds = [...new Set(pii.map((p) => p.type))].join(", ");
      if (prefs.autoAnonymize === true) {
        message = redactPii(message);
        deps.sse.write(raw, {
          type: "notice",
          message: `Removed personal details or secrets (${kinds}) before sending.`,
        });
      } else {
        deps.sse.write(raw, {
          type: "notice",
          message: `This message contains personal details or secrets (${kinds}). Turn on auto-anonymize in Settings to remove them before sending.`,
        });
      }
    }
    const clean = prefs.blockProfanity === true ? maskProfanity : (t: string) => t;
    message = clean(message);

    const enabled = members.filter((m) => {
      const driver = reg.get(m.provider);
      return !!driver;
    });

    if (enabled.length === 0) {
      deps.sse.write(raw, {
        type: "error",
        message:
          "No configured providers match the requested council members. Add a key for one of them under Settings → Provider Keys.",
      });
      raw.end();
      return;
    }

    // Debate depth cap guards resource usage from user-supplied values.
    const cap = globalFlags.getFlag("council.max_debate_rounds", MAX_DEBATE_ROUNDS);
    const debateRounds = Math.max(1, Math.min(MAX_DEBATE_ROUNDS, cap, Math.round(rounds ?? 1)));
    // Env and OAuth drivers arrive unwrapped (BYOK ones already are); the cache
    // replays a clean deterministic stream with zeroed usage.
    const driverFor = (provider: string): LlmDriver | undefined => {
      const raw = reg.get(provider) ?? reg.get("openrouter");
      return raw ? cachedDriver(raw) : undefined;
    };

    // ponytail: masking runs per streamed chunk, so a word split across two chunks slips through.
    const emitOpinion = (member: DebateMember, text: string, debateRound: number) => {
      deps.sse.write(raw, {
        type: "opinion",
        provider: member.provider,
        label: member.label,
        text: clean(text),
        summary: "",
        round,
        debateRound,
        keySource: sources.get(member.provider) ?? "none",
        ...(member.archetype ? { archetype: member.archetype } : {}),
      });
    };

    const emitErrorOpinion = (member: DebateMember, err: unknown, debateRound: number) => {
      deps.sse.write(raw, {
        type: "opinion",
        provider: member.provider,
        label: member.label,
        text: `[${member.label} error: ${err instanceof Error ? err.message : String(err)}]`,
        summary: "",
        round,
        debateRound,
        keySource: sources.get(member.provider) ?? "none",
        // Clients render member failures as failures, not as opinions.
        isError: true,
      } as Record<string, unknown>);
    };

    // Custom instructions (Profile page) ride in the per-user preferences
    // store and are prepended as a system message so every council member
    // honours them — previously the field was saved nowhere and read by
    // nothing (playtest: the Profile page advertised a no-op).
    const customInstructions = String(
      (deps.prefsStore.get(request.nexusUserId ?? "") as Record<string, unknown> | undefined)
        ?.customInstructions ?? "",
    )
      .slice(0, 2000)
      .trim();

    // Stage D2 — personas come from the same archetype registry /api/v1/council
    // resolves against, matched positionally to the members the client sent.
    // The client's provider and model win: those are an explicit UI choice,
    // where the archetype's model is only a default for callers that have none.
    await loadArchetypeStore();
    // A member may name its archetype; auto-council off leaves the rest as themselves.
    const personas = seatCouncil(
      request.nexusUserId ?? ANON_OWNER,
      detectTaskCategory(message),
      enabled.map((m) => (typeof m.archetypeId === "string" ? m.archetypeId : undefined)),
      prefs.autoCouncil !== false,
    );
    const redBlue =
      prefs.deliberationMode === "red_blue"
        ? (i: number) =>
            i % 2 === 0
              ? "You are on the blue team: build the strongest case for the best answer."
              : "You are on the red team: attack the weaknesses and risks in the other answers, then give your own."
        : () => "";
    const template =
      typeof request.body.templateId === "string"
        ? COUNCIL_TEMPLATES[request.body.templateId]
        : undefined;
    const debateMembers: DebateMember[] = enabled.map((m, i) => {
      const persona = personas[i];
      const role = template?.memberPrompts[i % template.memberPrompts.length];
      const systemPrompt = [persona?.systemPrompt, role, redBlue(i)].filter(Boolean).join("\n\n");
      return {
        label: m.label,
        provider: m.provider,
        model: m.model,
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(persona ? { archetype: persona.name } : {}),
        ...(persona?.temperature !== undefined ? { temperature: persona.temperature } : {}),
      };
    });

    const transport: IStreamingTransport = {
      async streamMember(member, messages, onDelta) {
        const driver = driverFor(member.provider);
        if (!driver) throw new Error(`No driver configured for provider "${member.provider}".`);
        let text = "";
        const res = await driver.stream(
          {
            model: member.model,
            messages: messages.map((m) => ({ role: m.role as LlmRole, content: m.content })),
            maxTokens: 2048,
            ...(member.temperature !== undefined ? { temperature: member.temperature } : {}),
          },
          (delta) => {
            if (delta.delta) {
              text += delta.delta;
              onDelta(delta.delta);
            }
          },
        );
        return {
          text,
          usage: {
            promptTokens: res.usage?.inputTokens ?? 0,
            completionTokens: res.usage?.outputTokens ?? 0,
          },
        };
      },
    };

    const reference = deps.stdPreamble(request, message);
    const dissent = deps.dissentPreamble(prefs.dissent);
    const domainFocus = deps.specialisationPreamble(request, request.body.threadId);
    const [mentioned, sourceSet] = await Promise.all([
      deps.mentionContext(request.body.mentions, request.nexusUserId, message, ["kb", "web"]),
      deps.citationSources(request.body.mentions, request.nexusUserId, message),
    ]);
    const screened = await screenForPrompt(sourceSet.chunks.map((c) => c.text));
    sourceSet.chunks.forEach((c, i) => (c.text = screened[i]!));
    const sourcesBlock = sourcesPrompt(sourceSet);
    const style = [
      {
        concise: "Answer in two or three sentences.",
        detailed: "Give a structured, detailed answer, with headings where they help.",
        exhaustive: "Give a comprehensive answer that covers edge cases, alternatives and caveats.",
      }[String(prefs.verbosityLevel)],
      {
        socratic:
          "Work through the question Socratically: raise the key assumptions as questions, answer each, then conclude.",
        hypothesis:
          "Frame competing hypotheses, weigh the evidence for each, then say which is best supported.",
        confidence: "Give a confidence percentage for each main claim and for your final answer.",
      }[String(prefs.deliberationMode)],
    ]
      .filter(Boolean)
      .join(" ");
    const outcome = await runCouncilDebate(
      transport,
      {
        message,
        members: debateMembers,
        rounds: debateRounds,
        // Later rounds are skipped once the members agree or stop changing their answers.
        untilAgreed: true,
        // A member's model says who agrees with whom; word overlap is the fallback.
        judge: async (prompt: string) => {
          const judgeMember = enabled.find((m) => driverFor(m.provider));
          const judgeDriver = judgeMember && driverFor(judgeMember.provider);
          if (!judgeMember || !judgeDriver) throw new Error("No member can judge agreement.");
          const res = await judgeDriver.complete({
            model: judgeMember.model,
            messages: [{ role: "user" as LlmRole, content: prompt }],
            maxTokens: 600,
            temperature: 0,
          });
          trackCost(judgeMember.model, res.usage);
          return res.content;
        },
        ...(customInstructions ||
        style ||
        preamble ||
        negations ||
        reference ||
        dissent ||
        domainFocus ||
        mentioned ||
        sourcesBlock
          ? {
              systemPreamble: [
                customInstructions &&
                  `Follow these standing user instructions:\n${customInstructions}`,
                style,
                preamble,
                negations,
                reference,
                dissent,
                domainFocus,
                mentioned,
                sourcesBlock,
              ]
                .filter(Boolean)
                .join("\n\n"),
            }
          : {}),
      },
      {
        onDelta: emitOpinion,
        onMemberError: emitErrorOpinion,
        // Round boundary, announced as part of each member's own text. Clients
        // (and persisted transcripts) concatenate opinion chunks per member, so
        // the boundary must travel IN the stream — a client-side tracker that
        // depends on ordering across events is what glued rounds together
        // (playtest: two error wrappers and two answers fused without a break).
        onRoundStart: (debateRound, roundMembers) => {
          for (const member of roundMembers) {
            emitOpinion(
              member,
              `\n\n――― round ${debateRound + 1} (sees other members' answers) ―――\n`,
              debateRound,
            );
          }
        },
        // Track the real usage once (a cache hit replays with ZEROED usage, so
        // the cost log shows the replay costing nothing).
        onUsage: (member, usage) =>
          trackCost(member.model, {
            inputTokens: usage?.promptTokens ?? 0,
            outputTokens: usage?.completionTokens ?? 0,
          }),
      },
    );

    // Verdict. A member's model groups the stated final answers by position
    // (word overlap when it cannot), and the line names who is on each side.
    // When the members did not converge there is no majority, and the line says
    // that instead of inventing one.
    if (debateRounds > 1 && outcome.finals.length > 0) {
      const failedCount = Math.max(0, enabled.length - outcome.finals.length);
      const failureNote =
        failedCount > 0 ? ` (${failedCount} member(s) failed — see member errors)` : "";
      const { agreement } = outcome;
      const ran =
        outcome.rounds < debateRounds
          ? `stopped after ${outcome.rounds} of ${debateRounds} rounds`
          : `${debateRounds} rounds`;
      const byOverlap = outcome.judgedBy === "overlap" ? "; by word overlap" : "";
      const others = outcome.positions
        .filter((g) => !agreement?.agreeing.includes(g.members[0]!))
        .map(
          (g) =>
            `${g.members.join(" and ")} ${g.members.length > 1 ? "say" : "says"} ${g.position.slice(0, 120)}`,
        );
      const sides = agreement
        ? `agree: ${agreement.agreeing.join(", ")}${others.length ? `; disagree: ${others.join("; ")}` : ""}${byOverlap}`
        : outcome.positions
            .map((g) => `${g.members.join(", ")}: ${g.position.slice(0, 120)}`)
            .join("; ") + byOverlap;
      const text = clean(
        agreement
          ? `Debate complete (${ran}): ${agreement.agreeing.length}/${enabled.length} members converged${failureNote} (${sides}) — ${agreement.representative.slice(0, 1500)}`
          : `Debate complete (${ran}): no majority position (${sides}) — the ` +
              `${outcome.finals.length} member(s) that answered did not converge${failureNote}.`,
      );
      deps.sse.write(raw, { type: "verdict", text, summary: "", round });
    }

    // The chair: one member's model reads every final answer and writes the
    // synthesis, keeping the disagreements visible instead of averaging them away.
    // Chair and validator run on a member that answered, not one whose provider just failed.
    const answered = new Set(outcome.finals.map((f) => f.label));
    const lead = enabled.find((m) => answered.has(m.label));
    const chairDriver = lead && driverFor(lead.provider);
    // Settings → peer ranking: members rank each other's anonymised answers first.
    let peerLine = "";
    if (prefs.peerRanking === true && outcome.finals.length >= 2) {
      const ranked = await rankPeers(
        async (label, prompt) => {
          const member = enabled.find((m) => m.label === label);
          const driver = member && driverFor(member.provider);
          if (!member || !driver) throw new Error(`No driver for ${label}.`);
          const res = await driver.complete({
            model: member.model,
            messages: [{ role: "user" as LlmRole, content: prompt }],
            maxTokens: 300,
            temperature: 0,
          });
          trackCost(member.model, res.usage);
          return res.content;
        },
        message,
        outcome.finals,
        Date.now(),
      ).catch(() => null);
      if (ranked) {
        peerLine = ranked.line;
        deps.sse.write(raw, {
          type: "verdict",
          text: `${debateRounds > 1 ? "\n\n" : ""}**${clean(ranked.line)}**`,
          summary: "",
          round,
        });
      }
    }
    let chairText = "";
    if (lead && chairDriver && outcome.finals.length >= 2) {
      const persona = new Map(debateMembers.map((m) => [m.label, m.archetype]));
      const answers = outcome.finals
        .map((f) => {
          const who = persona.get(f.label) ? `${f.label} (${persona.get(f.label)})` : f.label;
          return `### ${who}\n${f.text.slice(-3000)}`;
        })
        .join("\n\n");
      let gap = debateRounds > 1 || peerLine ? "\n\n" : "";
      try {
        const res = await chairDriver.stream(
          {
            model: lead.model,
            maxTokens: 900,
            messages: [
              {
                role: "system",
                content:
                  (template ? `${template.masterPrompt}\n\n` : "") +
                  "You chair a council of AI members. Write the council's synthesis in Markdown with these parts: " +
                  "**Answer** (the recommendation in one to three sentences), **Where the council agrees**, " +
                  "**Where it disagrees** (name the members on each side), and **What would settle it**. " +
                  "Be concrete, use only what the members said, and stay under 250 words." +
                  (sourceSet.sources.length ? " Keep the members' [n] source citations." : "") +
                  (peerLine
                    ? ` The members ranked each other's anonymised answers (Borda count): ${peerLine}. ` +
                      "Lead with the top-ranked answer unless its reasoning fails, and say so when you depart from it."
                    : ""),
              },
              { role: "user", content: `Question: ${message}\n\nFinal answers:\n\n${answers}` },
            ],
          },
          (delta) => {
            if (!delta.delta) return;
            chairText += delta.delta;
            deps.sse.write(raw, {
              type: "verdict",
              text: gap + clean(delta.delta),
              summary: "",
              round,
            });
            gap = "";
          },
        );
        trackCost(lead.model, res.usage);
      } catch (err) {
        deps.sse.write(raw, {
          type: "notice",
          message: `The synthesis could not be written: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    const modelOf = new Map(enabled.map((m) => [m.label, m.model]));
    if (outcome.agreement) {
      const agreeing = new Set(outcome.agreement.agreeing);
      void recordCouncilRun(
        request.nexusUserId ?? ANON_OWNER,
        message,
        outcome.finals.map((f) => ({
          model: modelOf.get(f.label) ?? f.label,
          agreed: agreeing.has(f.label),
        })),
      ).catch(() => undefined);
    }

    if (template?.rating && outcome.finals.length > 0) {
      const { line } = summarizeRatings(outcome.finals);
      deps.sse.write(raw, { type: "verdict", text: `\n\n**${line}**`, summary: "", round });
    }

    const validatorDriver = lead && driverFor(lead.provider);
    if (prefs.coldValidator === true && lead && validatorDriver) {
      const validator: DebateMember = {
        label: "Cold validator",
        provider: lead.provider,
        model: lead.model,
      };
      try {
        const res = await validatorDriver.complete({
          model: validator.model,
          maxTokens: 1024,
          messages: [
            {
              role: "system",
              content:
                "You are a cold, sceptical validator. Check the answers below for factual errors, unsupported claims and missing caveats. List the problems briefly, then give a corrected final answer.",
            },
            {
              role: "user",
              content: `Question: ${message}\n\n${outcome.finals
                .map((f) => `${f.label}:\n${f.text.slice(0, 4000)}`)
                .join("\n\n")}`,
            },
          ],
        });
        trackCost(validator.model, res.usage);
        emitOpinion(validator, res.content, debateRounds);
      } catch (err) {
        emitErrorOpinion(validator, err, debateRounds);
      }
    }

    if (sourceSet.sources.length) {
      const answer = chairText || outcome.finals.map((f) => f.text).join("\n\n");
      let cited = citedNumbers(answer, sourceSet.sources.length);
      if (!cited.size) {
        const embedder = deps.getEmbedder();
        cited = await supportingNumbers(answer, sourceSet, (texts) =>
          Promise.all(texts.map((t) => embedder.embed(t))),
        ).catch(() => new Set<number>());
      }
      deps.sse.write(raw, {
        type: "verdict",
        text: sourcesFooter(sourceSet, cited),
        summary: "",
        round,
      });
    }

    const latest = new Map(outcome.finals.map((f) => [f.label, f.text]));

    // Each member's stated position, scoped to the user so user-scoped recall finds it.
    if (request.nexusUserId) {
      for (const member of enabled) {
        const text = extractFinalAnswer(latest.get(member.label) ?? "");
        if (text) {
          deps
            .getMemory()
            .remember(`Q: ${message.slice(0, 200)}\nA: ${text.slice(0, 1000)}`, {
              metadata: { category: "gateway", tags: [member.model, member.provider] },
              userId: request.nexusUserId,
            })
            .catch(() => {});
        }
      }
    }

    deps.sse.write(raw, { type: "done", round });
    if (!raw.destroyed) raw.end();
  });
}
