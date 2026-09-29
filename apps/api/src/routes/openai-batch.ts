// SPDX-License-Identifier: Apache-2.0
/**
 * OpenAI's Files and Batch APIs at /v1, for clients that submit work as a JSONL file.
 *
 *   POST   /v1/files               — multipart upload (file, purpose)
 *   GET    /v1/files[/:id]         — list, or one file's metadata
 *   GET    /v1/files/:id/content   — the bytes
 *   DELETE /v1/files/:id
 *   POST   /v1/batches             — { input_file_id, endpoint, completion_window }
 *   GET    /v1/batches[/:id]
 *   POST   /v1/batches/:id/cancel
 *
 * A batch replays each line through this server's own /v1 route as its owner, one line at a
 * time, so free-tier limits see a steady trickle rather than a burst. Each line gets a fresh
 * short-lived token, so the caller's own token may expire meanwhile, and each answer is kept as
 * it arrives: a server that stops mid-batch hands it on, and the next one to start (or any
 * replica, once the owner's heartbeat goes stale) carries on from the first unanswered line.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import multipart from "@fastify/multipart";
import { s3Bucket, s3ConfigFromEnv } from "@nexus/sandbox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { issueAccessToken } from "../lib/issue-access-token.js";
import { patScopesAllow } from "../lib/pat-scopes.js";
import { verifyPat } from "../lib/pat-store.js";
import { PersistentStore, dataDir } from "../lib/persistent-store.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_LINES = 1000;
const ENDPOINTS = ["/v1/chat/completions", "/v1/completions", "/v1/embeddings"];

interface FileRow {
  id: string;
  userId: string;
  bytes: number;
  created_at: number;
  filename: string;
  purpose: string;
}

type Status =
  "validating" | "in_progress" | "finalizing" | "completed" | "failed" | "cancelling" | "cancelled";

interface BatchError {
  code: string;
  message: string;
  param: null;
  line: number | null;
}

interface BatchRow {
  id: string;
  userId: string;
  /** The owner's role, for the token each line runs with. */
  role: string;
  /** The server running it, and when that server last said so. */
  runner: string | null;
  heartbeatAt: number | null;
  object: "batch";
  endpoint: string;
  errors: { object: "list"; data: BatchError[] } | null;
  input_file_id: string;
  completion_window: string;
  status: Status;
  output_file_id: string | null;
  error_file_id: string | null;
  created_at: number;
  in_progress_at: number | null;
  expires_at: number;
  finalizing_at: number | null;
  completed_at: number | null;
  failed_at: number | null;
  expired_at: null;
  cancelling_at: number | null;
  cancelled_at: number | null;
  request_counts: { total: number; completed: number; failed: number };
  metadata: Record<string, string> | null;
}

const files = new PersistentStore<FileRow>("openai_files");
const batches = new PersistentStore<BatchRow>("openai_batches");
/** One answered line, kept until the batch writes its output files. */
const answered = new PersistentStore<{ batchId: string; index: number; ok: boolean; row: string }>(
  "openai_batch_lines",
);
/** A batch whose runner has not beaten for this long is taken over. */
const STALE_MS = 120_000;

const filesDir = () => path.join(dataDir(), "openai-files");

/** File bytes: in the drive bucket when one is configured, so every API process shares them. */
function blobs() {
  const cfg = s3ConfigFromEnv();
  if (cfg) {
    const bucket = s3Bucket(cfg);
    const key = (id: string) => `openai-files/${id}`;
    return {
      put: (id: string, data: Buffer) => bucket.put(key(id), data),
      get: async (id: string) => {
        const data = await bucket.get(key(id));
        if (!data) throw new Error(`The content of ${id} is missing from the bucket.`);
        return data;
      },
      remove: (id: string) => bucket.remove(key(id)),
    };
  }
  return {
    put: async (id: string, data: Buffer) => {
      await fs.mkdir(filesDir(), { recursive: true });
      await fs.writeFile(path.join(filesDir(), id), data);
    },
    get: (id: string) => fs.readFile(path.join(filesDir(), id)),
    remove: (id: string) => fs.rm(path.join(filesDir(), id), { force: true }),
  };
}
const now = () => Math.floor(Date.now() / 1000);
const idOf = (prefix: string) => `${prefix}${randomUUID().replace(/-/g, "")}`;
const userOf = (request: FastifyRequest) => request.nexusUserId ?? "local";

