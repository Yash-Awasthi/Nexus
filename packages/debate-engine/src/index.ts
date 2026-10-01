// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/debate-engine — converging multi-agent debate.
 *
 * Agents answer, read each other's positions and revise until they agree or stop moving.
 */

export { majorityFinalAnswer, runMultiAgentDebate } from "./multiagent-debate.js";
export type {
  AgentMessage,
  AgentTranscript,
  MultiAgentDebateOptions,
  MultiAgentDebateResult,
} from "./multiagent-debate.js";
