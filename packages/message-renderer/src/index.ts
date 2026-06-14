// SPDX-License-Identifier: Apache-2.0
/**
 * message-renderer — Platform-specific message rendering adapters.
 *
 * Converts a normalised MessagePayload into platform-native formatted strings.
 *
 * Provides:
 *   • MessagePayload      — platform-agnostic message structure
 *   • DiscordRenderer     — Discord markdown (bold/italic/code/embeds/tables)
 *   • TelegramRenderer    — Telegram MarkdownV2 (escaped special chars)
 *   • HtmlRenderer        — Safe HTML (no DOM, pure string)
 *   • RendererRegistry    — named renderer registry + dispatch
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type Platform = "discord" | "telegram" | "html" | "plain";

export interface MessageField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface MessageEmbed {
  title?: string;
  description?: string;
  color?: string; // hex like "#5865F2" or name
  fields?: MessageField[];
  footer?: string;
  url?: string;
  thumbnail?: string;
}

export interface MessagePayload {
  text?: string;
  embeds?: MessageEmbed[];
  /** Markdown-formatted table rows */
  table?: { headers: string[]; rows: string[][] };
  code?: { language?: string; content: string };
  /** Inline attachments/file names for reference */
  attachments?: string[];
}

export interface RenderResult {
  platform: Platform;
  output: string;
  truncated: boolean;
}

// ── Escape utils ──────────────────────────────────────────────────────────────

/** Escape Telegram MarkdownV2 special characters. */
function escapeTelegram(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\\$])/g, "\\$1");
}

/** Escape HTML entities. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** Convert generic markdown bold/italic/code to Discord-native. */
function markdownToDiscord(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "**$1**")
    .replace(/\*(.+?)\*/g, "*$1*")
    .replace(/`(.+?)`/g, "`$1`");
}

// ── Table renderer ────────────────────────────────────────────────────────────

function renderMarkdownTable(headers: string[], rows: string[][]): string {
  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length))
  );
  const header = "| " + headers.map((h, i) => h.padEnd(colWidths[i]!)).join(" | ") + " |";
  const divider = "|-" + colWidths.map((w) => "-".repeat(w)).join("-|-") + "-|";
  const body = rows.map(
    (row) => "| " + row.map((cell, i) => (cell ?? "").padEnd(colWidths[i]!)).join(" | ") + " |"
  );
  return [header, divider, ...body].join("\n");
}

function renderHtmlTable(headers: string[], rows: string[][]): string {
  const ths = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const trs = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("\n");
  return `<table><thead><tr>${ths}</tr></thead><tbody>\n${trs}\n</tbody></table>`;
}

// ── DiscordRenderer ───────────────────────────────────────────────────────────

export class DiscordRenderer {
  readonly platform: Platform = "discord";
  private maxLength: number;

  constructor(opts: { maxLength?: number } = {}) {
    this.maxLength = opts.maxLength ?? 2000;
  }

  render(payload: MessagePayload): RenderResult {
    const parts: string[] = [];

    if (payload.text) parts.push(markdownToDiscord(payload.text));

    if (payload.code) {
      const lang = payload.code.language ?? "";
      parts.push(`\`\`\`${lang}\n${payload.code.content}\n\`\`\``);
    }

    if (payload.table) {
      parts.push(renderMarkdownTable(payload.table.headers, payload.table.rows));
    }

    for (const embed of payload.embeds ?? []) {
      if (embed.title) parts.push(`**${embed.title}**`);
      if (embed.description) parts.push(embed.description);
      for (const f of embed.fields ?? []) {
        parts.push(`**${f.name}**: ${f.value}${f.inline ? " (inline)" : ""}`);
      }
      if (embed.footer) parts.push(`_${embed.footer}_`);
    }

    if (payload.attachments?.length) {
      parts.push(`📎 ${payload.attachments.join(", ")}`);
    }

    const full = parts.join("\n\n");
    const truncated = full.length > this.maxLength;
    return { platform: "discord", output: truncated ? full.slice(0, this.maxLength - 3) + "..." : full, truncated };
  }
}

