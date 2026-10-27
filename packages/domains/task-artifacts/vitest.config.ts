import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { reactCompilerPlugin } from '@slayzone/react-compiler-config'

export default defineConfig({
  // The React Compiler, set up exactly as the renderer builds run it: the jsdom
  // client suites must test hooks and components compiled the way they ship. The
  // node-environment server suites are untouched (the compiler preset never compiles
  // SSR-mode modules).
  plugins: [react(), reactCompilerPlugin()]
})
