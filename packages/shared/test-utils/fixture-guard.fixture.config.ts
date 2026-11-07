/**
 * The node harness config (vitest.harness.config.ts), unchanged, over one fixture file:
 * fixture-guard.test.ts runs it as a NESTED vitest to prove the harness fails a file
 * that leaves processes rooted in its own temp dirs.
 *
 * Only two things differ (see caller-env.fixture.config.ts): no globalSetup, and its
 * own module cache dir.
 */
import { join, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import harness from './vitest.harness.config.ts'

const rootDir = resolve(import.meta.dirname, '../../..')

export default defineConfig({
  ...harness,
  test: {
    ...harness.test,
    include: ['packages/shared/test-utils/fixture-guard.fixture.ts'],
    globalSetup: [],
    fsModuleCachePath: join(rootDir, 'node_modules', '.vitest-cache', 'harness-fixture-guard')
  }
})
