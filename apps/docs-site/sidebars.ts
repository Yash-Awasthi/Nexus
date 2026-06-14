// SPDX-License-Identifier: Apache-2.0
import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: [
    {
      type: "doc",
      id: "intro",
      label: "Overview",
    },
    {
      type: "doc",
      id: "quick-start",
      label: "Quick Start",
    },
    {
      type: "doc",
      id: "architecture",
      label: "Architecture",
    },
    {
      type: "category",
      label: "Guides",
      collapsed: false,
      items: ["plugin-author-guide", "contributing"],
    },
    {
      type: "category",
      label: "Reference",
      collapsed: false,
      items: ["api-reference", "cli-reference"],
    },
    {
      type: "category",
      label: "Security & Operations",
      items: ["threat-model", "runbook", "slos"],
    },
    {
      type: "doc",
      id: "adrs",
      label: "ADR Index",
    },
  ],
};

export default sidebars;
