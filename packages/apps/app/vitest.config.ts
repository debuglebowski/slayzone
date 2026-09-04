import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Mirrors the '@' alias in electron.vite.config.ts — needed so renderer files
// that import via '@/...' (the standard convention for this package) can be
// unit tested at all.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src')
    }
  }
})
