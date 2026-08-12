import { defineConfig } from 'vitest/config'

/**
 * `project-paths.test.ts` is excluded because it is NOT a vitest suite — it uses
 * the ipc-harness `test()` helper and is run by `run-all.sh` under the electron
 * strict loader. Vitest collects the file, its 8 tests pass and print ✓ through
 * the harness's own reporter, and vitest then fails the FILE with "No test suite
 * found" because it never registered a vitest suite. Excluding it here is what
 * lets `pnpm --filter @slayzone/computers test` be delegated from run-all.sh.
 *
 * Everything else in this package is ordinary vitest and needs the electron ABI
 * for better-sqlite3 — hence the `ELECTRON_RUN_AS_NODE=1 electron` test script.
 */
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', 'src/server/project-paths.test.ts']
  }
})
