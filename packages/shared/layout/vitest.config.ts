import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { reactCompilerPlugin } from '@slayzone/react-compiler-config'
import { isolateFromCaller } from '../test-utils/caller-env.ts'

// No suite here inherits the caller's SlayZone wiring, home or hub port block (see caller-env.ts): vitest's
// main process, before any worker forks.
isolateFromCaller()

export default defineConfig({
  // The React Compiler, set up exactly as the renderer builds run it: these suites
  // must test components compiled the way they ship.
  plugins: [react(), reactCompilerPlugin()],
  test: {
    environment: 'jsdom'
  }
})