// ── TelegramRenderer ──────────────────────────────────────────────────────────

export class TelegramRenderer {
  readonly platform: Platform = "telegram";
  private maxLength: number;
  private parseMode: "MarkdownV2" | "HTML";

  constructor(opts: { maxLength?: number; parseMode?: "MarkdownV2" | "HTML" } = {}) {
    this.maxLength = opts.maxLength ?? 4096;
    this.parseMode = opts.parseMode ?? "MarkdownV2";
  }

  render(payload: MessagePayload): RenderResult {
    const parts: string[] = [];

    if (this.parseMode === "HTML") {
      return this._renderHtmlMode(payload);
    }

    // MarkdownV2 mode
    if (payload.text) {
      parts.push(escapeTelegram(payload.text));
    }

    if (payload.code) {
      const lang = payload.code.language ?? "";
      parts.push(`\`\`\`${escapeTelegram(lang)}\n${escapeTelegram(payload.code.content)}\n\`\`\``);
    }

    if (payload.table) {
      // Telegram doesn't support tables — render as code block
      const table = renderMarkdownTable(payload.table.headers, payload.table.rows);
      parts.push(`\`\`\`\n${table}\n\`\`\``);
    }

    for (const embed of payload.embeds ?? []) {
      if (embed.title) parts.push(`*${escapeTelegram(embed.title)}*`);
      if (embed.description) parts.push(escapeTelegram(embed.description));
      for (const f of embed.fields ?? []) {
        parts.push(`*${escapeTelegram(f.name)}*: ${escapeTelegram(f.value)}`);
      }
      if (embed.footer) parts.push(`_${escapeTelegram(embed.footer)}_`);
    }

    if (payload.attachments?.length) {
      parts.push(escapeTelegram(`📎 ${payload.attachments.join(", ")}`));
    }

    const full = parts.join("\n\n");
    const truncated = full.length > this.maxLength;
    return { platform: "telegram", output: truncated ? full.slice(0, this.maxLength - 3) + "\\.\\.\\." : full, truncated };
  }

  private _renderHtmlMode(payload: MessagePayload): RenderResult {
    const parts: string[] = [];
    if (payload.text) parts.push(escapeHtml(payload.text));
    if (payload.code) {
      parts.push(`<pre><code>${escapeHtml(payload.code.content)}</code></pre>`);
    }
    for (const embed of payload.embeds ?? []) {
      if (embed.title) parts.push(`<b>${escapeHtml(embed.title)}</b>`);
      if (embed.description) parts.push(escapeHtml(embed.description));
    }
    const full = parts.join("\n");
    const truncated = full.length > this.maxLength;
    return { platform: "telegram", output: truncated ? full.slice(0, this.maxLength) : full, truncated };
  }
}

// ── HtmlRenderer ──────────────────────────────────────────────────────────────

export class HtmlRenderer {
  readonly platform: Platform = "html";
  private maxLength: number;
  private wrapBody: boolean;

  constructor(opts: { maxLength?: number; wrapBody?: boolean } = {}) {
    this.maxLength = opts.maxLength ?? 100_000;
    this.wrapBody = opts.wrapBody ?? false;
  }

  render(payload: MessagePayload): RenderResult {
    const parts: string[] = [];

    if (payload.text) {
      const html = escapeHtml(payload.text)
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*(.+?)\*/g, "<em>$1</em>")
        .replace(/`(.+?)`/g, "<code>$1</code>")
        .replace(/\n/g, "<br>");
      parts.push(`<p>${html}</p>`);
    }

    if (payload.code) {
      const lang = payload.code.language ? ` class="language-${escapeHtml(payload.code.language)}"` : "";
      parts.push(`<pre><code${lang}>${escapeHtml(payload.code.content)}</code></pre>`);
    }

    if (payload.table) {
      parts.push(renderHtmlTable(payload.table.headers, payload.table.rows));
    }

