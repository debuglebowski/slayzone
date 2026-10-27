import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { reactCompilerBabelOptions } from '@slayzone/react-compiler-config'

export default defineConfig({
  // The React Compiler, set up exactly as the renderer builds run it: these suites
  // must test components compiled the way they ship.
  plugins: [react({ babel: reactCompilerBabelOptions() })],
  test: {
    environment: 'jsdom'
  }
})
