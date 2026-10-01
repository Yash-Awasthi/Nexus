// SPDX-License-Identifier: Apache-2.0
// Only the isolated E2E API loads this: incoming HTTP remains available, while
// model discovery, search providers, telemetry and other outbound I/O fail closed.
const net = require("node:net");
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const [options] = Array.isArray(args[0]) ? args[0] : net._normalizeArgs(args);
  // Node-pty uses named pipes. Local IPC is not an outbound network connection.
  if (
    typeof options.path === "string" &&
    (process.platform !== "win32" || options.path.startsWith("\\\\.\\pipe\\"))
  ) {
    return connect.apply(this, args);
  }
  throw new Error("Outbound connections are disabled in offline E2E");
};
globalThis.fetch = async function () {
  throw new Error("Outbound fetch is disabled in offline E2E");
};
