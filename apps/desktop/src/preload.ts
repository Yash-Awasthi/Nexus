// SPDX-License-Identifier: Apache-2.0
/**
 * Preload — the only channel between the renderer and the main process.
 *
 * Exposes one object, `window.nexusHost`, holding a capability list and a
 * single `invoke`. The renderer never receives an Electron handle, a Node
 * module, or a method it has no capability for.
 */

import { contextBridge, ipcRenderer } from "electron";

import { createHostApi, INVOKE_CHANNEL } from "./bridge";

const version = process.env.npm_package_version ?? "0.1.0";

contextBridge.exposeInMainWorld(
  "nexusHost",
  createHostApi(
    { invoke: (method, args) => ipcRenderer.invoke(INVOKE_CHANNEL, method, args) },
    { name: "nexus-desktop", version },
  ),
);
