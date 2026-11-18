/**
 * What a phone needs to wake this PC with a magic packet: the MAC of every physical
 * network adapter (a sleeping PC often wakes on the wired one even when it is used
 * over Wi-Fi) and the broadcast address of each network the PC is on now.
 */
import os from "node:os";
import { execFile } from "node:child_process";

const normalize = (mac) => mac.replace(/[^0-9a-f]/gi, "").toUpperCase().replace(/(..)(?!$)/g, "$1:");

/** Directed broadcast of an IPv4 address and netmask, e.g. 192.168.1.255. */
export function broadcastOf(address, netmask) {
  const a = address.split(".").map(Number);
  const m = netmask.split(".").map(Number);
  return a.map((o, i) => (o | (~m[i] & 255)) & 255).join(".");
}

function ps(command) {
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
      { windowsHide: true, timeout: 15000 }, (err, out) => resolve(err ? "" : String(out)));
  });
}

/** { macs: [{ mac, name }], broadcasts: [ip] }. */
export async function wakeTargets() {
  const nets = Object.values(os.networkInterfaces()).flat().filter((n) => n && !n.internal);
  const broadcasts = [...new Set(nets.filter((n) => n.family === "IPv4" && !n.address.startsWith("169.254."))
    .map((n) => broadcastOf(n.address, n.netmask)))];
  let macs = [];
  if (process.platform === "win32") {
    // Disconnected adapters are included: the wired port is the one most likely to wake the PC.
    const out = await ps("Get-NetAdapter -Physical | ForEach-Object { $_.MacAddress + '|' + $_.InterfaceDescription }");
    macs = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const [mac, name] = l.split("|");
      return { mac: normalize(mac), name };
    });
  }
  if (!macs.length) {
    macs = nets.filter((n) => n.mac && n.mac !== "00:00:00:00:00:00").map((n) => ({ mac: normalize(n.mac), name: "" }));
  }
  const seen = new Set();
  return { macs: macs.filter((m) => m.mac.length === 17 && !seen.has(m.mac) && seen.add(m.mac)), broadcasts };
}

/** Physical adapters Windows lets wake the PC; empty means a magic packet cannot wake it. */
export async function wakeArmedAdapters() {
  if (process.platform !== "win32") return null;
  const [armed, adapters] = await Promise.all([
    ps("powercfg /devicequery wake_armed"),
    ps("Get-NetAdapter -Physical | ForEach-Object { $_.InterfaceDescription }"),
  ]);
  const names = armed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return adapters.split(/\r?\n/).map((l) => l.trim()).filter((a) => a && names.includes(a));
}
