// SPDX-License-Identifier: Apache-2.0
// oxlint-disable typescript/no-unsafe-assignment typescript/no-unsafe-call typescript/no-unsafe-member-access typescript/no-unsafe-return typescript/no-unsafe-argument
// Fake LSP server for @nexus/lsp tests. No dependencies, no real language server.
//
// Flags:
//   --argv                  emit one `$fake/argv` notification with the args after
//                           the flag, then exit (used by the spawn/argv tests)
//   --delays <json>         per-method response delay in ms, e.g. {"initialize":50}
//   --crash-on <method>     exit(17) when that method arrives, before responding
//   --ignore-shutdown       never answer `shutdown` and ignore the `exit` notification
//   --start-count <file>    append one line per process start
//   --request-log <file>    append one line per request method
//   --diagnostics-delay <ms> delay publishDiagnostics after didOpen/didChange
//   --no-diagnostics        never publish diagnostics
//   --many-locations <n>    return n locations for definition/references
//   --big-hover <n>         return n bytes of hover text

import { appendFileSync } from "node:fs";
import process from "node:process";

const argv = process.argv.slice(2);

function argValue(flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function write(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  process.stdout.write(Buffer.concat([header, body]));
}

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

function logLine(file, line) {
  if (!file) return;
  try {
    appendFileSync(file, `${line}\n`);
  } catch {
    // Logging is best-effort; tests that need it create the directory first.
  }
}

const manyLocations = Number(argValue("--many-locations") ?? 0);
const bigHover = Number(argValue("--big-hover") ?? 0);
const requestLog = argValue("--request-log");

function location(uri, index = 0) {
  return {
    uri,
    range: {
      start: { line: index, character: 0 },
      end: { line: index, character: 1 },
    },
  };
}

function locations(uri) {
  if (manyLocations > 0) {
    return Array.from({ length: manyLocations }, (_, index) => location(uri, index));
  }
  return [location(uri)];
}

const HANDLERS = {
  initialize(params) {
    if (argv.includes("--crash-on") && argValue("--crash-on") === "initialize") {
      process.exit(17);
    }
    write({ jsonrpc: "2.0", method: "$fake/initialize", params });
    return {
      capabilities: {
        textDocumentSync: 1,
        definitionProvider: true,
        referencesProvider: true,
        hoverProvider: true,
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
        renameProvider: true,
        codeActionProvider: true,
      },
      serverInfo: { name: "fake-lsp", version: "1.0.0" },
    };
  },
  "textDocument/definition": (params) => locations(params.textDocument.uri),
  "textDocument/references": (params) => locations(params.textDocument.uri),
  "textDocument/hover": () =>
    bigHover > 0
      ? { contents: { kind: "markdown", value: "h".repeat(bigHover) } }
      : { contents: { kind: "markdown", value: "fake hover" } },
  "textDocument/documentSymbol": () => [
    { name: "fakeSymbol", kind: 12, range, selectionRange: range },
  ],
  "workspace/symbol": (params) => [
    {
      name: `fakeWorkspaceSymbol:${params.query ?? ""}`,
      kind: 12,
      location: location("file:///fake/workspace.ts"),
    },
  ],
  "textDocument/rename": (params) => ({
    changes: {
      [params.textDocument.uri]: [{ range, newText: params.newName ?? "renamed" }],
    },
  }),
  "textDocument/codeAction": (params) => [
    {
      title: "Fake fix",
      kind: "quickfix",
      edit: { changes: { [params.textDocument.uri]: [{ range, newText: "fixed" }] } },
    },
  ],
  "nexus/env": () => process.env,
};

function handleRequest(message) {
  const method = message.method;
  logLine(requestLog, method);
  if (method === "shutdown") {
    if (argv.includes("--ignore-shutdown")) return;
    respond(message.id, null);
    return;
  }
  const handler = HANDLERS[method];
  if (!handler) {
    respondError(message.id, -32601, `method not found: ${method}`);
    return;
  }
  respond(message.id, handler(message.params ?? {}));
}

function start() {
  let delays = {};
  try {
    delays = JSON.parse(argValue("--delays") ?? "{}");
  } catch {
    delays = {};
  }
  const crashOn = argValue("--crash-on");
  logLine(argValue("--start-count"), String(process.pid));

  let buffer = Buffer.alloc(0);
  const separator = Buffer.from("\r\n\r\n", "ascii");

  function publishDiagnostics(document) {
    if (argv.includes("--no-diagnostics")) return;
    const send = () =>
      write({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri: document.uri,
          version: document.version,
          diagnostics: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              severity: 1,
              message: "fake diagnostic",
            },
          ],
        },
      });
    const delay = Number(argValue("--diagnostics-delay") ?? 0);
    if (delay > 0) setTimeout(send, delay);
    else send();
  }

  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf(separator);
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        process.exit(1);
        return;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + separator.length;
      if (buffer.length - bodyStart < length) return;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.subarray(bodyStart + length);

      let message;
      try {
        message = JSON.parse(body);
      } catch {
        process.exit(1);
        return;
      }

      if (message.method === undefined) continue;
      if (message.id === undefined) {
        if (message.method === "initialized") {
          write({ jsonrpc: "2.0", method: "$fake/initialized", params: {} });
        } else if (
          message.method === "textDocument/didOpen" ||
          message.method === "textDocument/didChange"
        ) {
          publishDiagnostics(message.params.textDocument);
        } else if (message.method === "exit") {
          if (!argv.includes("--ignore-shutdown")) setTimeout(() => process.exit(0), 0);
        }
        continue;
      }
      if (crashOn !== undefined && message.method === crashOn) {
        process.exit(17);
        return;
      }

      const delay = Number(delays[message.method] ?? 0);
      if (delay > 0) setTimeout(() => handleRequest(message), delay);
      else handleRequest(message);
    }
  });

  process.stdin.on("end", () => {
    if (!argv.includes("--ignore-shutdown")) process.exit(0);
  });
}

const stderrBytes = Number(argValue("--stderr-bytes") ?? 0);
if (stderrBytes > 0) process.stderr.write("e".repeat(stderrBytes));

if (argv.includes("--argv")) {
  const start = argv.indexOf("--argv");
  write({ jsonrpc: "2.0", method: "$fake/argv", params: { argv: argv.slice(start + 1) } });
  setTimeout(() => process.exit(0), 20);
} else {
  start();
}
