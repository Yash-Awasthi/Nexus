// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ConnectionMessageThrottle } from "../../src/lib/conn-throttle.js";

// Minimal WebSocket stub — just an object identity.
const fakeWs = () => ({ readyState: 1, send() {}, close() {} });

describe("ConnectionMessageThrottle", () => {
  let throttle: ConnectionMessageThrottle;

  beforeEach(() => {
    throttle = new ConnectionMessageThrottle({ maxMessages: 5, windowMs: 1000 });
  });

  afterEach(() => {
    throttle.reset();
  });

  it("allows messages up to the limit", () => {
    const ws = fakeWs();
    for (let i = 0; i < 5; i++) {
      expect(throttle.allow(ws)).toBe(true);
    }
  });

  it("blocks messages exceeding the limit", () => {
    const ws = fakeWs();
    for (let i = 0; i < 5; i++) throttle.allow(ws);
    expect(throttle.allow(ws)).toBe(false);
  });

  it("resets the window after windowMs elapses", async () => {
    const t = new ConnectionMessageThrottle({ maxMessages: 2, windowMs: 50 });
    const ws = fakeWs();
    t.allow(ws);
    t.allow(ws);
    expect(t.allow(ws)).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(t.allow(ws)).toBe(true);
  });

  it("tracks separate connections independently", () => {
    const ws1 = fakeWs();
    const ws2 = fakeWs();
    for (let i = 0; i < 5; i++) throttle.allow(ws1);
    expect(throttle.allow(ws1)).toBe(false);
    // ws2 is independent — should still have full budget
    expect(throttle.allow(ws2)).toBe(true);
  });

  it("release() removes connection state", () => {
    const ws = fakeWs();
    for (let i = 0; i < 5; i++) throttle.allow(ws);
    expect(throttle.getCount(ws)).toBe(5);
    throttle.release(ws);
    expect(throttle.getCount(ws)).toBe(0);
  });

  it("getStats reports trackedConnections", () => {
    const ws1 = fakeWs();
    const ws2 = fakeWs();
    throttle.allow(ws1);
    throttle.allow(ws2);
    expect(throttle.getStats().trackedConnections).toBe(2);
    throttle.release(ws1);
    expect(throttle.getStats().trackedConnections).toBe(1);
  });

  it("reset() clears all state", () => {
    const ws1 = fakeWs();
    const ws2 = fakeWs();
    throttle.allow(ws1);
    throttle.allow(ws2);
    throttle.reset();
    expect(throttle.getStats().trackedConnections).toBe(0);
  });
});
