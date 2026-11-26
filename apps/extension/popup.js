// SPDX-License-Identifier: Apache-2.0
// Settings live in extension storage; the answering is the server's own widget, drawn inline.
const $ = (id) => document.getElementById(id);

/** The page the person attached to this question, or null. Nothing is captured without a click. */
let attached = null;

/** Text selected on the active tab, used to prefill the input when a page is not attached. */
async function selection() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [hit] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => String(getSelection()),
    });
    return String(hit?.result ?? "")
      .trim()
      .slice(0, 500);
  } catch {
    return "";
  }
}

/** The chip above the input: what is attached, and how to take it off. */
function renderChip() {
  const chip = $("chip");
  chip.hidden = !attached;
  if (!attached) return;
  $("chip-label").textContent = NexusContext.attachmentLabel(attached);
  $("chip-url").textContent = attached.url;
  $("chip-url").title = attached.url;
}

async function show() {
  const { api, token } = await chrome.storage.local.get(["api", "token"]);
  const ready = Boolean(api && token);
  $("settings").hidden = ready;
  $("reset").hidden = !ready;
  $("attach").hidden = !ready;
  if (!ready) return;
  const widget = document.createElement("nexus-widget");
  for (const [k, v] of Object.entries({ mode: "inline", api, token, heading: "Ask Nexus" }))
    widget.setAttribute(k, v);
  $("ask").replaceChildren(widget);
  const text = await selection();
  const input = widget.shadowRoot?.querySelector("input");
  if (input && text) input.value = text;
  input?.focus();
  renderChip();
  if (attached) widget.setPage?.(attached);
}

/** Attach the tab on a click, and never before: this is the whole permission story. */
$("attach").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const page = await NexusContext.attachPage(chrome, tab.id);
  if (!page) {
    $("chip-label").textContent = "This page cannot be attached";
    $("chip").hidden = false;
    $("remove").hidden = true;
    return;
  }
  attached = page;
  $("remove").hidden = false;
  renderChip();
  const widget = document.querySelector("nexus-widget");
  widget?.setPage?.(attached);
});

$("remove").addEventListener("click", () => {
  attached = null;
  renderChip();
  document.querySelector("nexus-widget")?.clearPage?.();
});

$("settings").addEventListener("submit", async (e) => {
  e.preventDefault();
  const api = new URL($("api").value.trim()).origin;
  // Host access is asked for this one server, so the popup's requests skip CORS.
  if (!(await chrome.permissions.request({ origins: [`${api}/*`] }))) return;
  await chrome.storage.local.set({ api, token: $("token").value.trim() });
  void show();
});

$("reset").addEventListener("click", async () => {
  await chrome.storage.local.remove(["api", "token"]);
  attached = null;
  $("ask").replaceChildren();
  void show();
});

void show();
