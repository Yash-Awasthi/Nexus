// SPDX-License-Identifier: Apache-2.0
/*
 * Nexus embeddable widget: ask your knowledge bases from any page.
 *
 *   <script src="https://your-nexus/widget.js" defer></script>
 *   <nexus-widget token="nxk_..." kbs="kb-id,kb-id" heading="Ask us"></nexus-widget>
 *
 * Attributes: token (required; mint it with only the "search" scope, since
 * anyone who opens the page can read it), kbs, web, graph, heading, api (the
 * Nexus origin, defaults to where this script came from) and mode="inline"
 * (an open panel instead of the floating button).
 */
(() => {
  const scriptOrigin = document.currentScript
    ? new URL(document.currentScript.src).origin
    : location.origin;

  const STYLE = `
:host { --nexus-accent: #4f46e5; --bg: #fff; --fg: #111827; --muted: #6b7280; --line: #e5e7eb;
  font: 14px/1.5 system-ui, sans-serif; color: var(--fg); }
@media (prefers-color-scheme: dark) {
  :host { --bg: #111827; --fg: #f3f4f6; --muted: #9ca3af; --line: #374151; }
}
* { box-sizing: border-box; }
.launch { position: fixed; right: 20px; bottom: 20px; width: 52px; height: 52px; border: 0;
  border-radius: 50%; background: var(--nexus-accent); color: #fff; font-size: 22px; cursor: pointer;
  box-shadow: 0 4px 14px rgb(0 0 0 / 0.25); z-index: 2147483000; }
.panel { background: var(--bg); border: 1px solid var(--line); border-radius: 12px; display: flex;
  flex-direction: column; overflow: hidden; }
.floating { position: fixed; right: 20px; bottom: 84px; width: 360px; height: 480px;
  box-shadow: 0 10px 30px rgb(0 0 0 / 0.25); z-index: 2147483000; }
.inline { width: 100%; min-height: 360px; }
@media (max-width: 480px) {
  .floating { left: 8px; right: 8px; bottom: 76px; width: auto; height: 70vh; }
}
[hidden] { display: none !important; }
header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px;
  border-bottom: 1px solid var(--line); font-weight: 600; }
header button { background: none; border: 0; color: var(--muted); font-size: 20px; cursor: pointer; }
.log { flex: 1; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.q { align-self: flex-end; background: var(--nexus-accent); color: #fff; padding: 6px 10px;
  border-radius: 10px; max-width: 85%; overflow-wrap: anywhere; }
.a { white-space: pre-wrap; overflow-wrap: anywhere; }
.a.err { color: #b91c1c; }
.src { font-size: 12px; color: var(--muted); margin: 4px 0 0; padding-left: 18px; }
.src a { color: inherit; }
form { display: flex; gap: 6px; padding: 10px; border-top: 1px solid var(--line); }
input { flex: 1; min-width: 0; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px;
  background: var(--bg); color: var(--fg); font: inherit; }
form button { padding: 8px 12px; border: 0; border-radius: 8px; background: var(--nexus-accent);
  color: #fff; font: inherit; cursor: pointer; }
form button:disabled { opacity: 0.6; cursor: default; }
`;

  class NexusWidget extends HTMLElement {
    connectedCallback() {
      if (this.shadowRoot) return;
      const root = this.attachShadow({ mode: "open" });
      const inline = this.getAttribute("mode") === "inline";
      root.innerHTML = `<style>${STYLE}</style>
<button class="launch" part="launcher" aria-label="Open questions" aria-expanded="false">?</button>
<section class="panel ${inline ? "inline" : "floating"}" role="dialog" hidden>
  <header><span class="title"></span><button class="close" aria-label="Close">×</button></header>
  <div class="log" aria-live="polite"></div>
  <form><input name="q" maxlength="500" autocomplete="off" aria-label="Your question"
    placeholder="Ask a question"><button type="submit">Ask</button></form>
</section>`;
      const $ = (sel) => root.querySelector(sel);
      const panel = $(".panel");
      const launch = $(".launch");
      const title = this.getAttribute("heading") || "Ask";
      $(".title").textContent = title;
      panel.setAttribute("aria-label", title);
      const toggle = (open) => {
        panel.hidden = !open;
        launch.setAttribute("aria-expanded", String(open));
        if (open) $("input").focus();
      };
      if (inline) {
        launch.hidden = true;
        $(".close").hidden = true;
        panel.hidden = false;
      }
      launch.addEventListener("click", () => toggle(panel.hidden));
      $(".close").addEventListener("click", () => toggle(false));
      $("form").addEventListener("submit", (e) => {
        e.preventDefault();
        const input = $("input");
        const query = input.value.trim();
        if (!query) return;
        input.value = "";
        void this.ask(query, $(".log"), $("form button"));
      });
    }

    async ask(query, log, button) {
      const add = (cls, text) => {
        const el = document.createElement("div");
        el.className = cls;
        el.textContent = text;
        log.append(el);
        log.scrollTop = log.scrollHeight;
        return el;
      };
      add("q", query);
      const answer = add("a", "…");
      button.disabled = true;
      try {
        const api = (this.getAttribute("api") || scriptOrigin).replace(/\/+$/, "");
        const kbs = (this.getAttribute("kbs") || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const res = await fetch(`${api}/api/search`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.getAttribute("token") || ""}`,
          },
          body: JSON.stringify({
            query,
            answer: true,
            ...(kbs.length ? { kbs } : {}),
            web: this.hasAttribute("web"),
            graph: this.hasAttribute("graph"),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok)
          throw new Error(data.message || data.error || `request failed (${res.status})`);
        answer.textContent =
          data.answer ||
          // Provider errors name models and keys' owners; a visitor only needs to know.
          (data.answerError
            ? "No answer right now. These sources matched:"
            : (data.notes || []).join(" ") || "Nothing found.");
        const cited = new Set(data.cited || []);
        const shown = (data.sources || []).filter((s) => !cited.size || cited.has(s.n)).slice(0, 5);
        if (shown.length) {
          const list = document.createElement("ol");
          list.className = "src";
          for (const s of shown) {
            const li = document.createElement("li");
            li.value = s.n;
            if (s.url && /^https?:\/\//.test(s.url)) {
              const a = document.createElement("a");
              a.href = s.url;
              a.target = "_blank";
              a.rel = "noopener noreferrer";
              a.textContent = s.title;
              li.append(a);
            } else li.textContent = s.title;
            list.append(li);
          }
          answer.append(list);
        }
      } catch (err) {
        answer.classList.add("err");
        answer.textContent = err instanceof Error ? err.message : String(err);
      } finally {
        button.disabled = false;
        log.scrollTop = log.scrollHeight;
      }
    }
  }

  if (!customElements.get("nexus-widget")) customElements.define("nexus-widget", NexusWidget);
})();
