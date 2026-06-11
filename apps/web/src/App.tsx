// SPDX-License-Identifier: Apache-2.0
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout.js";
import Dashboard from "./pages/Dashboard.js";
import Council from "./pages/Council.js";
import Tasks from "./pages/Tasks.js";
import Approvals from "./pages/Approvals.js";
import Signals from "./pages/Signals.js";
import Audit from "./pages/Audit.js";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="signals" element={<Signals />} />
          <Route path="council" element={<Council />} />
          <Route path="tasks" element={<Tasks />} />
          <Route path="approvals" element={<Approvals />} />
          <Route path="audit" element={<Audit />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
