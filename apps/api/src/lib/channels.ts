// SPDX-License-Identifier: Apache-2.0
/**
 * Stream channels — the server end of @nexus/stream-recovery's ChannelReader
 * and ChannelWriter. A channel has one write key and one read key; text the
 * writer sends reaches every connected reader, and is kept so a reader that
 * joins late or reconnects after a drop replays everything first.
 *
 * WS /api/ws/channels/:id?key=&dir=read|write
 */
import crypto from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import type { StreamChannelRef } from "@nexus/stream-recovery";
import { WebSocketServer, type WebSocket } from "ws";

interface Chan {
  writeKey: string;
  readKey: string;
  frames: string[];
  bytes: number;
  closed: boolean;
  readers: Set<WebSocket>;
  expiresAt: number;
}

const TTL_MS = 60 * 60 * 1000;
const MAX_BYTES = 1024 * 1024;
const MAX_CHANNELS = 500;
const channels = new Map<string, Chan>();

function sweep(): void {
  const now = Date.now();
  for (const [id, c] of channels) if (c.expiresAt < now) drop(id);
  // Oldest first: Map keeps insertion order.
  while (channels.size >= MAX_CHANNELS) drop(channels.keys().next().value!);
}

function drop(id: string): void {
  const c = channels.get(id);
  if (!c) return;
  for (const r of c.readers) r.close(1000, "channel_close");
  channels.delete(id);
}

/** A new channel and the two refs that open it. */
export function createChannel(): { writerRef: StreamChannelRef; readerRef: StreamChannelRef } {
  sweep();
  const id = crypto.randomUUID();
  const c: Chan = {
    writeKey: crypto.randomBytes(24).toString("base64url"),
    readKey: crypto.randomBytes(24).toString("base64url"),
    frames: [],
    bytes: 0,
    closed: false,
    readers: new Set(),
    expiresAt: Date.now() + TTL_MS,
  };
  channels.set(id, c);
  return {
    writerRef: { channel_id: id, access_key: c.writeKey, direction: "write" },
    readerRef: { channel_id: id, access_key: c.readKey, direction: "read" },
  };
}

/** Append a frame and fan it out. Past MAX_BYTES a late reader misses the overflow. */
export function writeChannel(id: string, text: string): void {
  const c = channels.get(id);
  if (!c || c.closed) return;
  if (c.bytes + text.length <= MAX_BYTES) {
    c.frames.push(text);
    c.bytes += text.length;
  }
  for (const r of c.readers) r.send(text);
}

/** No more frames: readers are closed once they have everything. */
export function closeChannel(id: string): void {
  const c = channels.get(id);
  if (!c || c.closed) return;
  c.closed = true;
  for (const r of c.readers) r.close(1000, "channel_close");
  c.readers.clear();
}

const PATH = /^\/api\/ws\/channels\/([^/?]+)$/;

/** Accept channel sockets on the HTTP server; everything else is left alone. */
export function attachChannels(server: Server): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "", "http://x");
    const id = PATH.exec(url.pathname)?.[1];
    if (!id) return;
    const c = channels.get(id);
    const dir = url.searchParams.get("dir");
    const key = url.searchParams.get("key") ?? "";
    const want = dir === "write" ? c?.writeKey : dir === "read" ? c?.readKey : undefined;
    const ok =
      c !== undefined &&
      want !== undefined &&
      want.length === key.length &&
      crypto.timingSafeEqual(Buffer.from(want), Buffer.from(key));
    if (!ok || (dir === "write" && c.closed)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (dir === "read") {
        for (const f of c.frames) ws.send(f);
        if (c.closed) return ws.close(1000, "channel_close");
        c.readers.add(ws);
        ws.on("close", () => c.readers.delete(ws));
        return;
      }
      ws.on("message", (data, isBinary) => {
        // ponytail: text frames only; binary would need its own replay buffer and a reader for it.
        if (!isBinary) writeChannel(id, String(data));
      });
      ws.on("close", () => closeChannel(id));
    });
  });
}