const fail = (reply: FastifyReply, status: number, message: string) =>
  reply.code(status).send({ error: { message, type: "invalid_request_error", code: null } });

const fileView = ({ userId: _u, ...f }: FileRow) => ({ ...f, object: "file", status: "processed" });
const batchView = ({ userId: _u, role: _r, runner: _n, heartbeatAt: _h, ...b }: BatchRow) => b;

async function saveFile(userId: string, filename: string, purpose: string, data: Buffer) {
  const row: FileRow = {
    id: idOf("file-"),
    userId,
    bytes: data.length,
    created_at: now(),
    filename,
    purpose,
  };
  await blobs().put(row.id, data);
  files.set(row.id, row);
  return row;
}

interface Line {
  custom_id: string;
  body: Record<string, unknown>;
}

/** The file's requests, or every problem that stops the batch before it starts. */
function parseLines(raw: string, endpoint: string): { lines: Line[]; errors: BatchError[] } {
  const errors: BatchError[] = [];
  const lines: Line[] = [];
  const seen = new Set<string>();
  const err = (code: string, message: string, line: number | null) =>
    errors.push({ code, message, param: null, line });
  const rows = raw.split("\n").map((l, i) => [l.trim(), i + 1] as const);
  const filled = rows.filter(([l]) => l);
  if (filled.length === 0) err("empty_file", "The input file has no requests.", null);
  if (filled.length > MAX_LINES)
    err("too_many_lines", `A batch holds at most ${MAX_LINES} requests.`, null);
  for (const [text, n] of filled.slice(0, MAX_LINES)) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(text) as Record<string, unknown>;
    } catch {
      err("invalid_json_line", "This line is not valid JSON.", n);
      continue;
    }
    const id = row["custom_id"];
    if (typeof id !== "string" || !id) err("missing_custom_id", "custom_id is required.", n);
    else if (seen.has(id)) err("duplicate_custom_id", `custom_id "${id}" is used twice.`, n);
    else seen.add(id);
    if (row["method"] !== "POST") err("invalid_method", "method must be POST.", n);
    if (row["url"] !== endpoint)
      err("invalid_url", `url must be the batch endpoint, ${endpoint}.`, n);
    const body = row["body"];
    if (!body || typeof body !== "object" || Array.isArray(body))
      err("invalid_body", "body must be an object.", n);
    else if (typeof id === "string")
      lines.push({ custom_id: id, body: body as Record<string, unknown> });
  }
  return { lines, errors };
}

function update(id: string, patch: Partial<BatchRow>): BatchRow {
  const next = { ...batches.get(id)!, ...patch };
  batches.set(id, next);
  return next;
}

