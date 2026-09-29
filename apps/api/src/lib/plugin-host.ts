// SPDX-License-Identifier: Apache-2.0
/**
 * The host bridge a sandboxed plugin reaches its capabilities through: a
 * localhost HTTP server that lives for one run, answers only the run's random
 * token, and serves only capabilities the plugin was granted and the host backs.
 *
 *   POST /call  { capability, input }  →  { result } | { error }
 */
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import type { PluginBridge } from "@nexus/plugin-sdk";

export type HostHandler = (input: Record<string, unknown>) => Promise<unknown>;

const MAX_BODY = 64 * 1024;

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Open a bridge serving `handlers` for the capabilities in `granted`, run `fn`, then close it. */
export async function withPluginBridge<T>(
  granted: readonly string[],
  handlers: Record<string, HostHandler>,
  fn: (bridge: PluginBridge) => Promise<T>,
): Promise<T> {
  const token = crypto.randomBytes(32).toString("hex");
  const want = Buffer.from(`Bearer ${token}`);
  const server = http.createServer((req, res) => {
    const got = Buffer.from(req.headers.authorization ?? "");
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want))
      return send(res, 401, { error: "unauthorized" });
    if (req.method !== "POST" || req.url !== "/call") return send(res, 404, { error: "not_found" });
    let raw = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) req.destroy();
      else raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      let call: { capability?: unknown; input?: unknown };
      try {
        call = JSON.parse(raw) as typeof call;
      } catch {
        return send(res, 400, { error: "body must be JSON" });
      }
      const capability = String(call.capability ?? "");
      const handler = granted.includes(capability) ? handlers[capability] : undefined;
      if (!handler)
        return send(res, 403, {
          error: `capability "${capability}" is not granted to this plugin`,
        });
      const input =
        call.input && typeof call.input === "object" ? (call.input as Record<string, unknown>) : {};
      handler(input).then(
        (result) => send(res, 200, { result: result ?? null }),
        (err: unknown) =>
          send(res, 500, { error: err instanceof Error ? err.message : String(err) }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn({ url: `http://127.0.0.1:${port}`, token });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
