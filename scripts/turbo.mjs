#!/usr/bin/env node
/**
 * Runs the workspace's Turborepo (`pnpm typecheck` → `turbo run typecheck`) with its
 * anonymous usage telemetry off. A node wrapper rather than `VAR=1 turbo …` in the
 * package.json script: pnpm runs scripts under cmd on Windows (CI's check-windows job).
 * It runs turbo's own node entry (resolved from the root's devDependency), so it works
 * outside a pnpm script too (`node scripts/turbo.mjs …`, e.g. CI's cache prune).
 *
 * turbo.json: `typecheck` depends on the no-op `transit` task, which depends on every
 * dependency's `transit` — so a package's cache key covers its dependencies' files
 * (packages export source, so their files are typecheck inputs) without ordering the
 * typechecks after one another. `pnpm lint:tsconfig-hermetic` keeps every typecheck
 * input inside that key. `pnpm typecheck --force` ignores the cache.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const turboPackage = require.resolve('turbo/package.json')
const turboBin = join(dirname(turboPackage), require(turboPackage).bin.turbo)

const r = spawnSync(process.execPath, [turboBin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1' }
})
if (r.error) throw r.error
process.exit(r.status ?? 1)
