// SPDX-License-Identifier: Apache-2.0
/**
 * browser-task — `browser.task` BullMQ job: run a browser-agent session to
 * completion outside the API process (§15.4).
 *
 * The loop, the action vocabulary and the decision prompt all come from
 * @nexus/browser-automation, so a task behaves the same whichever process
 * picks it up. What differs is only what this process has: its own browser,
 * its own model key, and a direct write to the session store the API reads.
 *
 * The worker image ships Chromium through patchright; BROWSER_CDP_URL points at a
 * hosted browser instead. Outside the image, with neither, the job records that
 * on the session rather than failing silently.
 */

import {
  runBrowserAgentTask,
  browserDecisionMessages,
  parseBrowserDecision,
  type BrowserAgentPage,
  type BrowserAgentSession,
} from "@nexus/browser-automation";
import { AnthropicDriver, GroqDriver, type LlmDriver } from "@nexus/llm-drivers";
import { pinnedFetch } from "@nexus/runtime";
import { isPatchrightAvailable, PatchrightDriver, StealthBrowser } from "@nexus/stealth-browser";
import { Pool } from "pg";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BrowserTaskPayload {
  sessionId: string;
}

interface BrowserTaskResult {
  sessionId: string;
  status: BrowserAgentSession["status"];
  steps: number;
  result?: string;
  error?: string;
}

/** The collection PersistentStore keeps browser-agent sessions under. */
const COLLECTION = "browser_agent_sessions";

const NO_BROWSER =
  "No browser engine available in the worker. Set BROWSER_CDP_URL to a hosted browser " +
  "(Browserbase/Steel), or install patchright into the worker image.";

// ── Session store ─────────────────────────────────────────────────────────────

let _pool: Pool | null = null;

/** The shared `nexus_kv` pool, or null when the worker has no database. */
function pool(): Pool | null {
  if (!process.env.DATABASE_URL) return null;
  _pool ??= new Pool({ connectionString: process.env.DATABASE_URL });
  return _pool;
}

async function loadSession(id: string): Promise<BrowserAgentSession | null> {
  const p = pool();
  if (!p) return null;
  const { rows } = await p.query<{ data: BrowserAgentSession }>(
    "SELECT data FROM nexus_kv WHERE collection = $1 AND id = $2",
    [COLLECTION, id],
  );
  return rows[0]?.data ?? null;
}

async function saveSession(session: BrowserAgentSession): Promise<void> {
  const p = pool();
  if (!p) return;
  await p.query(
    "INSERT INTO nexus_kv (collection,id,data) VALUES($1,$2,$3) ON CONFLICT (collection,id) DO UPDATE SET data=$3",
    [COLLECTION, session.id, session],
  );
}

// ── Model ─────────────────────────────────────────────────────────────────────

const GROQ_MODEL = "openai/gpt-oss-120b";
const ANTHROPIC_MODEL = "claude-sonnet-4-5";

/** Groq for the decision loop, as the API does; Anthropic when there is no key. */
function makeDriver(): { driver: LlmDriver; model: string } | null {
  if (process.env.GROQ_API_KEY) {
    return {
      driver: new GroqDriver({ apiKey: process.env.GROQ_API_KEY, model: GROQ_MODEL }),
      model: GROQ_MODEL,
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      driver: new AnthropicDriver({ apiKey: process.env.ANTHROPIC_API_KEY }),
      model: ANTHROPIC_MODEL,
    };
  }
  return null;
}

// ── Handler ───────────────────────────────────────────────────────────────────

interface BrowserTaskDeps {
  load?: (id: string) => Promise<BrowserAgentSession | null>;
  save?: (session: BrowserAgentSession) => Promise<void>;
  browser?: { withPage<T>(fn: (page: BrowserAgentPage) => Promise<T>): Promise<T> };
  driver?: { driver: LlmDriver; model: string } | null;
}

export async function handleBrowserTaskJob(
  payload: BrowserTaskPayload,
  deps: BrowserTaskDeps = {},
): Promise<BrowserTaskResult> {
  const load = deps.load ?? loadSession;
  const save = deps.save ?? saveSession;

  const session = await load(payload.sessionId);
  if (!session) {
    return { sessionId: payload.sessionId, status: "error", steps: 0, error: "session not found" };
  }

  const fail = async (error: string): Promise<BrowserTaskResult> => {
    session.status = "error";
    session.error = error;
    await save(session);
    return { sessionId: session.id, status: "error", steps: session.steps.length, error };
  };

  const driver = deps.driver !== undefined ? deps.driver : makeDriver();
  if (!driver) return fail("No model key configured for the browser agent loop.");

  let browser = deps.browser;
  if (!browser) {
    // isPatchrightAvailable() is also true when BROWSER_CDP_URL is set, which
    // is the whole point: the engine is a deployment choice, not a code one.
    if (!(await isPatchrightAvailable())) return fail(NO_BROWSER);
    browser = new StealthBrowser({
      driver: new PatchrightDriver({ requestVia: pinnedFetch }),
    }) as unknown as {
      withPage<T>(fn: (page: BrowserAgentPage) => Promise<T>): Promise<T>;
    };
  }

  try {
    await runBrowserAgentTask(session, {
      withPage: (fn) => browser.withPage(fn),
      decide: async (context) => {
        const { system, user } = browserDecisionMessages(context);
        try {
          const r = await driver.driver.complete({
            model: driver.model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            maxTokens: 400,
          });
          return parseBrowserDecision((r.content ?? "").trim());
        } catch {
          return parseBrowserDecision("");
        }
      },
      save,
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }

  return {
    sessionId: session.id,
    status: session.status,
    steps: session.steps.length,
    ...(session.result !== undefined ? { result: session.result } : {}),
  };
}
