// SPDX-License-Identifier: Apache-2.0
/**
 * Browser-agent surface OWNER — extracted from api-bridge.ts.
 *
 * Headless navigation/scrape/screenshot plus the LLM-driven task loop and its
 * persisted sessions (owned per account, resumed after a restart). The bridge
 * passes its provider registry and default driver rather than this module
 * importing the bridge back.
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 */

import { pinnedFetch } from "@nexus/agent-core/kernel";
import {
  DEFAULT_MAX_AGENT_STEPS,
  applyBrowserAction,
  browserDecisionMessages,
  parseBrowserDecision,
  runBrowserAgentTask,
  type BrowserActionType,
  type BrowserAgentContext,
  type BrowserAgentDecision,
  type BrowserAgentSession,
  type BrowserAgentStep,
} from "@nexus/browser-automation";
import type { DriverRegistry, LlmRole } from "@nexus/llm/drivers";
import { PatchrightDriver, StealthBrowser, isPatchrightAvailable } from "@nexus/stealth-browser";
import type { FastifyInstance } from "fastify";

import { launchBrowserTask } from "../lib/agent-queue.ts";
import { PersistentStore } from "../lib/persistent-store.ts";
import { asUser } from "../lib/provider-keys.ts";
import { unsafeUrlReason } from "../lib/public-url.ts";

/** Bridge-owned provider wiring the agent loop asks for decisions. */
interface BrowserAgentRoutesDeps {
  getRegistry: () => DriverRegistry;
  getDriver: () => BrowserAgentDriver | undefined;
  defaultModel: () => string;
}

/** The slice of a driver the decision loop calls. */
interface BrowserAgentDriver {
  complete(opts: {
    model: string;
    messages: { role: LlmRole; content: string }[];
    maxTokens?: number;
  }): Promise<{ content: string }>;
}

const now = (): string => new Date().toISOString();
const systemMsg = (content: string) => ({ role: "system" as LlmRole, content });
const userMsg = (content: string) => ({ role: "user" as LlmRole, content });

