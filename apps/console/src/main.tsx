// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import 'leaflet/dist/leaflet.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { queryClient } from './lib/queryClient';
import { LanguageProvider } from './lib/i18n';
import { ThemeProvider } from './lib/theme';

// Import the generated route tree
import { routeTree } from './routeTree.gen';

document.documentElement.dataset.product = 'city';

function getRootElement() {
  const existingRoot = document.getElementById('root');
  if (existingRoot) {
    return existingRoot;
  }

  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  return root;
}

// Create a new router instance
const router = createRouter({
  routeTree,
  context: {
    queryClient,
  },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
});

// Register the router instance for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(getRootElement()).render(
  <React.StrictMode>
    <ThemeProvider>
      <LanguageProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </LanguageProvider>
    </ThemeProvider>
  </React.StrictMode>,
)
