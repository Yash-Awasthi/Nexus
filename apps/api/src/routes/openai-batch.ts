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
 * A batch replays each line through this server's own /v1 route with the caller's credentials,
 * one line at a time, so free-tier limits see a steady trickle rather than a burst.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

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

// ponytail: bytes live on this host's disk, so API replicas behind one balancer do not share
// them; move the content to the drive's S3 bucket when Nexus runs more than one API process.
const filesDir = () => path.join(dataDir(), "openai-files");
const now = () => Math.floor(Date.now() / 1000);
const idOf = (prefix: string) => `${prefix}${randomUUID().replace(/-/g, "")}`;
const userOf = (request: FastifyRequest) => request.nexusUserId ?? "local";

const fail = (reply: FastifyReply, status: number, message: string) =>
  reply.code(status).send({ error: { message, type: "invalid_request_error", code: null } });

const fileView = ({ userId: _u, ...f }: FileRow) => ({ ...f, object: "file", status: "processed" });
const batchView = ({ userId: _u, ...b }: BatchRow) => b;

async function saveFile(userId: string, filename: string, purpose: string, data: Buffer) {
  const row: FileRow = {
    id: idOf("file-"),
    userId,
    bytes: data.length,
    created_at: now(),
    filename,
    purpose,
  };
  await fs.mkdir(filesDir(), { recursive: true });
  await fs.writeFile(path.join(filesDir(), row.id), data);
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

async function runBatch(app: FastifyInstance, id: string, authorization: string | undefined) {
  const batch = batches.get(id)!;
  const input = await fs.readFile(path.join(filesDir(), batch.input_file_id), "utf8");
  const { lines, errors } = parseLines(input, batch.endpoint);
  if (errors.length) {
    update(id, { status: "failed", failed_at: now(), errors: { object: "list", data: errors } });
    return;
  }
  if (batches.get(id)!.status === "cancelling") {
    update(id, { status: "cancelled", cancelled_at: now() });
    return;
  }
  update(id, {
    status: "in_progress",
    in_progress_at: now(),
    request_counts: { total: lines.length, completed: 0, failed: 0 },
  });
  const out: string[] = [];
  const bad: string[] = [];
  for (const line of lines) {
    if (batches.get(id)!.status === "cancelling") break;
    const res = await app.inject({
      method: "POST",
      url: batch.endpoint,
      headers: authorization ? { authorization } : {},
      payload: { ...line.body, stream: false },
    });
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
    const ok = res.statusCode < 300;
    (ok ? out : bad).push(row);
    const c = batches.get(id)!.request_counts;
    update(id, {
      request_counts: { ...c, [ok ? "completed" : "failed"]: c[ok ? "completed" : "failed"] + 1 },
    });
  }
  const cancelled = batches.get(id)!.status === "cancelling";
  if (!cancelled) update(id, { status: "finalizing", finalizing_at: now() });
  const write = async (rows: string[]) =>
    rows.length
      ? (
          await saveFile(
            batch.userId,
            `${id}_output.jsonl`,
            "batch_output",
            Buffer.from(`${rows.join("\n")}\n`),
          )
        ).id
      : null;
  update(id, {
    output_file_id: await write(out),
    error_file_id: await write(bad),
    ...(cancelled
      ? { status: "cancelled", cancelled_at: now() }
      : { status: "completed", completed_at: now() }),
  });
}

export async function openaiBatchRoutes(app: FastifyInstance): Promise<void> {
  await Promise.all([files.load(), batches.load()]);
  // Runs are in-process, so a restart ends them; say so rather than leave them "in progress".
  for (const b of batches.values()) {
    if (["validating", "in_progress", "finalizing", "cancelling"].includes(b.status))
      update(b.id, {
        ...(b.status === "cancelling"
          ? { status: "cancelled", cancelled_at: now() }
          : { status: "failed", failed_at: now() }),
        errors: {
          object: "list",
          data: [
            {
              code: "interrupted",
              message: "The server restarted during this batch.",
              param: null,
              line: null,
            },
          ],
        },
      });
  }

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
    return reply
      .type("application/octet-stream")
      .send(await fs.readFile(path.join(filesDir(), f.id)));
  });

  app.delete<{ Params: { id: string } }>("/files/:id", async (request, reply) => {
    const f = ownFile(request);
    if (!f) return fail(reply, 404, "No such file.");
    files.delete(f.id);
    await fs.rm(path.join(filesDir(), f.id), { force: true });
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
    const created = now();
    const row: BatchRow = {
      id: idOf("batch_"),
      userId: userOf(request),
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
    void runBatch(app, row.id, request.headers.authorization).catch((err: unknown) =>
      update(row.id, {
        status: "failed",
        failed_at: now(),
        errors: {
          object: "list",
          data: [{ code: "server_error", message: String(err), param: null, line: null }],
        },
      }),
    );
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
