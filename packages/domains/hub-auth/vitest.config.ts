import { defineConfig } from 'vitest/config'
import { isolateFromCaller } from '../../shared/test-utils/caller-env.ts'
import { localMaxWorkers } from '../../shared/test-utils/vitest-workers.ts'

// No suite here inherits the caller's SlayZone wiring, home or hub port block (see caller-env.ts): vitest's
// main process, before any worker forks.
isolateFromCaller()

export default defineConfig({
  test: {
    maxWorkers: localMaxWorkers(),
    environment: 'node'
  }
})
