import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'

const appPkg = JSON.parse(readFileSync(new URL('../app/package.json', import.meta.url), 'utf-8'))

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  // Package is `type: module` (ESM source, required so tsx resolves CLI .ts cleanly
  // in tests under Node's require(esm) cycle rules). The bundle stays CJS — emit it
  // explicitly and pin dist/ to commonjs below so Node reads slay.js as CJS.
  format: 'cjs',
  outfile: 'dist/slay.js',
  banner: { js: '#!/usr/bin/env node' },
  external: ['node:sqlite'],
  define: { __APP_VERSION__: JSON.stringify(appPkg.version) }
})

// Pin the output dir to CommonJS so the CJS bundle is not reinterpreted as ESM
// under the package's `type: module`.
writeFileSync(new URL('dist/package.json', import.meta.url), '{\n  "type": "commonjs"\n}\n')
