import { defineConfig } from 'vitest/config'
import { stripCallerSlayzoneEnv } from '../../shared/test-utils/caller-env.ts'

// No suite here inherits the caller's SlayZone wiring (see caller-env.ts): vitest's
// main process, before any worker forks.
stripCallerSlayzoneEnv()

export default defineConfig({
  test: {
    environment: 'node'
  }
})
