import { defineConfig } from 'vitest/config'
import { isolateFromCaller } from '../../shared/test-utils/caller-env.ts'

// No suite here inherits the caller's SlayZone wiring, home or hub port block (see caller-env.ts): vitest's
// main process, before any worker forks.
isolateFromCaller()

/**
 * Every suite in this package is vitest and needs the electron ABI for
 * better-sqlite3 — hence the `ELECTRON_RUN_AS_NODE=1 electron` test script.
 */
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**']
  }
})
