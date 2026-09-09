// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/browser-automation — browser-use style actor model for AI agents,
 * running on @nexus/stealth-browser drivers.
 *
 * The previous implementation of this package was a no-op shell ("in
 * production, this would use CDP"); it now composes the two capabilities the
 * absorption campaign verified elsewhere:
 *
 *   • the browser-use actor loop (inspiration/Nexus/browser-use): perceive →
 *     plan → act, with the agent acting through numbered interactive elements
 *     instead of raw selectors;
 *   • @nexus/stealth-browser's BrowserDriver abstraction (MockDriver in
 *     tests, PatchrightDriver in production — see that package).
 *
 * DOM snapshot format follows browser-use's serializer convention
 * (dom/serializer/eval_serializer.py): compact tree, `[i_N]` selector-indices
 * on interactive elements only, inline text for leaf elements, SVG skipped.
 *
 * Ported from the replaced stub and kept behavioral: buildPageText() and the
 * planAction() heuristics (search-input / submit-button / scroll /
 * screenshot / extract keyword matching).
 */

import type { BrowserDriver, BrowserPage, StealthProfile } from "@nexus/stealth-browser";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ActorElement {
  /** The `[i_N]` index the agent uses to reference this element. */
  index: number;
  tagName: string;
  text: string;
  attributes: Record<string, string>;
  isInteractive: boolean;
  /** Unique selector used to act on the element through the driver. */
  selector: string;
  rect: { x: number; y: number; width: number; height: number };
}

export interface DomSnapshot {
  url: string;
  title: string;
  /** Interactive elements with browser-use-style `[i_N]` indices. */
  elements: ActorElement[];
  /** Compact serialized DOM (browser-use eval_serializer convention). */
  text: string;
}

export interface ActorAction {
  type: "click" | "type" | "select" | "scroll" | "navigate" | "screenshot" | "extract" | "done";
  /** `[i_N]` index of the target element (click/type/select). */
  elementIndex?: number;
  value?: string;
  url?: string;
  /** Set by the agent when type === "done". */
  answer?: string;
}

export interface ActionResult {
  success: boolean;
  output?: string;
  error?: string;
  /** Base64 PNG/JPEG, when action.type === "screenshot". */
  screenshot?: string;
  /** Populated when action.type === "extract". */
  snapshot?: DomSnapshot;
}

// ── Snapshot extraction ──────────────────────────────────────────────────────

/** Max text length for a single element's inline text. */
const MAX_ELEMENT_TEXT = 80;
/** Tags whose entire subtree is skipped (browser-use SVG_ELEMENTS). */
const SKIP_TAGS = new Set([
  "svg",
  "path",
  "rect",
  "circle",
  "g",
  "polygon",
  "polyline",
  "ellipse",
  "line",
  "defs",
  "use",
  "symbol",
  "clippath",
  "mask",
  "pattern",
]);
/** Interactive tags + attribute signals (browser-use clickable_elements). */
const INTERACTIVE_TAGS = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "label",
  "option",
  "details",
  "audio",
  "video",
]);
const INTERACTIVE_ATTRS = new Set([
  "onclick",
  "onmousedown",
  "onmouseup",
  "onkeydown",
  "onkeyup",
  "tabindex",
]);

export interface RawNode {
  tag: string;
  attributes: Record<string, string>;
  text: string;
  children: RawNode[];
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    attrs[m[1].toLowerCase()] = (m[2] ?? m[3] ?? "").trim();
  }
  return attrs;
}

/** Minimal HTML → tree parser sufficient for snapshot serialization. */
export function parseHtml(html: string): RawNode {
  const root: RawNode = { tag: "#document", attributes: {}, text: "", children: [] };
  const stack: RawNode[] = [root];
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)>/g;
  const SKIP_INNER = new Set(["script", "style", "noscript"]);
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const [full, tagLower, attrStr] = m;
    const tag = tagLower.toLowerCase();
    const preceding = html.slice(lastIndex, m.index);
    if (preceding) {
      const top = stack[stack.length - 1];
      const text = preceding
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim();
      if (text) top.text += (top.text ? " " : "") + text;
    }
    lastIndex = m.index + full.length;
    if (full.startsWith("</")) {
      // Pop to the matching open tag (best effort on malformed HTML).
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    if (SKIP_INNER.has(tag)) {
      // Skip the entire inner content of script/style blocks.
      const closeIdx = html.toLowerCase().indexOf(`</${tag}`, lastIndex);
      if (closeIdx >= 0) {
        lastIndex = closeIdx;
        tagRe.lastIndex = closeIdx;
      }
      continue;
    }
    const node: RawNode = {
      tag,
      attributes: parseAttrs(attrStr ?? ""),
      text: "",
      children: [],
    };
    stack[stack.length - 1].children.push(node);
    if (!full.endsWith("/>") && !VOID_TAGS.has(tag)) stack.push(node);
  }
  return root;
}

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function isInteractive(node: RawNode): boolean {
  if (INTERACTIVE_TAGS.has(node.tag)) return true;
  if (node.attributes.role === "button" || node.attributes.role === "link") return true;
  for (const a of INTERACTIVE_ATTRS) if (a in node.attributes) return true;
  return false;
}

