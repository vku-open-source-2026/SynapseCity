// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    TanStackRouterVite(),
    react()
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: true,
    allowedHosts: true,
    // Local development talks to the City service, not to the Vite SPA
    // fallback. A missing service now yields a proxy error instead of a 200
    // index.html, so list/map screens can show their explicit error state.
    proxy: {
      '/v1': {
        target: process.env.VITE_DEV_API_PROXY || 'http://localhost:8083',
        changeOrigin: true,
      },
    },
  },
  preview: {
    allowedHosts: true,
  }
})