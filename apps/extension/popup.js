// SPDX-License-Identifier: Apache-2.0
// Settings live in extension storage; the answering is the server's own widget, drawn inline.
const $ = (id) => document.getElementById(id);

/** Text selected on the active tab; pages the extension may not script give none. */
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

async function show() {
  const { api, token } = await chrome.storage.local.get(["api", "token"]);
  const ready = Boolean(api && token);
  $("settings").hidden = ready;
  $("reset").hidden = !ready;
  if (!ready) return;
  const widget = document.createElement("nexus-widget");
  for (const [k, v] of Object.entries({ mode: "inline", api, token, heading: "Ask Nexus" }))
    widget.setAttribute(k, v);
  $("ask").replaceChildren(widget);
  const text = await selection();
  const input = widget.shadowRoot?.querySelector("input");
  if (input && text) input.value = text;
  input?.focus();
}

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
  $("ask").replaceChildren();
  void show();
});

void show();
