import React from 'react';
import ComponentCreator from '@docusaurus/ComponentCreator';

export default [
  {
    path: '/docs',
    component: ComponentCreator('/docs', '5fc'),
    routes: [
      {
        path: '/docs',
        component: ComponentCreator('/docs', '262'),
        routes: [
          {
            path: '/docs',
            component: ComponentCreator('/docs', '037'),
            routes: [
              {
                path: '/docs/',
                component: ComponentCreator('/docs/', '7f2'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/adrs',
                component: ComponentCreator('/docs/adrs', 'f70'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/api-reference',
                component: ComponentCreator('/docs/api-reference', '7f7'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/architecture',
                component: ComponentCreator('/docs/architecture', 'b63'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/cli-reference',
                component: ComponentCreator('/docs/cli-reference', '4fc'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/contributing',
                component: ComponentCreator('/docs/contributing', 'a30'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/plugin-author-guide',
                component: ComponentCreator('/docs/plugin-author-guide', '094'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/quick-start',
                component: ComponentCreator('/docs/quick-start', '8de'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/runbook',
                component: ComponentCreator('/docs/runbook', 'a20'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/slos',
                component: ComponentCreator('/docs/slos', 'db6'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/threat-model',
                component: ComponentCreator('/docs/threat-model', 'c6c'),
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
