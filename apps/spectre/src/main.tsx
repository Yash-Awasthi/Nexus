// SPDX-License-Identifier: Apache-2.0
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App.js";

// Global CSS reset + CSS variable baseline (void theme defaults)
const style = document.createElement("style");
style.textContent = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body, #root { height: 100%; }
  body {
    background: var(--bg, #080808);
    color: var(--fg, #00ff88);
    font-family: var(--font, 'Courier New', monospace);
    -webkit-font-smoothing: antialiased;
  }
  ::-webkit-scrollbar { width: 4px; height: 4px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--fg3); }
  button { cursor: pointer; }
  button:focus-visible { outline: 1px solid var(--accent); }
  textarea:focus, input:focus { outline: 1px solid var(--accent) !important; }
  ::selection { background: var(--accent); color: var(--bg); }
`;
document.head.appendChild(style);

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
