// SPDX-License-Identifier: Apache-2.0
/**
 * Projects surface OWNER — extracted from api-bridge.ts.
 *
 * Groups, projects, tasks, the archive and project file attachments. Rows are
 * durable through PersistentStore (PG nexus_kv or JSON) and scoped to their
 * owner, with ownerless legacy rows visible to the desktop and anonymous
 * buckets. The stores live here now; the bridge only calls the registration.
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 */

import crypto from "node:crypto";
import path from "node:path";

import type { FastifyInstance } from "fastify";

import { claimable, ownsRow } from "../lib/owner.ts";
import { PersistentStore } from "../lib/persistent-store.ts";
import { makeUserRateLimitPreHandler } from "../lib/rate-limiter.ts";
import { emitReaction } from "../lib/reactions.ts";

const now = (): string => new Date().toISOString();

// Same budget as the rest of the bridge group (per user, IP fallback).
const bridgeRL = makeUserRateLimitPreHandler({
  limit: 60,
  windowMs: 60_000,
  keyPrefix: "bridge",
});

/** Register /v1/groups, /v1/projects, /v1/tasks and /v1/archive. */
export async function projectsRoutes(app: FastifyInstance): Promise<void> {
  // ── /v1/projects — Projects CRUD + Groups + Tasks + Archive ──────────────
  // Extended from mission-control: grouping, pinning, task status, archive.

  interface _Group {
    id: string;
    name: string;
    color: string;
    ownerId?: string | null;
    createdAt: string;
  }

  interface _Project {
    id: string;
    name: string;
    description: string;
    icon: string;
    iconColor: string;
    groupId: string | null;
    pinned: boolean;
    conversationCount: number;
    /** Standing instructions for work done in this project. */
    instructions?: string;
    /** Owning user (records created before scoping carry none = legacy/shared). */
    ownerId?: string | null;
    createdAt: string;
    updatedAt: string;
  }

  interface _Task {
    id: string;
    projectId: string;
    title: string;
    agent: string;
    status: "running" | "needs-input" | "done";
    branch: string;
    preview: string;
    lines: number;
    archived: boolean;
    createdAt: string;
    updatedAt: string;
  }

  const _groups = new PersistentStore<_Group>("groups");
  const _projects = new PersistentStore<_Project>("projects");
  const _tasks = new PersistentStore<_Task>("tasks");
  claimable("groups", _groups);
  claimable("projects", _projects);
  await Promise.all([_groups.load(), _projects.load(), _tasks.load()]);

  function _taskCounts(projectId: string) {
    let running = 0,
      needsInput = 0,
      done = 0;
    for (const t of _tasks.values()) {
      if (t.projectId !== projectId || t.archived) continue;
      if (t.status === "running") running++;
      else if (t.status === "needs-input") needsInput++;
      else if (t.status === "done") done++;
    }
    return { running, needsInput, done };
  }

  function _projectView(p: _Project) {
    const counts = _taskCounts(p.id);
    return { ...p, taskCounts: counts };
  }

  type _Req = { nexusUserId?: string };
  const _uid = (req: _Req) => req.nexusUserId ?? null;
  const _visible = ownsRow;
  const _myProject = (req: _Req, id: string) => {
    const p = _projects.get(id);
    return p && _visible(req, p) ? p : undefined;
  };
  const _myTask = (req: _Req, id: string) => {
    const t = _tasks.get(id);
    return t && _myProject(req, t.projectId) ? t : undefined;
  };

  // ── Groups CRUD ────────────────────────────────────────────────────────────

  app.get("/v1/groups", async (request, reply) => {
    return reply.send({ groups: [..._groups.values()].filter((g) => _visible(request, g)) });
  });

  app.post<{ Body: { name: string; color?: string } }>("/v1/groups", async (request, reply) => {
    const { name, color = "#6366f1" } = request.body ?? {};
    if (!name?.trim()) return reply.code(400).send({ message: "name is required" });
    const group: _Group = {
      id: `grp_${crypto.randomUUID()}`,
      name: name.trim(),
      color,
      ownerId: _uid(request),
      createdAt: now(),
    };
    _groups.set(group.id, group);
    return reply.code(201).send(group);
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; color?: string } }>(
    "/v1/groups/:id",
    async (request, reply) => {
      const group = _groups.get(request.params.id);
      if (!group || !_visible(request, group))
        return reply.code(404).send({ message: "group not found" });
      if (request.body?.name) group.name = request.body.name.trim();
      if (request.body?.color) group.color = request.body.color;
      _groups.set(group.id, group);
      return reply.send(group);
    },
  );

  app.delete<{ Params: { id: string } }>("/v1/groups/:id", async (request, reply) => {
    const group = _groups.get(request.params.id);
    if (!group || !_visible(request, group))
      return reply.code(404).send({ message: "group not found" });
    _groups.delete(group.id);
    for (const p of _projects.values()) {
      if (p.groupId === group.id) _projects.set(p.id, { ...p, groupId: null });
    }
    return reply.send({ ok: true });
  });

  // ── Projects CRUD ──────────────────────────────────────────────────────────

  app.get("/v1/projects", async (request, reply) => {
    const projects = [..._projects.values()]
      .filter((p) => _visible(request, p))
      .map(_projectView)
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.createdAt.localeCompare(a.createdAt);
      });
    return reply.send({ projects });
  });

  app.post<{
    Body: {
      name: string;
      description?: string;
      icon?: string;
      iconColor?: string;
      groupId?: string;
    };
  }>("/v1/projects", async (request, reply) => {
    const {
      name,
      description = "",
      icon = "",
      iconColor = "#6366f1",
      groupId = null,
    } = request.body ?? {};
    if (!name?.trim()) return reply.code(400).send({ message: "name is required" });
    const ts = now();
    const project: _Project = {
      id: `proj_${crypto.randomUUID()}`,
      name: name.trim(),
      description: description.trim(),
      icon: icon || name.trim().slice(0, 2).toUpperCase(),
      iconColor,
      groupId,
      pinned: false,
      conversationCount: 0,
      ownerId: _uid(request),
      createdAt: ts,
      updatedAt: ts,
    };
    _projects.set(project.id, project);
    return reply.code(201).send(_projectView(project));
  });

  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      description?: string;
      icon?: string;
      iconColor?: string;
      groupId?: string | null;
      pinned?: boolean;
      instructions?: string;
    };
  }>("/v1/projects/:id", async (request, reply) => {
    const project = _myProject(request, request.params.id);
    if (!project) return reply.code(404).send({ message: "project not found" });
    if (typeof request.body?.instructions === "string")
      project.instructions = request.body.instructions.slice(0, 2000);
    if (request.body?.name) project.name = request.body.name.trim();
    if (request.body?.description !== undefined)
      project.description = request.body.description.trim();
    if (request.body?.icon) project.icon = request.body.icon;
    if (request.body?.iconColor) project.iconColor = request.body.iconColor;
    if (request.body?.groupId !== undefined) project.groupId = request.body.groupId;
    if (request.body?.pinned !== undefined) project.pinned = request.body.pinned;
    project.updatedAt = now();
    _projects.set(project.id, project);
    return reply.send(_projectView(project));
  });

  app.get<{ Params: { id: string } }>("/v1/projects/:id", async (request, reply) => {
    const project = _myProject(request, request.params.id);
    if (!project) return reply.code(404).send({ message: "project not found" });
    return reply.send(_projectView(project));
  });

  app.delete<{ Params: { id: string } }>("/v1/projects/:id", async (request, reply) => {
    const project = _myProject(request, request.params.id);
    if (!project) return reply.code(404).send({ message: "project not found" });
    _projects.delete(project.id);
    for (const t of [..._tasks.values()]) {
      if (t.projectId === project.id) _tasks.delete(t.id);
    }
    return reply.send({ ok: true });
  });

  // ── Tasks CRUD ─────────────────────────────────────────────────────────────

  app.get<{ Params: { id: string } }>("/v1/projects/:id/tasks", async (request, reply) => {
    if (!_myProject(request, request.params.id))
      return reply.code(404).send({ message: "project not found" });
    const tasks = [..._tasks.values()]
      .filter((t) => t.projectId === request.params.id && !t.archived)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return reply.send({ tasks });
  });

  app.post<{
    Params: { id: string };
    Body: { title: string; agent?: string; branch?: string };
  }>("/v1/projects/:id/tasks", async (request, reply) => {
    if (!_myProject(request, request.params.id))
      return reply.code(404).send({ message: "project not found" });
    const { title, agent = "shell", branch = "main" } = request.body ?? {};
    if (!title?.trim()) return reply.code(400).send({ message: "title is required" });
    const ts = now();
    const task: _Task = {
      id: `task_${crypto.randomUUID()}`,
      projectId: request.params.id,
      title: title.trim(),
      agent,
      status: "running",
      branch,
      preview: "",
      lines: 0,
      archived: false,
      createdAt: ts,
      updatedAt: ts,
    };
    _tasks.set(task.id, task);
    emitReaction(request.nexusUserId, "task.created", { taskId: task.id, title: task.title });
    return reply.code(201).send(task);
  });

  app.post<{
    Params: { id: string };
    Body: { status?: string; preview?: string; lines?: number };
  }>("/v1/tasks/:id/status", async (request, reply) => {
    const task = _myTask(request, request.params.id);
    if (!task) return reply.code(404).send({ message: "task not found" });
    const status = request.body?.status;
    if (status === "running" || status === "needs-input" || status === "done") {
      if (status === "done" && task.status !== "done") {
        emitReaction(request.nexusUserId, "task.completed", { taskId: task.id, title: task.title });
      }
      task.status = status;
    }
    if (request.body?.preview !== undefined) task.preview = request.body.preview;
    if (request.body?.lines !== undefined) task.lines = request.body.lines;
    task.updatedAt = now();
    _tasks.set(task.id, task);
    return reply.send(task);
  });

  for (const [action, archived] of [
    ["archive", true],
    ["restore", false],
  ] as const) {
    app.post<{ Params: { id: string } }>(`/v1/tasks/:id/${action}`, async (request, reply) => {
      const task = _myTask(request, request.params.id);
      if (!task) return reply.code(404).send({ message: "task not found" });
      task.archived = archived;
      task.updatedAt = now();
      _tasks.set(task.id, task);
      return reply.send({ ok: true });
    });
  }

  app.get("/v1/archive", async (request, reply) => {
    const tasks = [..._tasks.values()]
      .filter((t) => t.archived && _myProject(request, t.projectId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return reply.send({ tasks });
  });

  // Project file attachments.
  interface _ProjectFile {
    id: string;
    projectId: string;
    name: string;
    mimeType: string;
    size: number;
    content: string; // base64
    createdAt: string;
  }
  const _fileStore = new PersistentStore<_ProjectFile>("project-files");
  _fileStore.load().catch(() => {});
  const _fileMeta = ({ content: _content, ...meta }: _ProjectFile) => meta;

  app.get<{ Params: { id: string } }>(
    "/v1/projects/:id/files",
    { preHandler: bridgeRL },
    async (request, reply) => {
      if (!_myProject(request, request.params.id))
        return reply.code(404).send({ error: "project_not_found" });
      const files = [..._fileStore.values()]
        .filter((f) => f.projectId === request.params.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(_fileMeta);
      return reply.send({ files });
    },
  );

  app.post<{ Params: { id: string }; Body: { name?: string; content: string; mimeType?: string } }>(
    "/v1/projects/:id/files",
    {
      preHandler: bridgeRL,
      schema: {
        body: {
          type: "object",
          required: ["content"],
          properties: {
            name: { type: "string", maxLength: 256 },
            content: { type: "string", maxLength: 10_000_000 }, // 10MB base64
            mimeType: { type: "string", maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id: projectId } = request.params;
      if (!_myProject(request, projectId))
        return reply.code(404).send({ error: "project_not_found" });
      const { name, content, mimeType } = request.body;
      const file: _ProjectFile = {
        id: `file_${crypto.randomUUID()}`,
        projectId,
        name: path.basename(name ?? `upload-${Date.now()}`),
        mimeType: mimeType ?? "application/octet-stream",
        size: Buffer.byteLength(content, "base64"),
        content,
        createdAt: new Date().toISOString(),
      };
      _fileStore.set(file.id, file);
      return reply.code(201).send(_fileMeta(file));
    },
  );

  app.delete<{ Params: { id: string; fileId: string } }>(
    "/v1/projects/:id/files/:fileId",
    { preHandler: bridgeRL },
    async (request, reply) => {
      const file = _fileStore.get(request.params.fileId);
      if (!file || file.projectId !== request.params.id || !_myProject(request, file.projectId)) {
        return reply.code(404).send({ error: "not_found" });
      }
      _fileStore.delete(request.params.fileId);
      return reply.send({ ok: true, deleted: request.params.fileId });
    },
  );

  app.get<{ Params: { id: string; fileId: string } }>(
    "/v1/projects/:id/files/:fileId",
    { preHandler: bridgeRL },
    async (request, reply) => {
      const file = _fileStore.get(request.params.fileId);
      if (!file || file.projectId !== request.params.id || !_myProject(request, file.projectId)) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.send(file);
    },
  );
}
