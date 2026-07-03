// SPDX-License-Identifier: Apache-2.0
/**
 * Video Transcript routes — extract transcripts from video URLs or uploads.
 *
 * GET  /video/transcript/sources  — list available video sources
 * POST /video/transcript          — extract transcript from a video URL
 */

import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const SUPPORTED_SOURCES = [
  {
    id: "youtube",
    name: "YouTube",
    supported: Boolean(process.env.YOUTUBE_API_KEY),
    urlPattern: "youtube.com/watch?v=*|youtu.be/*",
  },
  {
    id: "file",
    name: "File Upload",
    supported: true,
    urlPattern: undefined,
  },
  {
    id: "url",
    name: "Direct URL",
    supported: true,
    urlPattern: undefined,
  },
];

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function videoTranscriptRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /video/transcript/sources
   *
   * Returns the list of supported video sources with their availability status.
   */
  app.get(
    "/video/transcript/sources",
    {
      preHandler: requireAuth,
    },
    async (_req, reply) => {
      return reply.send({ sources: SUPPORTED_SOURCES });
    },
  );

  /**
   * POST /video/transcript
   *
   * Extract a transcript from a video URL or file upload.
   *
   * Body:
   *   source  — "youtube" | "file" | "url" (required)
   *   url     — video URL (required for youtube and url sources)
   *   base64  — base64-encoded file data (used by file source)
   */
  app.post(
    "/video/transcript",
    {
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const { source, url, base64 } = request.body as {
        source?: string;
        url?: string;
        base64?: string;
      };

      // Validate source
      if (!source || !["youtube", "file", "url"].includes(source)) {
        return reply.code(400).send({
          error: "invalid_source",
          message: 'source is required and must be one of: "youtube", "file", "url"',
        });
      }

      // Validate required params per source type
      if (source === "youtube" || source === "url") {
        if (!url) {
          return reply.code(400).send({
            error: "missing_url",
            message: "url is required for this source type",
          });
        }
      }

      if (source === "file" && !base64) {
        return reply.code(400).send({
          error: "missing_file",
          message: "base64 file data is required for file source",
        });
      }

      // Route to appropriate handler
      switch (source) {
        case "youtube": {
          if (!process.env.YOUTUBE_API_KEY) {
            return reply.code(503).send({
              error: "service_unavailable",
              message:
                "YouTube transcription is not configured. Set YOUTUBE_API_KEY to enable YouTube transcript extraction.",
            });
          }
          // Placeholder: real implementation uses youtube-transcript + fetch
          return reply.send({
            segments: [],
            fullText: "",
            title: undefined,
            note: "YouTube transcript extraction requires YOUTUBE_API_KEY. Once configured, transcripts will be fetched via youtube-transcript API.",
          });
        }

        case "file":
        case "url": {
          const provider = process.env.SPEECH_TO_TEXT_PROVIDER;
          if (!provider) {
            return reply.code(503).send({
              error: "service_unavailable",
              message:
                "Speech-to-text is not configured. Set SPEECH_TO_TEXT_PROVIDER (e.g. 'whisper', 'deepgram', 'assemblyai') and the corresponding API key to enable transcription of uploaded files and direct URLs.",
            });
          }
          // Placeholder: real implementation delegates to speech-to-text provider
          return reply.send({
            segments: [],
            fullText: "",
            title: undefined,
            note: `Speech-to-text routing to "${provider}" provider. Transcription will be processed upon full integration.`,
          });
        }

        default:
          return reply.code(400).send({
            error: "invalid_source",
            message: `Unknown source type: ${source}`,
          });
      }
    },
  );
}
