import { defineConfig } from 'vitest/config'
import { stripCallerSlayzoneEnv } from '../../shared/test-utils/caller-env.ts'

// No suite here inherits the caller's SlayZone wiring (see caller-env.ts): vitest's
// main process, before any worker forks.
stripCallerSlayzoneEnv()

/**
 * Every suite in this package is vitest and needs the electron ABI for
 * better-sqlite3 — hence the `ELECTRON_RUN_AS_NODE=1 electron` test script.
 */
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**']
  }
})
