/**
 * The node harness config (vitest.harness.config.ts), unchanged, over one fixture file:
 * caller-env.test.ts runs it as a NESTED vitest with a poisoned caller env, to prove a
 * harness run never lets that env reach a suite or the children it spawns.
 *
 * Only two things differ, neither about env: no globalSetup (the outer run already
 * built the bins, and a second build into the same dist/ would race the outer run's
 * suites spawning them) and its own module cache dir (two invocations must never share
 * one, see fs-module-cache.ts).
 */
import { join, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import harness from './vitest.harness.config.ts'

const rootDir = resolve(import.meta.dirname, '../../..')

export default defineConfig({
  ...harness,
  test: {
    ...harness.test,
    include: ['packages/shared/test-utils/caller-env.fixture.ts'],
    globalSetup: [],
    fsModuleCachePath: join(rootDir, 'node_modules', '.vitest-cache', 'harness-caller-env')
  }
})
