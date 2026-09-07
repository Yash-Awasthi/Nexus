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

      // Validate source — infer it from the payload when omitted so the
      // frontend's `{ url }` / `{ base64 }` shape (video-transcript.tsx) works.
      // YouTube links are inferred from the URL itself, not just the field.
      const inferredSource =
        source ??
        (base64
          ? "file"
          : url && (url.includes("youtube.com") || url.includes("youtu.be"))
            ? "youtube"
            : url
              ? "url"
              : undefined);
      if (!inferredSource || !["youtube", "file", "url"].includes(inferredSource)) {
        return reply.code(400).send({
          error: "invalid_source",
          message: 'source is required and must be one of: "youtube", "file", "url"',
        });
      }

      // Validate required params per source type
      if (inferredSource === "youtube" || inferredSource === "url") {
        if (!url) {
          return reply.code(400).send({
            error: "missing_url",
            message: "url is required for this source type",
          });
        }
      }

      if (inferredSource === "file" && !base64) {
        return reply.code(400).send({
          error: "missing_file",
          message: "base64 file data is required for file source",
        });
      }

      // Route to appropriate handler
      switch (inferredSource) {
        case "youtube": {
          // YouTube transcripts are publicly available — no API key needed
          // Extract video ID from URL
          const videoId = extractYouTubeId(url!);
          if (!videoId) {
            return reply.code(400).send({
              error: "invalid_url",
              message: "Could not extract YouTube video ID from URL",
            });
          }

          try {
            // Fetch YouTube page to extract transcript data
            const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
            const pageRes = await fetch(pageUrl, {
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
                "Accept-Language": "en-US,en;q=0.9",
              },
            });

            if (!pageRes.ok) {
              return reply.code(502).send({
                error: "fetch_failed",
                message: `YouTube returned status ${pageRes.status}`,
              });
            }

            const html = await pageRes.text();

            // Extract title from page
            const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
            const title = titleMatch?.[1]?.replace(/ - YouTube$/, "").trim();

            // Extract captions URL from ytInitialPlayerResponse
            const captionsMatch = html.match(/"captions":\{"playerCaptionsTracklistRenderer":\{"captionTracks":(\[.*?\])/);
            if (!captionsMatch) {
              return reply.send({
                segments: [],
                fullText: "",
                title,
                note: "No captions available for this video. The video may not have subtitles enabled.",
              });
            }

            const captionTracks = JSON.parse(captionsMatch[1]!) as Array<{
              languageCode: string;
              baseUrl: string;
              name?: { simpleText?: string };
            }>;

            // Prefer English, fall back to first available
            const track =
              captionTracks.find((t) => t.languageCode.startsWith("en")) ??
              captionTracks[0];

            if (!track?.baseUrl) {
              return reply.send({
                segments: [],
                fullText: "",
                title,
                note: "No caption tracks found.",
              });
            }

            // Fetch the caption XML
            const captionRes = await fetch(track.baseUrl);
            if (!captionRes.ok) {
              return reply.code(502).send({
                error: "caption_fetch_failed",
                message: `Caption fetch returned ${captionRes.status}`,
              });
            }

            const captionXml = await captionRes.text();

            // Parse XML captions into segments
            const segments = parseYouTubeCaptionXml(captionXml);
            const fullText = segments.map((s) => s.text).join(" ");

            return reply.send({
              segments,
              fullText,
              title,
              videoId,
              language: track.languageCode,
              note: "YouTube transcript extracted successfully.",
            });
          } catch (err) {
            app.log.error({ err, videoId }, "YouTube transcript extraction failed");
            return reply.code(500).send({
              error: "extraction_failed",
              message: err instanceof Error ? err.message : String(err),
            });
          }
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

          // Route to speech-to-text provider
          try {
            let audioBuffer: Buffer;

            if (source === "file" && base64) {
              audioBuffer = Buffer.from(base64, "base64");
            } else if (source === "url" && url) {
              const audioRes = await fetch(url);
              if (!audioRes.ok) {
                return reply.code(502).send({
                  error: "audio_fetch_failed",
                  message: `Audio fetch returned ${audioRes.status}`,
                });
              }
              audioBuffer = Buffer.from(await audioRes.arrayBuffer());
            } else {
              return reply.code(400).send({ error: "invalid_params" });
            }

            // Route to provider
            if (provider === "whisper" || provider === "openai") {
              const apiKey = process.env.OPENAI_API_KEY;
              if (!apiKey) {
                return reply.code(503).send({
                  error: "missing_api_key",
                  message: "OPENAI_API_KEY is required for Whisper transcription",
                });
              }

              const formData = new FormData();
              formData.append("file", new Blob([audioBuffer], { type: "audio/webm" }), "audio.webm");
              formData.append("model", "whisper-1");

              const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
                method: "POST",
                headers: { Authorization: `Bearer ${apiKey}` },
                body: formData,
              });

              if (!whisperRes.ok) {
                const err = await whisperRes.text();
                return reply.code(502).send({ error: "whisper_failed", message: err });
              }

              const result = (await whisperRes.json()) as { text: string };
              return reply.send({
                segments: [{ start: 0, end: 0, text: result.text }],
                fullText: result.text,
                title: undefined,
                provider: "whisper",
              });
            }

            if (provider === "deepgram") {
              const apiKey = process.env.DEEPGRAM_API_KEY;
              if (!apiKey) {
                return reply.code(503).send({
                  error: "missing_api_key",
                  message: "DEEPGRAM_API_KEY is required for Deepgram transcription",
                });
              }

              const dgRes = await fetch(
                `https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true`,
                {
                  method: "POST",
                  headers: {
                    Authorization: `Token ${apiKey}`,
                    "Content-Type": "audio/webm",
                  },
                  body: audioBuffer,
                },
              );

              if (!dgRes.ok) {
                const err = await dgRes.text();
                return reply.code(502).send({ error: "deepgram_failed", message: err });
              }

              const dgResult = (await dgRes.json()) as {
                results?: { channels?: { alternatives?: { transcript?: string; words?: { word: string; start: number; end: number }[] }[] }[] };
              };
              const alt = dgResult.results?.channels?.[0]?.alternatives?.[0];
              const segments = (alt?.words ?? []).map((w) => ({
                start: w.start,
                end: w.end,
                text: w.word,
              }));

              return reply.send({
                segments,
                fullText: alt?.transcript ?? "",
                title: undefined,
                provider: "deepgram",
              });
            }

            // Unknown provider
            return reply.code(400).send({
              error: "unknown_provider",
              message: `Unknown speech-to-text provider: ${provider}. Supported: whisper, deepgram`,
            });
          } catch (err) {
            app.log.error({ err }, "Speech-to-text failed");
            return reply.code(500).send({
              error: "transcription_failed",
              message: err instanceof Error ? err.message : String(err),
            });
          }
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

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Extract YouTube video ID from various URL formats */
function extractYouTubeId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const pat of patterns) {
    const m = url.match(pat);
    if (m) return m[1]!;
  }
  // If it's exactly 11 chars, assume it's a video ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;
  return null;
}

/** Parse YouTube caption XML into timed segments */
function parseYouTubeCaptionXml(xml: string): Array<{ start: number; end: number; text: string }> {
  const segments: Array<{ start: number; end: number; text: string }> = [];
  const regex = /<text start="([\d.]+)" dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(xml)) !== null) {
    const start = parseFloat(match[1]!);
    const dur = parseFloat(match[2]!);
    let text = match[3]!
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/<[^>]+>/g, "")  // strip any HTML tags inside captions
      .replace(/\n/g, " ")
      .trim();

    if (text) {
      segments.push({ start, end: start + dur, text });
    }
  }

  return segments;
}
