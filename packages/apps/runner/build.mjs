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
  // Optional native ws accelerators — resolved at runtime if present.
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info'
})
