// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/video-transcript — Extract transcripts from video URLs and files.
 */

export interface VideoTranscriptSource {
  type: "youtube" | "file" | "url";
  label: string;
  requiresAuth: boolean;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface TranscriptResult {
  segments: TranscriptSegment[];
  fullText: string;
  title?: string;
  source: string;
}

// ── YouTube transcript fetch ─────────────────────────────────────────────────

async function fetchYouTubeTranscript(videoId: string): Promise<TranscriptResult> {
  if (!process.env.YOUTUBE_API_KEY) {
    throw new Error(
      "YouTube transcription is not configured. Set YOUTUBE_API_KEY environment variable to enable YouTube transcript extraction.",
    );
  }

  const { YoutubeTranscript } = await import("youtube-transcript");

  const segments = await YoutubeTranscript.fetchTranscript(videoId);

  return {
    segments: segments.map((s) => ({
      start: s.offset / 1000,
      end: (s.offset + s.duration) / 1000,
      text: s.text,
    })),
    fullText: segments.map((s) => s.text).join(" "),
    source: "youtube",
  };
}

function extractYouTubeId(url: string): string | null {
  // youtu.be/<id>
  const shortMatch = /youtu\.be\/([a-zA-Z0-9_-]{11})/.exec(url);
  if (shortMatch) return shortMatch[1] ?? null;

  // youtube.com/watch?v=<id>
  const longMatch = /[?&]v=([a-zA-Z0-9_-]{11})/.exec(url);
  if (longMatch) return longMatch[1] ?? null;

  return null;
}

// ── Stub handlers for file/URL sources ────────────────────────────────────────

async function fetchFileTranscript(): Promise<TranscriptResult> {
  const provider = process.env.SPEECH_TO_TEXT_PROVIDER;
  if (!provider) {
    throw new Error(
      "Speech-to-text is not configured. Set SPEECH_TO_TEXT_PROVIDER (e.g. 'whisper', 'deepgram', 'assemblyai') and the corresponding API key to enable transcription of uploaded files.",
    );
  }

  return {
    segments: [],
    fullText: "",
    source: "file",
    title: `Speech-to-text routing to "${provider}" provider. Configure fully to enable file transcription.`,
  };
}

async function fetchUrlTranscript(): Promise<TranscriptResult> {
  const provider = process.env.SPEECH_TO_TEXT_PROVIDER;
  if (!provider) {
    throw new Error(
      "Speech-to-text is not configured. Set SPEECH_TO_TEXT_PROVIDER (e.g. 'whisper', 'deepgram', 'assemblyai') and the corresponding API key to enable transcription of direct URLs.",
    );
  }

  return {
    segments: [],
    fullText: "",
    source: "url",
    title: `Speech-to-text routing to "${provider}" provider. Configure fully to enable URL transcription.`,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function fetchTranscript(
  source: string,
  url: string,
): Promise<TranscriptResult> {
  switch (source) {
    case "youtube": {
      const videoId = extractYouTubeId(url);
      if (!videoId) {
        throw new Error(`Could not extract YouTube video ID from URL: ${url}`);
      }
      return fetchYouTubeTranscript(videoId);
    }
    case "file":
      return fetchFileTranscript();
    case "url":
      return fetchUrlTranscript();
    default:
      throw new Error(
        `Unknown source type: "${source}". Must be one of: youtube, file, url`,
      );
  }
}

export function getAvailableSources(): VideoTranscriptSource[] {
  const hasYouTubeKey = Boolean(process.env.YOUTUBE_API_KEY);

  return [
    {
      type: "youtube",
      label: "YouTube",
      requiresAuth: !hasYouTubeKey,
    },
    {
      type: "file",
      label: "File Upload",
      requiresAuth: true,
    },
    {
      type: "url",
      label: "Direct URL",
      requiresAuth: true,
    },
  ];
}