    for (const embed of payload.embeds ?? []) {
      const colorStyle = embed.color ? ` style="border-left: 4px solid ${escapeHtml(embed.color)}"` : "";
      const inner: string[] = [];
      if (embed.title) {
        const titleHtml = embed.url
          ? `<a href="${escapeHtml(embed.url)}">${escapeHtml(embed.title)}</a>`
          : escapeHtml(embed.title);
        inner.push(`<h3>${titleHtml}</h3>`);
      }
      if (embed.description) inner.push(`<p>${escapeHtml(embed.description)}</p>`);
      if (embed.fields?.length) {
        const fields = embed.fields.map(
          (f) => `<div class="field${f.inline ? " inline" : ""}"><strong>${escapeHtml(f.name)}</strong>: ${escapeHtml(f.value)}</div>`
        ).join("\n");
        inner.push(fields);
      }
      if (embed.footer) inner.push(`<footer><small>${escapeHtml(embed.footer)}</small></footer>`);
      parts.push(`<div class="embed"${colorStyle}>\n${inner.join("\n")}\n</div>`);
    }

    if (payload.attachments?.length) {
      const links = payload.attachments.map((a) => `<span class="attachment">${escapeHtml(a)}</span>`).join(", ");
      parts.push(`<div class="attachments">📎 ${links}</div>`);
    }

    let full = parts.join("\n");
    if (this.wrapBody) full = `<div class="message">\n${full}\n</div>`;

    const truncated = full.length > this.maxLength;
    return { platform: "html", output: truncated ? full.slice(0, this.maxLength) : full, truncated };
  }
}

// ── PlainRenderer ─────────────────────────────────────────────────────────────

export class PlainRenderer {
  readonly platform: Platform = "plain";

  render(payload: MessagePayload): RenderResult {
    const parts: string[] = [];
    if (payload.text) parts.push(payload.text.replace(/\*\*/g, "").replace(/\*/g, ""));
    if (payload.code) parts.push(payload.code.content);
    if (payload.table) {
      parts.push(renderMarkdownTable(payload.table.headers, payload.table.rows));
    }
    for (const embed of payload.embeds ?? []) {
      if (embed.title) parts.push(`[${embed.title}]`);
      if (embed.description) parts.push(embed.description);
      for (const f of embed.fields ?? []) parts.push(`${f.name}: ${f.value}`);
      if (embed.footer) parts.push(embed.footer);
    }
    if (payload.attachments?.length) parts.push(`Attachments: ${payload.attachments.join(", ")}`);
    return { platform: "plain", output: parts.join("\n\n"), truncated: false };
  }
}

// ── RendererRegistry ──────────────────────────────────────────────────────────

export interface IRenderer {
  platform: Platform;
  render(payload: MessagePayload): RenderResult;
}

export class RendererRegistry {
  private renderers = new Map<Platform, IRenderer>();

  register(renderer: IRenderer): this {
    this.renderers.set(renderer.platform, renderer);
    return this;
  }

  get(platform: Platform): IRenderer | undefined {
    return this.renderers.get(platform);
  }

  render(platform: Platform, payload: MessagePayload): RenderResult {
    const r = this.renderers.get(platform);
    if (!r) throw new Error(`No renderer registered for platform: ${platform}`);
    return r.render(payload);
  }

  platforms(): Platform[] {
    return [...this.renderers.keys()];
  }

  /** Render to all registered platforms. */
  renderAll(payload: MessagePayload): Map<Platform, RenderResult> {
    const results = new Map<Platform, RenderResult>();
    for (const [platform, renderer] of this.renderers) {
      results.set(platform, renderer.render(payload));
    }
    return results;
  }

  static createDefault(): RendererRegistry {
    return new RendererRegistry()
      .register(new DiscordRenderer())
      .register(new TelegramRenderer())
      .register(new HtmlRenderer())
      .register(new PlainRenderer());
  }
}
