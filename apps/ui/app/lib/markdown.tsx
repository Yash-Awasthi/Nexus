// SPDX-License-Identifier: Apache-2.0
/**
 * The Markdown subset models write in replies: headings, lists, fenced code and inline
 * bold, italic and code. Rendered as React elements, so a reply can never inject markup.
 */
import type { ReactNode } from "react";

type Block =
  | { type: "heading"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; text: string }
  | { type: "paragraph"; text: string };

type Span = { type: "text" | "strong" | "em" | "code"; text: string };

const ITEM = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/;

export function markdownBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().startsWith("```")) {
      const body: string[] = [];
      while (++i < lines.length && !lines[i]!.trim().startsWith("```")) body.push(lines[i]!);
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", text: heading[1]!.trim() });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const ordered = !!item[2];
      const last = blocks.at(-1);
      if (last?.type === "list" && last.ordered === ordered) last.items.push(item[3]!);
      else blocks.push({ type: "list", ordered, items: [item[3]!] });
      continue;
    }
    if (!line.trim()) continue;
    const last = blocks.at(-1);
    // A paragraph runs until a blank line or another block.
    if (last?.type === "paragraph" && lines[i - 1]?.trim()) last.text += `\n${line}`;
    else blocks.push({ type: "paragraph", text: line });
  }
  return blocks;
}

export function markdownSpans(text: string): Span[] {
  const spans: Span[] = [];
  const re = /\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|`([^`]+)`/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) spans.push({ type: "text", text: text.slice(at, m.index) });
    if (m[1] ?? m[2]) spans.push({ type: "strong", text: (m[1] ?? m[2])! });
    else if (m[3] ?? m[4]) spans.push({ type: "em", text: (m[3] ?? m[4])! });
    else spans.push({ type: "code", text: m[5]! });
    at = m.index + m[0].length;
  }
  if (at < text.length) spans.push({ type: "text", text: text.slice(at) });
  return spans;
}

function Inline({ text }: { text: string }): ReactNode {
  return markdownSpans(text).map((s, i) =>
    s.type === "strong" ? (
      <strong key={i}>{s.text}</strong>
    ) : s.type === "em" ? (
      <em key={i}>{s.text}</em>
    ) : s.type === "code" ? (
      <code key={i} className="rounded bg-muted px-1 font-mono text-[0.9em]">
        {s.text}
      </code>
    ) : (
      s.text
    ),
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="space-y-2 break-words">
      {markdownBlocks(text).map((b, i) => {
        if (b.type === "heading")
          return (
            <p key={i} className="font-semibold">
              <Inline text={b.text} />
            </p>
          );
        if (b.type === "code")
          return (
            <pre key={i} className="overflow-x-auto rounded bg-muted p-2 font-mono text-xs">
              {b.text}
            </pre>
          );
        if (b.type === "list") {
          const List = b.ordered ? "ol" : "ul";
          return (
            <List key={i} className={`space-y-1 pl-5 ${b.ordered ? "list-decimal" : "list-disc"}`}>
              {b.items.map((item, j) => (
                <li key={j}>
                  <Inline text={item} />
                </li>
              ))}
            </List>
          );
        }
        return (
          <p key={i} className="whitespace-pre-wrap">
            <Inline text={b.text} />
          </p>
        );
      })}
    </div>
  );
}
