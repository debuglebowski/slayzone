import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { reactCompilerBabelOptions } from '@slayzone/react-compiler-config'

// Mirrors the '@' alias in electron.vite.config.ts — needed so renderer files
// that import via '@/...' (the standard convention for this package) can be
// unit tested at all.
export default defineConfig({
  // The React Compiler, set up exactly as the renderer build (electron.vite.config.ts)
  // runs it: the jsdom suites must test components compiled the way they ship.
  // src/renderer/src/react-compiler-canary.test.tsx pins it.
  plugins: [react({ babel: reactCompilerBabelOptions() })],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src')
    }
  }
})
