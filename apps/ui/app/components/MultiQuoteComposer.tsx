/**
 * Multi-Quote Comment Composer — Phase 1.9
 *
 * Accumulates multiple quoted text selections (with per-quote comments)
 * before composing a structured reply to the council.
 *
 * Inspired by:
 * - Telegram's quote-reply accumulation pattern
 * - Hypothesis (BSD, hypothesis/h) — web annotation with text selection + commenting
 * - Quill's (BSD, slab/quill) rich-text selection primitives
 *
 * Usage:
 *   1. User selects text anywhere in the chat → floating "Quote" button appears
 *   2. Click adds the selection to the quote stack with metadata (who said it)
 *   3. Composer shows accumulated quotes; user adds per-quote comments
 *   4. Optional master instruction in the main input
 *   5. Sends { quotes: QuoteEntry[], instruction: string } to /api/ask
 */

import { useState, useCallback } from "react";
import { X, Quote, Send } from "lucide-react";
import { Button } from "~/components/ui/button";

export interface QuoteEntry {
  id: string;
  quotedText: string;
  speaker: string;      // council member name or "You"
  comment: string;      // per-quote annotation
  selectedAt: string;   // ISO timestamp
}

export interface MultiQuotePayload {
  quotes: QuoteEntry[];
  instruction: string;
}

interface Props {
  /** Called when user sends the multi-quote payload */
  onSend: (payload: MultiQuotePayload) => void;
  /** Whether the composer is currently visible (has at least one quote) */
  visible?: boolean;
}

export function MultiQuoteComposer({ onSend }: Props) {
  const [quotes, setQuotes] = useState<QuoteEntry[]>([]);
  const [instruction, setInstruction] = useState("");

  /** Called from the parent when a text selection is confirmed */
  const addQuote = useCallback((quotedText: string, speaker: string) => {
    const entry: QuoteEntry = {
      id: crypto.randomUUID(),
      quotedText,
      speaker,
      comment: "",
      selectedAt: new Date().toISOString(),
    };
    setQuotes(prev => [...prev, entry]);
  }, []);

  const updateComment = (id: string, comment: string) => {
    setQuotes(prev => prev.map(q => q.id === id ? { ...q, comment } : q));
  };

  const removeQuote = (id: string) => {
    setQuotes(prev => prev.filter(q => q.id !== id));
  };

  const handleSend = () => {
    if (quotes.length === 0) return;
    onSend({ quotes, instruction });
    setQuotes([]);
    setInstruction("");
  };

  if (quotes.length === 0) return null;

  return (
    <div className="border border-border rounded-lg bg-muted/30 p-3 space-y-2 mb-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground font-medium">
        <Quote className="size-3" />
        {quotes.length} quote{quotes.length !== 1 ? "s" : ""} selected
      </div>

      {/* Quote stack */}
      <div className="space-y-2 max-h-64 overflow-y-auto">
        {quotes.map(q => (
          <div key={q.id} className="bg-background border border-border rounded-md p-2 space-y-1">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <span className="text-xs font-medium text-primary">{q.speaker}</span>
                <p className="text-xs text-muted-foreground italic line-clamp-2 mt-0.5">
                  &ldquo;{q.quotedText}&rdquo;
                </p>
              </div>
              <button
                onClick={() => removeQuote(q.id)}
                className="text-muted-foreground hover:text-destructive shrink-0 mt-0.5"
                aria-label="Remove quote"
              >
                <X className="size-3" />
              </button>
            </div>
            <input
              type="text"
              placeholder="Add your comment on this quote..."
              value={q.comment}
              onChange={e => updateComment(q.id, e.target.value)}
              className="w-full text-xs bg-muted/50 border border-border rounded px-2 py-1 outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        ))}
      </div>

      {/* Master instruction */}
      <input
        type="text"
        placeholder="Optional: master instruction (e.g. 'address these sequentially')"
        value={instruction}
        onChange={e => setInstruction(e.target.value)}
        className="w-full text-xs bg-background border border-border rounded px-2 py-1 outline-none focus:ring-1 focus:ring-ring"
      />

      <Button
        size="sm"
        onClick={handleSend}
        disabled={quotes.length === 0}
        className="w-full gap-1.5"
      >
        <Send className="size-3" />
        Send {quotes.length} quote{quotes.length !== 1 ? "s" : ""} to council
      </Button>
    </div>
  );
}

// ─── useTextSelection hook ────────────────────────────────────────────────────
// Detects user text selections within a container.
// Mirrors Hypothesis's text selection detection pattern.
export function useTextSelection(
  onSelect: (text: string, speaker: string) => void,
  speaker: string,
) {
  const handleMouseUp = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;

    const text = selection.toString().trim();
    if (text.length < 3) return; // ignore tiny selections

    onSelect(text, speaker);
    selection.removeAllRanges();
  }, [onSelect, speaker]);

  return { handleMouseUp };
}

export { MultiQuoteComposer as default };
