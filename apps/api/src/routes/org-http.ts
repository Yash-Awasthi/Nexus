// SPDX-License-Identifier: Apache-2.0
/** What every org route shares: error mapping, and whose data a request reads. */

import { db } from "@nexus/db";
import { workspaceMembers, workspaces } from "@nexus/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";

import { scrub } from "../lib/org-portability.js";
import { OrgError, companyOf } from "../lib/org-store.js";
import type { Actor } from "../lib/org-work.js";
import { ownerIdFor } from "../lib/owner.js";

/** Run a store call and map an OrgError onto its status; anything else is a 500. */
export async function orgReply<T>(reply: FastifyReply, fn: () => T | Promise<T>, code = 200) {
  try {
    const out = await fn();
    return reply.code(code).send(out ?? { ok: true });
  } catch (err) {
    if (err instanceof OrgError)
      return reply.code(err.status).send({ error: err.code, message: err.message });
    throw err;
  }
}

export type Id = { Params: { id: string } };

/** The user's role in each live workspace they belong to; none without a database. */
export async function workspaceRolesFor(
  userId: string | undefined,
  onlyWorkspace?: string,
): Promise<Map<string, string>> {
  if (!userId || !process.env.DATABASE_URL) return new Map();
  try {
    const rows = await db
      .select({ id: workspaceMembers.workspaceId, role: workspaceMembers.role })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(
        and(
          eq(workspaceMembers.userId, userId),
          isNull(workspaces.deletedAt),
          onlyWorkspace ? eq(workspaceMembers.workspaceId, onlyWorkspace) : undefined,
        ),
      );
    return new Map(rows.map((r) => [r.id, r.role]));
  } catch {
    return new Map();
  }
}

/** The changes a workspace member may make to a shared company, and the body fields each may carry. */
const MEMBER_WRITES = {
  comment: ["body"],
  fileTask: [
    "title",
    "description",
    "priority",
    "status",
    "goalId",
    "parentId",
    "assigneeAgentId",
    "workMode",
  ],
  assign: ["assigneeAgentId"],
} as const;
type MemberWrite = keyof typeof MEMBER_WRITES;

/** Everything, for the company's owner. */
export const OWNER_CAN = ["manage", ...Object.keys(MEMBER_WRITES)];

/** What a workspace member may do with a shared company: the member writes, or nothing as a viewer. */
export function capabilitiesFor(role: string | undefined): string[] {
  return !role || role === "viewer" ? [] : Object.keys(MEMBER_WRITES);
}

/** A workspace member reading a shared company acts as its owner, for reads only. */
const readingAs = new WeakMap<FastifyRequest, string>();
export const ownerOf = (request: FastifyRequest) => readingAs.get(request) ?? ownerIdFor(request);

declare module "fastify" {
  interface FastifyContextConfig {
    /** A workspace member may make this change to a shared company, with only its fields. */
    memberWrite?: MemberWrite;
    /** Only the company's owner may read this, not its workspace members. */
    ownerOnly?: boolean;
  }
}

/** A member's view of any reply: every agent's adapter config scrubbed as an export would be. */
export function forMember(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => forMember(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      k === "adapterConfig" && v && typeof v === "object"
        ? scrub(v as Record<string, unknown>)
        : forMember(v, depth + 1),
    ]),
  );
}

export const isMemberRead = (request: FastifyRequest) => readingAs.has(request);

/** Who a change is logged as: the owner acts as the board, a workspace member as themselves. */
export const actorOf = (request: FastifyRequest): Actor =>
  isMemberRead(request)
    ? { type: "member", id: request.nexusUserId! }
    : { type: "user", id: ownerOf(request) };

/** Lets a workspace member read a shared company, and change it only through `memberWrite` routes. */
export async function shareGuard(request: FastifyRequest, reply: FastifyReply) {
  const id = (request.params as { id?: string } | undefined)?.id;
  const company = id ? companyOf(id) : undefined;
  const me = request.nexusUserId;
  if (!company?.workspaceId || !me || company.ownerId === me) return;
  const role = (await workspaceRolesFor(me, company.workspaceId)).get(company.workspaceId);
  if (!role) return;
  const { memberWrite, ownerOnly } = request.routeOptions.config;
  const deny = (message: string) => reply.code(403).send({ error: "forbidden", message });
  if (ownerOnly) return deny("Only the company's owner can do that.");
  if (request.method !== "GET") {
    if (!memberWrite || !capabilitiesFor(role).includes(memberWrite))
      return deny("Only the company's owner can do that.");
    const allowed: readonly string[] = MEMBER_WRITES[memberWrite];
    const extra = Object.keys((request.body as object | undefined) ?? {}).filter(
      (k) => !allowed.includes(k),
    );
    if (extra.length) return deny(`A workspace member cannot set ${extra.join(", ")}.`);
  }
  readingAs.set(request, company.ownerId);
}
