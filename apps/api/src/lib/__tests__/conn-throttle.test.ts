// SPDX-License-Identifier: Apache-2.0
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ConnectionMessageThrottle } from "../src/lib/conn-throttle.js";

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
      assert.ok(throttle.allow(ws), `message ${i} should be allowed`);
    }
  });

  it("blocks messages exceeding the limit", () => {
    const ws = fakeWs();
    for (let i = 0; i < 5; i++) throttle.allow(ws);
    assert.ok(!throttle.allow(ws), "6th message should be blocked");
  });

  it("resets the window after windowMs elapses", async () => {
    const t = new ConnectionMessageThrottle({ maxMessages: 2, windowMs: 50 });
    const ws = fakeWs();
    t.allow(ws);
    t.allow(ws);
    assert.ok(!t.allow(ws), "3rd should be blocked");
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(t.allow(ws), "after window reset, message allowed");
  });

  it("tracks separate connections independently", () => {
    const ws1 = fakeWs();
    const ws2 = fakeWs();
    for (let i = 0; i < 5; i++) throttle.allow(ws1);
    assert.ok(!throttle.allow(ws1), "ws1 at limit");
    // ws2 is independent — should still have full budget
    assert.ok(throttle.allow(ws2), "ws2 not affected by ws1");
  });

  it("release() removes connection state", () => {
    const ws = fakeWs();
    for (let i = 0; i < 5; i++) throttle.allow(ws);
    assert.strictEqual(throttle.getCount(ws), 5);
    throttle.release(ws);
    assert.strictEqual(throttle.getCount(ws), 0, "count reset after release");
  });

  it("getStats reports trackedConnections", () => {
    const ws1 = fakeWs();
    const ws2 = fakeWs();
    throttle.allow(ws1);
    throttle.allow(ws2);
    assert.strictEqual(throttle.getStats().trackedConnections, 2);
    throttle.release(ws1);
    assert.strictEqual(throttle.getStats().trackedConnections, 1);
  });

  it("reset() clears all state", () => {
    const ws1 = fakeWs();
    const ws2 = fakeWs();
    throttle.allow(ws1);
    throttle.allow(ws2);
    throttle.reset();
    assert.strictEqual(throttle.getStats().trackedConnections, 0);
  });
});
