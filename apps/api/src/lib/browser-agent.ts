// SPDX-License-Identifier: Apache-2.0
/**
 * Browser-agent execution, re-exported.
 *
 * The implementation moved to @nexus/browser-automation so the worker can run
 * the same loop; this file stays as the name the API's route modules already
 * import.
 */

export {
  applyBrowserAction,
  BrowserUrlBlockedError,
  runBrowserAgentTask,
  browserDecisionMessages,
  parseBrowserDecision,
  DEFAULT_MAX_AGENT_STEPS,
} from "@nexus/browser-automation";
export type {
  BrowserActionType,
  BrowserActionPage,
  BrowserAgentContext,
  BrowserAgentDecision,
  BrowserAgentSession,
  BrowserAgentStep,
} from "@nexus/browser-automation";
