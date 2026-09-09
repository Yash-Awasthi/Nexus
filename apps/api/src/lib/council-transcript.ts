// SPDX-License-Identifier: Apache-2.0
/**
 * Council run-transcript emission (end-to-end wiring, pass 65 + pass 66).
 *
 * The API's council route (/council/deliberate, /council/deliberate/stream,
 * /council/trigger) runs a real deliberation through CouncilService and
 * persists verdicts + vote turns; what it never recorded was the run-level
 * observability artifact from pass 58 (@nexus/council src/transcript.ts —
 * Weiping Council parity). Since pass 66 the composition lives once in
 * @nexus/council src/run-transcript.ts (buildCouncilRunTranscript +
 * councilTranscriptEvent), shared verbatim with the worker's council job and
 * agent-MCP tools, so this module is only the API's thin emission seam.
 *
 * Pure and DB-free: imports only @nexus/council's recorder and
 * @nexus/contracts types, so it is unit-testable without DATABASE_URL.
 */
import {
  buildCouncilRunTranscript,
  councilTranscriptEvent,
  type CouncilRunInput,
} from "@nexus/council";

export {
  buildCouncilRunTranscript,
  councilTranscriptJson,
  type CouncilRunInput,
} from "@nexus/council";

/**
 * Emit the worker-shaped "council.transcript" event for a completed run.
 * Never throws — logging an artifact must not break the API response path.
 * The composition lives in @nexus/council run-transcript.ts (pass 66) so the
 * API emits the same artifact contract as the worker council job.
 */
export function emitCouncilTranscript(input: CouncilRunInput): void {
  if (!input.result || input.votes.length === 0) return;
  try {
    const transcript = buildCouncilRunTranscript(input);
    console.log(JSON.stringify(councilTranscriptEvent(input.signalId, transcript)));
  } catch (err) {
    console.error("[council-transcript] emission failed:", err);
  }
}
