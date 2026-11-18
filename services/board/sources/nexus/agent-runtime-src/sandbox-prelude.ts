// SPDX-License-Identifier: Apache-2.0
/**
 * First lines of every sandboxed child Node (run under `--permission`, which
 * leaves the network open): empty the environment and refuse TCP, UDP, DNS
 * and fetch, so code cannot read the host's keys or send data out.
 */
export const SANDBOX_PRELUDE = `
for (const k of Object.keys(process.env)) delete process.env[k];
{
  const deny = () => { throw new Error("network access is disabled in the sandbox"); };
  const net = require("node:net");
  net.Socket.prototype.connect = deny;
  net.connect = net.createConnection = deny;
  const dgram = require("node:dgram");
  dgram.createSocket = deny;
  for (const k of ["bind", "connect", "send"]) dgram.Socket.prototype[k] = deny;
  const dns = require("node:dns");
  for (const o of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype])
    for (const k of Object.getOwnPropertyNames(o))
      if (typeof o[k] === "function" && k !== "constructor" && k !== "Resolver") o[k] = deny;
  globalThis.fetch = undefined;
}
`;
