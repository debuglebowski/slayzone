import { defineConfig } from 'vitest/config'
import { stripCallerSlayzoneEnv } from '../../shared/test-utils/caller-env.ts'

// No suite here inherits the caller's SlayZone wiring (see caller-env.ts). Otherwise
// vitest's defaults.
stripCallerSlayzoneEnv()

export default defineConfig({})
