// Claude Code permission prompts answered from the phone. Agents the daemon starts get a
// PermissionRequest hook that posts here, and the request waits as a proposal until decided.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { configDir } from "./config.js";
import * as proposals from "./proposals.js";
import { writeFileAtomic } from "./atomic_write.js";

// Separate from the master token: an agent can read its own environment, and this key only asks.
const key = crypto.randomBytes(24).toString("hex");
const WAIT_MS = 280_000;
const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "approve-hook.js");
const trusted = new Set();
let url = null;
let settingsFile = null;

export function init(cliPort) {
  url = `http://127.0.0.1:${cliPort}/approval`;
  settingsFile = path.join(configDir, "claude-approval.json");
  const command = `"${process.execPath}" "${HOOK}"`;
  const settings = { hooks: { PermissionRequest: [{ matcher: "*", hooks: [{ type: "command", command, timeout: 300 }] }] } };
  try {
    fs.mkdirSync(configDir, { recursive: true });
    writeFileAtomic(settingsFile, JSON.stringify(settings, null, 2));
  } catch (e) {
    settingsFile = null;
    console.warn(`  approvals unavailable: ${e.message}`);
  }
}

/** Extra arguments for a `claude` launch so its permission prompts reach the phone. */
export function claudeArgs() {
  return settingsFile ? ["--settings", settingsFile] : [];
}

export function env(owner) {
  return url ? { RH_APPROVAL_URL: url, RH_APPROVAL_KEY: key, RH_APPROVAL_OWNER: owner } : {};
}

export function keyMatches(given) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** "Allow all" on the phone: later requests from the same agent session skip the prompt. */
export function trust(agentSession) {
  if (agentSession) trusted.add(String(agentSession));
}

function describe(tool, input) {
  const i = input || {};
  if (tool === "Bash") return { type: "command_execute", summary: String(i.command || "").slice(0, 300) };
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) return { type: "file_write", summary: `${tool} ${i.file_path || i.notebook_path || ""}` };
  if (["WebFetch", "WebSearch"].includes(tool)) return { type: "network_request", summary: `${tool} ${i.url || i.query || ""}` };
  return { type: "tool", summary: tool };
}

/** Resolves to "allow", "deny" or "none" (nobody answered; the agent's own prompt takes over). */
export async function request({ owner, agentSession, tool, input, cwd }) {
  if (agentSession && trusted.has(String(agentSession))) return { decision: "allow" };
  const p = proposals.create({
    ...describe(String(tool || ""), input),
    detail: { tool: String(tool || ""), input: input || {}, cwd: cwd || "", agentSession: agentSession || "" },
    sessionId: owner || "unknown",
  });
  const { status } = await proposals.waitForDecision(p.id, WAIT_MS);
  if (status === "approved") return { decision: "allow" };
  if (status === "rejected") return { decision: "deny", message: "Denied from the PocketDesk phone app" };
  return { decision: "none" };
}
