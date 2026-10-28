import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { reactCompilerPlugin } from '@slayzone/react-compiler-config'

/**
 * Files below are vitest suites too, but they belong to run-all.sh's node harness group
 * (`run_harness` → `vitest.harness.config.ts`), which runs them under Electron's node:
 * they open the migrated test DB through better-sqlite3, built for Electron's ABI.
 * Collected here they would ERR_DLOPEN, and run twice. Every listed file must exist, so
 * a rename fails this config loudly instead of silently widening this run.
 */
const electronHarnessFiles = ['src/server/artifacts-router.test.ts']

for (const file of electronHarnessFiles) {
  if (!existsSync(fileURLToPath(new URL(file, import.meta.url)))) {
    throw new Error(`task-artifacts vitest.config: listed harness file is missing: ${file}`)
  }
}

export default defineConfig({
  // The React Compiler, set up exactly as the renderer builds run it: the jsdom
  // client suites must test hooks and components compiled the way they ship. The
  // node-environment server suites are untouched (the compiler preset never compiles
  // SSR-mode modules).
  plugins: [react(), reactCompilerPlugin()],
  test: {
    exclude: [...configDefaults.exclude, ...electronHarnessFiles]
  }
})
