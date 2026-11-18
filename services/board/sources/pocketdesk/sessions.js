import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { EventEmitter } from "node:events";
import pty from "node-pty";
import * as toolApproval from "./tool_approval.js";

// npm installs node-pty's macOS spawn-helper without its exec bit, and every spawn then fails with posix_spawnp.
if (process.platform === "darwin") {
  try {
    const dir = path.join(path.dirname(createRequire(import.meta.url).resolve("node-pty/package.json")), "prebuilds");
    for (const d of fs.readdirSync(dir)) if (d.startsWith("darwin")) fs.chmodSync(path.join(dir, d, "spawn-helper"), 0o755);
  } catch { /* built from source: no prebuilds to fix */ }
}

const IS_WIN = process.platform === "win32";

const SCROLLBACK = 100_000;
const MAX_SESSIONS = 50; // guard against unbounded session growth
const REAP_INTERVAL_MS = 60_000; // sweep dead sessions every 60s
const MAX_CHUNKS = 2_000; // per-session chunk ring for missed-output backfill
// Live sessions idle longer than this are killed (minutes; 0/env RH_IDLE_KILL_MINUTES disables).
const IDLE_KILL_MS = (Number(process.env.RH_IDLE_KILL_MINUTES) || 0) * 60_000;
const sessions = new Map(); // id -> { id, harnessId, cwd, pty, decoder, scrollback, chunks, seq, subs:Set, exitCode, endedAt, lastActivity }
let nextId = 1;

// ── Session events (output/exit) ───────────────────────────────────────────
// Consumed by the activity monitor and session recorder in server.js.
export const sessionEvents = new EventEmitter();
sessionEvents.setMaxListeners(50);

// ── Periodic dead-session reaper ───────────────────────────────────────────
// Sessions whose PTY has exited (exitCode !== null) are retained briefly for
// scrollback replay, but accumulate forever without reaping. This timer
// removes dead sessions after 5 minutes, freeing memory and the session map.
let _reapTimer = null;
function startReaper() {
  if (_reapTimer) return;
  _reapTimer = setInterval(_reap, REAP_INTERVAL_MS);
  _reapTimer.unref?.(); // don't keep the event loop alive solely for reaping
}

function _reap() {
  const now = Date.now();
  const DEAD_SESSION_TTL_MS = 5 * 60_000; // keep dead sessions for 5 min for replay
  let reaped = 0;
  for (const [id, s] of sessions) {
    if (s.exitCode !== null && s.endedAt && now - s.endedAt > DEAD_SESSION_TTL_MS) {
      // Clean up the PTY if still lingering
      try { s.pty.kill(); } catch {}
      s.subs.clear();
      sessions.delete(id);
      sessionEvents.emit("gone", { id });
      reaped++;
      continue;
    }
    // Idle reaper (persistent-terminal-api pattern): kill live sessions idle too long.
    if (IDLE_KILL_MS > 0 && s.exitCode === null && now - s.lastActivity > IDLE_KILL_MS) {
      try { s.pty.kill(); } catch {}
      s.exitCode = -1;
      s.endedAt = now;
      s.subs.clear();
      sessionEvents.emit("gone", { id });
      console.log(`[sessions] reaped idle session ${id} (idle > ${IDLE_KILL_MS / 60_000}min)`);
      reaped++;
    }
  }
  if (reaped > 0) console.log(`[sessions] reaped ${reaped} dead sessions`);
}

function stopReaper() {
  if (_reapTimer) clearInterval(_reapTimer);
  _reapTimer = null;
}

// Export for graceful shutdown wiring.
export { stopReaper };

// ponytail: the PC's screen in 9x19 cells once the desktop module has listed monitors, else 120x32;
// a PC-side viewer (browser terminal, `pocketdesk attach`) resizes to its real window.
let pcSize = { cols: 120, rows: 32 };
export function setPcScreen(w, h) {
  if (w > 0 && h > 0) pcSize = { cols: Math.min(500, Math.floor(w / 9)), rows: Math.min(200, Math.floor(h / 19)) };
}

export function create({ harnessId, bin, cwd, args = [] }, broadcast) {
  // Session cap: if at the limit, evict the oldest dead session first.
  // If no dead sessions exist, reject the create (prevents unbounded growth).
  if (sessions.size >= MAX_SESSIONS) {
    let oldestDead = null;
    for (const [sid, s] of sessions) {
      if (s.exitCode !== null) {
        if (!oldestDead || s.endedAt < oldestDead[1].endedAt) oldestDead = [sid, s];
      }
    }
    if (oldestDead) {
      try { oldestDead[1].pty.kill(); } catch {}
      oldestDead[1].subs.clear();
      sessions.delete(oldestDead[0]);
    } else {
      // All sessions are live — can't create without exceeding the cap.
      throw new Error(`Session limit reached (${MAX_SESSIONS} active). Kill a session first.`);
    }
  }
  startReaper();
  const id = "s" + nextId++;
  const dir = cwd && cwd.trim() ? path.resolve(cwd.replace(/^~(?=$|\/|\\)/, os.homedir())) : os.homedir();
  // cmd.exe /c on Windows wraps the real bin in a PTY; on POSIX spawn the bin
  // directly (node-pty cannot run cmd.exe there).
  if (harnessId === "claude") args = [...args, ...toolApproval.claudeArgs()];
  const env = harnessId === "claude" ? { ...process.env, ...toolApproval.env(id) } : process.env;
  const proc = IS_WIN
    ? pty.spawn("cmd.exe", ["/c", bin, ...args], { name: "xterm-256color", ...pcSize, cwd: dir, env })
    : pty.spawn(bin, args, { name: "xterm-256color", ...pcSize, cwd: dir, env });
  const s = { id, harnessId, cwd: dir, ...pcSize, pty: proc, decoder: new StringDecoder("utf8"), scrollback: "", chunks: [], seq: 0, subs: new Set(), exitCode: null, lastActivity: Date.now() };
  sessions.set(id, s);
  sessionEvents.emit("create", { id, harnessId: s.harnessId, cwd: dir });
  proc.onData((data) => {
    const text = s.decoder.write(Buffer.from(data));
    if (!text) return;
    s.scrollback = (s.scrollback + text).slice(-SCROLLBACK);
    s.lastActivity = Date.now();
    s.seq++;
    s.chunks.push({ seq: s.seq, text });
    if (s.chunks.length > MAX_CHUNKS) s.chunks.shift();
    sessionEvents.emit("output", { id, text });
    for (const ws of s.subs) send(ws, { type: "out", id, seq: s.seq, data: b64(text) });
  });
  proc.onExit(({ exitCode }) => {
    s.exitCode = exitCode;
    s.endedAt = Date.now();
    s.decoder.end();
    sessionEvents.emit("exit", { id, code: exitCode });
    broadcast({ type: "exit", id, code: exitCode });
    s.subs.clear();
  });
  return { id, harnessId, cwd: dir };
}

