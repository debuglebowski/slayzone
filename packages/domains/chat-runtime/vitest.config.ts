import { defineConfig } from 'vitest/config'
import { stripCallerSlayzoneEnv } from '../../shared/test-utils/caller-env.ts'

stripCallerSlayzoneEnv()

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
    maxWorkers: 2,
    fsModuleCache: true
  }
})
