/**
 * Bundle the runner into a single self-contained dist/bin.cjs (node target).
 * Not wired into the app build pipeline — build on demand:
 *   pnpm --filter @slayzone/runner build
 */
import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['src/bin.ts'],
  outfile: 'dist/bin.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  // node-pty is a native addon (loads a prebuilt .node binary) and cannot be
  // bundled; keep it external and resolve it from node_modules at runtime.
  // bufferutil/utf-8-validate are optional native ws accelerators.
  external: ['node-pty', 'bufferutil', 'utf-8-validate'],
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info'
})
