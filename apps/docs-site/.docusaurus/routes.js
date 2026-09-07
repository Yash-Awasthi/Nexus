import React from 'react';
import ComponentCreator from '@docusaurus/ComponentCreator';

export default [
  {
    path: '/docs',
    component: ComponentCreator('/docs', '093'),
    routes: [
      {
        path: '/docs',
        component: ComponentCreator('/docs', '3db'),
        routes: [
          {
            path: '/docs',
            component: ComponentCreator('/docs', '607'),
            routes: [
              {
                path: '/docs/',
                component: ComponentCreator('/docs/', '6e2'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/adrs',
                component: ComponentCreator('/docs/adrs', 'a59'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/api-reference',
                component: ComponentCreator('/docs/api-reference', '502'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/architecture',
                component: ComponentCreator('/docs/architecture', 'c63'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/cli-reference',
                component: ComponentCreator('/docs/cli-reference', '1c6'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/contributing',
                component: ComponentCreator('/docs/contributing', '6bb'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/plugin-author-guide',
                component: ComponentCreator('/docs/plugin-author-guide', 'cd0'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/quick-start',
                component: ComponentCreator('/docs/quick-start', 'f58'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/runbook',
                component: ComponentCreator('/docs/runbook', '2e8'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/sdk',
                component: ComponentCreator('/docs/sdk', '887'),
                exact: true
              },
              {
                path: '/docs/slos',
                component: ComponentCreator('/docs/slos', 'e51'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/spectre',
                component: ComponentCreator('/docs/spectre', 'e98'),
                exact: true
              },
              {
                path: '/docs/threat-model',
                component: ComponentCreator('/docs/threat-model', 'be0'),
                exact: true,
                sidebar: "docs"
              }
            ]
          }
        ]
      }
    ]
  },
  {
    path: '/',
    component: ComponentCreator('/', 'e5f'),
    exact: true
  },
  {
    path: '*',
    component: ComponentCreator('*'),
  },
];
