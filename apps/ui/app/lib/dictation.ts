// SPDX-License-Identifier: Apache-2.0
/**
 * Speech to text in the browser (Chrome, Edge and Safari have a recognizer;
 * Firefox does not). Chrome sends the audio to Google to transcribe it.
 */

interface Recognizer {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}

interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

function recognizerClass(): (new () => Recognizer) | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition) as (new () => Recognizer) | undefined;
}

export function dictationSupported(): boolean {
  return Boolean(recognizerClass());
}

/** Listen until a pause; each final phrase goes to `onText`. Returns a stop function, or null. */
export function startDictation(
  onText: (text: string) => void,
  onEnd: () => void,
): (() => void) | null {
  const Rec = recognizerClass();
  if (!Rec) return null;
  const rec = new Rec();
  rec.lang = typeof navigator !== "undefined" ? navigator.language : "en-US";
  rec.interimResults = false;
  rec.continuous = false;
  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]!;
      const text = r[0]?.transcript.trim();
      if (r.isFinal && text) onText(text);
    }
  };
  rec.onend = onEnd;
  rec.onerror = onEnd;
  rec.start();
  return () => rec.stop();
}
