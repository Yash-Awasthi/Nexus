// SPDX-License-Identifier: Apache-2.0
/**
 * The loopback sandbox helper's HTTP surface.
 *
 * A browser page cannot ask the deployed API to run code on the viewer's machine,
 * so the page talks to this process on http://127.0.0.1:4789 instead. Everything
 * here is written for that position: the listener is bound to loopback, every
 * state-changing call needs a paired token, a page whose origin is not on the
 * allowlist is refused, and the image and the runtime are chosen by the helper,
 * never by the request.
 *
 * Plain `node:http`, no framework: this runs on the user's machine, not in the
 * cluster.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { executeCode, SANDBOX_LANGUAGES, type Runner, type SandboxLanguage } from "@nexus/sandbox";

import { Pairing } from "./pairing.ts";

const LANGUAGES: ReadonlySet<string> = new Set(SANDBOX_LANGUAGES);

/** Requests larger than this are refused before they are buffered. */
const MAX_BODY_BYTES = 256 * 1024;
const MAX_CODE_BYTES = 100 * 1024;

export interface HelperOptions {
  /** Image runs are started in. Must appear in `allowedImages`. */
  image: string;
  /** Images this helper will ever run. A request cannot widen it. */
  allowedImages: string[];
  /** Page origins allowed to call the helper. Requests without an Origin (curl) pass. */
  allowedOrigins: string[];
  /** Runs the code; defaults to a Docker runner in the caller. */
  runner: Runner;
  /** Reports whether a Docker daemon answers, for /health. */
  dockerReady?: () => Promise<boolean>;
  pairing?: Pairing;
  /** Hard ceiling on a run. Default 30 s, matching the sandbox package. */
  maxRunMs?: number;
}

interface ErrorBody {
  error: string;
  message: string;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    // The helper is loopback-only; a cached answer would outlive the pairing.
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Vary: "Origin",
    // Chrome's Private Network Access preflight asks for this before a public page
    // may reach loopback. Answering it is the whole reason the helper is reachable.
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "600",
  };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

/** Read a JSON body, refusing anything over the cap instead of buffering it. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(buf);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
}

function failure(error: string, message: string): ErrorBody {
  return { error, message };
}

export function createHelperServer(options: HelperOptions): Server {
  if (!options.allowedImages.includes(options.image)) {
    throw new Error(
      `Image ${options.image} is not in the allowlist (${options.allowedImages.join(", ")}).`,
    );
  }
  const pairing = options.pairing ?? new Pairing();
  const maxRunMs = Math.min(options.maxRunMs ?? 30_000, 30_000);
  let running = false;

  return createServer((req, res) => {
    void (async () => {
      const origin = req.headers.origin;
      // A page from anywhere else is not this app. No Origin at all is a native
      // client (`curl`, a script), which cannot be a confused deputy for a page.
      const allowed = origin === undefined || options.allowedOrigins.includes(origin);
      const cors = corsHeaders(allowed ? origin : undefined);
      for (const [name, value] of Object.entries(cors)) res.setHeader(name, value);

      if (!allowed) {
        return send(res, 403, failure("origin_refused", `Origin ${origin} is not allowed.`));
      }

      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }

      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;

      if (req.method === "GET" && path === "/health") {
        const docker = options.dockerReady ? await options.dockerReady() : true;
        return send(res, 200, {
          ok: true,
          image: options.image,
          docker,
          paired: pairing.paired(),
          languages: [...LANGUAGES],
        });
      }

      if (req.method === "POST" && path === "/pair") {
        let body: unknown;
        try {
          body = await readJson(req);
        } catch (err) {
          const tooLarge = err instanceof Error && err.message === "body_too_large";
          return send(
            res,
            tooLarge ? 413 : 400,
            failure(tooLarge ? "body_too_large" : "bad_json", "Body is not valid JSON."),
          );
        }
        const code = (body as { code?: unknown }).code;
        if (typeof code !== "string") {
          return send(res, 400, failure("code_required", "Send the code shown by the helper."));
        }
        const token = pairing.redeem(code.trim(), origin ?? "none");
        if (!token) {
          return send(res, 401, failure("pairing_failed", "That code is wrong or has expired."));
        }
        return send(res, 200, token);
      }

      if (req.method === "POST" && path === "/run") {
        if (!pairing.verify(bearer(req), origin ?? "none")) {
          return send(res, 401, failure("not_paired", "Pair this browser with the helper first."));
        }

        let body: unknown;
        try {
          body = await readJson(req);
        } catch (err) {
          const tooLarge = err instanceof Error && err.message === "body_too_large";
          return send(
            res,
            tooLarge ? 413 : 400,
            failure(tooLarge ? "body_too_large" : "bad_json", "Body is not valid JSON."),
          );
        }

        const { language, code, timeoutMs } = body as {
          language?: unknown;
          code?: unknown;
          timeoutMs?: unknown;
        };
        if (typeof code !== "string" || code.trim() === "") {
          return send(res, 400, failure("code_required", "Nothing to run."));
        }
        if (Buffer.byteLength(code) > MAX_CODE_BYTES) {
          return send(res, 413, failure("code_too_large", "Code is too large to run."));
        }
        if (typeof language !== "string" || !LANGUAGES.has(language)) {
          return send(
            res,
            400,
            failure("language_refused", `Supported languages: ${[...LANGUAGES].join(", ")}.`),
          );
        }
        // One run at a time: a laptop is not a job queue, and two containers
        // started by a page that forgot to disable its button is not a load test.
        if (running) {
          return send(res, 429, failure("busy", "A run is already in progress."));
        }

        const budget =
          typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
            ? Math.min(Math.max(Math.floor(timeoutMs), 100), maxRunMs)
            : maxRunMs;

        running = true;
        try {
          const result = await executeCode(
            {
              taskType: "sandbox.execute",
              language: language as SandboxLanguage,
              code,
              timeoutMs: budget,
            },
            options.runner,
          );
          return send(res, 200, result);
        } finally {
          running = false;
        }
      }

      return send(res, 404, failure("not_found", `No route for ${req.method ?? "?"} ${path}.`));
    })().catch((err: unknown) => {
      if (!res.headersSent) {
        send(res, 500, failure("helper_error", err instanceof Error ? err.message : String(err)));
      } else {
        res.end();
      }
    });
  });
}
