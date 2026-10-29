#!/usr/bin/env node
/**
 * Runs the workspace's Turborepo (`pnpm typecheck` → `turbo run typecheck`) with its
 * anonymous usage telemetry off. A node wrapper rather than `VAR=1 turbo …` in the
 * package.json script: pnpm runs scripts under cmd on Windows (CI's check-windows job).
 *
 * turbo.json: `typecheck` depends on the no-op `transit` task, which depends on every
 * dependency's `transit` — so a package's cache key covers its dependencies' files
 * (packages export source, so their files are typecheck inputs) without ordering the
 * typechecks after one another. `pnpm lint:tsconfig-hermetic` keeps every typecheck
 * input inside that key. `pnpm typecheck --force` ignores the cache.
 */
import { spawnSync } from 'node:child_process'

const r = spawnSync('turbo', process.argv.slice(2), {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1' }
})
if (r.error) throw r.error
process.exit(r.status ?? 1)