function buildSelector(node: RawNode): string {
  const id = node.attributes.id;
  if (id) return `#${id}`;
  const name = node.attributes.name;
  if (name) return `${node.tag}[name="${name}"]`;
  const aria = node.attributes["aria-label"];
  if (aria) return `${node.tag}[aria-label="${aria}"]`;
  const placeholder = node.attributes.placeholder;
  if (placeholder) return `${node.tag}[placeholder="${placeholder}"]`;
  const text = node.text.trim();
  if (text) return `${node.tag}:has-text("${text.slice(0, 40)}")`;
  return node.tag;
}

/**
 * Serialize a DOM snapshot browser-use style (single pass so `[i_N]` indices
 * and the collected ActorElements stay consistent): compact indented tree,
 * `[i_N]` marks on interactive elements only, inline leaf text, SVG skipped.
 * Elements are appended to `elements` in document order as they are numbered.
 */
export function serializeDom(node: RawNode, elements: ActorElement[], depth = 0): string {
  const lines: string[] = [];
  const indent = "  ".repeat(depth);
  for (const child of node.children) {
    if (SKIP_TAGS.has(child.tag)) continue;
    let line = indent;
    if (isInteractive(child)) {
      line += `[i_${elements.length}] `;
      elements.push(toActorElement(child, elements.length));
    }
    const attrs = Object.entries(child.attributes)
      .map(([k, v]) => (v ? `${k}="${v.slice(0, 40)}"` : k))
      .slice(0, 4)
      .join(" ");
    line += `<${child.tag}`;
    if (attrs) line += ` ${attrs}`;
    const inlineText = child.text.trim().slice(0, MAX_ELEMENT_TEXT);
    if (inlineText && child.children.length === 0) {
      line += `>${inlineText}`;
    } else {
      line += " />";
    }
    lines.push(line);
    if (child.children.length) {
      const block = serializeDom(child, elements, depth + 1);
      if (block) lines.push(block);
    }
  }
  return lines.filter(Boolean).join("\n");
}

function toActorElement(node: RawNode, index: number): ActorElement {
  return {
    index,
    tagName: node.tag,
    text: node.text.trim().slice(0, MAX_ELEMENT_TEXT),
    attributes: node.attributes,
    isInteractive: true,
    selector: buildSelector(node),
    rect: { x: 0, y: 0, width: 0, height: 0 }, // geometry requires a live CDP query
  };
}

// ── Actor ────────────────────────────────────────────────────────────────────

export interface BrowserActorOptions {
  profile?: StealthProfile;
}

/**
 * Actor loop over a stealth-browser page: perceive (DOM snapshot with
 * numbered elements) → plan → act. Mirrors browser-use's actor model where
 * the LLM references elements by index, never by raw selector.
 */
export class BrowserActor {
  private page: BrowserPage | null = null;
  private snapshot: DomSnapshot | null = null;
  private history: Array<{ action: ActorAction; result: ActionResult; timestamp: number }> = [];

  constructor(
    private readonly driver: BrowserDriver,
    private readonly options: BrowserActorOptions = {},
  ) {}

  /** Currently open page (null until navigate()). */
  get currentPage(): BrowserPage | null {
    return this.page;
  }

  /** Latest DOM snapshot. */
  get currentSnapshot(): DomSnapshot | null {
    return this.snapshot;
  }

  /** Action history (chronological). */
  getHistory(): Array<{ action: ActorAction; result: ActionResult; timestamp: number }> {
    return [...this.history];
  }

  /** Open a page (optionally with a stealth profile) and return its snapshot. */
  async navigate(url: string): Promise<DomSnapshot> {
    if (!this.page || this.page.isClosed) {
      this.page = await this.driver.newPage(this.options.profile);
    }
    await this.page.navigate(url);
    this.snapshot = await this.buildSnapshot();
    return this.snapshot;
  }

  /**
   * Perceive: extract interactive elements and serialize the DOM
   * (browser-use eval_serializer format).
   */
  async buildSnapshot(): Promise<DomSnapshot> {
    if (!this.page) throw new Error("no page open — call navigate() first");
    const html = await this.page.content();
    const title = await this.page.title();
    const tree = parseHtml(html);
    const elements: ActorElement[] = [];
    const text = serializeDom(tree, elements).trim();
    this.snapshot = { url: this.page.url, title, elements, text };
    return this.snapshot;
  }

