// SPDX-License-Identifier: Apache-2.0
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import { ErrorBoundary } from "./components/ErrorBoundary.js";
import Layout from "./components/Layout.js";
import Approvals from "./pages/Approvals.js";
import Audit from "./pages/Audit.js";
import Billing from "./pages/Billing.js";
import Chat from "./pages/Chat.js";
import Connectors from "./pages/Connectors.js";
import Council from "./pages/Council.js";
import Dashboard from "./pages/Dashboard.js";
import Discover from "./pages/Discover.js";
import ImageGen from "./pages/ImageGen.js";
import KGExplorer from "./pages/KGExplorer.js";
import MemoryTimeline from "./pages/MemoryTimeline.js";
import Settings from "./pages/Settings.js";
import Signals from "./pages/Signals.js";
import Tasks from "./pages/Tasks.js";
import Voice from "./pages/Voice.js";
import Research from "./pages/Research.js";

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Layout />}>
            {/* Core platform */}
            <Route index element={<Dashboard />} />
            <Route path="discover" element={<Discover />} />
            <Route path="signals" element={<Signals />} />
            <Route path="council" element={<Council />} />
            <Route path="tasks" element={<Tasks />} />
            <Route path="chat" element={<Chat />} />
            <Route path="approvals" element={<Approvals />} />
            <Route path="audit" element={<Audit />} />
            <Route path="memory" element={<MemoryTimeline />} />
            <Route path="research" element={<Research />} />

            {/* Extended capabilities */}
            <Route path="billing" element={<Billing />} />
            <Route path="connectors" element={<Connectors />} />
            <Route path="image-gen" element={<ImageGen />} />
            <Route path="knowledge-graph" element={<KGExplorer />} />
            <Route path="settings" element={<Settings />} />
            <Route path="voice" element={<Voice />} />

            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
