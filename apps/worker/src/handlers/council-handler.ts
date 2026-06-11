// SPDX-License-Identifier: Apache-2.0
/**
 * Council task handler — processes `council.deliberate` jobs.
 *
 * Called by the task worker when a job with name "council.deliberate" is
 * dequeued from nexus-high or nexus-medium.
 */

import { CouncilService } from "@nexus/council";
import type { CouncilRequest } from "@nexus/contracts";

let _svc: CouncilService | null = null;

function getSvc(): CouncilService {
  if (!_svc) _svc = new CouncilService();
  return _svc;
}

export interface CouncilJobPayload {
  proposal: CouncilRequest["proposal"];
  budgetUsd?: number;
  timeoutMs?: number;
  signalId?: string;
}

export async function handleCouncilJob(payload: CouncilJobPayload): Promise<unknown> {
  const svc = getSvc();
  const request: CouncilRequest = {
    proposal: payload.proposal,
    budgetUsd: payload.budgetUsd,
    timeoutMs: payload.timeoutMs ?? 60_000,
  };
  return svc.deliberate(request, { signalId: payload.signalId });
}
