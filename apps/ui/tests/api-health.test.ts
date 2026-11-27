// SPDX-License-Identifier: Apache-2.0
/**
 * The server-trouble signal (plan M5.4.2).
 *
 * The point of these tests is the distinction the app got wrong before: a list that is empty because the
 * server said so, and a list that is empty because the server did not answer.
 */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  apiTroubleMessage,
  apiTroubleSnapshot,
  noteApiHealthy,
  noteApiTrouble,
  resetApiTrouble,
  subscribeApiTrouble,
} from "../app/lib/api-health";

beforeEach(() => {
  resetApiTrouble();
});

describe("api-health", () => {
  it("ignores the statuses a page answers for itself", () => {
    noteApiTrouble(401);
    noteApiTrouble(404);
    noteApiTrouble(422);
    expect(apiTroubleSnapshot()).toBeNull();
  });

  it("records a 5xx and a dead socket, and clears on the next good answer", () => {
    noteApiTrouble(503);
    expect(apiTroubleSnapshot()).toMatchObject({ status: 503 });
    noteApiHealthy();
    expect(apiTroubleSnapshot()).toBeNull();

    noteApiTrouble(0);
    expect(apiTroubleSnapshot()).toMatchObject({ status: 0 });
    expect(apiTroubleMessage(apiTroubleSnapshot()!)).toMatch(/could not be reached/);
  });

  it("notifies subscribers once per outage, not once per request", () => {
    const listener = vi.fn();
    const stop = subscribeApiTrouble(listener);
    noteApiTrouble(503);
    noteApiTrouble(503);
    noteApiTrouble(503);
    expect(listener).toHaveBeenCalledTimes(1);
    noteApiHealthy();
    expect(listener).toHaveBeenCalledTimes(2);
    noteApiHealthy();
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });

  it("says what happened in words that name the status", () => {
    noteApiTrouble(503);
    expect(apiTroubleMessage(apiTroubleSnapshot()!)).toMatch(/HTTP 503/);
    resetApiTrouble();
    noteApiTrouble(500);
    expect(apiTroubleMessage(apiTroubleSnapshot()!)).toMatch(/HTTP 500/);
  });
});
