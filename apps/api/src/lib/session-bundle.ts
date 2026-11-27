// SPDX-License-Identifier: Apache-2.0
/**
 * A session as one portable file.
 *
 * The use case is support and handoff, not backup: somebody pastes a transcript that is too
 * long for a ticket, and the reviewer needs the whole deliberation — every round, in order,
 * with the member labels — in an account that is not the reporter's. So the bundle is one
 * JSON object, self-describing, and it imports as a *copy* under a new thread id: an export
 * never overwrites, never merges into an existing thread, and importing the same file twice
 * is two sessions, not a duplicate-key failure.
 *
 * The format is versioned by the `format` field. `nexus.session/1` is this one. A reader may
 * ignore fields it does not know (that is how the format grows); it must refuse a `format` it
 * does not know, because guessing at an unknown version is how importers corrupt data.
 */

import type { ThreadMessage } from "./threads-store.ts";

export const BUNDLE_FORMAT = "nexus.session/1";

/** Caps: a hostile or accidental 200 MB upload should fail at the door, not in the store. */
export const MAX_MESSAGES = 500;
export const MAX_CONTENT_CHARS = 200_000;
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

const ROLES = new Set(["user", "opinion", "verdict", "system"]);

export interface SessionBundle {
  format: typeof BUNDLE_FORMAT;
  exportedAt: string;
  thread: {
    id: string;
    title: string;
    mode?: string;
    createdAt: string;
    updatedAt: string;
  };
  messages: ThreadMessage[];
  /** Counts computed at export time, so a reader can sanity-check without parsing everything. */
  stats: {
    messages: number;
    rounds: number;
    members: string[];
    characters: number;
  };
}

export function buildBundle(
  thread: SessionBundle["thread"],
  messages: ThreadMessage[],
): SessionBundle {
  const rounds = new Set<number>();
  const members = new Set<string>();
  let characters = 0;
  for (const message of messages) {
    rounds.add(message.round);
    if (message.member) members.add(message.member);
    characters += message.content.length;
  }
  return {
    format: BUNDLE_FORMAT,
    exportedAt: new Date().toISOString(),
    thread,
    messages,
    stats: {
      messages: messages.length,
      rounds: rounds.size,
      members: [...members].sort(),
      characters,
    },
  };
}

export type ValidationResult = { ok: true; bundle: SessionBundle } | { ok: false; reason: string };

function isIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/**
 * Check a bundle before a single row is written.
 *
 * Everything is checked explicitly rather than coerced: an importer that "fixes" a malformed
 * message is an importer that silently imports something other than what the file says.
 */
export function validateBundle(raw: unknown): ValidationResult {
  if (typeof raw !== "object" || raw === null)
    return { ok: false, reason: "bundle must be an object" };
  const bundle = raw as Partial<SessionBundle>;
  if (bundle.format !== BUNDLE_FORMAT) {
    return {
      ok: false,
      reason: `unsupported format ${JSON.stringify(bundle.format)} — this server reads ${BUNDLE_FORMAT}`,
    };
  }
  const thread = bundle.thread;
  if (typeof thread !== "object" || thread === null)
    return { ok: false, reason: "thread is missing" };
  if (typeof thread.title !== "string" || !thread.title.trim()) {
    return { ok: false, reason: "thread.title must be a non-empty string" };
  }
  if (thread.title.length > 300) return { ok: false, reason: "thread.title is too long" };
  if (!Array.isArray(bundle.messages)) return { ok: false, reason: "messages must be an array" };
  if (bundle.messages.length > MAX_MESSAGES) {
    return {
      ok: false,
      reason: `messages is limited to ${MAX_MESSAGES}; this bundle has ${bundle.messages.length}`,
    };
  }

  const seen = new Set<string>();
  const messages: ThreadMessage[] = [];
  for (const [index, candidate] of bundle.messages.entries()) {
    const message = candidate as Partial<ThreadMessage>;
    if (typeof message.id !== "string" || !message.id) {
      return { ok: false, reason: `messages[${index}].id must be a non-empty string` };
    }
    if (seen.has(message.id)) {
      // Duplicate ids would collapse into one row on import (the store upserts by id), so a
      // file that contains them is not the session it claims to be.
      return { ok: false, reason: `messages[${index}].id is duplicated (${message.id})` };
    }
    seen.add(message.id);
    if (typeof message.role !== "string" || !ROLES.has(message.role)) {
      return {
        ok: false,
        reason: `messages[${index}].role must be one of ${[...ROLES].join(", ")}`,
      };
    }
    if (typeof message.content !== "string") {
      return { ok: false, reason: `messages[${index}].content must be a string` };
    }
    if (message.content.length > MAX_CONTENT_CHARS) {
      return {
        ok: false,
        reason: `messages[${index}].content is longer than ${MAX_CONTENT_CHARS} characters`,
      };
    }
    const round =
      typeof message.round === "number" && Number.isFinite(message.round) ? message.round : 0;
    messages.push({
      id: message.id,
      role: message.role as ThreadMessage["role"],
      content: message.content,
      round,
      createdAt: isIso(message.createdAt) ? message.createdAt : new Date().toISOString(),
      ...(typeof message.member === "string" ? { member: message.member } : {}),
      ...(typeof message.archetype === "string" ? { archetype: message.archetype } : {}),
    });
  }

  return {
    ok: true,
    bundle: {
      format: BUNDLE_FORMAT,
      exportedAt: isIso(bundle.exportedAt) ? bundle.exportedAt : new Date().toISOString(),
      thread: {
        id: typeof thread.id === "string" ? thread.id : "",
        title: thread.title.trim(),
        ...(typeof thread.mode === "string" ? { mode: thread.mode } : {}),
        createdAt: isIso(thread.createdAt) ? thread.createdAt : new Date().toISOString(),
        updatedAt: isIso(thread.updatedAt) ? thread.updatedAt : new Date().toISOString(),
      },
      messages,
      stats: {
        messages: messages.length,
        rounds: new Set(messages.map((m) => m.round)).size,
        members: [...new Set(messages.map((m) => m.member).filter((m): m is string => !!m))].sort(),
        characters: messages.reduce((total, m) => total + m.content.length, 0),
      },
    },
  };
}

/** A filename a browser will accept and a human can read: `session-2026-05-01-migration-ab.json`. */
export function bundleFilename(title: string, createdAt: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  const day = Number.isFinite(Date.parse(createdAt))
    ? new Date(createdAt).toISOString().slice(0, 10)
    : "undated";
  return `session-${day}-${slug || "export"}.json`;
}
