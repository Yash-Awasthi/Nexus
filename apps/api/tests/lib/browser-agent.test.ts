// SPDX-License-Identifier: Apache-2.0
/**
 * The browser agent's one action executor (§15.4).
 *
 * What matters is that the LLM loop and the manual step endpoint now reach the
 * page through the same function, and that the URL policy the runtime adapter
 * enforces is enforced here too — the loop used to navigate anywhere it was
 * told to.
 */
import { describe, it, expect } from "vitest";

import {
  applyBrowserAction,
  BrowserUrlBlockedError,
  type BrowserActionPage,
} from "../../src/lib/browser-agent.js";

/** Records what an action asked the page to do. */
function fakePage(): BrowserActionPage & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    goto: async (url) => void calls.push(`goto ${url}`),
    click: async (sel) => void calls.push(`click ${sel}`),
    type: async (sel, text) => void calls.push(`type ${sel} ${text}`),
  };
}

describe("applyBrowserAction", () => {
  it("navigates, clicks and types through the same entry point", async () => {
    const page = fakePage();

    await applyBrowserAction(page, { type: "navigate", selector: "https://example.com/" });
    await applyBrowserAction(page, { type: "click", selector: "#go" });
    await applyBrowserAction(page, { type: "type", selector: "#q", value: "hello" });

    expect(page.calls).toEqual(["goto https://example.com/", "click #go", "type #q hello"]);
  });

  it("types an empty string rather than undefined when no value is given", async () => {
    const page = fakePage();

    await applyBrowserAction(page, { type: "type", selector: "#q" });

    expect(page.calls).toEqual(["type #q "]);
  });

  it.each([
    "http://127.0.0.1:8080/admin",
    "http://169.254.169.254/latest/meta-data/",
    "file:///etc/passwd",
    "http://localhost/",
  ])("refuses to navigate to %s", async (url) => {
    const page = fakePage();

    await expect(applyBrowserAction(page, { type: "navigate", selector: url })).rejects.toThrow(
      BrowserUrlBlockedError,
    );
    expect(page.calls).toEqual([]);
  });

  it("does nothing for the read-only and terminal actions", async () => {
    const page = fakePage();

    await applyBrowserAction(page, { type: "extract" });
    await applyBrowserAction(page, { type: "screenshot" });
    await applyBrowserAction(page, { type: "done" });
    await applyBrowserAction(page, { type: "navigate" });
    await applyBrowserAction(page, { type: "click" });

    expect(page.calls).toEqual([]);
  });
});
