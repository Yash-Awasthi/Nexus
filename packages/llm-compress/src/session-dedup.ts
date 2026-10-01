// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-turn dedup (after OmniRoute's session compression, github.com/diegosouzapw/OmniRoute,
 * MIT License, Copyright (c) 2026 diegosouzapw): within one session, a large tool output that is
 * byte-identical to an earlier one is sent as a pointer to it instead of again in full.
 */
import { createHash } from "node:crypto";

const tokens = (text: string) => Math.ceil(text.length / 4);

export class SessionDedup {
  private readonly firstSeen = new Map<string, string>();

  /** `minChars`: outputs shorter than this cost less than the pointer is worth. */
  constructor(private readonly minChars = 400) {}

  /**
   * `label` names this output for later pointers. `stillPresent(label, text)` says whether the
   * first copy is still in the history unchanged (compaction may drop it); if not, text repeats.
   */
  apply(
    label: string,
    text: string,
    stillPresent: (label: string, text: string) => boolean = () => true,
  ): { text: string; savedTokens: number } {
    if (text.length < this.minChars) return { text, savedTokens: 0 };
    const key = createHash("sha256").update(text).digest("hex");
    const first = this.firstSeen.get(key);
    if (!first || !stillPresent(first, text)) {
      this.firstSeen.set(key, label);
      return { text, savedTokens: 0 };
    }
    const note = `[identical to the output of ${first}; ${tokens(text)} tokens not repeated]`;
    return { text: note, savedTokens: tokens(text) - tokens(note) };
  }
}
