import { defineConfig } from 'vitest/config'

/**
 * Every suite in this package is vitest and needs the electron ABI for
 * better-sqlite3 — hence the `ELECTRON_RUN_AS_NODE=1 electron` test script.
 */
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**']
  }
})
