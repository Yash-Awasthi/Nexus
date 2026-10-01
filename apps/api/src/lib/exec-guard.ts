// SPDX-License-Identifier: Apache-2.0
/**
 * One gate, used the same way by every surface that executes.
 *
 * Each surface used to answer "may I run this" its own way, which is how the
 * PTY plane ended up with a loopback check as its whole policy. A route calls
 * `guardExec` and either proceeds or returns — the deny response, the approval
 * request and the redemption of a granted approval all live here, so a new
 * surface cannot get any of them subtly wrong.
 */

import type { ExecAction } from "@nexus/exec-policy";
import type { FastifyReply, FastifyRequest } from "fastify";

import { classifyAction, redeemApproval, requestApproval } from "./exec-approvals.js";
import { ownerIdFor } from "./owner.js";

/** `proceed` means the caller may run the action; `handled` means a reply was sent. */
type GuardOutcome = "proceed" | "handled";

/** An id the action names; `named` is false when the server minted it, so a retry could not repeat it. */
interface BoundId {
  field: string;
  named: boolean;
}

/** On a shared server a host shell is the operator's to grant, never a member's to approve. */
export function hostShellNeedsAdmin(
  request: { nexusUserId?: string; nexusRole?: string },
  surface: string,
): boolean {
  return (
    surface === "pty" &&
    process.env.NEXUS_DESKTOP !== "1" &&
    !!request.nexusUserId &&
    request.nexusRole !== "admin"
  );
}

export const HOST_SHELL_ADMIN_ONLY = {
  error: "host_shell_admin_only",
  message: "On a shared server only an admin can run a shell on the host.",
};

/**
 * Decide and, when a human is needed, answer for the caller.
 *
 * `approvalId` is whatever the caller sent back from an earlier 202. The
 * approval is redeemed — and so spent — before the action runs, so a failed
 * execution does not leave a reusable grant behind. An action that asks and names
 * a `bound` id the client did not choose is refused: its approval could never be redeemed.
 */
export async function guardExec(
  request: FastifyRequest,
  reply: FastifyReply,
  action: ExecAction,
  approvalId?: string,
  bound?: BoundId,
): Promise<GuardOutcome> {
  const verdict = classifyAction(action);
  if (verdict.decision === "allow") return "proceed";

  const owner = ownerIdFor(request);

  if (verdict.decision === "deny") {
    await reply
      .code(403)
      .send({ error: "exec_denied", rule: verdict.rule, message: verdict.reason });
    return "handled";
  }

  if (hostShellNeedsAdmin(request, action.surface)) {
    await reply.code(403).send(HOST_SHELL_ADMIN_ONLY);
    return "handled";
  }

  if (bound && !bound.named) {
    await reply.code(400).send({
      error: `${bound.field}_required`,
      message: `An action that needs approval must name its ${bound.field}, so the retry can repeat it.`,
    });
    return "handled";
  }

  if (!approvalId) {
    const pending = requestApproval(owner, action, verdict.reason);
    await reply.code(202).send({
      error: "approval_required",
      approvalId: pending.id,
      expiresAt: pending.expiresAt,
      action: { surface: action.surface, command: action.command, args: action.args ?? [] },
      message: `${verdict.reason} Approve it at /api/v1/exec/approvals and send the request again with approvalId.`,
    });
    return "handled";
  }

  const redeemed = redeemApproval(owner, approvalId, action);
  if (typeof redeemed === "string") {
    await reply.code(403).send({
      error: redeemed,
      message:
        redeemed === "action_mismatch"
          ? "That approval was granted for a different action."
          : "That approval cannot be used.",
    });
    return "handled";
  }

  return "proceed";
}
