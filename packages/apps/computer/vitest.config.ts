import { defineConfig } from 'vitest/config'
import { isolateFromCaller } from '../../shared/test-utils/caller-env.ts'

// No suite here inherits the caller's SlayZone wiring, home or hub port block (see caller-env.ts). Otherwise
// vitest's defaults.
isolateFromCaller()

export default defineConfig({})
