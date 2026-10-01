// SPDX-License-Identifier: Apache-2.0
import { BookOpen, Braces, FileText, Globe, X } from "lucide-react";

export type MentionType = "file" | "symbol" | "web" | "kb";

const ICON = { file: FileText, symbol: Braces, web: Globe, kb: BookOpen } as const;

export function ContextPill({
  type,
  label,
  value,
  onRemove,
}: {
  type: MentionType;
  label: string;
  value: string;
  onRemove: () => void;
}) {
  const Icon = ICON[type];
  return (
    <span
      title={value}
      className="inline-flex max-w-52 items-center gap-1 rounded-md border bg-muted px-1.5 py-0.5 text-xs"
    >
      <Icon className="size-3 shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        className="rounded text-muted-foreground hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}