export function get(id) {
  return sessions.get(id);
}

export function summary() {
  return [...sessions.values()]
    .filter((s) => s.exitCode === null)
    .map(({ id, harnessId, cwd, cols, rows }) => ({ id, harnessId, cwd, cols, rows }));
}

export function attach(id, ws, { since } = {}) {
  const s = sessions.get(id);
  if (!s || s.exitCode !== null) return false;
  s.subs.add(ws);
  ws._subs.add(id);
  // Missed-output backfill (cc-pocket/gotty reconnect pattern): if the client
  // says "I have everything up to seq N" and the ring still covers N, send only
  // the chunks after N instead of a full scrollback replay.
  const oldest = s.chunks.length ? s.chunks[0].seq : s.seq + 1;
  if (Number.isFinite(since) && since >= 0 && since >= oldest - 1 && since <= s.seq) {
    for (const c of s.chunks) {
      if (c.seq > since) send(ws, { type: "out", id, seq: c.seq, data: b64(c.text) });
    }
    send(ws, { type: "replay", id, seq: s.seq, data: "", incremental: true, cols: s.cols, rows: s.rows });
  } else {
    send(ws, { type: "replay", id, seq: s.seq, data: b64(s.scrollback), cols: s.cols, rows: s.rows });
  }
  return true;
}

export function detach(ws, id) {
  if (id) {
    const s = sessions.get(id);
    if (s) s.subs.delete(ws);
    ws._subs.delete(id);
    return;
  }
  // Chat keys ("chat:<id>") share the set and are left for chat.detach, which runs next.
  for (const sid of ws._subs) {
    if (sid.startsWith("chat:")) continue;
    sessions.get(sid)?.subs.delete(ws);
    ws._subs.delete(sid);
  }
}

export function write(id, text) {
  const s = sessions.get(id);
  if (!s || s.exitCode !== null) return false;
  s.lastActivity = Date.now();
  s.pty.write(text);
  return true;
}

export function resize(id, cols, rows) {
  const s = sessions.get(id);
  if (!s || s.exitCode !== null) return false;
  const c = Math.max(2, Math.min(500, cols | 0));
  const r = Math.max(2, Math.min(200, rows | 0));
  try {
    s.pty.resize(c, r);
  } catch {}
  s.cols = c;
  s.rows = r;
  // Viewers that never size the terminal themselves (the phone) draw the same grid.
  for (const ws of s.subs) send(ws, { type: "size", id, cols: c, rows: r });
  sessionEvents.emit("resize", { id, cols: c, rows: r });
  return true;
}

// The pty child leads its own session and process group, so signalling the group takes the agent's children too.
function hangUpGroup(s) {
  if (s.pty.pid) try { process.kill(-s.pty.pid, "SIGHUP"); } catch {}
}

export function kill(id) {
  const s = sessions.get(id);
  if (!s || s.exitCode !== null) return false;
  const killPty = () => { try { s.pty.kill(); } catch {} };
  if (IS_WIN && s.pty.pid) {
    // Tree-kill the wrapper + children so agents don't keep running orphaned; the wrapper must outlive the walk.
    execFile("taskkill", ["/PID", String(s.pty.pid), "/T", "/F"], { timeout: 5000, windowsHide: true }, killPty);
  } else {
    hangUpGroup(s);
    killPty();
  }
  s.endedAt = Date.now();
  return true;
}

export function count() {
  return sessions.size;
}

export function countLive() {
  let n = 0;
  for (const s of sessions.values()) if (s.exitCode === null) n++;
  return n;
}

/**
 * Kill ALL live PTY sessions. Used by the graceful-shutdown handler so no
 * orphaned child processes survive the daemon's exit. Returns the count killed.
 */
export function killAll() {
  let killed = 0;
  for (const s of sessions.values()) {
    if (s.exitCode === null) {
      // Synchronous: the daemon exits right after, and the agent's own children must not outlive it.
      if (IS_WIN && s.pty.pid) try { execFileSync("taskkill", ["/PID", String(s.pty.pid), "/T", "/F"], { stdio: "ignore", timeout: 5000, windowsHide: true }); } catch {}
      else hangUpGroup(s);
      try { s.pty.kill(); } catch {}
      s.exitCode = -1; // mark as killed by shutdown
      s.endedAt = Date.now();
      s.subs.clear();
      killed++;
    }
  }
  return killed;
}

/**
 * Get all live session IDs (for shutdown logging).
 */
export function liveIds() {
  return [...sessions.values()].filter(s => s.exitCode === null).map(s => s.id);
}

function b64(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