  /** Execute one actor action against the current page. */
  async execute(action: ActorAction): Promise<ActionResult> {
    if (!this.page) return { success: false, error: "no page open — call navigate() first" };
    let result: ActionResult;
    switch (action.type) {
      case "click":
        result = await this.click(action.elementIndex);
        break;
      case "type":
        result = await this.type(action.elementIndex, action.value ?? "");
        break;
      case "select":
        result = await this.select(action.elementIndex, action.value ?? "");
        break;
      case "scroll":
        result = await this.scroll(action.value ?? "down");
        break;
      case "navigate":
        result = { success: true, output: `Navigated to ${action.url}` };
        if (action.url) await this.navigate(action.url);
        break;
      case "screenshot":
        result = await this.screenshot();
        break;
      case "extract":
        result = {
          success: true,
          output: this.snapshot?.text ?? (await this.buildSnapshot()).text,
          snapshot: this.snapshot ?? undefined,
        };
        break;
      case "done":
        result = { success: true, output: action.answer ?? "" };
        break;
      default:
        result = { success: false, error: `Unknown action: ${(action as ActorAction).type}` };
    }
    this.history.push({ action, result, timestamp: Date.now() });
    return result;
  }

  // ── Ported stub heuristics (kept behavioral) ────────────────────────────────

  /**
   * Heuristic planner from the replaced stub: keyword-matches the goal against
   * the current snapshot. Real deployments replace this with an LLM call.
   */
  planAction(goal: string): ActorAction {
    const snapshot = this.snapshot;
    if (!snapshot) return { type: "extract" };
    const lowerGoal = goal.toLowerCase();
    const interactive = snapshot.elements.filter((e) => e.isInteractive);

    if (lowerGoal.includes("search")) {
      const searchInput = interactive.find(
        (e) => e.tagName === "input" && (e.attributes.type ?? "text") === "text",
      );
      if (searchInput) return { type: "click", elementIndex: searchInput.index };
    }

    if (lowerGoal.includes("submit") || lowerGoal.includes("enter")) {
      const submitBtn = interactive.find(
        (e) => e.tagName === "button" || e.attributes.type === "submit",
      );
      if (submitBtn) return { type: "click", elementIndex: submitBtn.index };
    }

    if (lowerGoal.includes("scroll")) {
      return { type: "scroll", value: lowerGoal.includes("up") ? "up" : "down" };
    }

    if (lowerGoal.includes("screenshot") || lowerGoal.includes("capture")) {
      return { type: "screenshot" };
    }

    return { type: "extract" };
  }

  /** Text view for LLM consumption (stub's buildPageText, on real snapshots). */
  buildPageText(): string {
    const s = this.snapshot;
    if (!s) return "";
    const lines: string[] = [`URL: ${s.url}`, `Elements: ${s.elements.length}`];
    for (const el of s.elements) {
      if (el.isInteractive) {
        const text = el.text.slice(0, 50) || el.attributes["aria-label"] || el.tagName;
        lines.push(`[${el.index}] <${el.tagName}> ${text}`);
      }
    }
    return lines.join("\n");
  }

  /** Close the underlying page (the driver outlives the actor). */
  async close(): Promise<void> {
    if (this.page && !this.page.isClosed) await this.page.close();
    this.page = null;
    this.snapshot = null;
  }

  // ── Action impls ─────────────────────────────────────────────────────────────

  private elementByIndex(index: number | undefined): ActorElement | null {
    if (index === undefined || !this.snapshot) return null;
    return this.snapshot.elements.find((e) => e.index === index) ?? null;
  }

  private async click(index: number | undefined): Promise<ActionResult> {
    const el = this.elementByIndex(index);
    if (!el) return { success: false, error: `Element ${index} not found` };
    if (!el.isInteractive) return { success: false, error: `Element ${index} is not interactive` };
    await this.page!.click(el.selector);
    this.snapshot = await this.buildSnapshot();
    return {
      success: true,
      output: `Clicked [i_${el.index}] <${el.tagName}> "${el.text.slice(0, 50)}"`,
    };
  }

  private async type(index: number | undefined, value: string): Promise<ActionResult> {
    const el = this.elementByIndex(index);
    if (!el) return { success: false, error: `Element ${index} not found` };
    await this.page!.type(el.selector, value);
    this.snapshot = await this.buildSnapshot();
    return { success: true, output: `Typed "${value}" into [i_${el.index}] <${el.tagName}>` };
  }

  private async select(index: number | undefined, value: string): Promise<ActionResult> {
    const el = this.elementByIndex(index);
    if (!el) return { success: false, error: `Element ${index} not found` };
    await this.page!.click(el.selector);
    this.snapshot = await this.buildSnapshot();
    return { success: true, output: `Selected "${value}" in [i_${el.index}] <${el.tagName}>` };
  }

  private async scroll(direction: string): Promise<ActionResult> {
    // Scroll via a string expression — the BrowserPage.evaluate contract has
    // no arg parameter, and a TS closure's captured variables do not exist
    // browser-side. Scrollable pixels are page-dependent.
    const dir = direction === "up" ? -500 : 500;
    await this.page!.evaluate<string>(`window.scrollBy(0, ${dir}); true`);
    return { success: true, output: `Scrolled ${direction} by 500px` };
  }

  private async screenshot(): Promise<ActionResult> {
    const buf = await this.page!.screenshot({ format: "png" });
    return {
      success: true,
      output: "Screenshot captured",
      screenshot: buf.toString("base64"),
    };
  }
}
