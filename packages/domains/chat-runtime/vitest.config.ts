import { defineConfig } from 'vitest/config'
import { isolateFromCaller } from '../../shared/test-utils/caller-env.ts'

isolateFromCaller()

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
    maxWorkers: 2,
    fsModuleCache: true
  }
})
