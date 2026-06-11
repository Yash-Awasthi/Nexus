// SPDX-License-Identifier: Apache-2.0
import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  title: "NEXUS",
  tagline: "Autonomous orchestration — sense, think, decide, act.",
  favicon: "img/favicon.ico",

  url: "https://nexus.dev",
  baseUrl: "/",

  organizationName: "Yash-Awasthi",
  projectName: "Nexus",

  onBrokenLinks: "warn",
  onBrokenMarkdownLinks: "warn",

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          editUrl: "https://github.com/Yash-Awasthi/Nexus/edit/main/apps/docs-site/",
          showLastUpdateTime: true,
          showLastUpdateAuthor: true,
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: "img/nexus-social.png",
    navbar: {
      title: "NEXUS",
      logo: {
        alt: "NEXUS Logo",
        src: "img/logo.svg",
      },
      items: [
        { type: "docSidebar", sidebarId: "docs", position: "left", label: "Docs" },
        { to: "/docs/api-reference", label: "API", position: "left" },
        { to: "/docs/cli-reference", label: "CLI", position: "left" },
        { to: "/docs/plugin-author-guide", label: "Plugins", position: "left" },
        {
          href: "https://github.com/Yash-Awasthi/Nexus",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Docs",
          items: [
            { label: "Quick Start", to: "/docs/quick-start" },
            { label: "Architecture", to: "/docs/architecture" },
            { label: "Plugin Guide", to: "/docs/plugin-author-guide" },
          ],
        },
        {
          title: "Reference",
          items: [
            { label: "API Reference", to: "/docs/api-reference" },
            { label: "CLI Reference", to: "/docs/cli-reference" },
            { label: "ADRs", to: "/docs/adrs" },
          ],
        },
        {
          title: "Community",
          items: [
            { label: "GitHub", href: "https://github.com/Yash-Awasthi/Nexus" },
            { label: "Contributing", to: "/docs/contributing" },
            {
              label: "Security",
              href: "https://github.com/Yash-Awasthi/Nexus/blob/main/SECURITY.md",
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Yash Awasthi. Apache-2.0 License.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["bash", "json", "yaml", "python", "typescript"],
    },
    colorMode: {
      defaultMode: "dark",
      disableSwitch: false,
    },
    algolia: undefined, // enable search once deployed
  } satisfies Preset.ThemeConfig,
};

export default config;