async function runBatch(app: FastifyInstance, id: string, runner: string, live: () => boolean) {
  const batch = update(id, { runner, heartbeatAt: Date.now() });
  const beat = setInterval(() => live() && update(id, { heartbeatAt: Date.now() }), 30_000);
  beat.unref();
  try {
    const input = (await blobs().get(batch.input_file_id)).toString("utf8");
    const { lines, errors } = parseLines(input, batch.endpoint);
    if (errors.length) {
      update(id, { status: "failed", failed_at: now(), errors: { object: "list", data: errors } });
      return;
    }
    const done = new Map(
      [...answered.values()].filter((a) => a.batchId === id).map((a) => [a.index, a]),
    );
    const count = () => {
      const all = [...done.values()];
      const completed = all.filter((a) => a.ok).length;
      return { total: lines.length, completed, failed: all.length - completed };
    };
    if (batches.get(id)!.status === "validating")
      update(id, { status: "in_progress", in_progress_at: now(), request_counts: count() });
    for (const [index, line] of lines.entries()) {
      if (done.has(index)) continue;
      if (!live() || batches.get(id)!.status === "cancelling") break;
      const res = await app.inject({
        method: "POST",
        url: batch.endpoint,
        headers: {
          authorization: `Bearer ${issueAccessToken(batch.userId, batch.role).accessToken}`,
        },
        payload: { ...line.body, stream: false },
      });
      // A server shutting down leaves the line for whoever picks the batch up.
      if (!live()) return;
      let body: unknown;
      try {
        body = res.json();
      } catch {
        body = res.body;
      }
      const row = JSON.stringify({
        id: idOf("batch_req_"),
        custom_id: line.custom_id,
        response: { status_code: res.statusCode, request_id: idOf("req_"), body },
        error: null,
      });
      const result = { batchId: id, index, ok: res.statusCode < 300, row };
      await answered.save(`${id}:${index}`, result);
      done.set(index, result);
      update(id, { request_counts: count(), heartbeatAt: Date.now() });
    }
    if (!live()) return;

    const cancelled = batches.get(id)!.status === "cancelling";
    if (!cancelled) update(id, { status: "finalizing", finalizing_at: now() });
    const rows = [...done.values()].sort((a, b) => a.index - b.index);
    const write = async (ok: boolean) => {
      const picked = rows.filter((r) => r.ok === ok).map((r) => r.row);
      return picked.length
        ? (
            await saveFile(
              batch.userId,
              `${id}_output.jsonl`,
              "batch_output",
              Buffer.from(`${picked.join("\n")}\n`),
            )
          ).id
        : null;
    };
    update(id, {
      output_file_id: await write(true),
      error_file_id: await write(false),
      runner: null,
      ...(cancelled
        ? { status: "cancelled", cancelled_at: now() }
        : { status: "completed", completed_at: now() }),
    });
    for (const r of rows) answered.delete(`${id}:${r.index}`);
  } finally {
    clearInterval(beat);
  }
}

const OPEN: Status[] = ["validating", "in_progress", "finalizing", "cancelling"];

