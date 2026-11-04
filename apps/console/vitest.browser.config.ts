// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'
import react from '@vitejs/plugin-react'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    include: ['leaflet-draw'],
  },
  test: {
    // Browser specs share one page, so run files sequentially: several specs
    // seed or clear the auth store and must not interleave.
    fileParallelism: false,
    setupFiles: ['./e2e/setup.ts'],
    include: ['e2e/**/*.spec.ts'],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      // https://vitest.dev/config/browser/playwright
      instances: [
        { browser: 'chromium' },
      ],
    },
  },
})