/** Register /browser-agent/* (navigation, tasks, sessions). */
export async function browserAgentRoutes(
  app: FastifyInstance,
  deps: BrowserAgentRoutesDeps,
): Promise<void> {
  // ══════════════════════════════════════════════════════════════════════════
  // C.4 — browser-agent: headless web automation via @nexus/stealth-browser
  //        Routes: POST /browser-agent/navigate
  //                POST /browser-agent/scrape
  //                POST /browser-agent/screenshot
  //        Lazy-init: PatchrightDriver when available, else 503
  // ══════════════════════════════════════════════════════════════════════════

  let _stealthBrowser: StealthBrowser | null = null;

  /** The real browser, or a 503 error: a mock page would pass for a site that was never visited. */
  async function _getBrowser(): Promise<StealthBrowser> {
    if (_stealthBrowser) return _stealthBrowser;
    if (!(await isPatchrightAvailable()))
      throw Object.assign(new Error("Browsing needs Patchright installed on this machine."), {
        statusCode: 503,
      });
    _stealthBrowser = new StealthBrowser({
      driver: new PatchrightDriver({ requestVia: pinnedFetch }),
    });
    return _stealthBrowser;
  }

  /**
   * POST /browser-agent/navigate — navigate to a URL, return title + HTML content.
   * Body: { url: string }
   */
  app.post<{ Body: { url: string } }>(
    "/browser-agent/navigate",
    {
      schema: {
        body: {
          type: "object",
          required: ["url"],
          properties: { url: { type: "string", format: "uri", maxLength: 2048 } },
        },
      },
    },
    async (request, reply) => {
      const unsafe = unsafeUrlReason(request.body.url);
      if (unsafe) return reply.code(400).send({ error: unsafe });
      const browser = await _getBrowser();
      return browser.withPage(async (page) => {
        const nav = await page.goto(request.body.url);
        const content = await page.content();
        const title = await page.title();
        return reply.send({
          url: nav.url ?? request.body.url,
          statusCode: nav.status ?? null,
          title,
          content,
        });
      });
    },
  );

  /**
   * POST /browser-agent/scrape — navigate + extract text content via innerText eval.
   * Body: { url: string }
   */
  app.post<{ Body: { url: string } }>(
    "/browser-agent/scrape",
    {
      schema: {
        body: {
          type: "object",
          required: ["url"],
          properties: { url: { type: "string", format: "uri", maxLength: 2048 } },
        },
      },
    },
    async (request, reply) => {
      const unsafe = unsafeUrlReason(request.body.url);
      if (unsafe) return reply.code(400).send({ error: unsafe });
      const browser = await _getBrowser();
      return browser.withPage(async (page) => {
        await page.goto(request.body.url);
        const title = await page.title();
        // Extract visible text and all href links via JS eval
        const text = await page.evaluate<string>("document.body?.innerText ?? ''");
        const links = await page.evaluate<string[]>(
          "Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(h => h.startsWith('http')).slice(0, 100)",
        );
        return reply.send({ url: request.body.url, title, text, links });
      });
    },
  );

  /**
   * POST /browser-agent/screenshot — navigate + capture screenshot as base64 PNG.
   * Body: { url: string, fullPage?: boolean }
   */
  app.post<{ Body: { url: string; fullPage?: boolean } }>(
    "/browser-agent/screenshot",
    {
      schema: {
        body: {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string", format: "uri", maxLength: 2048 },
            fullPage: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const unsafe = unsafeUrlReason(request.body.url);
      if (unsafe) return reply.code(400).send({ error: unsafe });
      const browser = await _getBrowser();
      return browser.withPage(async (page) => {
        await page.goto(request.body.url);
        const title = await page.title();
        const screenshot = await page.screenshot({ fullPage: request.body.fullPage ?? false });
        return reply.send({
          url: request.body.url,
          title,
          screenshot: screenshot.toString("base64"),
          mimeType: "image/png",
        });
      });
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  // C.4b — browser-agent TASK LOOP: LLM-driven multi-step web automation.
  //        POST /browser-agent/tasks            — create + run a task session
  //        GET  /browser-agent/sessions         — list sessions
  //        GET  /browser-agent/sessions/:id     — session detail
  //        POST /browser-agent/sessions/:id/action — manual single action
  //
  //        The agent drives @nexus/stealth-browser (server-side / remote CDP).
  //        Each step: snapshot page → LLM picks action → execute → repeat.
  //        Requires a real browser (patchright + BROWSER_CDP_URL or local
  //        chromium); without one the routes answer 503.
  // ══════════════════════════════════════════════════════════════════════════

  const _browserSessions = new PersistentStore<BrowserAgentSession & { ownerId?: string | null }>(
    "browser_agent_sessions",
  );
  const _mySession = (req: { nexusUserId?: string }, s?: { ownerId?: string | null }) =>
    !!s && (s.ownerId ?? null) === (req.nexusUserId ?? null);
  await _browserSessions.load();
  // A session left running belonged to a process that is gone. The queue, or
  // with none this process as its owner, finishes it from the recorded steps.
  for (const stale of [..._browserSessions.values()]) {
    if (stale.status !== "running" && stale.status !== "pending") continue;
    void launchBrowserTask(stale.id).then(async (queued) => {
      if (!queued)
        await asUser(stale.ownerId ?? null, () => _runBrowserAgent(stale)).catch((e: unknown) =>
          _saveSession({
            ...stale,
            status: "error",
            error: e instanceof Error ? e.message : String(e),
          }),
        );
      return queued;
    });
  }
  const MAX_AGENT_STEPS = DEFAULT_MAX_AGENT_STEPS;

  /** Persist a session after mutating it — the store is not a live object. */
  function _saveSession(session: BrowserAgentSession & { ownerId?: string | null }): void {
    // The agent loop saves its own copy of the session, which does not carry the owner.
    const ownerId = session.ownerId ?? _browserSessions.get(session.id)?.ownerId ?? null;
    _browserSessions.set(session.id, { ...session, ownerId });
  }

  /** Ask the LLM for the next browser action given the current page state. */
  async function _nextBrowserAction(context: BrowserAgentContext): Promise<BrowserAgentDecision> {
    const { system, user } = browserDecisionMessages(context);
    // Groq for the decision loop: fast, and reliably available here.
    const reg = deps.getRegistry();
    const drv = reg.get("groq") ?? deps.getDriver();
    let raw = "";
    if (drv) {
      try {
        const r = await drv.complete({
          model: reg.get("groq") ? "openai/gpt-oss-120b" : deps.defaultModel(),
          messages: [systemMsg(system), userMsg(user)],
          maxTokens: 400,
        });
        raw = (r.content ?? "").trim();
      } catch {
        raw = "";
      }
    }
    return parseBrowserDecision(raw);
  }

  /** Run the agent loop on a live page until done / max steps. Mutates session. */
  async function _runBrowserAgent(session: BrowserAgentSession): Promise<void> {
    const browser = await _getBrowser();
    await runBrowserAgentTask(session, {
      withPage: (fn) => browser.withPage(fn),
      decide: _nextBrowserAction,
      save: _saveSession,
      maxSteps: MAX_AGENT_STEPS,
    });
  }

  app.post<{ Body: { task: string; startUrl?: string } }>(
    "/browser-agent/tasks",
    {
      schema: {
        body: {
          type: "object",
          required: ["task"],
          properties: {
            task: { type: "string", minLength: 1, maxLength: 2000 },
            startUrl: { type: "string", maxLength: 2048 },
          },
        },
      },
    },
    async (request, reply) => {
      const patchrightOk = await isPatchrightAvailable();
      const hasCdp = Boolean(process.env.BROWSER_CDP_URL);
      const sessionId = crypto.randomUUID();
      const session: BrowserAgentSession & { ownerId?: string | null } = {
        id: sessionId,
        ownerId: request.nexusUserId ?? null,
        sessionId,
        task: request.body.task,
        url: request.body.startUrl,
        status: "pending",
        steps: [],
        createdAt: now(),
      };

      if (!patchrightOk && !hasCdp) {
        session.status = "error";
        session.error =
          "No browser engine available. Install patchright on the server (pnpm add patchright && npx patchright install chromium) " +
          "or set BROWSER_CDP_URL to a hosted browser (Browserbase/Steel). Browser automation cannot drive your personal logged-in browser from a website.";
        _saveSession(session);
        return reply.code(200).send({ session });
      }

      // Stored before it is queued: the worker reads it from the store as soon as it picks it up.
      await _browserSessions.save(sessionId, session);
      // Answer before the run. Up to MAX_AGENT_STEPS LLM calls plus that many
      // page loads is minutes, which is longer than any reasonable HTTP
      // timeout; the client polls /sessions/:id, which it already does.
      // The worker owns the run when a queue is configured, so a restart
      // resumes it; without one the loop stays in this process, where a restart
      // is still the end of it.
      if (!(await launchBrowserTask(sessionId))) {
        void _runBrowserAgent(session).catch((e: unknown) => {
          session.status = "error";
          session.error = e instanceof Error ? e.message : String(e);
          _saveSession(session);
        });
      }
      return reply.code(202).send({ session });
    },
  );

  app.get("/browser-agent/sessions", async (request, reply) => {
    const sessions = Array.from(_browserSessions.values())
      .filter((s) => _mySession(request, s))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return reply.send({ sessions });
  });

  app.get<{ Params: { id: string } }>("/browser-agent/sessions/:id", async (request, reply) => {
    // Refresh first: when the worker owns the run, every step it records lands
    // in the backing store, and this process's copy is whatever it last wrote.
    const session =
      (await _browserSessions.refresh(request.params.id)) ??
      _browserSessions.get(request.params.id);
    if (!session || !_mySession(request, session))
      return reply.code(404).send({ error: "session not found" });
    return reply.send(session);
  });

  app.post<{
    Params: { id: string };
    Body: { action: BrowserActionType; target?: string; value?: string };
  }>("/browser-agent/sessions/:id/action", async (request, reply) => {
    const session = _browserSessions.get(request.params.id);
    if (!session || !_mySession(request, session))
      return reply.code(404).send({ error: "session not found" });
    const { action, target, value } = request.body ?? {};
    if (!action) return reply.code(400).send({ error: "action is required" });
    const browser = await _getBrowser();
    let ok = true;
    let screenshot: string | undefined;
    try {
      await browser.withPage(async (page) => {
        if (session.url) {
          await applyBrowserAction(page, { type: "navigate", selector: session.url });
        }
        await applyBrowserAction(page, { type: action, selector: target, value });
        const shot = await page.screenshot({ fullPage: false });
        screenshot = shot.toString("base64");
      });
    } catch (e) {
      ok = false;
      session.error = e instanceof Error ? e.message : String(e);
    }
    const step: BrowserAgentStep = {
      action,
      target,
      value,
      description: "manual action",
      success: ok,
    };
    session.steps.push(step);
    if (screenshot) session.screenshot = screenshot;
    _saveSession(session);
    return reply.send(session);
  });
}