export async function openaiBatchRoutes(app: FastifyInstance): Promise<void> {
  await Promise.all([files.load(), batches.load(), answered.load()]);
  const runner = randomUUID();
  let closing = false;
  const live = () => !closing;
  const start = (id: string) =>
    void runBatch(app, id, runner, live).catch((err: unknown) =>
      update(id, {
        status: "failed",
        failed_at: now(),
        runner: null,
        errors: {
          object: "list",
          data: [{ code: "server_error", message: String(err), param: null, line: null }],
        },
      }),
    );
  // Take over batches no server is running: released on shutdown, or gone quiet.
  const resume = () => {
    for (const b of batches.values())
      if (
        OPEN.includes(b.status) &&
        b.runner !== runner &&
        (!b.runner || Date.now() - (b.heartbeatAt ?? 0) > STALE_MS)
      )
        start(b.id);
  };
  resume();
  const sweep = setInterval(resume, 60_000);
  sweep.unref();
  app.addHook("onClose", async () => {
    closing = true;
    clearInterval(sweep);
    for (const b of batches.values())
      if (b.runner === runner) await batches.save(b.id, { ...b, runner: null });
  });

  await app.register(multipart, { limits: { fileSize: MAX_FILE_BYTES, files: 1 } });

  const ownFile = (request: FastifyRequest<{ Params: { id: string } }>) => {
    const f = files.get(request.params.id);
    return f && f.userId === userOf(request) ? f : null;
  };
  const ownBatch = (request: FastifyRequest<{ Params: { id: string } }>) => {
    const b = batches.get(request.params.id);
    return b && b.userId === userOf(request) ? b : null;
  };

  app.post("/files", async (request, reply) => {
    if (!request.isMultipart()) return fail(reply, 400, "Send the file as multipart/form-data.");
    const part = await request.file();
    if (!part) return fail(reply, 400, "No file was sent.");
    let data: Buffer;
    try {
      data = await part.toBuffer();
    } catch {
      return fail(reply, 413, "Files are limited to 10 MB.");
    }
    const purpose = (part.fields["purpose"] as { value?: unknown } | undefined)?.value;
    if (typeof purpose !== "string" || !purpose) return fail(reply, 400, "purpose is required.");
    return fileView(await saveFile(userOf(request), part.filename || "upload", purpose, data));
  });

  app.get<{ Querystring: { purpose?: string } }>("/files", async (request) => ({
    object: "list",
    data: [...files.values()]
      .filter((f) => f.userId === userOf(request))
      .filter((f) => !request.query.purpose || f.purpose === request.query.purpose)
      .sort((a, b) => b.created_at - a.created_at)
      .map(fileView),
  }));

  app.get<{ Params: { id: string } }>("/files/:id", async (request, reply) => {
    const f = ownFile(request);
    return f ? fileView(f) : fail(reply, 404, "No such file.");
  });

  app.get<{ Params: { id: string } }>("/files/:id/content", async (request, reply) => {
    const f = ownFile(request);
    if (!f) return fail(reply, 404, "No such file.");
    return reply.type("application/octet-stream").send(await blobs().get(f.id));
  });

  app.delete<{ Params: { id: string } }>("/files/:id", async (request, reply) => {
    const f = ownFile(request);
    if (!f) return fail(reply, 404, "No such file.");
    files.delete(f.id);
    await blobs().remove(f.id);
    return { id: f.id, object: "file", deleted: true };
  });

  app.post<{
    Body: {
      input_file_id?: unknown;
      endpoint?: unknown;
      completion_window?: unknown;
      metadata?: unknown;
    };
  }>("/batches", async (request, reply) => {
    const body = request.body ?? {};
    if (typeof body.endpoint !== "string" || !ENDPOINTS.includes(body.endpoint))
      return fail(reply, 400, `endpoint must be one of ${ENDPOINTS.join(", ")}.`);
    if (body.completion_window !== "24h")
      return fail(reply, 400, 'completion_window must be "24h".');
    const input = files.get(String(body.input_file_id));
    if (!input || input.userId !== userOf(request)) return fail(reply, 404, "No such input file.");
    // Lines run on a token of their own, so a scoped token's limits are checked here.
    const raw = /^Bearer\s+(nxk_\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
    const pat = raw ? await verifyPat(raw) : null;
    if (pat && !patScopesAllow(pat.scopes, body.endpoint))
      return reply.code(403).send({
        code: "INSUFFICIENT_SCOPE",
        message: "Token scope does not allow this endpoint",
      });
    const created = now();
    const row: BatchRow = {
      id: idOf("batch_"),
      userId: userOf(request),
      role: request.nexusRole ?? "user",
      runner: null,
      heartbeatAt: null,
      object: "batch",
      endpoint: body.endpoint,
      errors: null,
      input_file_id: input.id,
      completion_window: "24h",
      status: "validating",
      output_file_id: null,
      error_file_id: null,
      created_at: created,
      in_progress_at: null,
      expires_at: created + 24 * 3600,
      finalizing_at: null,
      completed_at: null,
      failed_at: null,
      expired_at: null,
      cancelling_at: null,
      cancelled_at: null,
      request_counts: { total: 0, completed: 0, failed: 0 },
      metadata:
        body.metadata && typeof body.metadata === "object"
          ? (body.metadata as Record<string, string>)
          : null,
    };
    batches.set(row.id, row);
    start(row.id);
    return batchView(row);
  });

  app.get("/batches", async (request) => ({
    object: "list",
    data: [...batches.values()]
      .filter((b) => b.userId === userOf(request))
      .sort((a, b) => b.created_at - a.created_at)
      .map(batchView),
  }));

  app.get<{ Params: { id: string } }>("/batches/:id", async (request, reply) => {
    const b = ownBatch(request);
    return b ? batchView(b) : fail(reply, 404, "No such batch.");
  });

  app.post<{ Params: { id: string } }>("/batches/:id/cancel", async (request, reply) => {
    const b = ownBatch(request);
    if (!b) return fail(reply, 404, "No such batch.");
    if (b.status !== "validating" && b.status !== "in_progress") return batchView(b);
    return batchView(update(b.id, { status: "cancelling", cancelling_at: now() }));
  });
}
