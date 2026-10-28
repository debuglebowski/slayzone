import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { reactCompilerPlugin } from '@slayzone/react-compiler-config'
import {
  fsModuleCacheOptions,
  fsModuleCacheResolutionKey
} from '../../shared/test-utils/fs-module-cache.ts'

const repoRoot = resolve(__dirname, '../../..')

// Mirrors the '@' alias in electron.vite.config.ts — needed so renderer files
// that import via '@/...' (the standard convention for this package) can be
// unit tested at all.
export default defineConfig({
  // The React Compiler, set up exactly as the renderer build (electron.vite.config.ts)
  // runs it: the jsdom suites must test components compiled the way they ship.
  // src/renderer/src/react-compiler-canary.test.tsx pins it.
  plugins: [react(), reactCompilerPlugin(), fsModuleCacheResolutionKey(repoRoot)],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src')
    }
  },
  // Transforms persist between runs (the compiler pass was most of these suites' time).
  test: fsModuleCacheOptions(repoRoot, 'app')
})
