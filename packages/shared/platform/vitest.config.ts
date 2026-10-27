import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

/**
 * `pnpm test` here runs under PLAIN node — CI's `check-windows` job invokes it as the
 * "shell primitives" step, so every file it collects must be portable.
 *
 * The files below are vitest suites too, but they belong to run-all.sh's node harness
 * group (`run_harness` → `vitest.harness.config.ts`), which runs them under Electron's
 * node: better-sqlite3 is built for Electron's ABI (adopt-renamed-db, device-status-
 * queries), and several assume a Unix host (`sleep`, launchd/systemd units, POSIX
 * paths). Collected here they would fail on Windows or ERR_DLOPEN, and run twice.
 *
 * Every listed file must exist, so a rename fails this config loudly instead of
 * silently widening the portable run; a new file not listed runs here (and is
 * registered by run_package_tests), so it is never dropped.
 */
const electronHarnessFiles = [
  'adopt-renamed-db',
  'client-address',
  'client-settings',
  'computer-config-file',
  'config-prompt',
  'device-status-queries',
  'dirs',
  'env-manifest',
  'event-loop-stall',
  'hub-addr',
  'hub-config-file',
  'hub-convex',
  'hub-discovery',
  'hub-port-block',
  'hub-switch-refusal',
  'hub-switches',
  'security-log',
  'service-unit',
  'startup-deadline'
].map((name) => `src/${name}.test.ts`)

for (const file of electronHarnessFiles) {
  if (!existsSync(fileURLToPath(new URL(file, import.meta.url)))) {
    throw new Error(`platform vitest.config: listed harness file is missing: ${file}`)
  }
}

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ...electronHarnessFiles]
  }
})
