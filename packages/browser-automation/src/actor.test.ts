// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { MockBrowserDriver } from "@nexus/stealth-browser";
import {
  BrowserActor,
  parseHtml,
  serializeDom,
  type ActorElement,
} from "./index.js";

const PAGE_HTML = `<html><head><title>Test Page</title><style>body{color:red}</style></head>
<body>
<div class="header"><h1>Welcome</h1></div>
<svg width="20" height="20"><path d="M0 0"/></svg>
<form>
  <input id="q" type="text" placeholder="Search here">
  <button type="submit">Go</button>
</form>
<nav><a href="/docs">Docs</a><a href="/api">API</a></nav>
<p>Plain paragraph text.</p>
</body></html>`;

function makeActor(html: string, title = "Test Page"): BrowserActor {
  const driver = new MockBrowserDriver({ html, title });
  return new BrowserActor(driver);
}

describe("DOM parsing", () => {
  it("builds a tree, skipping script/style inner text", () => {
    const tree = parseHtml(PAGE_HTML);
    const html = tree.children[0];
    expect(html.tag).toBe("html");
    const body = html.children.find((c) => c.tag === "body");
    expect(body).toBeDefined();
    // <style> content ("body{color:red}") must not appear as text
    expect(JSON.stringify(body)).not.toContain("color:red");
    const tags = body!.children.map((c) => c.tag);
    expect(tags).toContain("div");
    expect(tags).toContain("form");
    expect(tags).toContain("nav");
    expect(tags).toContain("p");
  });

  it("collects inline text on leaf elements", () => {
    const tree = parseHtml("<div><p>Hello world</p></div>");
    const p = tree.children[0].children[0];
    expect(p.text).toBe("Hello world");
  });
});

describe("snapshot serialization (browser-use eval_serializer format)", () => {
  it("numbers interactive elements [i_N] in document order, skips SVG", () => {
    const tree = parseHtml(PAGE_HTML);
    const elements: ActorElement[] = [];
    const text = serializeDom(tree, elements);
    expect(text).toContain("[i_0] <input");
    expect(text).toContain("[i_1] <button");
    expect(text).toContain("[i_2] <a");
    // svg/path never serialized
    expect(text).not.toContain("<svg");
    expect(text).not.toContain("<path");
    // indices match element array
    expect(elements.map((e) => e.index)).toEqual([0, 1, 2, 3]);
    expect(elements[0].selector).toBe("#q");
    expect(elements[0].tagName).toBe("input");
  });

  it("inline text replaces children for leaves; indent reflects depth", () => {
    const tree = parseHtml("<div><span>deep</span></div>");
    const elements: ActorElement[] = [];
    const text = serializeDom(tree, elements);
    expect(text).toContain(">deep");
    // div at depth 0, span at depth 1 → two-space indent
    expect(text.split("\n").some((l) => l.startsWith("  <span"))).toBe(true);
  });
});

describe("BrowserActor perceive→plan→act", () => {
  it("navigate produces a snapshot with url/title/elements", async () => {
    const actor = makeActor(PAGE_HTML);
    const snap = await actor.navigate("https://example.test/search");
    expect(snap.url).toBe("https://example.test/search");
    expect(snap.title).toBe("Test Page");
    expect(snap.elements.length).toBe(4);
    expect(snap.text).toContain("[i_0]");
  });

  it("planAction: 'search' targets the text input; 'submit' targets the button", async () => {
    const actor = makeActor(PAGE_HTML);
    await actor.navigate("https://example.test/");
    const search = actor.planAction("search for laptops");
    expect(search.type).toBe("click");
    expect(search.elementIndex).toBe(0); // the #q input
    const submit = actor.planAction("submit the form");
    expect(submit.type).toBe("click");
    expect(submit.elementIndex).toBe(1); // the Go button
  });

  it("click/type act through the driver by element index and refresh the snapshot", async () => {
    const driver = new MockBrowserDriver({
      html: PAGE_HTML,
      clickable: { "#q": true, "#q2": true },
    });
    const actor = new BrowserActor(driver);
    await actor.navigate("https://example.test/");
    const r1 = await actor.execute({ type: "click", elementIndex: 0 });
    expect(r1.success).toBe(true);
    expect(driver.pagesCreated[0].clicks[0].selector).toBe("#q");
    const r2 = await actor.execute({ type: "type", elementIndex: 0, value: "hello" });
    expect(r2.success).toBe(true);
    expect(driver.pagesCreated[0].types[0]).toMatchObject({
      selector: "#q",
      text: "hello",
    });
    expect(actor.getHistory()).toHaveLength(2);
  });

  it("clicking a missing element fails without touching the driver", async () => {
    const driver = new MockBrowserDriver({ html: PAGE_HTML });
    const actor = new BrowserActor(driver);
    await actor.navigate("https://example.test/");
    const r = await actor.execute({ type: "click", elementIndex: 99 });
    expect(r.success).toBe(false);
    expect(r.error).toContain("99");
    expect(driver.pagesCreated[0].clicks).toHaveLength(0);
  });

  it("extract returns the snapshot; done answers; screenshot returns base64", async () => {
    const actor = makeActor(PAGE_HTML);
    await actor.navigate("https://example.test/");
    const ex = await actor.execute({ type: "extract" });
    expect(ex.success).toBe(true);
    expect(ex.snapshot?.elements.length).toBe(4);
    const dn = await actor.execute({ type: "done", answer: "42" });
    expect(dn.output).toBe("42");
    const ss = await actor.execute({ type: "screenshot" });
    expect(ss.success).toBe(true);
    expect(ss.screenshot).toBeTruthy();
    // mock screenshot decodes to the mock marker
    expect(Buffer.from(ss.screenshot!, "base64").toString()).toContain("mock-screenshot");
  });

  it("buildPageText renders the LLM-facing view", async () => {
    const actor = makeActor(PAGE_HTML);
    await actor.navigate("https://example.test/");
    const text = actor.buildPageText();
    expect(text).toContain("URL: https://example.test/");
    expect(text).toContain("[0] <input>");
    expect(text).toContain("[2] <a> Docs");
  });

  it("execute before navigate fails cleanly; close clears state", async () => {
    const driver = new MockBrowserDriver({ html: PAGE_HTML });
    const actor = new BrowserActor(driver);
    const r = await actor.execute({ type: "extract" });
    expect(r.success).toBe(false);
    await actor.navigate("https://example.test/");
    await actor.close();
    expect(actor.currentPage).toBeNull();
    expect(actor.currentSnapshot).toBeNull();
  });
});
