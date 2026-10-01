// SPDX-License-Identifier: Apache-2.0
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { apiFetch } from "~/lib/api";

/** Thumbs up or down on an answer; it lands in the account's RLHF feedback. */
export function RateAnswer(props: {
  sessionId: string;
  messageId: string;
  prompt: string;
  answer: string;
  model: string;
}) {
  const [rated, setRated] = useState<"thumbs_up" | "thumbs_down" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rate = (rating: "thumbs_up" | "thumbs_down") =>
    apiFetch("/api/v1/rlhf/feedback", {
      method: "POST",
      json: {
        sessionId: props.sessionId,
        messageId: props.messageId,
        promptText: props.prompt,
        responseText: props.answer,
        model: props.model,
        rating,
        source: "ui",
      },
    })
      .then(() => setRated(rating))
      .catch((e: Error) => setError(e.message));

  if (error) return <span className="text-xs text-destructive">{error}</span>;
  if (rated) return <span className="px-1 text-xs text-muted-foreground">Thanks for rating</span>;
  return (
    <span className="inline-flex items-center">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Good answer"
        title="Good answer"
        onClick={() => void rate("thumbs_up")}
      >
        <ThumbsUp />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Bad answer"
        title="Bad answer"
        onClick={() => void rate("thumbs_down")}
      >
        <ThumbsDown />
      </Button>
    </span>
  );
}
