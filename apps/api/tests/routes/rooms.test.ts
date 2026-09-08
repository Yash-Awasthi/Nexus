// SPDX-License-Identifier: Apache-2.0
/**
 * Rooms surface route tests — the §16.7 extraction of /rooms from
 * api-bridge.ts into routes/rooms.ts.
 *
 * The module-level room store is shared across tests in this file, so each
 * test uses a unique room name and cleans up after itself.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../../src/server.js";

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildServer();
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

interface Room {
  id: string;
  name: string;
  createdAt: string;
  members: string[];
}

let counter = 0;
function freshRoomName(): string {
  counter += 1;
  return `e2e-room-${counter}-${Date.now()}`;
}

describe("POST /api/rooms", () => {
  it("creates a room with an id, timestamp and empty members", async () => {
    const name = freshRoomName();
    const res = await app.inject({
      method: "POST",
      url: "/api/rooms",
      payload: { name },
    });
    expect(res.statusCode).toBe(201);
    const room = res.json<Room>();
    expect(room.id).toBeTruthy();
    expect(room.name).toBe(name);
    expect(room.members).toEqual([]);
    expect(room.createdAt).toBeTruthy();

    const del = await app.inject({ method: "DELETE", url: `/api/rooms/${room.id}` });
    expect(del.statusCode).toBe(204);
  });
});

describe("GET /api/rooms", () => {
  it("lists created rooms", async () => {
    const name = freshRoomName();
    const created = await app.inject({
      method: "POST",
      url: "/api/rooms",
      payload: { name },
    });
    const id = created.json<Room>().id;

    const res = await app.inject({ method: "GET", url: "/api/rooms" });
    expect(res.statusCode).toBe(200);
    const rooms = res.json<Room[]>();
    const mine = rooms.find((r) => r.id === id);
    expect(mine).toBeDefined();
    expect(mine!.name).toBe(name);

    const del = await app.inject({ method: "DELETE", url: `/api/rooms/${id}` });
    expect(del.statusCode).toBe(204);
  });
});

describe("DELETE /api/rooms/:id", () => {
  it("removes the room from the listing", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/rooms",
      payload: { name: freshRoomName() },
    });
    const id = created.json<Room>().id;

    const del = await app.inject({ method: "DELETE", url: `/api/rooms/${id}` });
    expect(del.statusCode).toBe(204);

    const res = await app.inject({ method: "GET", url: "/api/rooms" });
    expect(res.json<Room[]>().some((r) => r.id === id)).toBe(false);
  });
});