import { chromium } from "playwright-core";

const BASE = "http://localhost:5173";
const CRED = { email: "audit@nexus.local", password: "LocalDev12345!" };

// Authenticated headline pages to click through.
const PAGES = [
  "dashboard", "chat", "council-checkpoints", "deliberation", "prompts", "memory",
  "knowledge-bases", "knowledge-graph", "archetypes", "agents", "evaluation",
  "god-mode", "gauntlet", "drift", "deep-research", "image-gen", "marketplace",
  "workflows", "skills", "repos", "projects", "connectors/sync", "contacts",
  "billing", "rooms", "sandbox", "prediction-markets", "rlhf", "evals",
  "api-tokens", "provider-keys", "mcp-servers", "standard-answers", "settings",
  "profile", "language-models", "admin/users", "admin/analytics", "admin/system",
  "admin/audit", "admin/traces", "admin/feature-flags", "admin/feedback",
  "fine-tune", "redteam", "phantom", "honesty", "quality", "moderation",
  "semantic-cache", "cross-memory", "negation", "echo-chamber", "extraction",
  "fallback-chains", "codegen", "craft", "reasoning", "blind-council",
];

const results = [];

const browser = await chromium.launch({
  headless: true,
  executablePath: "/home/yash/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome",
  args: ["--no-sandbox"],
});
const ctx = await browser.newContext();
const page = await ctx.newPage();

// ── Login ──────────────────────────────────────────────────────────────
await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
// Try to log in via the real form; fall back to seeding tokens if form differs.
let loggedIn = false;
try {
  await page.fill('input[type="email"], input[name="email"]', CRED.email, { timeout: 4000 });
  await page.fill('input[type="password"], input[name="password"]', CRED.password, { timeout: 4000 });
  await page.click('button[type="submit"]', { timeout: 4000 });
  await page.waitForTimeout(2500);
  loggedIn = !page.url().includes("/login");
} catch {
  loggedIn = false;
}

if (!loggedIn) {
  // Seed auth by calling the API directly and storing tokens the way the app does.
  const resp = await page.request.post(`${BASE}/api/v1/auth/login`, { data: CRED });
  const body = await resp.json();
  await page.addInitScript((tok) => {
    localStorage.setItem("nexus_token", tok.accessToken);
    localStorage.setItem("nexus_user", JSON.stringify(tok.user ?? {}));
  }, body);
  await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
}

console.log(`login: ${loggedIn ? "form" : "seeded"}  url=${page.url()}`);

// ── Walk pages ─────────────────────────────────────────────────────────
for (const p of PAGES) {
  const consoleErrs = [];
  const netErrs = [];
  const onConsole = (m) => { if (m.type() === "error") consoleErrs.push(m.text().slice(0, 160)); };
  const onResp = (r) => {
    const s = r.status();
    const u = r.url();
    if (s >= 500 && u.includes("/api")) netErrs.push(`${s} ${u.replace(BASE, "").slice(0, 70)}`);
  };
  page.on("console", onConsole);
  page.on("response", onResp);
  let nav = "ok";
  try {
    await page.goto(`${BASE}/${p}`, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(800);
  } catch (e) {
    nav = `NAV_ERR ${String(e.message).slice(0, 60)}`;
  }
  // Detect a blank/crashed render: body text length + presence of an error boundary.
  const info = await page.evaluate(() => {
    const t = document.body?.innerText ?? "";
    return {
      len: t.trim().length,
      boundary: /something went wrong|application error|unhandled|ErrorBoundary|stack trace/i.test(t),
      head: t.trim().slice(0, 40).replace(/\s+/g, " "),
    };
  });
  page.off("console", onConsole);
  page.off("response", onResp);
  const status =
    nav !== "ok" ? nav
    : info.boundary ? "ERROR_BOUNDARY"
    : info.len < 20 ? "BLANK"
    : netErrs.length ? "API_500"
    : consoleErrs.length ? "CONSOLE_ERR"
    : "OK";
  results.push({ p, status, len: info.len, consoleErrs, netErrs, head: info.head });
  const tag = status === "OK" ? "OK  " : "FAIL";
  console.log(`${tag} /${p}  [${status}] len=${info.len}` +
    (netErrs.length ? ` net=${netErrs.join(",")}` : "") +
    (consoleErrs.length ? ` console="${consoleErrs[0]}"` : ""));
}

await browser.close();

const bad = results.filter((r) => r.status !== "OK");
console.log(`\n==== ${results.length - bad.length}/${results.length} OK, ${bad.length} FAIL ====`);
for (const b of bad) console.log(`  ${b.p}: ${b.status}` + (b.consoleErrs[0] ? ` | ${b.consoleErrs[0]}` : "") + (b.netErrs[0] ? ` | ${b.netErrs[0]}` : ""));
