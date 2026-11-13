import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { isolateFromCaller } from '../../shared/test-utils/caller-env.ts'
import { fsModuleCacheOptions } from '../../shared/test-utils/fs-module-cache.ts'

isolateFromCaller()

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
    maxWorkers: 2,
    // Its own cache directory, not the workspace-root default every other invocation
    // falls back to (see fsModuleCacheOptions).
    ...fsModuleCacheOptions(resolve(import.meta.dirname, '../../..'), 'chat-runtime')
  }
})
