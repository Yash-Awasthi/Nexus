// SPDX-License-Identifier: Apache-2.0
// Unit-test-only transport guard: permit servers created by this process and
// the CLI fixture's explicit loopback API, never arbitrary existing services.
const net = require("node:net");
const servers = new Set();
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  this.once("listening", () => {
    const address = this.address();
    if (address && typeof address === "object") {
      servers.add(address.port);
      this.once("close", () => servers.delete(address.port));
    }
  });
  return listen.apply(this, args);
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const [options] = Array.isArray(args[0]) ? args[0] : net._normalizeArgs(args);
  if (
    typeof options.path === "string" &&
    (process.platform !== "win32" || options.path.startsWith("\\\\.\\pipe\\"))
  ) {
    return connect.apply(this, args);
  }
  const host = options.host ?? "localhost";
  const port = Number(options.port);
  // Pinned-fetch tests inject their resolver. Let it exercise its SSRF checks,
  // then permit only a loopback address belonging to a server we created.
  if (typeof options.lookup === "function" && /\.(test|evil)$/.test(host)) {
    const lookup = options.lookup;
    options.lookup = (hostname, lookupOptions, callback) => {
      lookup(hostname, lookupOptions, (error, address, family) => {
        if (error) return callback(error);
        const addresses = Array.isArray(address) ? address.map((item) => item.address) : [address];
        if (servers.has(port) && addresses.every((ip) => ["127.0.0.1", "::1"].includes(ip))) {
          return callback(null, address, family);
        }
        callback(new Error("Outbound TCP disabled in isolated unit tests"));
      });
    };
    return connect.call(
      this,
      options,
      ...(Array.isArray(args[0]) ? args[0].slice(1) : args.slice(1)),
    );
  }
  let fixturePort;
  try {
    const fixture = new URL(process.env.NEXUS_API_URL ?? "");
    if (fixture.hostname === "127.0.0.1") fixturePort = Number(fixture.port);
  } catch {
    /* no child-process fixture configured */
  }
  if (
    ["127.0.0.1", "::1", "localhost"].includes(host) &&
    (servers.has(port) || (port > 1024 && port === fixturePort))
  ) {
    return connect.apply(this, args);
  }
  throw new Error("Outbound TCP disabled in isolated unit tests");
};
